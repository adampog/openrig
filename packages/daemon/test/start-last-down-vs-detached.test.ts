// S4-start-last-respects-down — the seat status `rig start --last` reads to tell a rig that was
// taken down from one that was running when the daemon stopped. Both project the same rig-level
// lifecycle, so the CLI reads the node inventory's sessionStatus (GET /api/rigs/:rigId/nodes).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { RigTeardownOrchestrator } from "../src/domain/rig-teardown.js";
import { Reconciler } from "../src/domain/reconciler.js";
import { getNodeInventory } from "../src/domain/node-inventory.js";
import { deriveRigLifecycleState } from "../src/domain/ps-projection.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { SnapshotCapture } from "../src/domain/snapshot-capture.js";

// Every tmux session is gone: what a `rig down` kill and a host reboot both leave behind.
function goneTmux(): TmuxAdapter {
  return {
    killSession: vi.fn(async () => ({ ok: true })),
    probeSession: vi.fn(async () => ({ state: "absent" })),
    hasSession: vi.fn(async () => false),
  } as unknown as TmuxAdapter;
}

describe("rig down leaves seats exited; a daemon stop leaves them detached", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let eventBus: EventBus;

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    eventBus = new EventBus(db);
  });

  afterEach(() => { db.close(); });

  function seedRunningRig(name: string): string {
    const rig = rigRepo.createRig(name);
    for (const logicalId of ["dev.impl", "dev.qa"]) {
      const node = rigRepo.addNode(rig.id, logicalId);
      const session = sessionRegistry.registerSession(node.id, `${logicalId.replace(".", "-")}@${name}`);
      sessionRegistry.updateStatus(session.id, "running");
    }
    return rig.id;
  }

  const seatStatuses = (rigId: string) => getNodeInventory(db, rigId).map((n) => n.sessionStatus);
  const rigLifecycle = (rigId: string) => deriveRigLifecycleState(getNodeInventory(db, rigId).map((n) => n.lifecycleState));

  it("reports exited after rig down and detached after a boot reconcile, with the same rig lifecycle", async () => {
    const downed = seedRunningRig("downed");
    const crashed = seedRunningRig("crashed");
    const tmux = goneTmux();

    await new RigTeardownOrchestrator({
      db, rigRepo, sessionRegistry, tmuxAdapter: tmux, eventBus,
      snapshotCapture: { captureSnapshot: vi.fn(() => ({ id: "snap-1" })), db } as unknown as SnapshotCapture,
    }).teardown(downed);
    const reconciler = new Reconciler({ db, sessionRegistry, eventBus, tmuxAdapter: tmux });
    await reconciler.reconcile(crashed);

    expect(seatStatuses(downed)).toEqual(["exited", "exited"]);
    expect(seatStatuses(crashed)).toEqual(["detached", "detached"]);
    // The rig-level projection cannot tell them apart, which is why the CLI reads the seats.
    expect(rigLifecycle(downed)).toBe(rigLifecycle(crashed));
  });

  it("a later boot reconcile does not turn a downed rig's exited seats into detached", async () => {
    const downed = seedRunningRig("downed");
    const tmux = goneTmux();
    await new RigTeardownOrchestrator({
      db, rigRepo, sessionRegistry, tmuxAdapter: tmux, eventBus,
      snapshotCapture: { captureSnapshot: vi.fn(() => ({ id: "snap-1" })), db } as unknown as SnapshotCapture,
    }).teardown(downed);

    const result = await new Reconciler({ db, sessionRegistry, eventBus, tmuxAdapter: tmux }).reconcile(downed);

    expect(result.detached).toBe(0);
    expect(seatStatuses(downed)).toEqual(["exited", "exited"]);
  });
});
