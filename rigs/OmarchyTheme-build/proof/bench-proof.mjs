#!/usr/bin/env -S node --import tsx
// Proof for slice 03-themes-rig, bench seats. Runs the OmarchyTheme-build definition on a PRIVATE
// daemon and tmux server (the repo's hermetic scaffold) with every seat's runtime swapped to `stub`,
// and drives it with the exact commands CULTURE.md gives the orchestrator. It never touches the daemon
// or tmux you run on, ~/.openrig or ~/.config/omarchy.
//
//   node --import tsx rigs/OmarchyTheme-build/proof/bench-proof.mjs
//
// A stub proves OpenRig's own plumbing (which seats start, what startup files each seat is handed);
// it does not prove how Claude Code, Codex or pi behave.
import { cpSync, mkdirSync, readFileSync, writeFileSync, existsSync, symlinkSync, readdirSync, rmSync, chmodSync } from "node:fs";
import { execFile } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { prepareHermeticEnv } from "../../../packages/daemon/test/helpers/hermetic-env.ts";
import { spawnScenarioDaemon, runRig } from "../../../packages/daemon/test/helpers/scenario-daemon.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");
const RIG_BIN = join(REPO, "packages/cli/dist/bin-wrapper.js");
const RIG_NAME = "OmarchyTheme-build";
const culture = readFileSync(join(REPO, "rigs", RIG_NAME, "CULTURE.md"), "utf-8");

// The commands, exactly as CULTURE.md spells them. The proof fails if CULTURE.md words one differently.
const CMD = {
  rigId: `RIG_ID=$(rig ps --json | jq -r '.[] | select(.name=="OmarchyTheme-build") | .rigId')`,
  start: (pod, seat) => `rig add "$RIG_ID" ${pod} <(sed "s|WORKDIR|$PWD|" "$RIG_ROOT/bench/${seat}.yaml") --rig-root "$RIG_ROOT"`,
  extra: `rig add "$RIG_ID" dev <(sed -e "s|WORKDIR|$PWD|" -e "s|MODEL|<model>|" -e "s|SEATID|<id>|g" "$RIG_ROOT/bench/extra-builder.yaml") --rig-root "$RIG_ROOT"`,
  stop: (id) => `rig seat stop ${id}@OmarchyTheme-build --reason "<why>"`,
  restart: (id) => `rig seat launch ${id}@OmarchyTheme-build --fresh --reason "<why>"`,
  remove: `rig remove "$RIG_ID" dev.<id>`,
  count: `rig ps --nodes --rig OmarchyTheme-build --json | jq -r '.[] | select(.sessionStatus=="running") | .logicalId' | grep -cE '^(dev\\.(fable|codex|qwen|extra.*))$'`,
  queueDest: (id) => `rig queue list --destination ${id}@OmarchyTheme-build --json`,
  queueSrc: (id) => `rig queue list --source ${id}@OmarchyTheme-build --json`,
};

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -- " + detail : ""}`);
  if (!ok) failed++;
};

const scaffold = prepareHermeticEnv({ baseEnv: { HOME: process.env.HOME, PATH: process.env.PATH, TERM: "xterm" } });
const root = join(scaffold.root, "stage");
const rigDir = join(root, "rigs", RIG_NAME);
mkdirSync(join(root, "rigs"), { recursive: true });
cpSync(join(REPO, "rigs", RIG_NAME), rigDir, { recursive: true, filter: (p) => !p.includes("/proof") });
symlinkSync(join(REPO, "packages"), join(root, "packages"));

// Every seat runs as a stub with its own working folder (the stub writes AGENTS.md in the seat's
// folder, which is where this proof reads what the seat was handed). Models stay as authored.
const cwdOf = (id) => { const d = join(scaffold.root, "cwd", id); mkdirSync(d, { recursive: true }); return d; };
const rewrite = (path, fn) => { const doc = parse(readFileSync(path, "utf-8")); fn(doc); writeFileSync(path, stringify(doc)); };
const authoredRig = {};
rewrite(join(rigDir, "rig.yaml"), (doc) => {
  for (const pod of doc.pods) for (const m of pod.members) { authoredRig[`${pod.id}.${m.id}`] = m.runtime; m.runtime = "stub"; m.cwd = cwdOf(`${pod.id}-${m.id}`); }
});
// Fragments keep their WORKDIR/MODEL/ID placeholders (the commands fill them); only the runtime is
// swapped, with a line-level edit so the placeholders survive. The authored runtimes are recorded first.
const declared = {};
for (const f of readdirSync(join(rigDir, "bench")).filter((f) => f.endsWith(".yaml"))) {
  const p = join(rigDir, "bench", f);
  const text = readFileSync(p, "utf-8");
  declared[f] = text.match(/^ {2}runtime: (.*)$/m)?.[1];
  writeFileSync(p, text.replace(/^ {2}runtime: .*$/m, "  runtime: stub"));
}

const daemon = await spawnScenarioDaemon(scaffold, { rigBin: RIG_BIN });
const binDir = join(scaffold.root, "rigbin");
mkdirSync(binDir);
writeFileSync(join(binDir, "rig"), `#!/bin/sh\nexec node ${JSON.stringify(RIG_BIN)} "$@"\n`);
chmodSync(join(binDir, "rig"), 0o755);
const shellEnv = { ...daemon.readEnv, PATH: `${binDir}:${daemon.readEnv.PATH}`, RIG_ROOT: rigDir };
const sh = (cmd, cwd) => new Promise((res) => {
  const env = Object.fromEntries(Object.entries(shellEnv).filter(([, v]) => v !== undefined));
  execFile("bash", ["-c", cmd], { env, cwd, timeout: 90_000 }, (err, stdout, stderr) => res({ code: err ? (err.code ?? 1) : 0, stdout, stderr }));
});
const rig = (...args) => runRig(args, daemon.readEnv, RIG_BIN, 60_000);
const rigJson = async (...args) => { const r = await rig(...args, "--json"); try { return { ...r, json: JSON.parse(r.stdout) }; } catch { return { ...r, json: null }; } };
const psNodes = async () => (await rigJson("ps", "--nodes", "--rig", RIG_NAME)).json ?? [];
const capture = async (session) => (await rig("capture", session, "--lines", "400")).stdout;
const agentsMd = (podMember) => { const p = join(scaffold.root, "cwd", podMember, "AGENTS.md"); return existsSync(p) ? readFileSync(p, "utf-8") : ""; };
const names = (ns) => ns.map((n) => n.canonicalSessionName).sort();

try {
  for (const c of [CMD.rigId, CMD.start("dev", "<seat>"), CMD.extra, CMD.stop("<id>"), CMD.restart("<id>"), CMD.remove, CMD.count, CMD.queueDest("<id>"), CMD.queueSrc("<id>")]) {
    check(`CULTURE.md carries the command verbatim: ${c.slice(0, 60)}...`, culture.includes(c));
  }

  const planDir = join(scaffold.root, "plan-cwd"); mkdirSync(planDir);
  const up = await rig("up", join(rigDir, "rig.yaml"), "--cwd", planDir, "--json");
  check("rig up (stub runtimes) succeeds", up.code === 0, up.stderr.trim().slice(0, 200));

  const idRes = await sh(`${CMD.rigId}; echo "$RIG_ID"`, planDir);
  const rigId = idRes.stdout.trim();
  check("the rig id lookup in CULTURE.md finds the rig by its capitalised name", /^[0-9A-Z]{26}$/.test(rigId), rigId || idRes.stderr);
  shellEnv.RIG_ID = rigId;

  let nodes = await psNodes();
  console.log("after up:", names(nodes).join(", "));
  const always = ["art.director", "dev.builder", "dev.qa", "dev.sonnet", "orch.lead"];
  check("exactly the five always-on seats exist after up", JSON.stringify(nodes.map((n) => n.logicalId).sort()) === JSON.stringify(always));
  check("no bench seat is running after up", !nodes.some((n) => /fable|qwen|codex/.test(n.logicalId)));
  check("session names keep the rig's capitals", nodes.every((n) => n.canonicalSessionName.endsWith(`@${RIG_NAME}`)));

  // Baseline: what an always-on seat is handed.
  check("always-on dev.builder was handed the rig's culture", readFileSync(join(planDir, "AGENTS.md"), "utf-8").includes("OmarchyTheme-build culture"));
  check("always-on dev.builder was handed its role guidance", /# Role: Implementer/.test(await capture(`dev-builder@${RIG_NAME}`)));

  // The art director: planned on the custom agent, culture and its own role guidance delivered at start.
  const adPane = await capture(`art-director@${RIG_NAME}`);
  check("art.director is planned on the custom art-director agent", /agent_spec: art-director/.test(adPane), (adPane.match(/agent_spec: .*/) ?? [""])[0]);
  check("art.director was handed its role guidance at start", /# Art director: role/.test(adPane));
  check("art.director was handed the rig's culture", readFileSync(join(planDir, "AGENTS.md"), "utf-8").includes("OmarchyTheme-build culture"));
  check("art.director's role guidance is the committed file", adPane.replace(/\s+/g, "").includes(readFileSync(join(REPO, "rigs", RIG_NAME, "agents/art-director/guidance/role.md"), "utf-8").split("\n").filter(Boolean)[1].replace(/\s+/g, "").slice(0, 60)));

  const roleMarker = { fable: /# Role: Implementer/, qwen: /# Role: Implementer/, codex: /# Role: Implementer/ };
  const bench = [["dev", "fable"], ["dev", "qwen"], ["dev", "codex"]];
  for (const [pod, id] of bench) {
    const r = await sh(CMD.start(pod, id), cwdOf(`${pod}-${id}`));
    check(`start ${pod}.${id} with the CULTURE.md command`, r.code === 0, (r.stdout + r.stderr).trim().split("\n").slice(0, 3).join(" | "));
    check(`${pod}.${id} was handed the rig's culture`, agentsMd(`${pod}-${id}`).includes("OmarchyTheme-build culture"));
    check(`${pod}.${id} was handed its role guidance`, roleMarker[id].test(await capture(`${pod}-${id}@${RIG_NAME}`)));
  }
  nodes = await psNodes();
  console.log("after adds:", names(nodes).join(", "));
  check("session names of started seats keep capitals", nodes.every((n) => n.canonicalSessionName.endsWith(`@${RIG_NAME}`)));

  const count = await sh(CMD.count, planDir);
  check("the running-bench count command sees the three started bench seats", count.stdout.trim() === "3", count.stdout.trim() + count.stderr.trim());

  // Negative control: the same fragment WITHOUT its startup entry gets no rig culture (trap 1 in the
  // mission NOTES). The startup entry in bench/*.yaml is what delivers CULTURE.md.
  const bare = join(scaffold.root, "bare.yaml");
  writeFileSync(bare, stringify({ member: { id: "bare", agent_ref: "local:../../packages/daemon/specs/agents/development/implementer", runtime: "stub", profile: "default", cwd: cwdOf("dev-bare") } }));
  const bareAdd = await rigJson("add", rigId, "dev", bare, "--rig-root", rigDir);
  check("control: a seat added without the startup entry lacks the rig's culture", bareAdd.code === 0 && !agentsMd("dev-bare").includes("OmarchyTheme-build culture") && agentsMd("dev-bare").includes("OpenRig default culture"));

  nodes = await psNodes();
  const modelOf = (id) => nodes.find((n) => n.logicalId === id)?.model;
  const want = [["orch.lead", "opus"], ["art.director", "claude-fable-5-1"], ["dev.builder", "opus"], ["dev.sonnet", "sonnet"], ["dev.qa", "sonnet"], ["dev.fable", "claude-fable-5-1"], ["dev.qwen", "macllm/mlx-community/Qwen3.6-35B-A3B-4bit"]];
  check("recorded models match the seat table", want.every(([id, m]) => modelOf(id) === m) && modelOf("dev.codex") == null, JSON.stringify(Object.fromEntries(nodes.map((n) => [n.logicalId, n.model]))));
  const wantRt = { "orch.lead": "claude-code", "art.director": "claude-code", "dev.builder": "claude-code", "dev.sonnet": "claude-code", "dev.qa": "claude-code" };
  check("authored runtimes of the always-on seats match the seat table (QA is Claude Code)", Object.entries(wantRt).every(([id, r]) => authoredRig[id.replace(".", ".")] === r), JSON.stringify(authoredRig));
  check("authored runtimes of the bench match the seat table", declared["fable.yaml"] === "claude-code" && declared["qwen.yaml"] === "pi" && declared["codex.yaml"] === "codex", JSON.stringify(declared));

  // Stop, then restart the way CULTURE.md says. The delivered file is removed first so a pass means
  // the culture was handed over again, not left over from the first start.
  const qd = await sh(CMD.queueDest("dev-fable"), planDir);
  const qs = await sh(CMD.queueSrc("dev-fable"), planDir);
  check("the queue checks before a stop print [] for a seat with no rows", qd.code === 0 && qs.code === 0 && qd.stdout.trim() === "[]" && qs.stdout.trim() === "[]", qd.stdout.trim().slice(0, 80) + qs.stderr.trim().slice(0, 120));
  const stop = await sh(CMD.stop("dev-fable").replace("<why>", "proof").replace("dev-fable@", "dev-fable@"), planDir);
  check("stop dev.fable with the CULTURE.md command", stop.code === 0, (stop.stdout + stop.stderr).trim().slice(0, 200));
  nodes = await psNodes();
  const stopped = nodes.find((n) => n.logicalId === "dev.fable");
  check("the stopped seat is still in the rig, not running", !!stopped && stopped.sessionStatus !== "running", JSON.stringify({ s: stopped?.sessionStatus }));
  rmSync(join(scaffold.root, "cwd", "dev-fable", "AGENTS.md"), { force: true });
  const restart = await sh(CMD.restart("dev-fable").replace("<why>", "proof"), planDir);
  check("restart dev.fable with the CULTURE.md command", restart.code === 0, (restart.stdout + restart.stderr).trim().slice(0, 200));
  nodes = await psNodes();
  check("the restarted seat is running", nodes.find((n) => n.logicalId === "dev.fable")?.sessionStatus === "running");
  check("the restarted seat was handed the culture again", agentsMd("dev-fable").includes("OmarchyTheme-build culture"));
  check("the restarted seat was handed its role guidance again", /# Role: Implementer/.test(await capture(`dev-fable@${RIG_NAME}`)));

  // Extra builder from the template, on a chosen model, then removed.
  const extraCmd = CMD.extra.replace("<model>", "sonnet").replace("<id>", "extra1");
  const extra = await sh(extraCmd, cwdOf("dev-extra1"));
  check("add an extra builder from the template with the CULTURE.md command", extra.code === 0, (extra.stdout + extra.stderr).trim().split("\n").slice(0, 3).join(" | "));
  nodes = await psNodes();
  check("the extra builder is on the chosen model", nodes.find((n) => n.logicalId === "dev.extra1")?.model === "sonnet");
  check("the extra builder was handed the culture", agentsMd("dev-extra1").includes("OmarchyTheme-build culture"));
  check("the extra builder was handed its role guidance", /# Role: Implementer/.test(await capture(`dev-extra1@${RIG_NAME}`)));
  const rm = await sh(CMD.remove.replace("<id>", "extra1"), planDir);
  check("remove the extra builder with the CULTURE.md command", rm.code === 0, (rm.stdout + rm.stderr).trim().slice(0, 200));
  check("the extra builder is gone and the core seats remain", !(await psNodes()).some((n) => n.logicalId === "dev.extra1") && (await psNodes()).some((n) => n.logicalId === "dev.builder"));
} finally {
  await daemon.stop().catch(() => {});
}
console.log(failed === 0 ? "\nALL CHECKS PASSED" : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
