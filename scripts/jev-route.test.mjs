import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const JEV = path.join(HERE, "jev.mjs");
const OPUS = "dev-builder@r", SONNET = "dev-sonnet@r", CODEX = "dev-codex@r", QA = "dev-qa@r";

// A fake `rig` that only answers `ps` and `capture` (reads). Any other call (send, ...) is logged and fails.
const FAKE_RIG = `#!/usr/bin/env node
const fs = require("node:fs");
const [cmd, ...a] = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_RIG_CALLS, JSON.stringify([cmd, ...a]) + "\\n");
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

function world({ endpoint = "http://127.0.0.1:9/x", running = [OPUS, SONNET, CODEX, QA], screens = {} } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "jev-route-"));
  const home = path.join(root, "home"), openrig = path.join(root, "openrig"), bin = path.join(root, "bin");
  for (const d of [home, path.join(openrig, "secrets"), path.join(openrig, "jev"), bin]) mkdirSync(d, { recursive: true });
  writeFileSync(path.join(openrig, "secrets", "jev.env"), "JEV_API_KEY=fake-route-key-0123\n");
  // The human's live config shape: no seat keys, so the seat map comes from jev.defaults.json.
  const { seats, default_seat, ...defaults } = JSON.parse(readFileSync(path.join(HERE, "jev.defaults.json"), "utf8"));
  writeFileSync(path.join(openrig, "jev", "config.json"), JSON.stringify({ ...defaults, threshold: 0.25, endpoint,
    seats: { opus: OPUS, sonnet: SONNET, codex: CODEX }, default_seat: OPUS }));
  writeFileSync(path.join(bin, "rig"), FAKE_RIG); chmodSync(path.join(bin, "rig"), 0o755);
  const calls = path.join(root, "calls.jsonl");
  writeFileSync(calls, "");
  const env = { PATH: `${bin}${path.delimiter}${process.env.PATH}`, HOME: home, OPENRIG_HOME: openrig, FAKE_RIG_CALLS: calls,
    FAKE_RIG_SEATS: running === "down" ? "down" : JSON.stringify(running),
    FAKE_RIG_SCREENS: screens === "down" ? "down" : JSON.stringify(screens) };
  return {
    jev: (...args) => new Promise((resolve) => execFile(process.execPath, [JEV, ...args], { env }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }))),
    route: async (task) => JSON.parse((await new Promise((resolve) => execFile(process.execPath, [JEV, "route", "--json", task], { env }, (e, out) => resolve(out))))),
    calls: () => readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)),
    home,
    done: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** Routing only ever reads (`rig ps`, `rig capture`), and never touches the human's Claude settings. */
function assertHandsOff(w) {
  assert.ok(w.calls().every(([cmd]) => cmd === "ps" || cmd === "capture"), JSON.stringify(w.calls()));
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
