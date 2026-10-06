#!/usr/bin/env node
// jev — ask Jev (TypeSafe) which model and effort a task needs, and record the answer.
//
//   jev decide [--rig NAME] [--default MODEL] [--json] [TASK... | -]   (no TASK or "-": read stdin)
//   jev on | off | status [--json]
//   jev route [--rig NAME] [--json] [TASK... | -]     pick the implementation seat for TASK
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
  jev decide [--rig NAME] [--default MODEL] [--json] [TASK... | -]
      Ask Jev which model and effort TASK needs (stdin when TASK is omitted or "-").
      --default MODEL  the target seat's own model, used whenever Jev's pick is not used
  jev on | off       turn Jev routing on or off for every rig (takes effect on the next decision)
  jev status [--rig NAME] [--json]
  jev route [--rig NAME] [--json] [TASK... | -]
      Pick the implementation seat for TASK: the seat fixed on Jev's chosen model, or the default
      seat when Jev is unsure, routing is off, Jev is down, or the chosen seat isn't running or its
      model is failing (read from the seat's screen).
      --rig NAME overrides the asking seat's rig (otherwise read with rig whoami).
      Without a rig identity or override, use the legacy seats/default_seat config.
      Reports the picked seat, whether it is running, and the fallback dispatch seat.
      Prints the seat and effort to put in the dispatch. Never starts, stops or types into a seat.
  jev log [-n N] [--json]  recent routes: task, Jev's pick, the seat, and why
Config: ${paths.config}
Record: ${paths.record}`;

function loadConfig({ initialize = true } = {}) {
  if (!existsSync(paths.config) && initialize) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(paths.config, readFileSync(defaultsPath, "utf8"));
  }
  try {
    return { config: { ...JSON.parse(readFileSync(defaultsPath, "utf8")), ...(existsSync(paths.config) ? JSON.parse(readFileSync(paths.config, "utf8")) : {}) } };
  } catch {
    return { config: JSON.parse(readFileSync(defaultsPath, "utf8")), warning: `${paths.config} is not valid JSON; using the built-in defaults` };
  }
}

// Identity comes from the installed CLI, never from a sibling seat or the config's first rig.
// Bound the read so dispatch does not hang when the daemon is unavailable. The runtime's
// session address is a fallback; without either identity source we retain legacy behavior.
async function askingRig(explicitRig) {
  if (explicitRig) return explicitRig;
  try {
    const { stdout } = await promisify(execFile)("rig", ["whoami", "--json"], { timeout: 1500, maxBuffer: 1024 * 1024 });
    const rig = JSON.parse(stdout).identity?.rigName;
    if (typeof rig === "string" && rig) return rig;
  } catch { /* no live identity; try the runtime address below */ }
  return seatRig(process.env.OPENRIG_SESSION_NAME);
}

const seatRig = (seat) => typeof seat === "string" ? seat.split("@").at(1) || null : null;

/** Per-rig maps replace the legacy map; missing candidates inherit the shared list. */
async function selectedConfig(explicitRig, { forRoute = false, initialize = true } = {}) {
  const { config: shared, warning } = loadConfig({ initialize });
  const requestedRig = await askingRig(explicitRig);
  const legacyRig = seatRig(shared.default_seat);
  const rig = requestedRig ?? legacyRig;
  const profile = requestedRig ? shared.rigs?.[requestedRig] : null;
  if (forRoute && requestedRig && !profile && requestedRig !== legacyRig) {
    throw new Error(`No Jev seat config for rig ${requestedRig}; add rigs.${requestedRig} to ${paths.config}`);
  }
  const config = profile ? { ...shared, seats: profile.seats ?? {}, default_seat: profile.default_seat,
    candidates: profile.candidates ?? shared.candidates } : { ...shared };
  if (forRoute) {
    if (!config.default_seat || !Object.values(config.seats ?? {}).includes(config.default_seat)) {
      throw new Error(`Jev rig ${rig ?? "legacy"} needs a default_seat present in its seats map`);
    }
    if (rig && Object.values(config.seats ?? {}).some((seat) => seatRig(seat) !== rig)) {
      throw new Error(`Jev seats for rig ${rig} must all address that rig`);
    }
  }
  if (forRoute) {
    config.candidates = Object.fromEntries(Object.entries(config.candidates ?? {})
      .filter(([model]) => Object.hasOwn(config.seats ?? {}, model)));
  }
  return { config, rig, warning };
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

async function decide(task, defaultModel, selection) {
  const { config, warning, rig } = selection;
  const result = {
    time: new Date().toISOString(),
    task,
    rig,
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
  else if (!Object.keys(config.candidates ?? {}).length) result.fallback.reason = "no candidates have a seat in this rig";
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

/**
 * The model error a running seat is stuck on, if any: an error line among the last few lines above its
 * prompt. Read with `rig capture` only; an older error followed by more work does not count.
 */
async function failingModel(seat, patterns) {
  const { stdout } = await promisify(execFile)("rig", ["capture", seat, "--lines", "60"], { maxBuffer: 8 * 1024 * 1024 });
  const lines = stdout.split("\n");
  const prompt = lines.findLastIndex((l) => /^\s*[›❯](\s|$)/.test(l));
  const above = lines.slice(0, prompt < 0 ? lines.length : prompt).filter((l) => l.trim() && !/^[\s─═-]+$/.test(l)).slice(-3);
  const res = patterns.map((p) => new RegExp(p, "i"));
  return above.find((l) => res.some((re) => re.test(l)))?.trim() ?? null;
}

/** The seat a task goes to. Seats are fixed to their models; nothing here changes a seat. */
async function route(task, selection) {
  const { config, rig } = selection;
  const seats = config.seats ?? {};
  const fallbackSeat = config.default_seat;
  const defaultModel = Object.keys(seats).find((m) => seats[m] === fallbackSeat);
  const d = await decide(task, defaultModel, selection);
  const r = {
    type: "route", time: new Date().toISOString(), task, rig,
    jev: d.jev ? { model: d.jev.model.choice, confidence: d.jev.model.confidence, effort: d.jev.effort?.choice ?? null } : null,
    picked_seat: d.jev ? seats[d.jev.model.choice] ?? null : null,
    picked_model: d.jev?.model.choice ?? null, picked_running: null, fallback_seat: fallbackSeat,
    seat: fallbackSeat, model: defaultModel ?? null, effort: null, fallback: d.fallback.applied, reason: d.fallback.reason,
  };
  if (!d.fallback.applied) {
    const chosen = seats[d.model];
    let running = null;
    try { running = await runningSeats(); } catch { /* reported below */ }
    if (!chosen) r.reason = `no seat is fixed on ${d.model}`;
    else if (!running) r.reason = `rig ps unavailable, so ${chosen} could not be checked`;
    else if (!running.has(chosen)) {
      r.picked_running = false;
      r.reason = `${chosen} (${d.model}) isn't running`;
    } else {
      r.picked_running = true;
      try {
        const failing = await failingModel(chosen, config.failing_seat_patterns ?? []);
        if (failing) r.reason = `${chosen} (${d.model}) is running but its model is failing: ${failing}`;
      } catch { r.reason = `${chosen}'s screen could not be read to check its model`; }
    }
    if (!r.reason) Object.assign(r, { seat: chosen, model: d.model, effort: d.effort, fallback: false, reason: null });
    if (r.reason) r.fallback = true;
  }
  // A record that can't be written never stops dispatch: the seat is still returned, with the error.
  try { appendFileSync(paths.record, `${JSON.stringify(r)}\n`); } catch (err) { r.record_error = err?.code ?? "write failed"; }
  return r;
}

const routeLine = (r) => `${r.time.slice(0, 19)}  [rig: ${r.rig ?? seatRig(r.seat) ?? "legacy"}]  ${r.seat}  ${r.model ?? "?"}${r.effort ? `/${r.effort}` : ""}  `
  + `[Jev: ${r.jev ? `${r.jev.model} ${fmt(r.jev.confidence)}` : "no pick"}]  ${r.fallback ? `default: ${r.reason}` : "Jev's pick"}  — ${r.task.slice(0, 60)}`;

async function main(argv) {
  const [command, ...args] = argv;
  // Help exits before reading stdin, config, identity, secrets, or calling Jev.
  if (command === "--help" || command === "-h" || args.includes("--help") || args.includes("-h")) {
    console.log(USAGE);
    return 0;
  }
  let explicitRig;
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--rig") {
      explicitRig = args[++i];
      if (!explicitRig || explicitRig.startsWith("-")) {
        console.error("--rig needs a rig name");
        return 2;
      }
    } else rest.push(args[i]);
  }
  const json = rest.includes("--json");
  if (command === "on" || command === "off") {
    setRouting(command);
    console.log(`Jev routing is ${command}.`);
    return 0;
  }
  if (command === "status") {
    const { rig } = await selectedConfig(explicitRig, { initialize: false });
    const status = { rig, routing: routingOn() ? "on" : "off", key: readKey() ? "found" : "missing", config: paths.config, record: paths.record };
    console.log(json ? JSON.stringify(status) : `Jev routing is ${status.routing}. API key: ${status.key}.\nRig: ${status.rig ?? "legacy"}\nConfig: ${status.config}\nRecord: ${status.record}`);
    return 0;
  }
  if (command === "route") {
    const words = rest.filter((w) => w !== "--json");
    const task = (words.length && words.join(" ") !== "-" ? words.join(" ") : await readStdin()).trim();
    if (!task) { console.error(`jev route needs a task.\n\n${USAGE}`); return 2; }
    const selection = await selectedConfig(explicitRig, { forRoute: true });
    const r = await route(task, selection);
    console.log(json ? JSON.stringify(r) : [
      `Rig: ${r.rig ?? "legacy"}`,
      `Dispatch to: ${r.seat}  (${r.model ?? "its fixed model"})`,
      r.picked_seat ? `Picked seat: ${r.picked_seat} (${r.picked_model}); ${r.picked_running === false ? "not running" : r.picked_running === true ? "running" : "running state not checked"}` : null,
      `Fallback seat: ${r.fallback_seat}`,
      `Effort: ${r.effort ?? "the seat's usual"}`,
      r.jev ? `Jev picked ${r.jev.model} (confidence ${fmt(r.jev.confidence)})${r.jev.effort ? `, effort ${r.jev.effort}` : ""}` : null,
      r.fallback ? `Default seat because: ${r.reason}` : null,
      `Put in the row body: Jev: ${r.model ?? "default"}${r.effort ? `, effort ${r.effort}` : ""}${r.fallback ? ` (default: ${r.reason})` : ""}`,
      r.record_error ? `Not recorded (${r.record_error}); jev log won't show this task` : null,
    ].filter(Boolean).join("\n"));
    return 0;
  }
  if (command === "log") {
    const n = rest.includes("-n") ? Number(rest[rest.indexOf("-n") + 1]) || 20 : 20;
    let text = "";
    try { text = readFileSync(paths.record, "utf8"); } catch { /* no record yet */ }
    let skipped = 0;
    const entries = text.split("\n").filter((l) => l.trim()).flatMap((l) => {
      try { return [JSON.parse(l)]; } catch { skipped++; return []; }
    }).filter((e) => e.type === "route").slice(-n);
    const note = skipped ? `${skipped} unreadable line(s) in ${paths.record} skipped` : null;
    if (json) console.log(JSON.stringify(entries));
    else console.log([entries.map(routeLine).join("\n") || "No routed tasks yet.", note].filter(Boolean).join("\n"));
    if (json && note) console.error(note);
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
    const result = await decide(task, defaultModel, await selectedConfig(explicitRig));
    console.log(json ? JSON.stringify(result) : human(result));
    return 0;
  }
  console.log(USAGE);
  return command === undefined || command === "help" || command === "--help" ? 0 : 2;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (err) {
  console.error(err.message);
  process.exitCode = 2;
}
