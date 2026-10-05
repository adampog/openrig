import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const JEV = path.join(path.dirname(fileURLToPath(import.meta.url)), "jev.mjs");
const FAKE_KEY = "fake-jev-key-for-tests-0123456789";

/** A stub Jev: answers with `reply(body)` and remembers each request. */
async function stubJev(reply) {
  const requests = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      requests.push({ auth: req.headers.authorization, body: JSON.parse(body) });
      const out = reply(JSON.parse(body));
      if (out === "hang") return;
      res.writeHead(out.status ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify(out.json ?? {}));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}/v1/systemone`, requests, close: () => server.closeAllConnections() || server.close() };
}

const answer = (model, confidence, probabilities, effort = "medium", effortConfidence = 0.8) => ({
  json: {
    model: "jev-1.13.0",
    answers: {
      model: { type: "choice", choice: model, confidence, probabilities },
      effort: { type: "choice", choice: effort, confidence: effortConfidence, probabilities: { [effort]: effortConfidence } },
    },
  },
});

function home({ key = true, endpoint, config = {} } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "jev-test-"));
  if (key) {
    mkdirSync(path.join(dir, "secrets"), { recursive: true });
    writeFileSync(path.join(dir, "secrets", "jev.env"), `# test key\nJEV_API_KEY=${FAKE_KEY}\n`, { mode: 0o600 });
  }
  const defaults = JSON.parse(readFileSync(path.join(path.dirname(JEV), "jev.defaults.json"), "utf8"));
  mkdirSync(path.join(dir, "jev"), { recursive: true });
  writeFileSync(path.join(dir, "jev", "config.json"), JSON.stringify({ ...defaults, ...(endpoint ? { endpoint } : {}), ...config }));
  return dir;
}

function jev(dir, ...args) {
  return new Promise((resolve) => {
    const started = Date.now();
    execFile(process.execPath, [JEV, ...args], { env: { PATH: process.env.PATH, OPENRIG_HOME: dir } }, (err, stdout, stderr) =>
      resolve({ code: err ? err.code : 0, stdout, stderr, ms: Date.now() - started }));
  });
}

const records = (dir) => readFileSync(path.join(dir, "jev", "decisions.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

function assertNoKey(dir, ...outputs) {
  for (const text of [...outputs, readFileSync(path.join(dir, "jev", "decisions.jsonl"), "utf8")]) {
    assert.ok(!text.includes(FAKE_KEY), "the API key leaked into output or the record");
  }
}

test("a confident pick returns the model, effort and confidences, and is recorded", async () => {
  const stub = await stubJev(() => answer("opus", 0.62, { haiku: 0.05, sonnet: 0.2, opus: 0.7, codex: 0.05 }, "high", 1));
  const dir = home({ endpoint: stub.url });
  try {
    const r = await jev(dir, "decide", "--default", "sonnet", "--json", "Root-cause seats marked detached after resume");
    assert.equal(r.code, 0);
    const out = JSON.parse(r.stdout);
    assert.equal(out.model, "opus");
    assert.equal(out.runtime, "claude-code");
    assert.equal(out.effort, "high");
    assert.equal(out.fallback.applied, false);
    assert.equal(out.jev.model.confidence, 0.62);
    assert.deepEqual(out.jev.model.probabilities, { haiku: 0.05, sonnet: 0.2, opus: 0.7, codex: 0.05 });

    const [rec] = records(dir);
    assert.equal(rec.task, "Root-cause seats marked detached after resume");
    assert.equal(rec.model, "opus");
    assert.equal(rec.fallback.applied, false);
    assert.ok(!Number.isNaN(Date.parse(rec.time)));

    // The question carries the candidates from config and the cheapest-first rule; the key goes only in the header.
    const [req] = stub.requests;
    assert.equal(req.auth, `Bearer ${FAKE_KEY}`);
    assert.deepEqual(Object.keys(req.body.questions.model.criteria), ["haiku", "sonnet", "opus", "codex"]);
    assert.match(req.body.questions.model.instructions, /cheapest/);
    assert.deepEqual(Object.keys(req.body.questions.effort.criteria), ["low", "medium", "high"]);

    const human = await jev(dir, "decide", "--default", "sonnet", "Root-cause seats marked detached after resume");
    assert.match(human.stdout, /Model: {2}opus {2}confidence 0\.62/);
    assert.match(human.stdout, /Effort: high {2}confidence 1\.00/);
    assert.match(human.stdout, /Recorded in /);
    assertNoKey(dir, r.stdout, r.stderr, human.stdout, human.stderr);
  } finally { stub.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("a low-confidence pick falls back to the seat's default and names Jev's would-be pick", async () => {
  const stub = await stubJev(() => answer("haiku", 0.38, { haiku: 0.54, codex: 0.32, sonnet: 0.1, opus: 0.04 }, "low", 0.73));
  const dir = home({ endpoint: stub.url });
  try {
    const r = await jev(dir, "decide", "--default", "sonnet", "--json", "Add --json to habit list, with tests");
    const out = JSON.parse(r.stdout);
    assert.equal(r.code, 0);
    assert.equal(out.model, "sonnet");
    assert.equal(out.fallback.applied, true);
    assert.match(out.fallback.reason, /confidence in haiku \(0\.38\) is below the threshold 0\.4/);
    assert.equal(out.jev.model.choice, "haiku");
    assert.equal(records(dir)[0].fallback.applied, true);

    const human = await jev(dir, "decide", "--default", "sonnet", "Add --json to habit list, with tests");
    assert.match(human.stdout, /Model: {2}sonnet \(default: Jev's confidence in haiku/);
    assert.match(human.stdout, /Jev would pick: haiku \(confidence 0\.38\)/);
  } finally { stub.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("the threshold and candidates come from the config file, not code", async () => {
  const stub = await stubJev(() => answer("haiku", 0.38, { haiku: 0.38 }));
  const dir = home({
    endpoint: stub.url,
    config: { threshold: 0.3, candidates: { haiku: { runtime: "claude-code", description: "cheap" }, sonnet: { runtime: "claude-code", description: "mid" } } },
  });
  try {
    const out = JSON.parse((await jev(dir, "decide", "--json", "Fix a README typo")).stdout);
    assert.equal(out.model, "haiku");
    assert.equal(out.fallback.applied, false);
    assert.deepEqual(stub.requests[0].body.questions.model.criteria, { haiku: "cheap", sonnet: "mid" });
  } finally { stub.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("a Codex pick is marked as a runtime", async () => {
  const stub = await stubJev(() => answer("codex", 0.9, { codex: 0.9 }));
  const dir = home({ endpoint: stub.url });
  try {
    const out = JSON.parse((await jev(dir, "decide", "--json", "Implement the spec'd parser with tests")).stdout);
    assert.equal(out.model, "codex");
    assert.equal(out.runtime, "codex");
    assert.match((await jev(dir, "decide", "Implement the spec'd parser with tests")).stdout, /send the task to a Codex seat/);
  } finally { stub.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("the switch: off makes no call and returns the default; on restores Jev; status reads it from a fresh process", async () => {
  const stub = await stubJev(() => answer("opus", 0.9, { opus: 0.9 }));
  const dir = home({ endpoint: stub.url });
  try {
    assert.match((await jev(dir, "status")).stdout, /Jev routing is on\./);
    assert.equal((await jev(dir, "off")).code, 0);
    assert.equal(JSON.parse((await jev(dir, "status", "--json")).stdout).routing, "off");
    const off = JSON.parse((await jev(dir, "decide", "--default", "sonnet", "--json", "Fix a typo")).stdout);
    assert.equal(off.model, "sonnet");
    assert.equal(off.fallback.reason, "routing is off");
    assert.equal(stub.requests.length, 0);
    assert.match((await jev(dir, "decide", "--default", "sonnet", "Fix a typo")).stdout, /routing is off/);

    assert.equal((await jev(dir, "on")).code, 0);
    assert.match((await jev(dir, "status")).stdout, /Jev routing is on\./);
    const on = JSON.parse((await jev(dir, "decide", "--default", "sonnet", "--json", "Fix a typo")).stdout);
    assert.equal(on.model, "opus");
    assert.equal(stub.requests.length, 1);
  } finally { stub.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("a missing key, an unreachable or failing Jev, or a slow Jev each return the default promptly with exit 0", async () => {
  const cases = [];
  const missingKey = home({ key: false, endpoint: "http://127.0.0.1:9/v1/systemone" });
  cases.push([missingKey, /no JEV_API_KEY in /]);
  const closed = await stubJev(() => answer("opus", 1, {}));
  closed.close();
  cases.push([home({ endpoint: closed.url }), /Jev could not be reached \(ECONNREFUSED\)/]);
  const failing = await stubJev(() => ({ status: 500, json: { error: "boom" } }));
  cases.push([home({ endpoint: failing.url }), /Jev returned HTTP 500/]);
  const slow = await stubJev(() => "hang");
  cases.push([home({ endpoint: slow.url, config: { timeout_ms: 300 } }), /no answer within 300 ms/]);
  try {
    for (const [dir, reason] of cases) {
      const r = await jev(dir, "decide", "--default", "sonnet", "--json", "Fix a typo");
      assert.equal(r.code, 0);
      const out = JSON.parse(r.stdout);
      assert.equal(out.model, "sonnet");
      assert.match(out.fallback.reason, reason);
      assert.ok(r.ms < 5000, `took ${r.ms} ms`);
      assertNoKey(dir, r.stdout, r.stderr);
    }
  } finally {
    failing.close(); slow.close();
    for (const [dir] of cases) rmSync(dir, { recursive: true, force: true });
  }
});
