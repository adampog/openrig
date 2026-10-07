#!/usr/bin/env -S node --import tsx
// Proof for esp32-firmware-rig / 01-rig-definition. Runs this definition on a PRIVATE
// daemon and tmux server (the repo's hermetic scaffold) with every seat's runtime swapped to `stub`,
// and drives it with the exact commands CULTURE.md gives the orchestrator. It never touches the daemon
// or tmux you run on, ~/.openrig, firmware, or hardware.
//
//   node --import tsx rigs/esp32-firmware-build/proof/bench-proof.mjs
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
const RIG_NAME = "esp32-firmware-build";
const culture = readFileSync(join(REPO, "rigs", RIG_NAME, "CULTURE.md"), "utf-8");

// The commands, exactly as CULTURE.md spells them. The proof fails if CULTURE.md words one differently.
const CMD = {
  rigId: `RIG_ID=$(rig ps --json | jq -r '.[] | select(.name=="esp32-firmware-build") | .rigId')`,
  start: (pod, seat) => `rig add "$RIG_ID" ${pod} <(sed "s|WORKDIR|$PWD|" "$RIG_ROOT/bench/${seat}.yaml") --rig-root "$RIG_ROOT"`,
  extra: `rig add "$RIG_ID" dev <(sed -e "s|WORKDIR|$PWD|" -e "s|MODEL|<model>|" -e "s|SEATID|<id>|g" "$RIG_ROOT/bench/extra-builder.yaml") --rig-root "$RIG_ROOT"`,
  stop: (id) => `rig seat stop ${id}@esp32-firmware-build --reason "<why>"`,
  restart: (id) => `rig seat launch ${id}@esp32-firmware-build --fresh --reason "<why>"`,
  remove: `rig remove "$RIG_ID" dev.<id>`,
  count: `rig ps --nodes --rig esp32-firmware-build --json | jq -r '.[] | select(.sessionStatus=="running") | .logicalId' | grep -cE "^(dev\\.(fable|codex|qwen|extra.*)|hw\\.expert)$"`,
  startNoView: (pod, seat) => `rig add "$RIG_ID" ${pod} <(sed "s|WORKDIR|$PWD|" "$RIG_ROOT/bench/${seat}.yaml") --rig-root "$RIG_ROOT" --no-view`,
  queueDest: (id) => `rig queue list --destination ${id}@esp32-firmware-build --json`,
  queueSrc: (id) => `rig queue list --source ${id}@esp32-firmware-build --json`,
};

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -- " + detail : ""}`);
  if (!ok) failed++;
};

const scratchBase = join(REPO, "node_modules", ".cache", "fw");
mkdirSync(scratchBase, { recursive: true });
process.env.TMPDIR = scratchBase;
const scaffold = prepareHermeticEnv({ baseEnv: { HOME: process.env.HOME, PATH: process.env.PATH, TERM: "xterm", TMPDIR: scratchBase } });
const root = join(scaffold.root, "stage");
const rigDir = join(root, "rigs", RIG_NAME);
mkdirSync(join(root, "rigs"), { recursive: true });
cpSync(join(REPO, "rigs", RIG_NAME), rigDir, { recursive: true, filter: (p) => !p.includes("/proof") });
symlinkSync(join(REPO, "packages"), join(root, "packages"));

// Every seat runs as a stub with its own working folder (the stub writes AGENTS.md in the seat's
// folder, which is where this proof reads what the seat was handed). Models stay as authored.
const cwdOf = (id) => { const d = join(scaffold.root, "cwd", id); mkdirSync(d, { recursive: true }); return d; };
const rewrite = (path, fn) => { const doc = parse(readFileSync(path, "utf-8")); fn(doc); writeFileSync(path, stringify(doc)); };
rewrite(join(rigDir, "rig.yaml"), (doc) => {
  for (const pod of doc.pods) for (const m of pod.members) { m.runtime = "stub"; m.cwd = cwdOf(`${pod.id}-${m.id}`); }
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
  const always = ["dev.firmware", "dev.qa", "dev.sonnet", "orch.lead"];
  const bench = [["hw", "expert", "opus"], ["dev", "fable", "claude-fable-5-1"], ["dev", "codex", undefined], ["dev", "qwen", "macllm/mlx-community/Qwen3.6-35B-A3B-4bit"]];
  const authored = parse(readFileSync(join(REPO, "rigs", RIG_NAME, "rig.yaml"), "utf-8"));
  const coreModels = { "orch.lead": "opus", "dev.firmware": "opus", "dev.sonnet": "sonnet" };
  check("authored core seats match the mission table", JSON.stringify(authored.pods.flatMap(p => p.members.map(m => `${p.id}.${m.id}`)).sort()) === JSON.stringify(always));
  for (const pod of authored.pods) for (const member of pod.members) {
    check(`authored ${pod.id}.${member.id} runtime/model`, member.runtime === (member.id === "qa" ? "codex" : "claude-code") && member.model === coreModels[`${pod.id}.${member.id}`]);
  }
  // Native spec offline checks: model/runtime fields remain authored, only cwd is scratch.
  // All bench entries are assembled into a staged spec to plan all eight without launching.
  const allSeats = structuredClone(authored);
  for (const pod of allSeats.pods) for (const member of pod.members) member.cwd = cwdOf(`${pod.id}-${member.id}`);
  for (const [pod, id, model] of bench) {
    const fragment = parse(readFileSync(join(REPO, "rigs", RIG_NAME, "bench", `${id}.yaml`), "utf-8"));
    check(`authored ${pod}.${id} runtime/model`, fragment.member.runtime === (id === "codex" ? "codex" : id === "qwen" ? "pi" : "claude-code") && fragment.member.model === model);
    fragment.member.cwd = cwdOf(`${pod}-${id}`);
    allSeats.pods.find(p => p.id === pod).members.push(fragment.member);
    allSeats.pods.find(p => p.id === pod).edges.push(...(fragment.edges ?? []));
  }
  const fullPath = join(rigDir, "all-seats.yaml");
  writeFileSync(fullPath, stringify(allSeats));
  console.log("authored seat manifest:", JSON.stringify(allSeats.pods.flatMap(p => p.members.map(m => ({ id: `${p.id}.${m.id}`, agent: m.agent_ref, runtime: m.runtime, model: m.model ?? null, runs: always.includes(`${p.id}.${m.id}`) ? "always" : "bench" })))));
  for (const verb of ["validate", "audit", "preflight"]) {
    const result = await rigJson("spec", verb, fullPath);
    console.log(`${verb} all authored seats:`, result.stdout.trim(), result.stderr.trim());
    check(`all-eight-seat ${verb} passes`, result.code === 0 && result.json?.[verb === "validate" ? "valid" : verb === "audit" ? "clean" : "ready"] === true);
  }
  const planDir = cwdOf("plan");
  const planned = await rigJson("up", fullPath, "--plan", "--cwd", planDir);
  console.log("all-eight-seat plan:", planned.stdout.trim(), planned.stderr.trim());
  check("all-eight-seat plan exits successfully without launching", planned.code === 0 && planned.json?.status === "planned" && (await psNodes()).length === 0);
  check("plan lists each declared logical seat", [...always, ...bench.map(([pod, id]) => `${pod}.${id}`)].every(id => planned.stdout.includes(id)));
  const corePlan = await rigJson("up", join(REPO, "rigs", RIG_NAME, "rig.yaml"), "--plan", "--cwd", planDir);
  console.log("authored four-seat plan:", corePlan.stdout.trim(), corePlan.stderr.trim());
  check("original four-seat definition plans without launching", corePlan.code === 0 && corePlan.json?.status === "planned" && (await psNodes()).length === 0);

  for (const c of [CMD.rigId, CMD.start("<pod>", "<seat>"), CMD.startNoView("<pod>", "<seat>"), CMD.extra, CMD.stop("<id>"), CMD.restart("<id>"), CMD.remove, CMD.count, CMD.queueDest("<id>"), CMD.queueSrc("<id>")]) {
    check(`culture carries command: ${c.slice(0, 70)}`, culture.includes(c));
  }
  const up = await rig("up", join(rigDir, "rig.yaml"), "--cwd", planDir, "--json");
  check("stub rig starts in a private daemon", up.code === 0, up.stderr.trim());
  const idRes = await sh(`${CMD.rigId}; echo "$RIG_ID"`, planDir);
  const rigId = idRes.stdout.trim();
  check("culture rig-id lookup finds this rig", /^[0-9A-Z]{26}$/.test(rigId), rigId);
  shellEnv.RIG_ID = rigId;
  check("only four always-on seats start", JSON.stringify((await psNodes()).map(n => n.logicalId).sort()) === JSON.stringify(always));
  check("always-on seat receives culture", readFileSync(join(planDir, "AGENTS.md"), "utf-8").includes(`${RIG_NAME} culture`));
  check("default builder receives implementer role", /# Role: Implementer/.test(await capture(`dev-firmware@${RIG_NAME}`)));

  for (const [pod, id, model] of bench) {
    // One bench seat at a time; exercise the documented --no-view variant too.
    const command = id === "codex" ? CMD.startNoView(pod, id) : CMD.start(pod, id);
    const added = await sh(command, cwdOf(`${pod}-${id}`));
    check(`culture command adds ${pod}.${id}`, added.code === 0, (added.stdout + added.stderr).trim().slice(0, 300));
    check(`${pod}.${id} receives culture`, agentsMd(`${pod}-${id}`).includes(`${RIG_NAME} culture`));
    const pane = await capture(`${pod}-${id}@${RIG_NAME}`);
    check(`${pod}.${id} receives builtin role`, (id === "expert" ? /# Role: Research Analyst/ : /# Role: Implementer/).test(pane));
    if (id === "expert") check("hardware expert receives specialist role", /# Role: ESP32 Hardware Specialist/.test(pane));
    const node = (await psNodes()).find(n => n.logicalId === `${pod}.${id}`);
    check(`${pod}.${id} model preserved`, !!node && (model === undefined ? node.model == null : node.model === model), JSON.stringify({ model: node?.model }));
    const count = await sh(CMD.count, planDir);
    check("count sees exactly one running bench seat", count.stdout.trim() === "1", count.stdout.trim());
    for (const queueCommand of [CMD.queueDest(`${pod}-${id}`), CMD.queueSrc(`${pod}-${id}`)]) {
      const q = await sh(queueCommand, planDir);
      check("queue stop precheck is empty", q.code === 0 && q.stdout.trim() === "[]", q.stdout.trim());
    }
    if (id === "fable") {
      const stopped = await sh(CMD.stop("dev-fable").replace("<why>", "proof"), planDir);
      check("culture stop pauses fable", stopped.code === 0 && (await psNodes()).find(n => n.logicalId === "dev.fable")?.sessionStatus !== "running");
      rmSync(join(scaffold.root, "cwd", "dev-fable", "AGENTS.md"), { force: true });
      const restarted = await sh(CMD.restart("dev-fable").replace("<why>", "proof"), planDir);
      check("culture fresh restart runs fable", restarted.code === 0 && (await psNodes()).find(n => n.logicalId === "dev.fable")?.sessionStatus === "running");
      check("fresh restart delivers culture again", agentsMd("dev-fable").includes(`${RIG_NAME} culture`));
      check("fresh restart delivers role again", /# Role: Implementer/.test(await capture(`dev-fable@${RIG_NAME}`)));
    }
    const remove = pod === "hw" ? `rig remove "$RIG_ID" hw.expert` : CMD.remove.replace("<id>", id);
    check("culture carries bench removal command", culture.includes(pod === "hw" ? remove : CMD.remove));
    const removed = await sh(remove, planDir);
    check(`remove ${pod}.${id} after work`, removed.code === 0 && !(await psNodes()).some(n => n.logicalId === `${pod}.${id}`));
  }

  // Negative control pins why every bench fragment has its own culture startup entry.
  const bare = join(scaffold.root, "bare.yaml");
  writeFileSync(bare, stringify({ member: { id: "bare", agent_ref: "local:../../packages/daemon/specs/agents/research/analyst", runtime: "stub", profile: "default", cwd: cwdOf("hw-bare") } }));
  const control = await rigJson("add", rigId, "hw", bare, "--rig-root", rigDir, "--no-view");
  check("control without startup lacks rig culture", control.code === 0 && !agentsMd("hw-bare").includes(`${RIG_NAME} culture`) && agentsMd("hw-bare").includes("OpenRig default culture"));
  await rig("remove", rigId, "hw.bare");
  const extra = await sh(CMD.extra.replace("<model>", "sonnet").replace("<id>", "extra1"), cwdOf("dev-extra1"));
  check("extra builder uses culture command", extra.code === 0, extra.stderr.trim());
  check("extra builder model is explicit", (await psNodes()).find(n => n.logicalId === "dev.extra1")?.model === "sonnet");
  check("extra builder receives culture and role", agentsMd("dev-extra1").includes(`${RIG_NAME} culture`) && /# Role: Implementer/.test(await capture(`dev-extra1@${RIG_NAME}`)));
  const removed = await sh(CMD.remove.replace("<id>", "extra1"), planDir);
  check("extra removed; core remains", removed.code === 0 && JSON.stringify((await psNodes()).map(n => n.logicalId).sort()) === JSON.stringify(always));
} finally {
  await daemon.stop().catch(() => {});
}
console.log(failed === 0 ? "\nALL CHECKS PASSED" : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
