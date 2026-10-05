#!/usr/bin/env node
// jev — ask Jev (TypeSafe) which model and effort a task needs, and record the answer.
//
//   jev decide [--default MODEL] [--json] [TASK... | -]   (no TASK or "-": read stdin)
//   jev on | off | status [--json]
//   jev route [--json] [TASK... | -]     pick the implementation seat for TASK
//   jev log [-n N] [--json]
//
// Everything lives under $OPENRIG_HOME (default ~/.openrig):
//   jev/config.json        threshold, candidates, efforts, seats (keys missing here come from jev.defaults.json)
//   jev/routing            the on/off switch; absent means on
//   jev/decisions.jsonl    one JSON line per decision and per route
//   secrets/jev.env        JEV_API_KEY, read here and never printed or recorded
//
// A decision always exits 0: when routing is off, the key is missing, Jev is
// unreachable or unsure, the result is the seat's default model (--default) and
// says why. Dispatch never waits on Jev.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const home = process.env.OPENRIG_HOME || path.join(homedir(), ".openrig");
const dir = path.join(home, "jev");
const paths = {
  config: path.join(dir, "config.json"),
  routing: path.join(dir, "routing"),
  record: path.join(dir, "decisions.jsonl"),
  secret: path.join(home, "secrets", "jev.env"),
};
const defaultsPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "jev.defaults.json");

const USAGE = `Usage:
  jev decide [--default MODEL] [--json] [TASK... | -]
      Ask Jev which model and effort TASK needs (stdin when TASK is omitted or "-").
      --default MODEL  the target seat's own model, used whenever Jev's pick is not used
  jev on | off       turn Jev routing on or off for every rig (takes effect on the next decision)
  jev status [--json]
  jev route [--json] [TASK... | -]
      Pick the implementation seat for TASK: the seat fixed on Jev's chosen model, or the default
      seat when Jev is unsure, routing is off, Jev is down, or the chosen seat isn't running.
      Prints the seat and effort to put in the dispatch. Never types into any seat.
  jev log [-n N] [--json]  recent routes: task, Jev's pick, the seat, and why
Config: ${paths.config}
Record: ${paths.record}`;

function loadConfig() {
  if (!existsSync(paths.config)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(paths.config, readFileSync(defaultsPath, "utf8"));
  }
  try {
    return { config: { ...JSON.parse(readFileSync(defaultsPath, "utf8")), ...JSON.parse(readFileSync(paths.config, "utf8")) } };
  } catch {
    return { config: JSON.parse(readFileSync(defaultsPath, "utf8")), warning: `${paths.config} is not valid JSON; using the built-in defaults` };
  }
}

function routingOn() {
  try { return readFileSync(paths.routing, "utf8").trim() !== "off"; } catch { return true; }
}

function setRouting(state) {
  mkdirSync(dir, { recursive: true });
  const tmp = `${paths.routing}.${process.pid}.tmp`;
  writeFileSync(tmp, `${state}\n`);
  renameSync(tmp, paths.routing);
}

function readKey() {
  let text;
  try { text = readFileSync(paths.secret, "utf8"); } catch { return null; }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^export\s+/, "");
    if (!line.startsWith("JEV_API_KEY=")) continue;
    const value = line.slice("JEV_API_KEY=".length).trim().replace(/^(["'])(.*)\1$/, "$2");
    return value || null;
  }
  return null;
}

/** One call, two questions. Returns the answers or a reason it could not. Never includes the key. */
async function askJev(task, config, key) {
  const body = {
    state: `A software engineering task to be given to an AI coding agent:\n\n${task}`,
    model: config.jev_model,
    questions: {
      model: {
        type: "choice",
        instructions: "Which model should do this task? Pick the cheapest one that will reliably complete it well; choose a more capable, more expensive one only when the task needs it.",
        criteria: Object.fromEntries(Object.entries(config.candidates).map(([name, c]) => [name, c.description])),
      },
      effort: {
        type: "choice",
        instructions: "How much reasoning effort the chosen model should spend on this task.",
        criteria: config.efforts,
      },
    },
  };
  const started = Date.now();
  let response;
  try {
    response = await fetch(config.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.timeout_ms),
    });
  } catch (err) {
    const why = err?.name === "TimeoutError" ? `no answer within ${config.timeout_ms} ms`
      : err?.cause?.code ?? err?.name ?? "network error";
    return { reason: `Jev could not be reached (${why})` };
  }
  if (!response.ok) return { reason: `Jev returned HTTP ${response.status}` };
  let data;
  try { data = await response.json(); } catch { return { reason: "Jev's answer was not valid JSON" }; }
  const pick = (q) => {
    const a = data?.answers?.[q];
    return a && typeof a.choice === "string" ? { choice: a.choice, confidence: a.confidence, probabilities: a.probabilities } : null;
  };
  const model = pick("model");
  const effort = pick("effort");
  if (!model || !(model.choice in config.candidates)) return { reason: "Jev's answer did not name a known candidate" };
  return { jev: { model, effort, jev_model: data.model ?? null, latency_ms: Date.now() - started } };
}

async function decide(task, defaultModel) {
  const { config, warning } = loadConfig();
  const result = {
    time: new Date().toISOString(),
    task,
    routing: routingOn() ? "on" : "off",
    model: defaultModel ?? "seat-default",
    runtime: null,
    effort: null,
    default_model: defaultModel ?? null,
    threshold: config.threshold,
    fallback: { applied: true, reason: null },
    jev: null,
    ...(warning ? { warning } : {}),
  };
  const key = result.routing === "on" ? readKey() : null;
  if (result.routing === "off") result.fallback.reason = "routing is off";
  else if (!key) result.fallback.reason = `no JEV_API_KEY in ${paths.secret}`;
  else {
    const asked = await askJev(task, config, key);
    if (asked.reason) result.fallback.reason = asked.reason;
    else {
      result.jev = asked.jev;
      result.effort = asked.jev.effort?.choice ?? null;
      const { choice, confidence } = asked.jev.model;
      if (typeof confidence === "number" && confidence >= config.threshold) {
        result.model = choice;
        result.runtime = config.candidates[choice].runtime ?? null;
        result.fallback = { applied: false, reason: null };
      } else {
        result.fallback.reason = `Jev's confidence in ${choice} (${fmt(confidence)}) is below the threshold ${config.threshold}`;
      }
    }
  }
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(paths.record, `${JSON.stringify(result)}\n`);
    result.recorded = paths.record;
  } catch (err) {
    result.recorded = null;
    result.record_error = err?.code ?? "write failed";
  }
  return result;
}

const fmt = (n) => (typeof n === "number" ? n.toFixed(2) : "?");

function human(r) {
  const lines = [];
  const seatDefault = r.default_model ?? "the seat's default model";
  if (r.fallback.applied) {
    lines.push(`Model:  ${seatDefault} (default: ${r.fallback.reason})`);
    if (r.jev) lines.push(`Jev would pick: ${r.jev.model.choice} (confidence ${fmt(r.jev.model.confidence)})`);
  } else {
    lines.push(`Model:  ${r.model}  confidence ${fmt(r.jev.model.confidence)}`);
    if (r.runtime === "codex") lines.push("Runtime: codex. This is a runtime, not a Claude model: send the task to a Codex seat.");
  }
  lines.push(r.jev?.effort ? `Effort: ${r.jev.effort.choice}  confidence ${fmt(r.jev.effort.confidence)}` : "Effort: the seat's default");
  if (r.jev) lines.push(`Probabilities: ${Object.entries(r.jev.model.probabilities ?? {}).map(([k, v]) => `${k} ${fmt(v)}`).join(", ")}`);
  if (r.warning) lines.push(`Warning: ${r.warning}`);
  lines.push(r.recorded ? `Recorded in ${r.recorded}` : `Not recorded (${r.record_error})`);
  return lines.join("\n");
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

async function runningSeats() {
  const { stdout } = await promisify(execFile)("rig", ["ps", "--nodes", "--json"], { maxBuffer: 8 * 1024 * 1024 });
  return new Set((JSON.parse(stdout).entries ?? [])
    .filter((e) => e.sessionStatus === "running" && e.startupStatus === "ready")
    .map((e) => e.canonicalSessionName));
}

/** The seat a task goes to. Seats are fixed to their models; nothing here changes a seat. */
async function route(task) {
  const { config } = loadConfig();
  const seats = config.seats ?? {};
  const fallbackSeat = config.default_seat;
  const defaultModel = Object.keys(seats).find((m) => seats[m] === fallbackSeat);
  const d = await decide(task, defaultModel);
  const r = {
    type: "route", time: new Date().toISOString(), task,
    jev: d.jev ? { model: d.jev.model.choice, confidence: d.jev.model.confidence, effort: d.jev.effort?.choice ?? null } : null,
    seat: fallbackSeat, model: defaultModel ?? null, effort: null, fallback: d.fallback.applied, reason: d.fallback.reason,
  };
  if (!d.fallback.applied) {
    const chosen = seats[d.model];
    let running = null;
    try { running = await runningSeats(); } catch { /* reported below */ }
    if (!chosen) r.reason = `no seat is fixed on ${d.model}`;
    else if (!running) r.reason = `rig ps unavailable, so ${chosen} could not be checked`;
    else if (!running.has(chosen)) r.reason = `${chosen} (${d.model}) isn't running`;
    else Object.assign(r, { seat: chosen, model: d.model, effort: d.effort, fallback: false, reason: null });
    if (r.reason) r.fallback = true;
  }
  appendFileSync(paths.record, `${JSON.stringify(r)}\n`);
  return r;
}

const routeLine = (r) => `${r.time.slice(0, 19)}  ${r.seat}  ${r.model ?? "?"}${r.effort ? `/${r.effort}` : ""}  `
  + `[Jev: ${r.jev ? `${r.jev.model} ${fmt(r.jev.confidence)}` : "no pick"}]  ${r.fallback ? `default: ${r.reason}` : "Jev's pick"}  — ${r.task.slice(0, 60)}`;

async function main(argv) {
  const [command, ...rest] = argv;
  const json = rest.includes("--json");
  if (command === "on" || command === "off") {
    setRouting(command);
    console.log(`Jev routing is ${command}.`);
    return 0;
  }
  if (command === "status") {
    const status = { routing: routingOn() ? "on" : "off", key: readKey() ? "found" : "missing", config: paths.config, record: paths.record };
    console.log(json ? JSON.stringify(status) : `Jev routing is ${status.routing}. API key: ${status.key}.\nConfig: ${status.config}\nRecord: ${status.record}`);
    return 0;
  }
  if (command === "route") {
    const words = rest.filter((w) => w !== "--json");
    const task = (words.length && words.join(" ") !== "-" ? words.join(" ") : await readStdin()).trim();
    if (!task) { console.error(`jev route needs a task.\n\n${USAGE}`); return 2; }
    const r = await route(task);
    console.log(json ? JSON.stringify(r) : [
      `Dispatch to: ${r.seat}  (${r.model ?? "its fixed model"})`,
      `Effort: ${r.effort ?? "the seat's usual"}`,
      r.jev ? `Jev picked ${r.jev.model} (confidence ${fmt(r.jev.confidence)})${r.jev.effort ? `, effort ${r.jev.effort}` : ""}` : null,
      r.fallback ? `Default seat because: ${r.reason}` : null,
      `Put in the row body: Jev: ${r.model ?? "default"}${r.effort ? `, effort ${r.effort}` : ""}${r.fallback ? ` (default: ${r.reason})` : ""}`,
    ].filter(Boolean).join("\n"));
    return 0;
  }
  if (command === "log") {
    const n = rest.includes("-n") ? Number(rest[rest.indexOf("-n") + 1]) || 20 : 20;
    let entries = [];
    try { entries = readFileSync(paths.record, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.type === "route"); } catch { /* no record yet */ }
    entries = entries.slice(-n);
    console.log(json ? JSON.stringify(entries) : entries.map(routeLine).join("\n") || "No routed tasks yet.");
    return 0;
  }
  if (command === "decide") {
    let defaultModel;
    const words = [];
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--json") continue;
      if (rest[i] === "--default") { defaultModel = rest[++i]; continue; }
      words.push(rest[i]);
    }
    const task = (words.length && words.join(" ") !== "-" ? words.join(" ") : await readStdin()).trim();
    if (!task) { console.error(`jev decide needs a task.\n\n${USAGE}`); return 2; }
    const result = await decide(task, defaultModel);
    console.log(json ? JSON.stringify(result) : human(result));
    return 0;
  }
  console.log(USAGE);
  return command === undefined || command === "help" || command === "--help" ? 0 : 2;
}

process.exitCode = await main(process.argv.slice(2));
