import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import YAML from "yaml";
import { Hono } from "hono";
import { proofRoutes } from "../src/routes/proof.js";
import { readSliceReadiness } from "../src/domain/proof/judgments.js";

// A temporary workspace shaped like ~/.openrig/workspace with a project catalog:
//   missions/                     default project (root .)
//   projects/plug/missions/       project "plug"
//   projects/themes/missions/     project "themes"
// "omarchy-rigs" exists in both plug and themes (an ambiguous name); "plug-only" only in plug.
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

function write(file: string, data: string | object) {
  fs.mkdirSync(join(file, ".."), { recursive: true });
  fs.writeFileSync(file, typeof data === "string" ? data : YAML.stringify(data));
}
function slice(missions: string, mission: string, name: string) {
  const dir = join(missions, mission, "slices", name);
  write(join(missions, mission, "mission.yaml"), { kind: "mission", metadata: { name: mission, status: "active" } });
  write(join(dir, "slice.yaml"), { kind: "slice", metadata: { id: name, status: "draft" } });
  write(join(dir, "SPEC.md"), `---\nid: ${name}\n---\n# ${name}\n\n## Proof contract\n- [ ] Prove ${name}.\n`);
  write(join(dir, "proof", "evidence.md"), `Observed outcome for ${name}.\n`);
  return dir;
}
function workspace(opts: { catalog?: boolean } = {}) {
  const root = fs.mkdtempSync(join(tmpdir(), "proof-project-roots-")); dirs.push(root);
  const project = (dir: string, id: string) => {
    write(join(dir, "project.yaml"), { kind: "project", metadata: { id }, proofPolicy: { judges: ["judge@rig"] }, missions: { root: "missions" } });
    write(join(dir, "SPEC.md"), `# ${id}\n`); // a catalogued project carries its SPEC.md (the project read requires it)
  };
  project(root, "default");
  project(join(root, "projects", "plug"), "plug");
  project(join(root, "projects", "themes"), "themes");
  if (opts.catalog !== false) write(join(root, "workspace.yaml"), { schema: "openrig.workspace/v0alpha1", projects: [{ id: "default", root: "." }, { id: "plug", root: "projects/plug" }, { id: "themes", root: "projects/themes" }] });
  const dflt = slice(join(root, "missions"), "default-m", "01-a");
  const plugOnly = slice(join(root, "projects/plug/missions"), "plug-only", "01-a");
  const plugRigs = slice(join(root, "projects/plug/missions"), "omarchy-rigs", "01-a");
  const themesRigs = slice(join(root, "projects/themes/missions"), "omarchy-rigs", "01-a");
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("sliceIndexer" as never, { isReady: () => true, slicesRoot: join(root, "missions"), invalidate() {} } as never); await next(); });
  app.route("/api/proof", proofRoutes());
  const show = (scope: string) => app.request(`/api/proof?scope=${encodeURIComponent(scope)}`);
  const judge = async (scope: string, dir: string) => {
    const item = readSliceReadiness(dir).items[0]!;
    return app.request("/api/proof/judge", { method: "POST", headers: { "Content-Type": "application/json", "X-OpenRig-Session": "judge@rig" }, body: JSON.stringify({ scope, item: item.id, verdict: "accept", reason: "Observed", evidence: ["proof/evidence.md"], expectedRevision: item.revision, expectedPrevious: null }) });
  };
  return { root, dflt, plugOnly, plugRigs, themesRigs, show, judge };
}

describe("proof show and judge across project mission roots", () => {
  it("keeps default-project addressing exactly as before", async () => {
    const w = workspace();
    const res = await w.show("default-m/slices/01-a");
    expect(res.status).toBe(200);
    expect((await res.json()).items[0].text).toContain("Prove 01-a");
    expect((await w.judge("default-m/slices/01-a", w.dflt)).status).toBe(201);
    expect(fs.existsSync(join(w.dflt, "proof/judgments/00000001.md"))).toBe(true);
  });

  it("works with no workspace.yaml: only the primary root, as before", async () => {
    const w = workspace({ catalog: false });
    expect((await w.show("default-m/slices/01-a")).status).toBe(200);
    const res = await w.show("plug-only/slices/01-a");
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("scope_missing");
  });

  it("shows and judges a mission that lives under a registered project root", async () => {
    const w = workspace();
    const res = await w.show("plug-only/slices/01-a");
    expect(res.status, await res.clone().text()).toBe(200);
    expect((await res.json()).items[0].state).toBe("pending");
    const judged = await w.judge("plug-only/slices/01-a", w.plugOnly);
    expect(judged.status, await judged.clone().text()).toBe(201);
    expect(fs.existsSync(join(w.plugOnly, "proof/judgments/00000001.md"))).toBe(true);
    expect(readSliceReadiness(w.plugOnly).state).toBe("ready");
    // The ledger scope is relative to the owning project, so the receipt names that project's tree.
    const receipt = fs.readFileSync(join(w.plugOnly, "proof/judgments/00000001.md"), "utf8");
    expect(receipt).toContain("scope: missions/plug-only/slices/01-a");
  });

  it("accepts an absolute path inside a registered project's missions root", async () => {
    const w = workspace();
    expect((await w.show(w.plugOnly)).status).toBe(200);
    expect((await w.judge(w.themesRigs, w.themesRigs)).status).toBe(201);
  });

  it("fails an ambiguous name clearly, listing every project, and never picks one", async () => {
    const w = workspace();
    const res = await w.show("omarchy-rigs/slices/01-a");
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("scope_ambiguous");
    expect(body.message).toContain("plug");
    expect(body.message).toContain("themes");
    expect(body.message).toContain(w.plugRigs);
    expect(body.message).toContain(w.themesRigs);
    const judged = await w.judge("omarchy-rigs/slices/01-a", w.plugRigs);
    expect(judged.status).toBe(409);
    expect(fs.existsSync(join(w.plugRigs, "proof/judgments"))).toBe(false);
    expect(fs.existsSync(join(w.themesRigs, "proof/judgments"))).toBe(false);
    // The absolute path names the one you mean.
    expect((await w.show(w.themesRigs)).status).toBe(200);
  });

  it("a name found in the default project and in another project is ambiguous too", async () => {
    const w = workspace();
    slice(join(w.root, "missions"), "plug-only", "01-a");
    expect((await w.show("plug-only/slices/01-a")).status).toBe(409);
  });

  it("still refuses paths that escape every registered root", async () => {
    const w = workspace();
    const outside = fs.mkdtempSync(join(tmpdir(), "proof-outside-")); dirs.push(outside);
    const outsideSlice = slice(outside, "elsewhere", "01-a");
    // an absolute path outside every registered root
    const abs = await w.show(outsideSlice);
    expect(abs.status).toBe(400);
    expect((await abs.json()).error).toBe("path_escape");
    // a symlink under a registered root that leaves it
    fs.symlinkSync(join(outside, "elsewhere"), join(w.root, "projects/plug/missions/linked"));
    const link = await w.show("linked/slices/01-a");
    expect(link.status).toBe(400);
    expect((await link.json()).error).toBe("path_escape");
    // a symlink under the default root that points into ANOTHER registered root still leaves its own root
    fs.symlinkSync(join(w.root, "projects/plug/missions/plug-only"), join(w.root, "missions/borrowed"));
    const borrowed = await w.show("borrowed/slices/01-a");
    expect(borrowed.status).toBe(400);
    expect((await borrowed.json()).error).toBe("path_escape");
    // ".." out of a root
    expect((await w.show("../../projects/plug/missions/plug-only/slices/01-a")).status).toBe(400);
    // a project directory outside its missions root is not a mission root
    const notMissions = join(w.root, "projects/plug/notes");
    fs.mkdirSync(join(notMissions, "slices", "01-a"), { recursive: true });
    expect((await w.show(join(notMissions, "slices", "01-a"))).status).toBe(400);
    // nothing was judged through any of them
    expect((await w.judge(outsideSlice, outsideSlice)).status).toBe(400);
    expect(fs.existsSync(join(outsideSlice, "proof/judgments"))).toBe(false);
  });

  it("reports a scope that exists nowhere as scope_missing", async () => {
    const w = workspace();
    const res = await w.show("nowhere/slices/01-a");
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("scope_missing");
  });

  it("reads the catalog through the daemon's settings (workspace.root), as it does in production", async () => {
    const w = workspace();
    const app = new Hono();
    const settingsStore = { resolveOne: (key: string) => ({ value: key === "workspace.root" ? w.root : undefined }) };
    app.use("*", async (c, next) => {
      c.set("settingsStore" as never, settingsStore as never);
      c.set("sliceIndexer" as never, { isReady: () => true, slicesRoot: join(w.root, "missions"), invalidate() {} } as never);
      await next();
    });
    app.route("/api/proof", proofRoutes());
    expect((await app.request("/api/proof?scope=plug-only/slices/01-a")).status).toBe(200);
    expect((await app.request("/api/proof?scope=default-m/slices/01-a")).status).toBe(200);
    expect((await app.request("/api/proof?scope=omarchy-rigs/slices/01-a")).status).toBe(409);
  });

  // The catalog is read the same way with and without a settings store: custom missions.root is
  // honoured and an invalid project manifest contributes no root, on both paths.
  describe.each([["with a settings store", true], ["without a settings store", false]])("project manifests, %s", (_name, withStore) => {
    function manifests() {
      const w = workspace();
      const customProject = join(w.root, "projects/custom"), badProject = join(w.root, "projects/bad");
      write(join(customProject, "project.yaml"), { kind: "project", metadata: { id: "custom" }, proofPolicy: { judges: ["judge@rig"] }, missions: { root: "work/missions" } });
      write(join(customProject, "SPEC.md"), "# custom\n");
      write(join(badProject, "project.yaml"), { kind: "project", metadata: { id: "bad" }, proofPolicy: { judges: ["judge@rig"] }, missions: { root: "../outside" } });
      write(join(badProject, "SPEC.md"), "# bad\n");
      write(join(w.root, "workspace.yaml"), { schema: "openrig.workspace/v0alpha1", projects: [
        { id: "default", root: "." }, { id: "plug", root: "projects/plug" }, { id: "themes", root: "projects/themes" },
        { id: "custom", root: "projects/custom" }, { id: "bad", root: "projects/bad" },
      ] });
      const customSlice = slice(join(customProject, "work/missions"), "custom-m", "01-a");
      const badSlice = slice(join(badProject, "missions"), "bad-m", "01-a"); // default-shaped dir the manifest does not allow
      const app = new Hono();
      const settingsStore = { resolveOne: (key: string) => ({ value: key === "workspace.root" ? w.root : undefined }) };
      app.use("*", async (c, next) => {
        if (withStore) c.set("settingsStore" as never, settingsStore as never);
        c.set("sliceIndexer" as never, { isReady: () => true, slicesRoot: join(w.root, "missions"), invalidate() {} } as never);
        await next();
      });
      app.route("/api/proof", proofRoutes());
      return { w, customSlice, badSlice, show: (scope: string) => app.request(`/api/proof?scope=${encodeURIComponent(scope)}`) };
    }
    it("honours a project's custom missions.root", async () => {
      const m = manifests();
      expect((await m.show("custom-m/slices/01-a")).status).toBe(200);
      expect((await m.show(m.customSlice)).status).toBe(200);
    });
    it("gives a project with an invalid missions.root no mission root, even if a missions/ folder exists", async () => {
      const m = manifests();
      const res = await m.show("bad-m/slices/01-a");
      expect(res.status).toBe(404);
      expect((await res.json()).error).toBe("scope_missing");
      expect((await m.show(m.badSlice)).status).toBe(400);
    });
    it("still serves the other projects", async () => {
      const m = manifests();
      expect((await m.show("plug-only/slices/01-a")).status).toBe(200);
      expect((await m.show("omarchy-rigs/slices/01-a")).status).toBe(409);
    });
  });
});
