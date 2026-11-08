import fc from "fast-check";
import { afterEach, expect, expectTypeOf, it, vi } from "vitest";
import type { ThreadSandboxStorage } from "@pwragent/owner-core/mcp-connection-storage";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { ThreadSandboxStore } from "../state/thread-sandbox-store";
import type { StateDb } from "../state/state-db";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { createThreadSandboxStorage } from "../storage/desktop-runtime-storage";
import { desktopMcpConnectionSelectionStorage, recordCreatedSandbox } from "../storage/desktop-mcp-connection-storage";
import { openInMemoryStateDb } from "./sqlite-test-utils";

const active = vi.hoisted(() => ({
  db: undefined as StateDb | undefined,
  overlay: undefined as SqliteOverlayStore | undefined,
  mode: null as "bootstrap" | "profile" | null,
}));
vi.mock("../state/app-state", () => ({
  getAppStateDb: () => active.db!,
  getAppOverlayStore: () => active.overlay!,
  getAppStateMode: () => active.mode,
}));
afterEach(() => {
  active.db = undefined;
  active.overlay = undefined;
  active.mode = null;
  vi.unstubAllEnvs();
});

it("exposes the complete sandbox port without its concrete database constructor", () => {
  expectTypeOf<ReturnType<typeof createThreadSandboxStorage>>().toEqualTypeOf<ThreadSandboxStorage>();
  expectTypeOf<keyof ThreadSandboxStorage>().toEqualTypeOf<keyof ThreadSandboxStore>();
});

it("preserves event-time profile selection, bootstrap guards, retained cleanup bindings and exact writes", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const operation = fc.record({
    profile: fc.integer({ min: 0, max: 1 }),
    current: fc.integer({ min: 0, max: 1 }),
    mode: fc.constantFrom("bootstrap" as const, "profile" as const, null),
    action: fc.constantFrom("create", "stopped", "deleted"),
    sandbox: fc.integer({ min: 0, max: 3 }),
    thread: fc.integer({ min: 0, max: 1 }),
    backend: fc.constantFrom("codex" as const, "claude" as const),
    selected: fc.array(fc.constantFrom("pwrsnap", "builtin:sandboxer", "fixture"), { maxLength: 4 }),
  });
  await fc.assert(fc.asyncProperty(fc.array(operation, { minLength: 1, maxLength: 25 }), async (operations) => {
    const databases = Array.from({ length: 4 }, () => openInMemoryStateDb());
    const stores = databases.map(db => new ThreadSandboxStore(db.raw));
    const overlays = databases.slice(0, 2).map(db => new SqliteOverlayStore(db));
    const bindings = stores.slice(0, 2).map((_, index) => {
      active.db = databases[index];
      return createThreadSandboxStorage();
    });
    try {
      for (const [index, op] of operations.entries()) {
        active.db = databases[op.current];
        active.overlay = overlays[op.current];
        active.mode = op.mode;
        const params = {
          connectionId: "builtin:sandboxer", sandboxId: `sb_${op.sandbox}`, threadId: `thread-${op.thread}`,
          backend: op.backend, name: `Fixture ${index}`, now: index,
        };
        const actual = await measureSqliteWrites(() => {
          if (op.action === "create") recordCreatedSandbox(params);
          else bindings[op.profile]!.markOutcome({ ...params, status: op.action });
        });
        const oracle = await measureSqliteWrites(() => {
          if (op.action === "create") {
            // This is the gateway's original guard and event-time constructor.
            if (op.mode) new ThreadSandboxStore(databases[op.current + 2]!.raw).recordCreated(params);
          } else stores[op.profile + 2]!.markOutcome({ ...params, status: op.action });
        });
        expect([actual.writes.commits, actual.writes.statements, actual.writes.rowsChanged])
          .toEqual([oracle.writes.commits, oracle.writes.statements, oracle.writes.rowsChanged]);
        for (const profile of [0, 1]) {
          expect(stores[profile]!.all()).toEqual(stores[profile + 2]!.all());
          expect(databases[profile]!.raw.prepare("SELECT * FROM thread_sandboxes ORDER BY connection_id, sandbox_id").all())
            .toEqual(databases[profile + 2]!.raw.prepare("SELECT * FROM thread_sandboxes ORDER BY connection_id, sandbox_id").all());
        }
        const context = { backend: op.backend, threadId: params.threadId };
        await overlays[op.current]!.setThreadMcpConnectionIds({ ...context, connectionIds: op.selected });
        const read = await measureSqliteWrites(() => desktopMcpConnectionSelectionStorage.readSelection(context));
        expect(read.result).toEqual((await overlays[op.current]!.getThreadOverlayState(context))?.mcpConnectionIds ?? []);
        expect(read.writes.commits).toBe(0);
      }
    } finally {
      active.db = undefined;
      active.overlay = undefined;
      for (const db of databases) db.close();
    }
  }), { numRuns: 25 });
});
