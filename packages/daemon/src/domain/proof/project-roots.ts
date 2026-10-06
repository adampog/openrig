import * as fs from "node:fs";
import * as path from "node:path";
import { listProjects } from "../workspace/project-read.js";
import type { SettingsStore } from "../user-settings/settings-store.js";
import type { ProofRoot } from "./judgments.js";

type Ctx = { get: (key: never) => unknown };

/**
 * The mission roots the proof surface may address: the daemon's primary missions root first,
 * then the missions root of every project registered in workspace.yaml (the same catalog
 * `rig context work-install` reads). Roots are real paths, de-duplicated; a project whose root or
 * manifest is unreadable, or whose missions root does not exist, contributes nothing.
 */
export function proofMissionRoots(c: Ctx, primary: string): ProofRoot[] {
  const real = (p: string) => { try { return fs.realpathSync(p); } catch { return null; } };
  const roots: ProofRoot[] = [];
  const add = (id: string, root: string) => {
    const resolved = real(root);
    if (!resolved || !fs.statSync(resolved).isDirectory() || roots.some(r => r.root === resolved)) return;
    roots.push({ id, root: resolved });
  };
  const projects: Array<{ id: string; missionsRoot: string }> = [];
  try {
    // One reader for both cases: the daemon's own project read (listProjects), so manifest
    // identity, missions.root, SPEC and containment rules are the same whether or not a settings
    // store is present. Without one (tests, minimal hosts) the workspace is the primary root's
    // parent, which is where the catalog lives.
    const store = (c.get("settingsStore" as never) as SettingsStore | undefined)
      ?? { resolveOne: (key: string) => ({ value: key === "workspace.root" ? path.dirname(primary) : undefined }) } as unknown as SettingsStore;
    projects.push(...listProjects({ get: () => store }).projects.filter(p => !p.error));
  } catch { /* A broken catalog leaves the primary root, exactly as before. */ }
  const primaryReal = real(primary);
  const primaryId = projects.find(p => real(p.missionsRoot) === primaryReal)?.id ?? "workspace";
  add(primaryId, primary);
  for (const p of projects) add(p.id, p.missionsRoot);
  return roots;
}
