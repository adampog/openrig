import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ResumeMetadataRefresher } from "../src/domain/resume-metadata-refresher.js";
import { lstartToMinTs } from "../src/domain/codex-thread-id.js";
import type { SessionRegistry } from "../src/domain/session-registry.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

const roots: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const identity = "Sun Sep  6 23:52:32 2026";
const token = "019d45c3-e909-7152-b52e-34edab4070ed";
const session = { sessionId: "session-1", sessionName: "codex@rig", runtime: "codex", resumeType: null, resumeToken: null };
function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "resume-capture-retry-")); roots.push(home);
  const codexHome = path.join(home, ".codex"); fs.mkdirSync(codexHome);
  const logsPath = path.join(codexHome, "logs_2.sqlite");
  const logs = new Database(logsPath);
  logs.exec("CREATE TABLE logs (ts INTEGER, process_uuid TEXT, thread_id TEXT)"); logs.close();
  const state = new Database(path.join(codexHome, "state_5.sqlite"));
  state.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, source TEXT, rollout_path TEXT)"); state.close();
  const add = (id: string, source = "cli") => {
    const logs = new Database(logsPath);
    logs.prepare("INSERT INTO logs VALUES (?, ?, ?)").run(lstartToMinTs(identity)! + 1, "pid:901:native", id); logs.close();
    const state = new Database(path.join(codexHome, "state_5.sqlite"));
    state.prepare("INSERT INTO threads VALUES (?, ?, ?)").run(id, source, path.join(home, id + ".jsonl")); state.close();
  };
  const lines: string[] = [];
  const registry = { updateResumeToken: vi.fn(() => true), markResumeProbeResult: vi.fn(), isForkClaimingHeldToken: () => false,
    findResumeContextByName: () => ({ sessionId: session.sessionId }) } as unknown as SessionRegistry;
  const refresher = new ResumeMetadataRefresher({
    sessionRegistry: registry, tmuxAdapter: { getPanePid: async () => 900 } as TmuxAdapter,
    listProcesses: () => [{ pid: 900, ppid: 1, command: "bash" }, { pid: 901, ppid: 900, command: "codex", startedAt: identity }],
    codexHome, homeDir: home, log: line => lines.push(line), sleep: async () => {},
  });
  return { add, lines, registry, refresher, logsPath };
}

describe("S11 Codex capture diagnostics and retry", () => {
  it("S11-1: no log row reports once per session, without token text", async () => {
    const f = fixture();
    expect(await f.refresher.captureCodexThreadId(session.sessionName, { attempts: 1 })).toBeUndefined();
    expect(await f.refresher.captureCodexThreadId(session.sessionName, { attempts: 1 })).toBeUndefined();
    expect(f.lines).toEqual(["[resume-capture] codex@rig: no_log_row"]);
    expect(f.lines.join("\n")).not.toContain(token);
  });
  it("S11-2: ambiguous CLI threads are reported with count, never selected", async () => {
    const f = fixture(); f.add(token); f.add("019d45c3-e909-7152-b52e-34edab4070ee");
    expect(await f.refresher.captureCodexThreadId(session.sessionName, { attempts: 1 })).toBeUndefined();
    expect(f.lines).toEqual(["[resume-capture] codex@rig: ambiguous_threads count=2"]);
    expect(f.lines.join("\n")).not.toContain(token);
  });
  it("S11-3: a late SQLite row fills a null token on the next tick and logs redacted success once", async () => {
    const f = fixture();
    await f.refresher.refresh([session], { fillNullOnly: true });
    expect(f.registry.updateResumeToken).not.toHaveBeenCalled();
    f.add(token);
    await f.refresher.refresh([session], { fillNullOnly: true });
    expect(f.registry.updateResumeToken).toHaveBeenCalledWith(session.sessionId, "codex_id", token, "scrape");
    await f.refresher.refresh([{ ...session, resumeToken: token }], { fillNullOnly: true });
    expect(f.lines).toEqual(["[resume-capture] codex@rig: no_log_row", "[resume-capture] codex@rig: captured"]);
    expect(f.lines.join("\n")).not.toContain(token);
    expect(f.lines.join("\n")).not.toContain(token.slice(0, 8));
    console.log(f.lines.join("\n"));
  });
  it("S11-4: null discovery retries every tick in its first minute, then every fifth tick indefinitely", async () => {
    let now = 0; const read = vi.fn(() => undefined);
    const registry = { isForkClaimingHeldToken: () => false, updateResumeToken: vi.fn(), markResumeProbeResult: vi.fn() } as unknown as SessionRegistry;
    const refresher = new ResumeMetadataRefresher({ sessionRegistry: registry,
      tmuxAdapter: { getPanePid: async () => 900 } as TmuxAdapter,
      listProcesses: () => [{ pid: 901, ppid: 900, command: "codex" }],
      readCodexThreadIdByPid: read, now: () => now, log: () => {},
    });
    for (let tick = 0; tick < 4; tick++) { now = tick * 15_000; await refresher.refresh([session], { fillNullOnly: true }); }
    expect(read).toHaveBeenCalledTimes(4);
    for (let tick = 1; tick <= 25; tick++) {
      now = 60_000 + tick * 300_000;
      await refresher.refresh([session], { fillNullOnly: true });
      expect(read).toHaveBeenCalledTimes(4 + Math.floor(tick / 5));
    }
    // Existing FR-6.1 freshness reads for present tokens remain unchanged.
    read.mockReturnValue(token);
    await refresher.refresh([{ ...session, resumeToken: token }], { fillNullOnly: true });
    expect(registry.markResumeProbeResult).toHaveBeenCalledWith(session.sessionId, "resumable");
  });
  it("S11-5: shutdown cancels an unresolved adoption read, with retry by a new refresher", async () => {
    const read = vi.fn(() => new Promise<string | undefined>(() => {}));
    const deps = { sessionRegistry: {} as SessionRegistry, tmuxAdapter: { getPanePid: async () => 900 } as TmuxAdapter,
      listProcesses: () => [{ pid: 901, ppid: 900, command: "codex" }], readCodexThreadIdByPid: read, log: () => {} };
    const refresher = new ResumeMetadataRefresher(deps);
    const capture = refresher.captureCodexThreadId(session.sessionName);
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    refresher.stop();
    expect(await capture).toBeUndefined();
    const next = new ResumeMetadataRefresher({ ...deps, readCodexThreadIdByPid: () => token });
    expect(await next.captureCodexThreadId(session.sessionName)).toBe(token);
  });
  it("bounds adoption even when a dependency never settles", async () => {
    vi.useFakeTimers();
    const refresher = new ResumeMetadataRefresher({ sessionRegistry: {} as SessionRegistry,
      tmuxAdapter: { getPanePid: () => new Promise(() => {}) } as TmuxAdapter, log: () => {} });
    const capture = refresher.captureCodexThreadId(session.sessionName);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await capture).toBeUndefined();
  });
  it.each(["no_pane_pid", "no_codex_descendant", "no_cli_thread", "sqlite_unreadable"])("reports %s without raw exception data", async reason => {
    const f = fixture();
    if (reason === "no_cli_thread") f.add(token, "exec");
    if (reason === "sqlite_unreadable") fs.writeFileSync(f.logsPath, "not sqlite");
    if (reason === "no_pane_pid") (f.refresher as any).tmuxAdapter.getPanePid = async () => null;
    if (reason === "no_codex_descendant") (f.refresher as any).listProcesses = () => [];
    expect(await f.refresher.captureCodexThreadId(session.sessionName, { attempts: 1 })).toBeUndefined();
    expect(f.lines).toEqual([`[resume-capture] codex@rig: ${reason}`]);
  });
});
