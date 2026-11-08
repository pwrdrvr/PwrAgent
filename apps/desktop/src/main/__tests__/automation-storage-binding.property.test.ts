import fc from "fast-check";
import { afterEach, expect, expectTypeOf, it, vi } from "vitest";
import type { AutomationStorage } from "@pwragent/owner-core/automation-storage";
import { getDesktopAutomationStore, setDesktopAutomationStoreForTests } from "../automations/desktop-automation-service";
import { AutomationStore } from "../storage/automation-store";
import { getAutomationStorage } from "../storage/desktop-automation-storage";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { openInMemoryStateDb } from "./sqlite-test-utils";

const active = vi.hoisted(() => ({ store: undefined as AutomationStorage | undefined }));
vi.mock("../state/app-state", () => ({
  getAppAutomationStore: () => {
    if (!active.store) throw new Error("App state not initialized");
    return active.store;
  },
}));
afterEach(() => {
  active.store = undefined;
  setDesktopAutomationStoreForTests(null);
  vi.unstubAllEnvs();
});

it("keeps the application binding handle-free and preserves initialization errors and overrides", () => {
  expectTypeOf<ReturnType<typeof getAutomationStorage>>().toEqualTypeOf<AutomationStorage>();
  expectTypeOf<ReturnType<typeof getDesktopAutomationStore>>().toEqualTypeOf<AutomationStorage>();
  expect(() => getDesktopAutomationStore()).toThrow("App state not initialized");
  const db = openInMemoryStateDb();
  try {
    const override = new AutomationStore(db);
    setDesktopAutomationStoreForTests(override);
    expect(getDesktopAutomationStore()).toBe(override);
    setDesktopAutomationStoreForTests(null);
    expect(() => getDesktopAutomationStore()).toThrow("App state not initialized");
  } finally {
    db.close();
  }
});

it("matches SQLite results, persisted rows and exact writes through profile switches and retained bindings", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const operation = fc.record({
    profile: fc.integer({ min: 0, max: 1 }),
    current: fc.integer({ min: 0, max: 1 }),
    action: fc.constantFrom("update", "pause", "resume", "delete"),
    name: fc.string({ maxLength: 15 }),
  });
  await fc.assert(fc.asyncProperty(fc.array(operation, { minLength: 1, maxLength: 20 }), async (operations) => {
    const databases = Array.from({ length: 4 }, () => openInMemoryStateDb());
    const stores = databases.map(db => new AutomationStore(db));
    const bindings = stores.slice(0, 2).map(store => {
      active.store = store;
      return getDesktopAutomationStore();
    });
    for (const store of stores) store.createAutomation({
      id: "automation", backend: "codex", threadId: "thread", name: "Fixture", taskPrompt: "Fixture task",
      schedule: { kind: "interval", every: 5, unit: "minutes" }, now: 0,
    });
    try {
      for (const [index, op] of operations.entries()) {
        active.store = stores[op.current];
        expect(getDesktopAutomationStore()).toBe(stores[op.current]);
        const apply = (store: AutomationStorage) => {
          const now = index + 1;
          switch (op.action) {
            case "update": return store.updateAutomation("automation", { name: op.name, now });
            case "pause": return store.pauseAutomation("automation", now);
            case "resume": return store.resumeAutomation("automation", { nextRunAt: now + 10, now });
            default: return store.deleteAutomation("automation", now);
          }
        };
        const actual = await measureSqliteWrites(() => apply(bindings[op.profile]!));
        const oracle = await measureSqliteWrites(() => apply(stores[op.profile + 2]!));
        expect(actual.result).toEqual(oracle.result);
        expect([actual.writes.commits, actual.writes.statements, actual.writes.rowsChanged])
          .toEqual([oracle.writes.commits, oracle.writes.statements, oracle.writes.rowsChanged]);
        for (const profile of [0, 1]) {
          expect(databases[profile]!.raw.prepare("SELECT * FROM automations ORDER BY automation_id").all())
            .toEqual(databases[profile + 2]!.raw.prepare("SELECT * FROM automations ORDER BY automation_id").all());
        }
      }
    } finally {
      active.store = undefined;
      for (const db of databases) db.close();
    }
  }), { numRuns: 25 });
});
