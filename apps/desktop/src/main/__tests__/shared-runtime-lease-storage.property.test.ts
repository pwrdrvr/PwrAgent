import fc from "fast-check";
import { afterEach, expect, it, vi } from "vitest";
import { AppRuntimeInstanceStore as SharedStore } from "@pwragent/sqlite-storage/app-runtime-instance-store";
import { StateDb } from "@pwragent/sqlite-storage/state-db";
import { AppRuntimeInstanceStore as DesktopStore } from "../storage/app-runtime-instance-store";
import { AppRuntimeInstanceStore as CompatibilityStore } from "../state/app-runtime-instance-store";
import { RUNTIME_LEASE_DEAD_OWNER_GRACE_MS, type MessagingRuntimeLeaseRecord, type RuntimeLeaseStorage } from "@pwragent/owner-core/runtime-lease-storage";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

const kinds = ["messaging", "federation", "mcp"] as const;
type Kind = typeof kinds[number];
const bindings = [SharedStore, DesktopStore, CompatibilityStore];
function read(store: RuntimeLeaseStorage, kind: Kind) {
  return kind === "messaging" ? store.getMessagingLease()
    : kind === "federation" ? store.getFederationLease() : store.getMcpConnectionsLease();
}
function acquire(store: RuntimeLeaseStorage, kind: Kind, instanceId: string, now: number,
  isOwnerAlive: (owner: { instanceId: string }) => boolean, immediate: boolean) {
  if (kind === "mcp") return store.acquireMcpConnectionsLease({ instanceId, now, isOwnerAlive });
  const params = { instanceId, now, isOwnerAlive, canReclaimOwnerImmediately: () => immediate };
  return kind === "messaging" ? store.acquireMessagingLease(params)
    : store.acquireFederationLease(params);
}
function release(store: RuntimeLeaseStorage, kind: Kind, instanceId: string, now: number) {
  const params = { instanceId, now };
  return kind === "messaging" ? store.releaseMessagingLease(params)
    : kind === "federation" ? store.releaseFederationLease(params) : store.releaseMcpConnectionsLease(params);
}

afterEach(() => vi.unstubAllEnvs());

it("binds desktop construction and state compatibility to the functioning portable lease implementation", () => {
  fc.assert(fc.property(fc.constantFrom("portable", "desktop", "state"), binding => {
    const constructors = { portable: SharedStore, desktop: DesktopStore, state: CompatibilityStore };
    expect(constructors[binding]).toBe(SharedStore);
  }));
});

it("does not retain a desktop-only class behind state compatibility exports", () => {
  expect(CompatibilityStore).toBe(SharedStore);
});

it("keeps the MCP death grace when the shared test driver requests immediate reclamation", () => {
  const { dbPath, tempDir } = createTempStateDb("shared-mcp-grace-");
  const db = StateDb.open(dbPath);
  const store = new SharedStore(db);
  try {
    for (const instanceId of ["owner", "challenger"]) store.recordInstanceStart({
      instanceId, processId: 123, profileName: "fixture", startedAt: 100, desiredMessagingEnabled: true,
    });
    expect(acquire(store, "mcp", "owner", 100, () => true, false).acquired).toBe(true);
    expect(acquire(store, "mcp", "challenger", 100, () => false, true)).toEqual({
      acquired: false, reason: "held", holder: {
        ownerInstanceId: "owner", acquiredAt: 100, heartbeatAt: 100,
        expiresAt: 100 + RUNTIME_LEASE_DEAD_OWNER_GRACE_MS, status: "active",
      },
    });
    expect(store.getInstance("owner")?.exitedAt).toBe(100);
    // A later live PID cannot undo the recorded death or shorten MCP's grace.
    expect(acquire(store, "mcp", "challenger", 100 + RUNTIME_LEASE_DEAD_OWNER_GRACE_MS - 1, () => true, true).acquired).toBe(false);
    expect(acquire(store, "mcp", "challenger", 100 + RUNTIME_LEASE_DEAD_OWNER_GRACE_MS, () => true, true).acquired).toBe(true);
  } finally { db.close(); removeTempStateDbDir(tempDir); }
});

// One owner per lease, persisted death cannot be undone by PID reuse, and only
// the owner can release. This model knows identities and deadlines, no SQL.
it("matches an independent owner model across WAL connections, clocks, death, PID reuse and reopens", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  await fc.assert(fc.asyncProperty(fc.array(fc.record({
    actor: fc.integer({ min: 0, max: 2 }), connection: fc.integer({ min: 0, max: 2 }),
    kind: fc.constantFrom(...kinds), action: fc.constantFrom("acquire", "release", "exit", "liveness", "reopen"),
    delta: fc.integer({ min: -70_000, max: 70_000 }), alive: fc.boolean(), immediate: fc.boolean(),
  }), { minLength: 1, maxLength: 35 }), async (commands) => {
    const { dbPath, tempDir } = createTempStateDb("shared-lease-model-");
    const connections = bindings.map(() => StateDb.open(dbPath));
    const stores = connections.map((db, index) => new bindings[index]!(db));
    const alive = new Map([0, 1, 2].map(actor => [`actor-${actor}`, true]));
    const exited = new Map<string, number>();
    const leases = new Map<Kind, MessagingRuntimeLeaseRecord>();
    const messaging = new Map<string, { effective: boolean; reason?: string }>();
    let now = 1_000_000;
    try {
      for (const actor of alive.keys()) {
        stores[0]!.recordInstanceStart({ instanceId: actor, processId: 123, profileName: "fixture",
          startedAt: now, desiredMessagingEnabled: true });
        messaging.set(actor, { effective: false });
      }
      for (const command of commands) {
        now += command.delta;
        const actor = `actor-${command.actor}`;
        const store = stores[command.connection]!;
        const prior = leases.get(command.kind);
        // A process whose exit was persisted cannot initiate new owner work.
        if (exited.has(actor) && ["acquire", "release", "exit"].includes(command.action)) continue;
        if (command.action === "liveness") alive.set(actor, command.alive);
        if (command.action === "exit") {
          store.markInstanceExited({ instanceId: actor, now });
          exited.set(actor, now);
        }
        if (command.action === "reopen") {
          connections[command.connection]!.close();
          const reopening = await measureSqliteWrites(() => StateDb.open(dbPath));
          expect(reopening.writes.commits).toBe(0);
          connections[command.connection] = reopening.result;
          stores[command.connection] = new bindings[command.connection]!(reopening.result);
        }
        if (command.action === "release") {
          const owned = prior?.status === "active" && prior.ownerInstanceId === actor;
          expect(release(store, command.kind, actor, now)).toBe(owned);
          if (owned) {
            leases.set(command.kind, { ...prior!, status: "released", releasedAt: now });
            if (command.kind === "messaging") messaging.set(actor, { effective: false, reason: "runtime_stopped" });
          }
        }
        if (command.action === "acquire") {
          let held = false;
          if (prior?.status === "active" && prior.ownerInstanceId !== actor) {
            const owner = prior.ownerInstanceId;
            const immediate = command.kind !== "mcp" && command.immediate;
            if (exited.has(owner)) {
              const deadline = exited.get(owner)! + (immediate ? 0 : RUNTIME_LEASE_DEAD_OWNER_GRACE_MS);
              prior.expiresAt = deadline;
              held = now < deadline;
            } else if (alive.get(owner)) held = true;
            else {
              exited.set(owner, now);
              if (!immediate) {
                prior.expiresAt = now + RUNTIME_LEASE_DEAD_OWNER_GRACE_MS;
                held = true;
              }
            }
          }
          const result = acquire(store, command.kind, actor, now, owner => alive.get(owner.instanceId)!, command.immediate);
          expect(result.acquired).toBe(!held);
          if (held) expect(result).toEqual({ acquired: false, reason: "held", holder: prior });
          else {
            if (prior?.status !== "active" || prior.ownerInstanceId !== actor) {
              leases.set(command.kind, { ownerInstanceId: actor, acquiredAt: now, heartbeatAt: now,
                expiresAt: Number.MAX_SAFE_INTEGER, status: "active" });
            }
            expect(result).toEqual({ acquired: true, lease: leases.get(command.kind) });
          }
          if (command.kind === "messaging") messaging.set(actor, held
            ? { effective: false, reason: "lease_held" } : { effective: true });
        }
        const reads = await measureSqliteWrites(() => {
          for (const observer of stores) {
            for (const kind of kinds) expect(read(observer, kind)).toEqual(leases.get(kind));
            for (const id of alive.keys()) {
              const instance = observer.getInstance(id)!;
              expect(instance.exitedAt).toBe(exited.get(id));
              expect(instance.effectiveMessagingEnabled).toBe(messaging.get(id)!.effective);
              expect(instance.disabledReason).toBe(messaging.get(id)!.reason);
              expect(instance.processId).toBe(123);
            }
          }
        });
        expect([reads.writes.commits, reads.writes.statements, reads.writes.rowsChanged]).toEqual([0, 0, 0]);
      }
    } finally {
      for (const db of connections) db.close();
      removeTempStateDbDir(tempDir);
    }
  }), { numRuns: 25 });
});

it("preserves owner exclusion in either portable/desktop order and isolates different profiles", async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.constantFrom(...kinds), { minLength: 1, maxLength: 15 }),
    fc.boolean(), async (operations, desktopFirst) => {
      const fixtures = [createTempStateDb("shared-lease-profile-a-"), createTempStateDb("shared-lease-profile-b-")];
      const connections = fixtures.flatMap(fixture => [StateDb.open(fixture.dbPath), StateDb.open(fixture.dbPath)]);
      const order = desktopFirst ? [DesktopStore, SharedStore] : [SharedStore, DesktopStore];
      const stores = connections.map((db, index) => new order[index % 2]!(db));
      try {
        for (const store of stores) for (const actor of ["owner", "challenger"]) {
          store.recordInstanceStart({ instanceId: actor, processId: 1, profileName: "fixture",
            startedAt: 100, desiredMessagingEnabled: true });
        }
        for (const kind of operations) {
          expect(acquire(stores[0]!, kind, "owner", 100, () => true, false).acquired).toBe(true);
          expect(acquire(stores[1]!, kind, "challenger", 9_000_000, () => true, true).acquired).toBe(false);
          expect(acquire(stores[2]!, kind, "challenger", 100, () => true, false).acquired).toBe(true);
          expect(release(stores[1]!, kind, "challenger", 101)).toBe(false);
          expect(release(stores[0]!, kind, "owner", 102)).toBe(true);
          expect(acquire(stores[1]!, kind, "challenger", 103, () => true, false).acquired).toBe(true);
          expect(release(stores[1]!, kind, "challenger", 104)).toBe(true);
        }
      } finally {
        for (const db of connections) db.close();
        for (const fixture of fixtures) removeTempStateDbDir(fixture.tempDir);
      }
    }), { numRuns: 12 });
});

it("rolls back lease replacement and messaging side effects together when storage refuses the transition", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  await fc.assert(fc.asyncProperty(fc.constantFrom(...kinds), fc.boolean(), async (kind, messagingFailure) => {
    const { dbPath, tempDir } = createTempStateDb("shared-lease-rollback-");
    const db = StateDb.open(dbPath);
    const observer = StateDb.open(dbPath);
    const store = new SharedStore(db);
    try {
      for (const instanceId of ["owner", "challenger"]) store.recordInstanceStart({ instanceId,
        processId: 1, profileName: "fixture", startedAt: 100, desiredMessagingEnabled: true });
      acquire(store, kind, "owner", 100, () => true, false);
      store.markInstanceExited({ instanceId: "owner", now: 101 });
      const before = observer.raw.prepare("SELECT * FROM messaging_runtime_lease").all();
      const instances = observer.raw.prepare("SELECT * FROM app_runtime_instances ORDER BY instance_id").all();
      db.raw.exec(kind === "messaging" && messagingFailure
        ? "CREATE TRIGGER fixture_refusal BEFORE UPDATE ON app_runtime_instances BEGIN SELECT RAISE(ABORT, 'fixture refusal'); END"
        : "CREATE TRIGGER fixture_refusal BEFORE UPDATE ON messaging_runtime_lease BEGIN SELECT RAISE(ABORT, 'fixture refusal'); END");
      const rejected = await measureSqliteWrites(() => {
        expect(() => acquire(store, kind, "challenger", 100_000, () => false, false)).toThrow("fixture refusal");
      });
      expect(rejected.writes.commits).toBe(0);
      expect(observer.raw.prepare("SELECT * FROM messaging_runtime_lease").all()).toEqual(before);
      expect(observer.raw.prepare("SELECT * FROM app_runtime_instances ORDER BY instance_id").all()).toEqual(instances);
      db.raw.exec("DROP TRIGGER fixture_refusal");
      expect(acquire(store, kind, "challenger", 100_000, () => false, false).acquired).toBe(true);
      expect(read(new DesktopStore(observer), kind)?.ownerInstanceId).toBe("challenger");
    } finally { observer.close(); db.close(); removeTempStateDbDir(tempDir); }
  }), { numRuns: 12 });
});
