import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scopeCommand } from "../src/commands/scope.js";
import { proofCommand } from "../src/commands/proof.js";

let root: string;
let project: string;
const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
function mission(base: string, name = "plugin-proof") {
  const dir = path.join(base, "missions", name);
  write(path.join(dir, "SPEC.md"), "---\nid: OPR.99.0.1\n---\n# Mission\n");
  write(path.join(dir, "slices/01-label/SPEC.md"), "---\nid: OPR.99.0.1.1\n---\n# Label\n");
  return dir;
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cli-project-roots-"));
  project = path.join(root, "projects/plugins");
  fs.mkdirSync(path.join(root, "missions"));
  write(path.join(project, "SPEC.md"), "# Plugins\n");
  write(path.join(project, "project.yaml"), "id: plugins\n");
  write(path.join(root, "workspace.yaml"), "projects:\n  - id: plugins\n    root: projects/plugins\n    rigs: [OmarchyPlugin-build]\n");
  mission(project);
  vi.stubEnv("OPENRIG_WORKSPACE_ROOT", root);
  vi.stubEnv("OPENRIG_WORKSPACE_SLICES_ROOT", path.join(root, "missions"));
  vi.stubEnv("OPENRIG_WORKSPACE_CATALOG_PATH", path.join(root, "workspace.yaml"));
  vi.stubEnv("OPENRIG_SESSION_NAME", "dev-codex@OmarchyPlugin-build");
});
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs(); process.exitCode = undefined;
  fs.rmSync(root, { recursive: true, force: true });
});
async function run(kind: "scope" | "proof", args: string[]) {
  let output = "";
  vi.spyOn(console, "log").mockImplementation((...s: unknown[]) => { output += s.join(" ") + "\n"; });
  vi.spyOn(console, "error").mockImplementation((...s: unknown[]) => { output += s.join(" ") + "\n"; });
  vi.spyOn(process.stdout, "write").mockImplementation(((s: unknown) => { output += String(s); return true; }) as typeof process.stdout.write);
  vi.spyOn(process.stderr, "write").mockImplementation(((s: unknown) => { output += String(s); return true; }) as typeof process.stderr.write);
  vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("fixture-exit"); }) as typeof process.exit);
  const command = kind === "scope" ? scopeCommand() : proofCommand();
  let failed = false;
  try { await command.parseAsync(["node", kind, ...args]); }
  catch (err) { if ((err as Error).message !== "fixture-exit") throw err; failed = true; }
  failed ||= process.exitCode === 1;
  vi.restoreAllMocks(); process.exitCode = undefined;
  return { failed, output };
}
it.each([
  ["mission", "show", "plugin-proof"],
  ["mission", "graph", "plugin-proof"],
  ["slice", "ls", "--mission", "plugin-proof"],
  ["slice", "show", "01-label", "--mission", "plugin-proof"],
  ["slice", "show", "plugin-proof/slices/01-label"],
])("resolves registered project via scope %s %s", async (...args) => {
  const result = await run("scope", [...args, "--json"]);
  expect(result.failed, result.output).toBe(false);
  expect(result.output).not.toContain('"ok": false');
});
it("audit reads a registered mission and reports its actual missing rails", async () => {
  const result = await run("scope", ["audit", "--mission", "plugin-proof", "--json"]);
  const report = JSON.parse(result.output);
  expect(report.error).toBeUndefined();
  expect(report.mission.name).toBe("plugin-proof");
  expect(report.mission.findings.some((f: { path: string }) => f.path === path.join(project, "missions/plugin-proof"))).toBe(true);
});
it("proof add writes evidence under the project without --workspace", async () => {
  const result = await run("proof", ["add", "01-label", "--mission", "plugin-proof", "--artifact-type", "qa", "--verdict", "CLEAR", "--candidate-sha", "abc1234", "--money-evidence", "label visible", "--body", "observed label", "--name", "qa.md", "--json"]);
  expect(result.failed, result.output).toBe(false);
  expect(fs.readFileSync(path.join(project, "missions/plugin-proof/slices/01-label/proof/qa.md"), "utf8")).toContain("observed label");
  expect(fs.readdirSync(path.join(root, "missions"))).toEqual([]);
});
it("refuses duplicate mission names and lists project ids and paths", async () => {
  mission(root);
  const result = await run("scope", ["mission", "show", "plugin-proof", "--json"]);
  expect(result.failed).toBe(true);
  expect(result.output).toContain("ambiguous");
  expect(result.output).toContain("plugins");
  expect(result.output).toContain(path.join(project, "missions"));
  expect(result.output).toContain(path.join(root, "missions"));
});
it("explicit --workspace selects a duplicate and absolute slice paths disambiguate", async () => {
  mission(root);
  const explicit = await run("scope", ["--workspace", project, "mission", "show", "plugin-proof", "--json"]);
  expect(explicit.failed, explicit.output).toBe(false);
  expect(JSON.parse(explicit.output).mission.path).toBe(path.join(project, "missions/plugin-proof"));
  const absolute = await run("scope", ["slice", "show", path.join(project, "missions/plugin-proof/slices/01-label"), "--json"]);
  expect(absolute.failed, absolute.output).toBe(false);
});
it("uses manifest missions.root", async () => {
  fs.renameSync(path.join(project, "missions"), path.join(project, "work"));
  write(path.join(project, "project.yaml"), "id: plugins\nmissions:\n  root: work\n");
  const result = await run("scope", ["mission", "show", "plugin-proof", "--json"]);
  expect(result.failed, result.output).toBe(false);
  expect(JSON.parse(result.output).mission.path).toBe(path.join(project, "work/plugin-proof"));
});
it("broken catalog falls back to default missions and new missions stay there", async () => {
  mission(root, "central");
  write(path.join(root, "workspace.yaml"), "projects: [broken\n");
  expect((await run("scope", ["mission", "show", "central", "--json"])).failed).toBe(false);
  write(path.join(root, "workspace.yaml"), "projects:\n  - id: plugins\n    root: projects/plugins\n");
  const result = await run("scope", ["mission", "create", "new-work", "--json"]);
  expect(result.failed, result.output).toBe(false);
  expect(fs.existsSync(path.join(root, "missions/new-work/SPEC.md"))).toBe(true);
  expect(fs.existsSync(path.join(project, "missions/new-work"))).toBe(false);
});
it("refuses a project mission or slice symlink escaping its registered mission root", async () => {
  const outside = path.join(root, "outside");
  mission(outside, "escape");
  fs.symlinkSync(path.join(outside, "missions/escape"), path.join(project, "missions/escape"));
  const result = await run("scope", ["mission", "show", "escape", "--json"]);
  expect(result.failed).toBe(true);
  const slice = path.join(project, "missions/plugin-proof/slices/02-escape");
  fs.symlinkSync(path.join(outside, "missions/escape/slices/01-label"), slice);
  expect((await run("scope", ["slice", "show", slice, "--json"])).failed).toBe(true);
});
it("refuses project-root approval before daemon access, even with explicit workspace", async () => {
  const result = await run("scope", ["--workspace", project, "mission", "approve", "plugin-proof", "--json"]);
  expect(result.failed).toBe(true);
  expect(result.output).toContain("project-root scopes");
  expect(result.output).toContain("central");
});
it.each(["mission", "slice"] as const)("refuses implicit project-root %s approval without stamping the central folder", async tier => {
  const args = tier === "mission" ? ["plugin-proof"] : ["01-label", "--mission", "plugin-proof"];
  const result = await run("scope", [tier, "approve", ...args, "--json"]);
  expect(result.output).toContain("project-root scopes");
  expect(result.failed).toBe(true);
  expect(fs.readFileSync(path.join(project, "missions/plugin-proof/SPEC.md"), "utf8")).not.toContain("approved");
});
it.each(["mission", "slice"] as const)("updates %s progress, stage, verified and repair within the registered project", async tier => {
  const target = tier === "mission" ? ["plugin-proof"] : ["01-label", "--mission", "plugin-proof"];
  const dir = path.join(project, "missions/plugin-proof", tier === "mission" ? "" : "slices/01-label");
  expect((await run("scope", [tier, "repair", ...target, "--json"])).failed).toBe(false);
  const progress = await run("scope", [tier, "progress", ...target, "--add", "Visible project outcome", "--json"]);
  expect(progress.failed, progress.output).toBe(false);
  expect(fs.readFileSync(path.join(dir, "PROGRESS.md"), "utf8")).toContain("Visible project outcome");
  const stage = await run("scope", [tier, "stage", ...target, "provisional", "--json"]);
  expect(stage.failed, stage.output).toBe(false);
  expect(fs.readFileSync(path.join(dir, "SPEC.md"), "utf8")).toContain("stage: provisional");
  const verified = await run("scope", [tier, "verified", ...target, "--against", "isolated fixture", "--json"]);
  expect(verified.failed, verified.output).toBe(false);
  expect(fs.readFileSync(path.join(dir, "SPEC.md"), "utf8")).toContain("isolated fixture");
  expect(fs.readdirSync(path.join(root, "missions"))).toEqual([]);
});
it("creates a slice under an existing project mission and closes it there", async () => {
  const created = await run("scope", ["slice", "create", "plugin-proof", "second", "--json"]);
  expect(created.failed, created.output).toBe(false);
  expect(fs.existsSync(path.join(project, "missions/plugin-proof/slices/02-second/SPEC.md"))).toBe(true);
  const closed = await run("scope", ["slice", "close", "02-second", "--mission", "plugin-proof", "--reason", "deferred", "--json"]);
  expect(closed.failed, closed.output).toBe(false);
  expect(fs.existsSync(path.join(project, "missions/plugin-proof/closed/02-second/SPEC.md"))).toBe(true);
});
it.each(["move", "ship"])("resolves both source and destination project missions for slice %s", async verb => {
  const destination = mission(root, "destination");
  const result = await run("scope", ["slice", verb, "01-label", "destination", "--mission", "plugin-proof", "--json"]);
  expect(result.failed, result.output).toBe(false);
  expect(fs.existsSync(path.join(project, "missions/plugin-proof/slices/01-label"))).toBe(false);
  expect(fs.existsSync(path.join(destination, "slices/02-label/SPEC.md"))).toBe(true);
});
it("refuses duplicate slice targets before proof writes", async () => {
  mission(root);
  const result = await run("proof", ["add", "01-label", "--mission", "plugin-proof", "--artifact-type", "qa", "--verdict", "CLEAR", "--candidate-sha", "abc1234", "--money-evidence", "label visible", "--body", "observed", "--name", "qa.md", "--json"]);
  expect(result.failed).toBe(true);
  expect(result.output).toContain("ambiguous");
  expect(result.output).toContain("plugins");
  expect(fs.existsSync(path.join(project, "missions/plugin-proof/slices/01-label/proof"))).toBe(false);
  expect(fs.existsSync(path.join(root, "missions/plugin-proof/slices/01-label/proof"))).toBe(false);
});
it("rejects escaping sources even with explicit workspace and in audit", async () => {
  const dir = path.join(project, "missions/plugin-proof");
  fs.unlinkSync(path.join(dir, "SPEC.md"));
  write(path.join(root, "outside.md"), "# Outside\n");
  fs.symlinkSync(path.join(root, "outside.md"), path.join(dir, "SPEC.md"));
  const result = await run("scope", ["--workspace", project, "audit", "--mission", "plugin-proof", "--json"]);
  expect(result.failed).toBe(true);
  expect(result.output).toContain("escapes");
});
it("deduplicates real root aliases and works without a primary missions directory", async () => {
  fs.rmdirSync(path.join(root, "missions"));
  fs.symlinkSync(project, path.join(root, "alias"));
  fs.unlinkSync(path.join(project, "project.yaml"));
  write(path.join(root, "workspace.yaml"), "projects:\n  - id: plugins\n    root: projects/plugins\n  - id: alias\n    root: alias\n");
  const result = await run("scope", ["mission", "show", "plugin-proof", "--json"]);
  expect(result.failed, result.output).toBe(false);
});
it("resolves catalog-relative paths from a separately configured catalog", async () => {
  const catalog = path.join(root, "registry/catalog.yaml");
  write(catalog, "projects:\n  - id: plugins\n    root: ../projects/plugins\n");
  vi.stubEnv("OPENRIG_WORKSPACE_CATALOG_PATH", catalog);
  const result = await run("scope", ["mission", "show", "plugin-proof", "--json"]);
  expect(result.failed, result.output).toBe(false);
  expect(JSON.parse(result.output).mission.path).toBe(path.join(project, "missions/plugin-proof"));
});
it("legacy work-root override cannot bypass the project approval refusal", async () => {
  vi.stubEnv("OPENRIG_WORK_ROOT", project);
  const result = await run("scope", ["mission", "approve", "plugin-proof", "--json"]);
  expect(result.failed).toBe(true);
  expect(result.output).toContain("project-root scopes");
});
it("an absolute target under nested registered roots is one scope with the deepest mission context", async () => {
  const nested = path.join(root, "missions/embedded");
  write(path.join(nested, "SPEC.md"), "# Embedded project\n");
  write(path.join(nested, "project.yaml"), "id: nested\n");
  const dir = mission(nested, "nested-proof");
  write(path.join(root, "workspace.yaml"), "projects:\n  - id: nested\n    root: missions/embedded\n");
  const result = await run("scope", ["slice", "show", path.join(dir, "slices/01-label"), "--json"]);
  expect(result.failed, result.output).toBe(false);
  expect(JSON.parse(result.output).slice.mission).toBe("nested-proof");
});
it("slice creation refuses an escaping slices parent before writing anything", async () => {
  const dir = path.join(project, "missions/plugin-proof");
  fs.rmSync(path.join(dir, "slices"), { recursive: true });
  const outside = path.join(root, "outside");
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(dir, "slices"));
  const original = fs.readFileSync(path.join(dir, "SPEC.md"), "utf8");
  const result = await run("scope", ["slice", "create", "plugin-proof", "escape-write", "--json"]);
  expect(result.failed, result.output).toBe(true);
  expect(fs.readdirSync(outside)).toEqual([]);
  expect(fs.readFileSync(path.join(dir, "SPEC.md"), "utf8")).toBe(original);
});
it("proof add refuses an escaping proof directory", async () => {
  const outside = path.join(root, "outside");
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(project, "missions/plugin-proof/slices/01-label/proof"));
  const result = await run("proof", ["add", "01-label", "--mission", "plugin-proof", "--artifact-type", "qa", "--verdict", "CLEAR", "--candidate-sha", "abc1234", "--money-evidence", "label visible", "--body", "observed", "--name", "qa.md", "--json"]);
  expect(result.failed, result.output).toBe(true);
  expect(fs.readdirSync(outside)).toEqual([]);
});
it("progress refuses an escaping progress file", async () => {
  const outside = path.join(root, "outside.md");
  write(outside, "# Progress\n");
  fs.symlinkSync(outside, path.join(project, "missions/plugin-proof/PROGRESS.md"));
  const result = await run("scope", ["mission", "progress", "plugin-proof", "--add", "Must stay inside", "--json"]);
  expect(result.failed, result.output).toBe(true);
  expect(fs.readFileSync(outside, "utf8")).toBe("# Progress\n");
});
it.each(["move", "ship", "close"])("slice %s refuses an escaping destination parent", async verb => {
  const dir = verb === "close" ? path.join(project, "missions/plugin-proof") : mission(root, "destination");
  const bucket = path.join(dir, verb === "close" ? "closed" : "slices");
  fs.rmSync(bucket, { recursive: true, force: true });
  const outside = path.join(root, "outside"); fs.mkdirSync(outside);
  fs.symlinkSync(outside, bucket);
  const args = verb === "close" ? ["--reason", "deferred"] : ["destination"];
  const result = await run("scope", ["slice", verb, "01-label", ...args, "--mission", "plugin-proof", "--json"]);
  expect(result.failed, result.output).toBe(true);
  expect(fs.readdirSync(outside)).toEqual([]);
  expect(fs.existsSync(path.join(project, "missions/plugin-proof/slices/01-label/SPEC.md"))).toBe(true);
});
it("mission repair refuses an escaping slices directory before any repair writes", async () => {
  const dir = path.join(project, "missions/plugin-proof");
  fs.rmSync(path.join(dir, "slices"), { recursive: true });
  const outside = path.join(root, "outside");
  const externalMission = mission(outside);
  fs.symlinkSync(path.join(externalMission, "slices"), path.join(dir, "slices"));
  const result = await run("scope", ["mission", "repair", "plugin-proof", "--json"]);
  expect(result.failed, result.output).toBe(true);
  expect(fs.existsSync(path.join(externalMission, "slices/01-label/PROGRESS.md"))).toBe(false);
  expect(fs.existsSync(path.join(dir, "PROGRESS.md"))).toBe(false);
});
it("a dangling slices-directory symlink is refused without creating its target", async () => {
  const dir = path.join(project, "missions/plugin-proof");
  fs.rmSync(path.join(dir, "slices"), { recursive: true });
  const outside = path.join(root, "not-created");
  fs.symlinkSync(outside, path.join(dir, "slices"));
  const result = await run("scope", ["slice", "create", "plugin-proof", "escape", "--json"]);
  expect(result.failed, result.output).toBe(true);
  expect(fs.existsSync(outside)).toBe(false);
});
it("a moved source symlink outside its new root is refused and the move rolled back", async () => {
  const source = path.join(project, "missions/plugin-proof/slices/01-label/SPEC.md");
  const shared = path.join(project, "missions/plugin-proof/shared.md");
  const original = fs.readFileSync(source, "utf8");
  write(shared, original);
  fs.unlinkSync(source); fs.symlinkSync(shared, source);
  const destination = mission(root, "destination");
  const result = await run("scope", ["slice", "move", "01-label", "destination", "--mission", "plugin-proof", "--json"]);
  expect(result.failed, result.output).toBe(true);
  expect(fs.existsSync(source)).toBe(true);
  expect(fs.existsSync(path.join(destination, "slices/02-label"))).toBe(false);
  expect(fs.readFileSync(shared, "utf8")).toBe(original);
});
