import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import YAML from "yaml";
import { Hono } from "hono";
import { deriveCurrentWork } from "../src/domain/current-work.js";
import { proofRoutes } from "../src/routes/proof.js";
import { proofMissionRoots } from "../src/domain/proof/project-roots.js";
import { watchProofSources } from "../src/domain/proof/source-watch.js";
import { readSliceReadiness, recordJudgment } from "../src/domain/proof/judgments.js";
import type { EventBus } from "../src/domain/event-bus.js";

// Temporary workspace: default project (missions/), project "plug" and project "themes", each with a
// mission. "omarchy-rigs" exists in plug and themes; "plug-only" only in plug.
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
function write(file: string, data: string | object) {
  fs.mkdirSync(join(file, ".."), { recursive: true });
  fs.writeFileSync(file, typeof data === "string" ? data : YAML.stringify(data));
}
function slice(missions: string, mission: string, name: string) {
  const dir = join(missions, mission, "slices", name);
  write(join(missions, mission, "mission.yaml"), { kind: "mission", metadata: { name: mission, status: "active" }, composition: { slices: [{ ref: `slices/${name}/slice.yaml`, order: 1, active: true }] } });
  write(join(missions, mission, "SPEC.md"), `---\nid: ${mission}\n---\n# ${mission}\n`);
  write(join(dir, "slice.yaml"), { kind: "slice", metadata: { id: name, status: "draft" } });
  write(join(dir, "SPEC.md"), `---\nid: ${name}\n---\n# ${name}\n\n## Proof contract\n- [ ] Prove ${name}.\n`);
  write(join(dir, "proof", "evidence.md"), `Observed outcome for ${name}.\n`);
  return dir;
}
function workspace() {
  const root = fs.mkdtempSync(join(tmpdir(), "project-roots-resolvers-")); dirs.push(root);
  for (const [dir, id] of [[root, "default"], [join(root, "projects/plug"), "plug"], [join(root, "projects/themes"), "themes"]] as const) {
    write(join(dir, "project.yaml"), { kind: "project", metadata: { id }, proofPolicy: { judges: ["judge@rig"] }, missions: { root: "missions" } });
    write(join(dir, "SPEC.md"), `# ${id}\n`);
  }
  write(join(root, "workspace.yaml"), { schema: "openrig.workspace/v0alpha1", projects: [{ id: "default", root: "." }, { id: "plug", root: "projects/plug" }, { id: "themes", root: "projects/themes" }] });
  const missions = join(root, "missions");
  const d = slice(missions, "default-m", "01-a");
  const po = slice(join(root, "projects/plug/missions"), "plug-only", "01-a");
  const pr = slice(join(root, "projects/plug/missions"), "omarchy-rigs", "01-a");
  const tr = slice(join(root, "projects/themes/missions"), "omarchy-rigs", "01-a");
  const ctx = { get: () => undefined } as { get: (k: never) => unknown };
  return { root, missions, d, po, pr, tr, roots: () => proofMissionRoots(ctx, missions) };
}
const row = (mission: string, slice: string) => ({ state: "in-progress", tags: [`mission:${mission}`, `slice:${slice}`] });

describe("current work resolves typed rows across registered project roots", () => {
  it("a row naming a mission in a project root resolves to that work node", () => {
    const w = workspace();
    const r = deriveCurrentWork([row("plug-only", "01-a")], w.roots());
    expect(r.currentWork?.workNodePath).toBe(fs.realpathSync(w.po));
  });
  it("the default project is unchanged, with a root list or a single path", () => {
    const w = workspace();
    expect(deriveCurrentWork([row("default-m", "01-a")], w.roots()).currentWork?.workNodePath).toBe(fs.realpathSync(w.d));
    expect(deriveCurrentWork([row("default-m", "01-a")], w.missions).currentWork?.workNodePath).toBe(w.d);
  });
  it("a mission name present in two projects is refused with both listed, never guessed", () => {
    const w = workspace();
    const r = deriveCurrentWork([row("omarchy-rigs", "01-a")], w.roots());
    expect(r.currentWork).toBeNull();
    expect(r.currentWorkBasis).toContain("resolves to 2 directories");
    expect(r.currentWorkBasis).toContain("plug");
    expect(r.currentWorkBasis).toContain("themes");
  });
  it("an unknown mission is still refused, and a single-root string behaves as before", () => {
    const w = workspace();
    expect(deriveCurrentWork([row("nowhere", "01-a")], w.roots()).currentWork).toBeNull();
    expect(deriveCurrentWork([row("plug-only", "01-a")], w.missions).currentWork).toBeNull();
    expect(deriveCurrentWork([row("plug-only", "01-a")], "").currentWorkBasis).toBe("no missions root configured");
  });
});

describe("GET /api/proof with no scope lists every registered project with its id", () => {
  it("keeps the default fields and adds projects[] carrying each project id", async () => {
    const w = workspace();
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("sliceIndexer" as never, { isReady: () => true, slicesRoot: w.missions, invalidate() {} } as never); await next(); });
    app.route("/api/proof", proofRoutes());
    const body = await (await app.request("/api/proof")).json();
    expect(body.missions.map((m: { name: string }) => m.name)).toEqual(["default-m"]); // default fields unchanged
    const byId = Object.fromEntries(body.projects.map((p: { id: string; missions: Array<{ name: string }> }) => [p.id, p.missions.map(m => m.name).sort()]));
    expect(byId).toEqual({ default: ["default-m"], plug: ["omarchy-rigs", "plug-only"], themes: ["omarchy-rigs"] });
  });
});

describe("proof source watch covers project roots", () => {
  it("emits proof.sources_changed when a judgment lands in a project-root mission", async () => {
    const w = workspace();
    const events: unknown[] = [];
    const watch = watchProofSources(w.missions, () => {}, { emit: (e: unknown) => events.push(e) } as unknown as EventBus, w.roots);
    try {
      await new Promise(r => setTimeout(r, 250));
      expect(events).toHaveLength(0);
      const item = readSliceReadiness(w.po).items[0]!;
      recordJudgment(w.roots(), { scope: w.po, item: item.id, verdict: "accept", reason: "Observed", evidence: ["proof/evidence.md"], expectedRevision: item.revision, expectedPrevious: null }, "judge@rig", "test");
      await expect.poll(() => events.length, { timeout: 5000 }).toBeGreaterThan(0);
    } finally { watch.close(); }
  });
  it("without the roots argument a project-root judgment is not noticed, as before (primary root only)", async () => {
    const w = workspace();
    const events: unknown[] = [];
    const watch = watchProofSources(w.missions, () => {}, { emit: (e: unknown) => events.push(e) } as unknown as EventBus);
    try {
      await new Promise(r => setTimeout(r, 250));
      const item = readSliceReadiness(w.po).items[0]!;
      recordJudgment(w.roots(), { scope: w.po, item: item.id, verdict: "accept", reason: "Observed", evidence: ["proof/evidence.md"], expectedRevision: item.revision, expectedPrevious: null }, "judge@rig", "test");
      await new Promise(r => setTimeout(r, 400));
      expect(events).toHaveLength(0);
    } finally { watch.close(); }
  });
});
