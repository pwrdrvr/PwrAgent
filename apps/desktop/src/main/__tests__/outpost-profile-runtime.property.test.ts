import fc from "fast-check";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { RuntimeLeaseManager as SharedManager } from "@pwragent/owner-core/runtime-lease-manager";
import { StateDb } from "@pwragent/sqlite-storage/state-db";
import { AppRuntimeInstanceStore } from "@pwragent/sqlite-storage/app-runtime-instance-store";
import { startProfileRuntimeHeartbeat } from "@pwragent/sqlite-storage/profile-runtime-markers";
import { measureSqliteWrites } from "@pwragent/sqlite-storage/sqlite-write-metrics";
import { RuntimeLeaseManager as DesktopManager } from "../runtime-lease-manager";
import { openOutpostProfileRuntime } from "../../../../../packages/pwragent/src/federation-core";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "outpost-profile-"));
  roots.push(root);
  const db = StateDb.open(path.join(root, "state.db"), { profileName: "fixture" });
  return { root, db, store: new AppRuntimeInstanceStore(db) };
}
const budgetFile = "outpost-sqlite-write-budgets.json";
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

it("binds desktop to the functioning shared manager rather than another owner implementation", () => {
  expect(DesktopManager.prototype).toBeInstanceOf(SharedManager);
  expect(Object.getOwnPropertyNames(DesktopManager.prototype)).toEqual(["constructor"]);
});

// Independent model: each resource has at most one live owner. Only its owner
// may release it; a different process cannot take it while that owner is live.
it("matches live-owner exclusion across generated desktop/portable acquisitions and releases", () => {
  fc.assert(fc.property(fc.array(fc.record({
    actor: fc.integer({ min: 0, max: 2 }),
    kind: fc.constantFrom("federation", "messaging", "mcp_connections"),
    acquire: fc.boolean(),
  }), { minLength: 1, maxLength: 60 }), commands => {
    const { root, db } = fixture();
    const other = StateDb.open(path.join(root, "state.db"));
    const managers = [DesktopManager, SharedManager, SharedManager].map((Manager, actor) => new Manager({
      instanceId: `runtime-v2-actor-${actor}`, profileName: "fixture", processId: 100 + actor,
      startedAt: 1_000, cwd: root, now: () => 2_000, systemBootedAt: 0,
      store: new AppRuntimeInstanceStore(actor % 2 ? other : db), runtimeIdentityIsAlive: () => true,
    }));
    const model = new Map<string, number>();
    try {
      for (const command of commands) {
        const manager = managers[command.actor]!;
        const holder = model.get(command.kind);
        if (command.acquire) {
          const accepted = holder === undefined || holder === command.actor;
          expect(manager.acquire(command.kind).acquired).toBe(accepted);
          if (accepted) model.set(command.kind, command.actor);
        } else {
          expect(manager.release(command.kind)).toBe(holder === command.actor);
          if (holder === command.actor) model.delete(command.kind);
        }
        for (const [actor, observer] of managers.entries()) {
          expect(observer.snapshot(command.kind).leaseHeld).toBe(model.get(command.kind) === actor);
        }
      }
    } finally { other.close(); db.close(); }
  }), { numRuns: 35 });
});

it("measures the actual Outpost binding lifecycle and one idle hour separately from schema setup", async () => {
  vi.stubEnv("PWRAGENT_DEV_SQLITE_WRITE_METRICS", "1");
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const { root, db, store } = fixture();
  try {
    const lifecycle = await measureSqliteWrites(async () => {
      const runtime = openOutpostProfileRuntime({ stateDirectory: root, profileName: "fixture", cwd: root });
      expect(Object.keys(runtime)).toEqual(["close", "openOwnerStorage"]);
      const idle = await measureSqliteWrites(() => vi.advanceTimersByTime(3_600_000));
      expectSqliteWriteBudget({ scenario: "outpost-idle-hour", note: "One idle hour, profile markers refreshed; no SQLite heartbeat", budgetFile, writes: idle.writes });
      expect(store.getFederationLease()?.status).toBe("active");
      expect(store.getMessagingLease()?.status).toBe("active");
      runtime.close();
      const repeated = await measureSqliteWrites(() => runtime.close());
      expect(repeated.writes.commits).toBe(0);
    });
    expectSqliteWriteBudget({ scenario: "outpost-profile-lifecycle", note: "Register, acquire both leases, release both and mark exited; schema excluded", budgetFile, writes: lifecycle.writes });
    expect(store.getFederationLease()?.status).toBe("released");
    expect(store.getMessagingLease()?.status).toBe("released");
  } finally { db.close(); }
});

it("rolls back acquired runtime resources on either held lease and preserves the live holder", async () => {
  await fc.assert(fc.asyncProperty(fc.constantFrom("federation", "messaging"), async kind => {
    const { root, db, store } = fixture();
    const startedAt = Date.now();
    const holder = new DesktopManager({
      instanceId: "runtime-v2-held", processId: process.ppid, startedAt,
      profileName: "fixture", cwd: root, systemBootedAt: 0, store,
    });
    const heartbeat = startProfileRuntimeHeartbeat("fixture", {
      markerDir: path.join(root, "runtime-instances"), instanceId: holder.id,
      processId: process.ppid, startedAt,
    });
    try {
      expect(holder.acquire(kind).acquired).toBe(true);
      const prior = kind === "federation" ? store.getFederationLease() : store.getMessagingLease();
      expect(() => openOutpostProfileRuntime({ stateDirectory: root, profileName: "fixture", cwd: root }))
        .toThrow(/Profile .* lease is held/);
      expect(kind === "federation" ? store.getFederationLease() : store.getMessagingLease()).toEqual(prior);
      if (kind === "messaging") expect(store.getFederationLease()?.status).toBe("released");
      expect(holder.snapshot(kind).leaseHeld).toBe(true);
    } finally { heartbeat.stop(); db.close(); }
  }), { numRuns: 10 });
});

it("retires the runtime identity and any earlier lease when a startup statement is refused", () => {
  const refusals = [
    "CREATE TRIGGER refuse_runtime BEFORE INSERT ON app_runtime_instances BEGIN SELECT RAISE(ABORT, 'fixture refusal'); END",
    "CREATE TRIGGER refuse_runtime BEFORE INSERT ON messaging_runtime_lease WHEN NEW.lease_key = 'profile-federation' BEGIN SELECT RAISE(ABORT, 'fixture refusal'); END",
    "CREATE TRIGGER refuse_runtime BEFORE INSERT ON messaging_runtime_lease WHEN NEW.lease_key = 'profile-messaging' BEGIN SELECT RAISE(ABORT, 'fixture refusal'); END",
  ];
  fc.assert(fc.property(fc.constantFrom(...refusals), refusal => {
    const { root, db } = fixture();
    try {
      db.raw.exec(refusal);
      expect(() => openOutpostProfileRuntime({ stateDirectory: root, profileName: "fixture", cwd: root })).toThrow("fixture refusal");
      expect(db.raw.prepare("SELECT count(*) AS n FROM messaging_runtime_lease WHERE status = 'active'").get()).toEqual({ n: 0 });
      expect(db.raw.prepare("SELECT count(*) AS n FROM app_runtime_instances WHERE exited_at IS NULL").get()).toEqual({ n: 0 });
    } finally { db.close(); }
  }), { numRuns: 12 });
});

it("preserves the Outpost CLI's existing profile-name and state-path contract", () => {
  fc.assert(fc.property(fc.tuple(
    fc.constantFrom(..."aAZ09"), fc.array(fc.constantFrom(..."abAZ09_-"), { maxLength: 63 }),
  ), ([first, rest]) => {
    const { root, db, store } = fixture();
    try {
      const profileName = first + rest.join("");
      const runtime = openOutpostProfileRuntime({ stateDirectory: root, profileName, cwd: root });
      const owner = store.getFederationLease()!.ownerInstanceId;
      expect(store.getInstance(owner)?.profileName).toBe(profileName);
      runtime.close();
    } finally { db.close(); }
  }), { numRuns: 15 });
});
