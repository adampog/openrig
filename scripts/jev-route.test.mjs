import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const JEV = process.env.JEV_TEST_SCRIPT || path.join(HERE, "jev.mjs");
const OPUS = "dev-builder@r", SONNET = "dev-sonnet@r", CODEX = "dev-codex@r", QA = "dev-qa@r";

// A fake `rig` that only answers `whoami`, `ps` and `capture` (reads). Any other call (send, ...) is logged and fails.
const FAKE_RIG = `#!/usr/bin/env node
const fs = require("node:fs");
const [cmd, ...a] = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_RIG_CALLS, JSON.stringify([cmd, ...a]) + "\\n");
if (cmd === "whoami" && process.env.FAKE_RIG_IDENTITY !== "down") {
  process.stdout.write(process.env.FAKE_RIG_IDENTITY);
  process.exit(0);
}
if (cmd === "ps" && process.env.FAKE_RIG_SEATS !== "down") {
  const seats = JSON.parse(process.env.FAKE_RIG_SEATS);
  process.stdout.write(JSON.stringify({ entries: seats.map((s) => ({ canonicalSessionName: s, sessionStatus: "running", startupStatus: "ready" })) }));
  process.exit(0);
}
if (cmd === "capture" && process.env.FAKE_RIG_SCREENS !== "down") {
  process.stdout.write(JSON.parse(process.env.FAKE_RIG_SCREENS)[a[0]] ?? "\\n› Ask Codex to do anything\\n");
  process.exit(0);
}
process.exit(1);
`;

async function stubJev(reply) {
  const requests = [];
  const server = createServer((req, res) => {
    let body = ""; req.on("data", (c) => { body += c; });
    req.on("end", () => { requests.push(JSON.parse(body)); res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(reply())); });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}/v1/systemone`, requests, close: () => server.closeAllConnections() || server.close() };
}
const answer = (model, confidence, effort = "medium") => ({
  answers: { model: { choice: model, confidence, probabilities: { [model]: confidence } }, effort: { choice: effort, confidence: 0.9 } },
});

function world({ endpoint = "http://127.0.0.1:9/x", running = [OPUS, SONNET, CODEX, QA], screens = {}, identity = null, session = "", config = {}, configText = null, redirect = null } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "jev-route-"));
  const home = path.join(root, "home"), openrig = path.join(root, "openrig"), bin = path.join(root, "bin");
  for (const d of [home, path.join(openrig, "secrets"), path.join(openrig, "jev"), bin]) mkdirSync(d, { recursive: true });
  writeFileSync(path.join(openrig, "secrets", "jev.env"), "JEV_API_KEY=fake-route-key-0123\n");
  // Isolated legacy config; optional per-rig profiles exercise the new shape.
  const { seats, default_seat, ...defaults } = JSON.parse(readFileSync(path.join(HERE, "jev.defaults.json"), "utf8"));
  writeFileSync(path.join(openrig, "jev", "config.json"), configText ?? JSON.stringify({ ...defaults, threshold: 0.25, endpoint,
    seats: { opus: OPUS, sonnet: SONNET, codex: CODEX }, default_seat: OPUS, ...config }));
  writeFileSync(path.join(bin, "rig"), FAKE_RIG); chmodSync(path.join(bin, "rig"), 0o755);
  const calls = path.join(root, "calls.jsonl");
  writeFileSync(calls, "");
  const preload = path.join(root, "redirect.mjs");
  if (redirect) writeFileSync(preload, `const original = globalThis.fetch; globalThis.fetch = (url, options) => original(${JSON.stringify(redirect)}, options);`);
  const env = { PATH: `${bin}${path.delimiter}${process.env.PATH}`, HOME: home, OPENRIG_HOME: openrig, OPENRIG_SESSION_NAME: session, FAKE_RIG_CALLS: calls,
    FAKE_RIG_IDENTITY: identity ? JSON.stringify({ identity: { rigName: identity } }) : "down",
    FAKE_RIG_SEATS: running === "down" ? "down" : JSON.stringify(running),
    FAKE_RIG_SCREENS: screens === "down" ? "down" : JSON.stringify(screens) };
  return {
    jev: (...args) => new Promise((resolve) => execFile(process.execPath, [...(redirect ? ["--import", preload] : []), JEV, ...args], { env }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }))),
    route: async (task) => JSON.parse((await new Promise((resolve) => execFile(process.execPath, [...(redirect ? ["--import", preload] : []), JEV, "route", "--json", task], { env }, (e, out) => resolve(out))))),
    calls: () => readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)),
    home,
    configPath: path.join(openrig, "jev", "config.json"),
    record: path.join(openrig, "jev", "decisions.jsonl"),
    done: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** Routing only ever reads (`rig ps`, `rig capture`), and never touches the human's Claude settings. */
function assertHandsOff(w) {
  assert.ok(w.calls().every(([cmd]) => cmd === "whoami" || cmd === "ps" || cmd === "capture"), JSON.stringify(w.calls()));
  assert.equal(existsSync(path.join(w.home, ".claude")), false);
}

test("each pick lands on the seat fixed to that model, with Jev's effort stated for the dispatch", async () => {
  for (const [model, seat] of [["opus", OPUS], ["sonnet", SONNET], ["codex", CODEX]]) {
    const stub = await stubJev(() => answer(model, 0.8, "high"));
    const w = world({ endpoint: stub.url });
    try {
      const r = await w.route(`a ${model} task`);
      assert.equal(r.seat, seat);
      assert.equal(r.model, model);
      assert.equal(r.effort, "high");
      assert.equal(r.fallback, false);
      assert.notEqual(r.seat, QA);
      const human = (await w.jev("route", `a ${model} task`)).stdout;
      assert.match(human, new RegExp(`Dispatch to: ${seat}`));
      assert.match(human, /Put in the row body: Jev: \w+, effort high/);
      assertHandsOff(w);
    } finally { stub.close(); w.done(); }
  }
});

test("unsure, off, outage, or a chosen seat that isn't running: the default seat, with the reason recorded", async () => {
  const unsure = await stubJev(() => answer("sonnet", 0.1));
  const sure = await stubJev(() => answer("sonnet", 0.9));
  const cases = [
    [world({ endpoint: unsure.url }), /confidence in sonnet \(0\.10\) is below the threshold 0\.25/],
    [world(), /Jev could not be reached/],
    [world({ endpoint: sure.url, running: [OPUS, QA] }), /dev-sonnet@r \(sonnet\) isn't running/],
    [world({ endpoint: sure.url, running: "down" }), /rig ps unavailable, so dev-sonnet@r could not be checked/],
  ];
  try {
    for (const [w, reason] of cases) {
      try {
        const r = await w.route("Add a flag");
        assert.equal(r.seat, OPUS);
        assert.equal(r.fallback, true);
        assert.match(r.reason, reason);
        assertHandsOff(w);
      } finally { w.done(); }
    }
    const w = world({ endpoint: sure.url });
    try {
      await w.jev("off");
      const before = sure.requests.length;
      const r = await w.route("Add a flag");
      assert.deepEqual([r.seat, r.fallback, r.reason], [OPUS, true, "routing is off"]);
      assert.equal(sure.requests.length, before);
      await w.jev("on");
      assert.equal((await w.route("Add a flag")).seat, SONNET);
    } finally { w.done(); }
  } finally { unsure.close(); sure.close(); }
});

test("jev log shows each task's pick, the seat, and why, without reading transcripts", async () => {
  const stub = await stubJev(() => answer("codex", 0.7, "low"));
  const w = world({ endpoint: stub.url });
  try {
    await w.route("Write the parser");
    await w.jev("off");
    await w.route("Fix the typo");
    const log = (await w.jev("log")).stdout.trim().split("\n");
    assert.equal(log.length, 2);
    assert.match(log[0], /dev-codex@r {2}codex\/low {2}\[Jev: codex 0\.70\] {2}Jev's pick {2}— Write the parser/);
    assert.match(log[1], /dev-builder@r {2}opus {2}\[Jev: no pick\] {2}default: routing is off {2}— Fix the typo/);
    assert.equal(JSON.parse((await w.jev("log", "-n", "1", "--json")).stdout).length, 1);
  } finally { stub.close(); w.done(); }
});

test("the shipped defaults offer Jev exactly the models that have a seat: no Haiku", () => {
  const d = JSON.parse(readFileSync(path.join(HERE, "jev.defaults.json"), "utf8"));
  assert.deepEqual(Object.keys(d.candidates).sort(), ["codex", "opus", "sonnet"]);
  assert.deepEqual(Object.keys(d.seats).sort(), Object.keys(d.candidates).sort());
  assert.ok(Object.values(d.seats).includes(d.default_seat));
});

const CODEX_CAPACITY = [
  "• Explored", "  └ Search ^## Resolve the selected path", "",
  "■ Selected model is at capacity. Please try a different model.", "", "",
  "› Ask Codex to do anything", "", "  GPT-6.1-Sol default · ~/Projects/openrig-work", "  ? for shortcuts",
].join("\n");
const CLAUDE_OVERLOADED = [
  "❯ Mission: x", "  ⎿  API Error: 529 {\"type\":\"overloaded_error\"}", "",
  "─".repeat(40), "❯ ", "─".repeat(40), "  ⏵⏵ auto mode on",
].join("\n");

test("a running seat whose model is failing counts as unavailable: the task goes to the default seat, and why", async () => {
  const codex = await stubJev(() => answer("codex", 0.8));
  const sonnet = await stubJev(() => answer("sonnet", 0.8));
  try {
    for (const [stub, screens, reason] of [
      [codex, { [CODEX]: CODEX_CAPACITY }, /dev-codex@r \(codex\) is running but its model is failing: ■ Selected model is at capacity\. Please try a different model\./],
      [sonnet, { [SONNET]: CLAUDE_OVERLOADED }, /dev-sonnet@r \(sonnet\) is running but its model is failing: ⎿ {2}API Error: 529/],
      [codex, "down", /dev-codex@r's screen could not be read to check its model/],
    ]) {
      const w = world({ endpoint: stub.url, screens });
      try {
        const r = await w.route("Write the parser");
        assert.deepEqual([r.seat, r.model, r.fallback], [OPUS, "opus", true]);
        assert.match(r.reason, reason);
        assertHandsOff(w);
        assert.ok(w.calls().some(([cmd, seat]) => cmd === "capture" && seat !== OPUS));
      } finally { w.done(); }
    }
  } finally { codex.close(); sonnet.close(); }
});

test("an old error followed by more work, or the words in ordinary output, do not make a seat unavailable", async () => {
  const stub = await stubJev(() => answer("codex", 0.8));
  const recovered = CODEX_CAPACITY.replace("\n\n\n› Ask", "\n\n› retry\n\n• Ran npm test\n  └ 12 passing\n\n• Done: tests pass.\n\n› Ask");
  const prose = CODEX_CAPACITY.replace("■ Selected model is at capacity. Please try a different model.", "• Noted: the old error said the model was at capacity; it has recovered.");
  try {
    for (const screen of [recovered, prose]) {
      const w = world({ endpoint: stub.url, screens: { [CODEX]: screen } });
      try {
        const r = await w.route("Write the parser");
        assert.deepEqual([r.seat, r.fallback, r.reason], [CODEX, false, null]);
      } finally { w.done(); }
    }
  } finally { stub.close(); }
});

test("a record that can't be written still returns the seat, with the error", { skip: !existsSync("/dev/full") && "no /dev/full" }, async () => {
  const stub = await stubJev(() => answer("sonnet", 0.8));
  const w = world({ endpoint: stub.url });
  try {
    symlinkSync("/dev/full", w.record); // every write fails with ENOSPC
    for (const off of [false, true]) {
      if (off) await w.jev("off");
      const r = await w.jev("route", "--json", "Add a flag");
      assert.equal(r.code, 0);
      const out = JSON.parse(r.stdout);
      assert.equal(out.seat, off ? OPUS : SONNET);
      assert.equal(out.record_error, "ENOSPC");
      const human = await w.jev("route", "Add a flag");
      assert.equal(human.code, 0);
      assert.match(human.stdout, new RegExp(`Dispatch to: ${off ? OPUS : SONNET}`));
      assert.match(human.stdout, /Not recorded \(ENOSPC\); jev log won't show this task/);
    }
  } finally { stub.close(); w.done(); }
});

test("jev log shows every readable route and counts damaged lines instead of hiding them", async () => {
  const stub = await stubJev(() => answer("opus", 0.8));
  const w = world({ endpoint: stub.url });
  try {
    await w.route("First task");
    appendFileSync(w.record, '{"type":"route","time":"2026-10-05T05:0\n');
    await w.route("Second task");
    appendFileSync(w.record, '{"type":"route","ti');
    const log = await w.jev("log");
    const lines = log.stdout.trim().split("\n");
    assert.match(lines[0], /— First task$/);
    assert.match(lines[1], /— Second task$/);
    assert.match(lines[2], /^2 unreadable line\(s\) in .*decisions\.jsonl skipped$/);
    const json = await w.jev("log", "--json");
    assert.deepEqual(JSON.parse(json.stdout).map((e) => e.task), ["First task", "Second task"]);
    assert.match(json.stderr, /2 unreadable line\(s\)/);
  } finally { stub.close(); w.done(); }
});

const RIGS = {
  "plugin-build": {
    seats: { opus: "dev-builder@plugin-build", codex: "dev-codex@plugin-build" },
    default_seat: "dev-builder@plugin-build",
  },
  "theme-build": {
    seats: { opus: "dev-builder@theme-build", fable: "dev-fable@theme-build", qwen: "dev-qwen@theme-build" },
    default_seat: "dev-builder@theme-build",
    candidates: {
      fable: { runtime: "claude-code", description: "Claude Fable 5.1: hardest scenes and visual design" },
      qwen: { runtime: "pi", description: "Text-only chores; cannot look at images" },
      codex: { runtime: "codex", description: "No seat here; never offer this model" },
    },
  },
};
const RIG_RUNNING = Object.values(RIGS).flatMap((r) => Object.values(r.seats));

test("same task uses the asking rig's own model seat and default on fallback", async () => {
  const stub = await stubJev(() => answer("opus", 0.9));
  try {
    for (const rig of Object.keys(RIGS)) {
      // Both rigs offer opus for this test; their normal candidate overrides are checked separately.
      const rigs = Object.fromEntries(Object.entries(RIGS).map(([name, r]) => [name, { ...r, candidates: undefined }]));
      const w = world({ endpoint: stub.url, identity: rig, running: RIG_RUNNING, config: { rigs } });
      try {
        const r = await w.route("Build the same task");
        assert.equal(r.rig, rig);
        assert.equal(r.seat, RIGS[rig].seats.opus);
        assert.equal(r.fallback_seat, RIGS[rig].default_seat);
        await w.jev("off");
        const fallback = await w.route("Build the same task");
        assert.equal(fallback.seat, RIGS[rig].default_seat);
        assert.equal(fallback.rig, rig);
        const records = readFileSync(w.record, "utf8").trim().split("\n").map(JSON.parse);
        assert.ok(records.every((record) => record.rig === rig));
        assertHandsOff(w);
      } finally { w.done(); }
    }
  } finally { stub.close(); }
});

test("explicit --rig overrides identity; outside a rig it selects that rig", async () => {
  const stub = await stubJev(() => answer("codex", 0.9));
  try {
    for (const identity of [null, "theme-build"]) {
      const w = world({ endpoint: stub.url, identity, running: RIG_RUNNING, config: { rigs: RIGS } });
      try {
        const out = await w.jev("route", "--rig", "plugin-build", "--json", "Write a parser");
        assert.equal(out.code, 0);
        const r = JSON.parse(out.stdout);
        assert.equal(r.rig, "plugin-build");
        assert.equal(r.seat, RIGS["plugin-build"].seats.codex);
        assert.equal(r.task, "Write a parser");
        assert.equal(w.calls().some(([cmd]) => cmd === "whoami"), false);
      } finally { w.done(); }
    }
  } finally { stub.close(); }
});

test("rig candidates replace shared candidates, filter unmapped models, and allow fable", async () => {
  let model = "codex";
  const stub = await stubJev(() => answer(model, 0.9));
  const plugin = world({ endpoint: stub.url, identity: "plugin-build", running: RIG_RUNNING, config: { rigs: RIGS } });
  const theme = world({ endpoint: stub.url, identity: "theme-build", running: RIG_RUNNING, config: { rigs: RIGS } });
  try {
    assert.equal((await plugin.route("Build a parser")).seat, RIGS["plugin-build"].seats.codex);
    assert.deepEqual(Object.keys(stub.requests.at(-1).questions.model.criteria).sort(), ["codex", "opus"]);
    model = "fable";
    assert.equal((await theme.route("Build a scene")).seat, RIGS["theme-build"].seats.fable);
    assert.deepEqual(stub.requests.at(-1).questions.model.criteria, {
      fable: RIGS["theme-build"].candidates.fable.description,
      qwen: RIGS["theme-build"].candidates.qwen.description,
    });
    // Even a bad answer cannot select a model that was excluded from the asking rig.
    model = "codex";
    const rejected = await theme.route("Build a scene");
    assert.equal(rejected.seat, RIGS["theme-build"].default_seat);
    assert.equal(rejected.fallback, true);
    assert.match(rejected.reason, /known candidate/);
  } finally { stub.close(); plugin.done(); theme.done(); }
});

test("stopped picked seat is reported in text and JSON alongside the fallback", async () => {
  const stub = await stubJev(() => answer("fable", 0.9, "high"));
  const w = world({ endpoint: stub.url, identity: "theme-build", running: [RIGS["theme-build"].default_seat], config: { rigs: RIGS } });
  try {
    const r = await w.route("Render the hardest scene");
    assert.equal(r.picked_seat, "dev-fable@theme-build");
    assert.equal(r.picked_model, "fable");
    assert.equal(r.picked_running, false);
    assert.equal(r.fallback_seat, "dev-builder@theme-build");
    assert.equal(r.seat, r.fallback_seat);
    assert.equal(r.fallback, true);
    const text = (await w.jev("route", "Render the hardest scene")).stdout;
    assert.match(text, /Picked seat: dev-fable@theme-build.*not running/);
    assert.match(text, /Fallback seat: dev-builder@theme-build/);
    assertHandsOff(w);
  } finally { stub.close(); w.done(); }
});

test("route and decide help make no call or record, including -h", async () => {
  const stub = await stubJev(() => answer("opus", 0.9));
  const w = world({ endpoint: stub.url });
  try {
    for (const command of ["route", "decide"]) {
      for (const flag of ["--help", "-h"]) {
        const out = await w.jev(command, flag);
        assert.equal(out.code, 0);
        assert.match(out.stdout, /Usage:/);
      }
    }
    assert.equal(stub.requests.length, 0);
    assert.deepEqual(w.calls(), []);
    assert.equal(existsSync(w.record), false);
  } finally { stub.close(); w.done(); }
});

test("status, log, and decision records show the rig", async () => {
  const stub = await stubJev(() => answer("codex", 0.9));
  const w = world({ endpoint: stub.url, identity: "plugin-build", running: RIG_RUNNING, config: { rigs: RIGS } });
  try {
    await w.route("Implement the parser");
    assert.match((await w.jev("status")).stdout, /Rig: plugin-build/);
    assert.equal(JSON.parse((await w.jev("status", "--json")).stdout).rig, "plugin-build");
    assert.match((await w.jev("log")).stdout, /plugin-build/);
    assert.equal(JSON.parse((await w.jev("log", "--json")).stdout)[0].rig, "plugin-build");
    const d = JSON.parse((await w.jev("decide", "--json", "Implement the parser")).stdout);
    assert.equal(d.rig, "plugin-build");
  } finally { stub.close(); w.done(); }
});

test("unconfigured rigs and malformed --rig cannot dispatch into another rig", async () => {
  const stub = await stubJev(() => answer("codex", 0.9));
  const w = world({ endpoint: stub.url, identity: "unconfigured", config: { rigs: RIGS } });
  try {
    for (const args of [["route", "Task"], ["route", "--rig", "missing", "Task"], ["route", "--rig"], ["route", "--rig", "--json", "Task"]]) {
      const out = await w.jev(...args);
      assert.equal(out.code, 2);
      assert.match(out.stderr, /rig|--rig/);
    }
    assert.equal(stub.requests.length, 0);
    assert.equal(existsSync(w.record), false);
  } finally { stub.close(); w.done(); }
});

test("unchanged live legacy config routes all four models as before with no rig override", async () => {
  const configText = readFileSync(path.join(HERE, "fixtures", "jev-legacy-config.json"), "utf8");
  const config = JSON.parse(configText);
  for (const [model, seat] of Object.entries(config.seats)) {
    const stub = await stubJev(() => answer(model, 0.9));
    const w = world({ configText, redirect: stub.url, identity: "openrig-build", running: Object.values(config.seats) });
    try {
      const r = await w.route("Implement the same task");
      assert.deepEqual([r.seat, r.model, r.effort, r.fallback, r.reason], [seat, model, "medium", false, null]);
      assert.deepEqual(Object.keys(stub.requests.at(-1).questions.model.criteria), Object.keys(config.candidates));
      await w.jev("off");
      const fallback = await w.route("Implement the same task");
      assert.deepEqual([fallback.seat, fallback.model, fallback.fallback, fallback.reason], ["dev-builder@openrig-build", "opus", true, "routing is off"]);
      assert.equal(readFileSync(w.configPath, "utf8"), configText);
      assertHandsOff(w);
    } finally { stub.close(); w.done(); }
  }
});


test("unavailable identity uses the runtime session address, then legacy when outside a rig", async () => {
  const stub = await stubJev(() => answer("codex", 0.9));
  try {
    for (const [session, seat, rig] of [["orch-lead@plugin-build", "dev-codex@plugin-build", "plugin-build"], ["", CODEX, "r"]]) {
      const w = world({ endpoint: stub.url, session, running: [...RIG_RUNNING, CODEX], config: { rigs: RIGS } });
      try {
        const r = await w.route("Write a parser");
        assert.equal(r.rig, rig);
        assert.equal(r.seat, seat);
      } finally { w.done(); }
    }
  } finally { stub.close(); }
});

test("per-rig default and seat addresses are validated before calling Jev", async () => {
  const stub = await stubJev(() => answer("codex", 0.9));
  try {
    for (const profile of [
      { seats: { codex: CODEX }, default_seat: CODEX },
      { seats: { codex: "dev-codex@plugin-build" } },
    ]) {
      const w = world({ endpoint: stub.url, identity: "plugin-build", config: { rigs: { "plugin-build": profile } } });
      try {
        const out = await w.jev("route", "Task");
        assert.equal(out.code, 2);
        assert.match(out.stderr, /must all address that rig|default_seat/);
        assert.equal(existsSync(w.record), false);
      } finally { w.done(); }
    }
    assert.equal(stub.requests.length, 0);
  } finally { stub.close(); }
});


test("decide stays model-only and status shows identity even without a rig seat profile", async () => {
  const stub = await stubJev(() => answer("codex", 0.9));
  const w = world({ endpoint: stub.url, identity: "advisor", config: { rigs: RIGS } });
  try {
    const out = await w.jev("decide", "--json", "Implement a parser");
    assert.equal(out.code, 0);
    const d = JSON.parse(out.stdout);
    assert.equal(d.model, "codex");
    assert.equal(d.rig, "advisor");
    assert.equal(d.runtime, "codex");
    assert.deepEqual(Object.keys(stub.requests[0].questions.model.criteria), ["sonnet", "opus", "codex"]);
    const status = await w.jev("status", "--json");
    assert.equal(status.code, 0);
    assert.equal(JSON.parse(status.stdout).rig, "advisor");
    assert.ok(w.calls().every(([cmd]) => cmd === "whoami"));
  } finally { stub.close(); w.done(); }
});
