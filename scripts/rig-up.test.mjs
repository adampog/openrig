import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Tests for the dead-workspace prune in scripts/rig-up.sh. Nothing here touches the real herdr,
// tmux, rig or daemon: the Python body is exercised either as a pure function over fixtures, or
// end to end against fake `rig`, `herdr`, `tmux` and `pgrep` programs on PATH and a fake herdr
// socket under a scratch HOME. The fake `herdr workspace close` only writes to a log.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = process.env.RIG_UP_TEST_SCRIPT || path.join(HERE, "rig-up.sh");
const PYTHON = readFileSync(SCRIPT, "utf8").split("<<'PY_RIG_UP'\n")[1].split("\nPY_RIG_UP")[0];

const scratch = mkdtempSync(path.join(tmpdir(), "rig-up-test-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));

// ---------- pure function: plan_prune / pane_kind ----------
function py(code) {
  const file = path.join(scratch, "rig_up_body.py");
  writeFileSync(file, PYTHON);
  const r = spawnSync("python3", ["-c", `import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("rig_up", ${JSON.stringify(file)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
${code}`], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}
const shell = (pid = 10) => ({ shell_pid: pid, foreground_processes: [{ name: "zsh", pid, argv: ["-zsh"] }] });
const attach = (session, pid = 11) => ({ shell_pid: pid, foreground_processes: [{ name: "tmux: client", pid, argv: ["/usr/bin/tmux", "attach", "-t", session] }] });
const pane = (id, label, status = "unknown") => ({ pane_id: id, label, agent_status: status });
const SEATS = { "openrig-build": ["orch.lead", "dev.builder"], kernel: ["advisor.lead", "operator.human"] };

const J = (value) => `json.loads(${JSON.stringify(JSON.stringify(value))})`;
function plan({ workspaces, panes, procs, live = [], seats = SEATS, preexisting, screens = {} }) {
  return py(`
close, keep = m.plan_prune(${J(workspaces)}, ${J(panes)}, ${J(procs)}, set(${J(live)}),
  {k: set(v) for k, v in ${J(seats)}.items()}, set(${J(preexisting ?? workspaces.map((w) => w.workspace_id))}), ${J(screens)})
print(json.dumps({"close": [c[0] for c in close], "keep": {k: why for k, why in keep}}))`);
}
const W = (id, label) => ({ workspace_id: id, label });
const LIVE = ["orch-lead@openrig-build", "dev-builder@openrig-build"];
const liveWall = { w: W("wLive", "openrig-build"), panes: [pane("p1", "orch.lead", "idle"), pane("p2", "dev.builder", "idle")], procs: { p1: attach(LIVE[0]), p2: attach(LIVE[1]) } };
const deadWall = (id = "wDead") => ({ w: W(id, "openrig-build"), panes: [pane(id + "a", "orch.lead"), pane(id + "b", "dev.builder")], procs: { [id + "a"]: shell(), [id + "b"]: shell() } });
function build(...parts) {
  const workspaces = [], panes = {}, procs = {};
  for (const p of parts) { workspaces.push(p.w); panes[p.w.workspace_id] = p.panes; Object.assign(procs, p.procs); }
  return { workspaces, panes, procs, live: LIVE };
}

test("closes a wall whose panes are all idle bare shells when the rig has a live wall", () => {
  const r = plan(build(liveWall, deadWall()));
  assert.deepEqual(r.close, ["wDead"]);
  assert.match(r.keep.wLive, /attached to a live tmux session/);
});

test("race: a wall whose agent reads 'unknown' but is attached to a live tmux session is kept", () => {
  const justStarted = { w: W("wNew", "openrig-build"), panes: [pane("n1", "orch.lead", "unknown"), pane("n2", "dev.builder", "unknown")], procs: { n1: attach(LIVE[0]), n2: attach(LIVE[1]) } };
  const r = plan(build(justStarted, deadWall()));
  assert.ok(!r.close.includes("wNew"));
  assert.deepEqual(r.close, ["wDead"]);
});

test("a wall with a single pane attached to a live session is kept even if the others are bare shells", () => {
  const mixed = { w: W("wMix", "openrig-build"), panes: [pane("m1", "orch.lead"), pane("m2", "dev.builder")], procs: { m1: attach(LIVE[0]), m2: shell() } };
  assert.deepEqual(plan(build(mixed, deadWall())).close, ["wDead"]);
});

test("never closes the only wall of a rig, even when it is dead", () => {
  const r = plan(build(deadWall("wOnly")));
  assert.deepEqual(r.close, []);
  assert.match(r.keep.wOnly, /only wall/);
});

test("never closes a workspace that was not there before the run began", () => {
  const b = build(liveWall, deadWall("wLate"));
  const r = plan({ ...b, preexisting: ["wLive"] });
  assert.deepEqual(r.close, []);
  assert.match(r.keep.wLate, /after this run began/);
});

test("a label that is not an up rig is not OpenRig's to close (the stray '~' shell)", () => {
  const stray = { w: W("wTilde", "~"), panes: [pane("t1", "~")], procs: { t1: shell() } };
  const r = plan(build(liveWall, stray));
  assert.deepEqual(r.close, []);
  assert.match(r.keep.wTilde, /not a rig that is up/);
});

test("a pane that is not one of the rig's seats keeps the workspace", () => {
  const odd = { w: W("wOdd", "openrig-build"), panes: [pane("o1", "orch.lead"), pane("o2", "my-notes")], procs: { o1: shell(), o2: shell() } };
  const r = plan(build(liveWall, odd));
  assert.deepEqual(r.close, []);
  assert.match(r.keep.wOdd, /not one of the rig's seats/);
});

test("an unlabelled spare shell showing only a prompt does not stop a dead wall closing; one showing content does", () => {
  const spare = (id, screen) => ({ w: W(id, "openrig-build"), panes: [pane(id + "a", "orch.lead"), { pane_id: id + "s" }], procs: { [id + "a"]: shell(), [id + "s"]: shell() }, screen });
  const bare = spare("wBare", "sh-5.3$\n"), used = spare("wUsed", "sh-5.3$ vim notes.txt\n$ ");
  const b = build(liveWall, bare, used);
  const r = plan({ ...b, screens: { wBares: bare.screen, wUseds: used.screen } });
  assert.deepEqual(r.close, ["wBare"]);
  assert.match(r.keep.wUsed, /unlabelled pane shows content/);
});

test("a workspace with no seat pane at all is kept", () => {
  const noSeat = { w: W("wNone", "openrig-build"), panes: [{ pane_id: "x1" }], procs: { x1: shell() } };
  assert.deepEqual(plan({ ...build(liveWall, noSeat), screens: { x1: "$" } }).close, []);
});

test("a busy pane (a foreground job, an editor, a tmux client of an unknown session) keeps the workspace", () => {
  for (const proc of [
    { shell_pid: 10, foreground_processes: [{ name: "nvim", pid: 99, argv: ["nvim"] }] },
    { shell_pid: 10, foreground_processes: [{ name: "zsh", pid: 10, argv: ["zsh"] }, { name: "sleep", pid: 55, argv: ["sleep", "999"] }] },
    attach("ghost@openrig-build"),
    null,
    {},
  ]) {
    const w = { w: W("wBusy", "openrig-build"), panes: [pane("b1", "orch.lead")], procs: { b1: proc } };
    assert.deepEqual(plan(build(liveWall, w)).close, [], JSON.stringify(proc));
  }
});

test("a workspace with no listed panes, or a pane reporting an agent at work, is kept", () => {
  const empty = { w: W("wEmpty", "openrig-build"), panes: [], procs: {} };
  const working = { w: W("wWork", "openrig-build"), panes: [pane("k1", "orch.lead", "working")], procs: { k1: shell() } };
  assert.deepEqual(plan(build(liveWall, empty, working)).close, []);
});

test("agent_status never decides on its own: dead shells close whatever they last reported", () => {
  const b = build(liveWall, { w: W("wIdle", "openrig-build"), panes: [pane("i1", "orch.lead", "idle")], procs: { i1: shell() } },
    { w: W("wUnk", "openrig-build"), panes: [pane("u1", "orch.lead", "unknown")], procs: { u1: shell() } });
  assert.deepEqual(plan(b).close.sort(), ["wIdle", "wUnk"]);
});

test("pane_kind recognises a tmux client by its -t target and a shell by it being its own foreground", () => {
  const r = py(`print(json.dumps([m.pane_kind(${J(attach(LIVE[0]))}, set(${J(LIVE)})), m.pane_kind(${J(attach("x@y"))}, set()), m.pane_kind(${J(shell())}, set()), m.pane_kind(None, set())]))`);
  assert.deepEqual(r, ["attached-live", "tmux-other", "idle-shell", "unknown"]);
});

// ---------- end to end against fake rig / herdr / tmux / pgrep ----------
const FAKE = `#!/usr/bin/env python3
import json, os, sys
tool = os.path.basename(sys.argv[0]); args = sys.argv[1:]
state = json.load(open(os.environ["FAKE_STATE"]))
def log(*a):
    with open(os.environ["FAKE_LOG"], "a") as f: f.write(json.dumps([tool, *a]) + "\\n")
def counter(key):
    p = os.environ["FAKE_STATE"] + "." + key
    n = int(open(p).read()) if os.path.exists(p) else 0
    open(p, "w").write(str(n + 1)); return n
log(*args)
if tool == "rig":
    if args[:1] == ["ps"] and "--nodes" in args:
        name = args[args.index("--rig") + 1]; print(json.dumps(state["nodes"][name]))
    elif args[:1] == ["ps"] and "--json" in args: print(json.dumps(state["fleet"]))
    elif args[:1] == ["ps"]: print("RIG TABLE")
    elif args[:2] == ["terminal", "open"]: pass
    else: sys.exit(1)
elif tool == "tmux":
    for n, c in state["tmux"].items(): print(n, c)
elif tool == "pgrep":
    print("1 herdr")
elif tool == "herdr":
    if args[:2] == ["workspace", "list"]:
        if state.get("inventory_fails") and counter("list") == 0: sys.exit(1)
        print(json.dumps({"result": {"workspaces": state["workspaces"]}}))
    elif args[:2] == ["pane", "list"]:
        print(json.dumps({"result": {"panes": state["panes"][args[args.index("--workspace") + 1]]}}))
    elif args[:2] == ["pane", "process-info"]:
        pid = args[args.index("--pane") + 1]
        flip = state.get("flip", {}).get(pid)
        info = state["procs"][pid]
        if flip and counter("flip-" + pid) >= flip["after_reads"]: info = flip["to"]
        print(json.dumps({"result": {"process_info": info}}))
    elif args[:2] == ["pane", "read"]:
        print(state.get("screens", {}).get(args[2], "sh-5.3$"))
    elif args[:2] == ["workspace", "close"]:
        state["workspaces"] = [w for w in state["workspaces"] if w["workspace_id"] != args[2]]
        json.dump(state, open(os.environ["FAKE_STATE"], "w"))
    else: sys.exit(1)
`;
const SOCKET_SERVER = `import json, os, socketserver, sys
class H(socketserver.StreamRequestHandler):
    def handle(self):
        state = json.load(open(os.environ["FAKE_STATE"]))
        req = json.loads(self.rfile.readline())
        with open(os.environ["FAKE_LOG"], "a") as f: f.write(json.dumps(["socket", req["method"], req["params"]]) + "\\n")
        out = {"workspaces": state["workspaces"]} if req["method"] == "workspace.list" else {}
        self.wfile.write((json.dumps({"id": req["id"], "result": out}) + "\\n").encode())
path = sys.argv[1]
class S(socketserver.UnixStreamServer): pass
S(path, H).serve_forever()
`;

function node(name, status = "running") {
  return { canonicalSessionName: name, logicalId: name.split("@")[0].replace("-", "."), sessionStatus: status, startupStatus: "ready" };
}
function fleetState(extra = {}) {
  const workspaces = [W("wK", "kernel"), W("wKold", "kernel"), W("wOB", "openrig-build"), W("wOBold", "openrig-build"), W("wTilde", "~"), W("wRace", "openrig-build")];
  const kernelSeats = ["advisor-lead@kernel", "operator-human@kernel"], obSeats = ["orch-lead@openrig-build", "dev-builder@openrig-build"];
  const panes = {
    wK: [pane("k1", "advisor.lead"), pane("k2", "operator.human"), { pane_id: "ks" }],
    wKold: [pane("ko1", "advisor.lead"), pane("ko2", "operator.human"), { pane_id: "kos" }],
    wOB: [pane("o1", "orch.lead"), pane("o2", "dev.builder"), { pane_id: "os" }],
    wOBold: [pane("oo1", "orch.lead"), pane("oo2", "dev.builder"), { pane_id: "oos" }],
    wTilde: [pane("t1", "~")],
    // a recovery wall rig-up's earlier run opened: agents read 'unknown', tmux sessions live
    wRace: [pane("r1", "orch.lead", "unknown"), pane("r2", "dev.builder", "unknown")],
  };
  const procs = {
    k1: attach(kernelSeats[0]), k2: attach(kernelSeats[1]), ko1: shell(), ko2: shell(),
    o1: attach(obSeats[0]), o2: attach(obSeats[1]), oo1: shell(), oo2: shell(),
    t1: shell(), r1: attach(obSeats[0]), r2: attach(obSeats[1]),
    ks: shell(), kos: shell(), os: shell(), oos: shell(),
  };
  return {
    fleet: [{ name: "kernel", status: "running", rigId: "K", isArchived: false }, { name: "openrig-build", status: "running", rigId: "O", isArchived: false }],
    nodes: { kernel: kernelSeats.map((s) => node(s)), "openrig-build": obSeats.map((s) => node(s)) },
    tmux: Object.fromEntries([...kernelSeats, ...obSeats].map((s) => [s, 1])),
    workspaces, panes, procs, ...extra,
  };
}

async function runRigUp(args, state) {
  const dir = mkdtempSync(path.join(scratch, "run-"));
  const bin = path.join(dir, "bin"), home = path.join(dir, "home");
  mkdirSync(bin); mkdirSync(path.join(home, ".config/herdr"), { recursive: true });
  for (const t of ["rig", "herdr", "tmux", "pgrep"]) { writeFileSync(path.join(bin, t), FAKE); chmodSync(path.join(bin, t), 0o755); }
  writeFileSync(path.join(dir, "state.json"), JSON.stringify(state));
  writeFileSync(path.join(dir, "sock.py"), SOCKET_SERVER);
  const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: home, FAKE_STATE: path.join(dir, "state.json"), FAKE_LOG: path.join(dir, "calls.log"), RIG_UP_PRUNE_SETTLE: "0" };
  const server = spawn("python3", [path.join(dir, "sock.py"), path.join(home, ".config/herdr/herdr.sock")], { env });
  for (let i = 0; i < 50 && !existsSync(path.join(home, ".config/herdr/herdr.sock")); i++) await new Promise((r) => setTimeout(r, 40));
  const r = await new Promise((resolve) => {
    const child = spawn("bash", [SCRIPT, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d)); child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  server.kill();
  const calls = existsSync(path.join(dir, "calls.log")) ? readFileSync(path.join(dir, "calls.log"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  const closed = calls.filter((c) => c[0] === "herdr" && c[1] === "workspace" && c[2] === "close").map((c) => c[3]);
  const opened = calls.filter((c) => c[0] === "rig" && c[1] === "terminal" && c[2] === "open");
  return { ...r, calls, closed, opened };
}

test("end to end: closes only the provably dead pre-restart walls; the live wall, the race wall and the '~' shell survive", async () => {
  const r = await runRigUp([], fleetState());
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.deepEqual(r.closed.sort(), ["wKold", "wOBold"]);
  assert.match(r.stdout, /prune: closed dead workspace wKold/);
  // Pruning runs before ordering: the kernel, left with one wall, is now placed first. openrig-build
  // still has two kept walls (the live one and the race wall), so ordering still never picks between them.
  const moves = r.calls.filter((c) => c[0] === "socket" && c[1] === "workspace.move").map((c) => c[2]);
  assert.deepEqual(moves, [{ workspace_id: "wK", insert_index: 0 }]);
  assert.match(r.stdout, /prune: keep wRace: a pane is attached to a live tmux session/);
  assert.match(r.stdout, /prune: keep wTilde: label is not a rig that is up/);
  assert.equal(r.opened.length, 0, "recovery opened nothing: the live walls were already attached");
});

test("end to end: a spare shell with typed content keeps its wall", async () => {
  const r = await runRigUp([], fleetState({ screens: { oos: "sh-5.3$ ls\nfile1\nsh-5.3$" } }));
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.ok(!r.closed.includes("wOBold"));
  assert.match(r.stdout, /prune: keep wOBold: an unlabelled pane shows content/);
  assert.ok(r.closed.includes("wKold"));
});

test("end to end: --prune-plan reports what would close and changes nothing", async () => {
  const r = await runRigUp(["--prune-plan"], fleetState());
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.deepEqual(r.closed, []);
  assert.equal(r.opened.length, 0);
  assert.ok(!r.calls.some((c) => c[0] === "rig" && ["start", "restore", "terminal"].includes(c[1])));
  assert.match(r.stdout, /prune: would close wKold/);
  assert.match(r.stdout, /prune: would close wOBold/);
});

test("end to end: --no-prune keeps today's recovery-only behaviour", async () => {
  const r = await runRigUp(["--no-prune"], fleetState());
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.deepEqual(r.closed, []);
  assert.doesNotMatch(r.stdout, /prune:/);
});

test("end to end: a wall that comes alive between the reads is not closed", async () => {
  const state = fleetState({ flip: { oo1: { after_reads: 1, to: attach("orch-lead@openrig-build") } } });
  const r = await runRigUp([], state);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.ok(!r.closed.includes("wOBold"), r.stdout);
  assert.match(r.stdout, /prune: keep wOBold: (it changed|a pane is attached)/);
  assert.ok(r.closed.includes("wKold"));
});

test("end to end: if the workspace inventory cannot be read before recovery, nothing is pruned", async () => {
  const r = await runRigUp([], fleetState({ inventory_fails: true }));
  assert.deepEqual(r.closed, []);
  assert.match(r.stderr, /prune skipped/);
});

test("end to end: a rig that is not up gets no pruning of its walls", async () => {
  const state = fleetState();
  state.fleet.push({ name: "esp32", status: "stopped", rigId: "E", isArchived: false });
  state.workspaces.push(W("wEsp", "esp32"), W("wEsp2", "esp32"));
  state.panes.wEsp = [pane("e1", "orch.lead")]; state.panes.wEsp2 = [pane("e2", "orch.lead")];
  state.procs.e1 = shell(); state.procs.e2 = shell();
  const r = await runRigUp([], state);
  assert.ok(!r.closed.includes("wEsp") && !r.closed.includes("wEsp2"));
});
