import { afterEach, describe, expect, it, vi } from "vitest";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { TerminalService } from "../src/domain/terminal/terminal-service.js";
import { HerdrAdapter } from "../src/domain/terminal/herdr-adapter.js";
import type { HerdrTransport } from "../src/domain/terminal/herdr-transport.js";

const RIG = "OmarchyTheme-build";
const SEAT = `infra-server2@${RIG}`;
const dbs: ReturnType<typeof createFullTestDb>[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

function fixture(labels = [RIG], alive = true, applyFails = false, rigName = RIG) {
  const rigLabel = rigName;
  const seat = `infra-server2@${rigLabel}`;
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  const probe = vi.fn(async () => ({ alive }));
  const transport: HerdrTransport = {
    probe,
    request: async (method, params) => {
      requests.push({ method, params: params as Record<string, unknown> });
      if (method === "workspace.list") return { type: "workspace_list", workspaces: labels.map((label, i) => ({ workspace_id: `w${i}`, label })) };
      if (method === "workspace.create") return { type: "workspace_created", workspace: { workspace_id: "fresh" }, tab: { tab_id: "blank" } };
      if (method === "tab.focus" || method === "tab.close") return { type: "ok" };
      if (method === "layout.apply") {
        if (applyFails) throw new Error("fixture apply failed");
        return { type: "layout_apply", layout: { workspace_id: "w0", tab_id: "new-tab" } };
      }
      if (method === "pane.list") return { type: "pane_list", panes: [seat, `infra-server@${rigLabel}`].map(label => ({ tab_id: "new-tab", label })) };
      throw new Error(`Unexpected Herdr method: ${method}`);
    },
  };
  const adapter = new HerdrAdapter({ transportFactory: () => transport, newLaunchToken: () => "join" });
  const svc = new TerminalService({
    resolveProvider: name => name === "herdr" ? adapter : null,
    viewsStore: { get: () => null, list: () => [] },
    listRigSeats: name => name === rigLabel ? ["infra-server", "infra-server2"].map(s => ({ canonicalSessionName: `${s}@${rigLabel}`, attachmentType: "tmux", tmuxSession: `${s}@${rigLabel}`, rigName: rigLabel })) : null,
    listPodSeats: (arg, pod) => [rigLabel, "web-rig-id"].includes(arg) && pod === "infra"
      ? ["infra-server", "infra-server2"].map(s => ({ canonicalSessionName: `${s}@${rigLabel}`, attachmentType: "tmux", tmuxSession: `${s}@${rigLabel}`, rigName: rigLabel })) : null,
    listScopeSeats: () => null, listRigNames: () => [rigLabel],
    resolveHost: () => null, hasSession: () => true,
    resolveLocalTmux: () => "/fixture/tmux",
  });
  const db = createFullTestDb(); dbs.push(db);
  const setup = createTestApp(db, { appDeps: { terminalService: svc } });
  const rig = setup.rigRepo.createRig(rigLabel);
  async function add(noView?: boolean) {
    const expanded = await setup.rigExpansionService.expand({ rigId: rig.id, pod: {
      id: "infra", label: "Infrastructure", members: [{ id: "server", runtime: "terminal", agentRef: "builtin:terminal", profile: "none", cwd: "/tmp" }], edges: [],
    } });
    expect(expanded.ok).toBe(true);
    const res = await setup.app.request(`/api/rigs/${rig.id}/pods/infra/members`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ member: { id: "server2", runtime: "terminal", agent_ref: "builtin:terminal", profile: "none", cwd: "/tmp" }, ...(noView === undefined ? {} : { noView }) }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.result.node.status).toBe("launched");
    return body;
  }
  return { add, requests, probe, svc, transport, setup, rig };
}

describe("add member joins the existing rig wall through a fake Herdr", () => {
  it.each([RIG, "web-rig-id"])("pod open with rig argument %s joins the canonical wall", async arg => {
    const f = fixture([RIG]);
    const result = await f.svc.openView({ view: `pod:${arg}/infra` });
    expect(result).toMatchObject({ ok: true, opened: [`infra-server@${RIG}`, SEAT] });
    expect(f.requests.find(r => r.method === "layout.apply")?.params).toMatchObject({ workspace_id: "w0", focus: true });
    expect(f.requests.some(r => r.method === "workspace.create")).toBe(false);
  });
  it("pod open without a wall keeps the existing fresh pod workspace behavior", async () => {
    const f = fixture([]);
    expect(await f.svc.openView({ view: `pod:${RIG}/infra` })).toMatchObject({ ok: true });
    expect(f.requests.find(r => r.method === "workspace.create")?.params).toMatchObject({ label: `pod:${RIG}/infra` });
    expect(f.requests.find(r => r.method === "layout.apply")?.params).toMatchObject({ workspace_id: "fresh" });
  });
  it("bare rig open remains a fresh workspace even with an open wall", async () => {
    const f = fixture([RIG]);
    expect(await f.svc.openView({ view: RIG })).toMatchObject({ ok: true });
    expect(f.requests.find(r => r.method === "workspace.create")?.params).toMatchObject({ label: RIG });
  });
  it("failed pod join never falls back to creating a duplicate space", async () => {
    const f = fixture([RIG], true, true);
    const result = await f.svc.openView({ view: "pod:web-rig-id/infra" });
    expect(result).toMatchObject({ ok: false, code: "herdr_join_failed", error: expect.stringContaining("fixture apply failed") });
    expect(result.degraded.map(s => s.seat)).toEqual([`infra-server@${RIG}`, SEAT]);
    expect(f.requests.map(r => r.method)).toEqual(["workspace.list", "layout.apply"]);
  });
  it("does not retry an unconfirmed join or create a fallback workspace", async () => {
    const f = fixture();
    const original = f.transport.request;
    vi.spyOn(f.transport, "request").mockImplementation(async (method, params) => {
      const result = await original(method, params);
      return method === "layout.apply" ? { type: "layout_apply" } : result;
    });
    const body = await f.add();
    expect(body.result.warnings.join(" ")).toContain("unconfirmed");
    expect(f.requests.map(r => r.method)).toEqual(["workspace.list", "layout.apply"]);
  });
  it("preserves the asking rig's OmarchyPlugin-build capitals", async () => {
    const f = fixture(["omarchyplugin-build", "OmarchyPlugin-build"], true, false, "OmarchyPlugin-build");
    await f.add();
    expect(f.requests.find(r => r.method === "layout.apply")?.params).toMatchObject({ workspace_id: "w1", root: { label: "infra-server2@OmarchyPlugin-build" } });
  });
  it("appends only the new seat to the exact rig label without changing existing tabs", async () => {
    const f = fixture(["omarchytheme-build", RIG, `pod:${RIG}/infra`]);
    await f.add();
    expect(f.requests.map(r => r.method)).toContain("layout.apply");
    const apply = f.requests.find(r => r.method === "layout.apply")!;
    expect(apply.params).toMatchObject({ workspace_id: "w1", focus: false, root: { type: "pane", label: SEAT, command: ["sh", "-c", expect.stringContaining("/fixture/tmux")] } });
    expect(JSON.stringify(apply.params)).not.toContain(`infra-server@${RIG}`);
    expect(f.requests.every(r => ["workspace.list", "layout.apply", "pane.list"].includes(r.method))).toBe(true);
  });
  it("leaves views alone when no exact wall is open", async () => {
    const f = fixture(["omarchytheme-build", `pod:${RIG}/infra`]);
    await f.add();
    expect(f.requests.map(r => r.method)).toEqual(["workspace.list"]);
  });
  it("--no-view skips even the Herdr probe", async () => {
    const f = fixture(); await f.add(true);
    expect(f.probe).not.toHaveBeenCalled(); expect(f.requests).toEqual([]);
  });
  it("adds normally when Herdr is unavailable", async () => {
    const f = fixture([RIG], false); await f.add();
    expect(f.probe).toHaveBeenCalled(); expect(f.requests).toEqual([]);
  });
  it("does not guess between duplicate exact-label walls", async () => {
    const f = fixture([RIG, RIG]);
    const body = await f.add();
    expect(f.requests.map(r => r.method)).toEqual(["workspace.list"]);
    expect(body.result.warnings.join(" ")).toContain("multiple");
  });
  it("preserves the launched seat and reports a failed join without creating a space", async () => {
    const f = fixture([RIG], true, true);
    const body = await f.add();
    expect(body.result.warnings.join(" ")).toContain("fixture apply failed");
    expect(f.requests.map(r => r.method)).toEqual(["workspace.list", "layout.apply"]);
  });
  it("reports an unattachable inventory seat without creating a view", async () => {
    const f = fixture();
    expect(await f.svc.joinRigWall(RIG, `missing@${RIG}`)).toMatchObject({ ok: false, code: "seat_not_attachable" });
    expect(f.probe).not.toHaveBeenCalled();
  });
  it("does not access Herdr on a rejected add", async () => {
    const f = fixture();
    const res = await f.setup.app.request(`/api/rigs/${f.rig.id}/pods/missing/members`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ member: { id: "server2", runtime: "terminal", agent_ref: "builtin:terminal", profile: "none", cwd: "/tmp" } }),
    });
    expect(res.status).toBe(404); expect(f.probe).not.toHaveBeenCalled();
  });
});
