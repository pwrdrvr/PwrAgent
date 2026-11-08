import fc from "fast-check";
import { afterEach, expect, expectTypeOf, it, vi } from "vitest";
import type { RuntimeLeaseStorage } from "@pwragent/owner-core/runtime-lease-storage";
import { RuntimeLeaseManager } from "../runtime-lease-manager";
import { getDesktopRuntimeLeaseStorage } from "../storage/desktop-runtime-storage";
import { AppRuntimeInstanceStore } from "../state/app-runtime-instance-store";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { openInMemoryStateDb } from "./sqlite-test-utils";

const active = vi.hoisted(() => ({ store: undefined as AppRuntimeInstanceStore | undefined }));
vi.mock("../state/app-state", () => ({
  getAppRuntimeInstanceStore: () => {
    if (!active.store) throw new Error("App state not initialized");
    return active.store;
  },
}));
afterEach(() => { active.store = undefined; vi.unstubAllEnvs(); });

it("keeps the complete lease port structural without exporting its database or constructor", () => {
  expectTypeOf<ReturnType<typeof getDesktopRuntimeLeaseStorage>>().toEqualTypeOf<RuntimeLeaseStorage>();
  expectTypeOf<RuntimeLeaseStorage>().toEqualTypeOf<Pick<AppRuntimeInstanceStore, keyof AppRuntimeInstanceStore>>();
  expect(() => getDesktopRuntimeLeaseStorage()).toThrow("App state not initialized");
});

it("matches the SQLite oracle across profile switches, live/dead owners, clock changes and every lease kind", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const operation = fc.record({
    profile: fc.integer({ min: 0, max: 1 }), actor: fc.integer({ min: 0, max: 1 }),
    kind: fc.constantFrom("messaging" as const, "federation" as const, "mcp_connections" as const),
    action: fc.constantFrom("acquire", "release", "snapshot", "exit", "messaging"),
    delta: fc.integer({ min: -5000, max: 70000 }), alive: fc.boolean(), enabled: fc.boolean(),
  });
  await fc.assert(fc.asyncProperty(fc.array(operation, { minLength: 1, maxLength: 25 }), async (operations) => {
    const databases = Array.from({ length: 4 }, () => openInMemoryStateDb());
    const stores = databases.map(db => new AppRuntimeInstanceStore(db));
    const exited = new Set<string>();
    let now = 100_000;
    let alive = true;
    try {
      const construction = await measureSqliteWrites(() => Array.from({ length: 2 }, (_, profile) => {
        active.store = stores[profile];
        return Array.from({ length: 2 }, (_, actor) => {
          const options = {
            instanceId: `instance-${actor}`, processId: 100 + actor, profileName: `profile-${profile}`,
            startedAt: now, cwd: `/fixture/${profile}/${actor}`, now: () => now,
            runtimeIdentityIsAlive: () => alive, systemBootedAt: 0,
          };
          return {
            port: new RuntimeLeaseManager(options),
            oracle: new RuntimeLeaseManager({ ...options, store: stores[profile + 2]! }),
          };
        });
      }));
      expect(construction.writes.commits).toBe(0);
      for (const op of operations) {
        const actorKey = `${op.profile}:${op.actor}`;
        // A stopped process only serves final snapshots, never starts work again.
        if (exited.has(actorKey) && op.action !== "snapshot") continue;
        if (op.action === "exit") exited.add(actorKey);
        now += op.delta;
        alive = op.alive;
        // A manager retains its original binding after global state changes.
        active.store = op.enabled ? stores[1 - op.profile] : undefined;
        const pair = construction.result[op.profile]![op.actor]!;
        const apply = (manager: RuntimeLeaseManager) => {
          switch (op.action) {
            case "acquire": return manager.acquire(op.kind);
            case "release": return manager.release(op.kind);
            case "snapshot": return manager.snapshot(op.kind);
            case "exit": return manager.markExited();
            default: return manager.recordMessagingState({ desiredMessagingEnabled: op.enabled, effectiveMessagingEnabled: false });
          }
        };
        const actual = await measureSqliteWrites(() => apply(pair.port));
        const expected = await measureSqliteWrites(() => apply(pair.oracle));
        expect(actual.result).toEqual(expected.result);
        expect([actual.writes.commits, actual.writes.statements, actual.writes.rowsChanged])
          .toEqual([expected.writes.commits, expected.writes.statements, expected.writes.rowsChanged]);
        const reads = await measureSqliteWrites(() => {
          for (const managers of construction.result) {
            for (const managersByActor of managers) {
              expect(managersByActor.port.getInstance()).toEqual(managersByActor.oracle.getInstance());
              for (const kind of ["messaging", "federation", "mcp_connections"] as const) {
                expect(managersByActor.port.snapshot(kind)).toEqual(managersByActor.oracle.snapshot(kind));
                expect(managersByActor.port.shouldRetryAcquisition(kind)).toBe(managersByActor.oracle.shouldRetryAcquisition(kind));
              }
            }
          }
        });
        expect(reads.writes.commits).toBe(0);
        for (const profile of [0, 1]) {
          for (const table of ["app_runtime_instances", "messaging_runtime_lease"]) {
            // Fixed test-owned table names; compare the persisted oracle, too.
            const query = table === "app_runtime_instances"
              ? "SELECT * FROM app_runtime_instances ORDER BY instance_id"
              : "SELECT * FROM messaging_runtime_lease ORDER BY lease_key";
            expect(databases[profile]!.raw.prepare(query).all()).toEqual(databases[profile + 2]!.raw.prepare(query).all());
          }
        }
      }
    } finally {
      active.store = undefined;
      for (const db of databases) db.close();
    }
  }), { numRuns: 25 });
});
