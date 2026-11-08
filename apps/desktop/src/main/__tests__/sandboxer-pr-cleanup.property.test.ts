import fc from "fast-check";
import { afterEach, expect, it, vi } from "vitest";
import type { ThreadSandboxRecord } from "@pwragent/owner-core/mcp-connection-storage";
import type { StateDb } from "../state/state-db";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { createThreadSandboxStorage } from "../storage/desktop-runtime-storage";
import { SandboxerPrCleanupService } from "../mcp-connections/sandboxer-pr-cleanup";
import { openInMemoryStateDb } from "./sqlite-test-utils";

const active = vi.hoisted(() => ({ db: undefined as StateDb | undefined }));
vi.mock("../state/app-state", () => ({ getAppStateDb: () => active.db! }));
afterEach(() => { active.db = undefined; vi.unstubAllEnvs(); });

it("releases only the first creator's eligible resources and shares concurrent cleanup without extra writes", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const creation = fc.record({
    connection: fc.integer({ min: 0, max: 1 }), sandbox: fc.integer({ min: 0, max: 4 }),
    thread: fc.integer({ min: 0, max: 1 }), backend: fc.constantFrom("codex", "claude", undefined),
    stopped: fc.boolean(),
  });
  await fc.assert(fc.asyncProperty(
    fc.array(creation, { maxLength: 18 }), fc.boolean(), fc.constantFrom("delete", "stop", "none"),
    fc.array(fc.constantFrom("ok", "gone", "failed"), { minLength: 5, maxLength: 5 }),
    fc.integer({ min: 0, max: 18 }), fc.constantFrom("codex", "claude"),
    async (creations, enabled, capability, outcomes, cutoff, backend) => {
      const db = openInMemoryStateDb();
      active.db = db;
      const store = createThreadSandboxStorage();
      const model = new Map<string, ThreadSandboxRecord>();
      const calls: string[] = [];
      const closed: string[] = [];
      try {
        for (const [index, creation] of creations.entries()) {
          const record: ThreadSandboxRecord = {
            connectionId: `connection-${creation.connection}`, sandboxId: `sb_${creation.sandbox}`,
            threadId: `thread-${creation.thread}`, backend: creation.backend,
            status: creation.stopped ? "stopped" : "active", name: `Fixture ${index}`,
            createdAt: index, updatedAt: index,
          };
          const key = `${record.connectionId}/${record.sandboxId}`;
          const inserted = store.recordCreated({ ...record, now: index });
          expect(inserted).toBe(!model.has(key));
          if (!model.has(key)) {
            model.set(key, record);
            if (creation.stopped) store.markOutcome({ ...record, status: "stopped", now: index });
          }
        }
        const eligible = [...model.entries()].filter(([, row]) =>
          row.threadId === "thread-0" && (!row.backend || row.backend === backend) && row.createdAt <= cutoff
        );
        const expectedCalls: string[] = [];
        let commits = 0;
        if (enabled && capability !== "none") {
          for (const [key, row] of eligible) {
            if (capability === "stop" && row.status === "stopped") continue;
            expectedCalls.push(`${row.connectionId}/${row.sandboxId}/${capability}_sandbox`);
            const outcome = outcomes[Number(row.sandboxId.slice(3))];
            if (outcome === "failed") continue;
            commits += 1;
            if (capability === "delete" || outcome === "gone") model.delete(key);
            else model.set(key, { ...row, status: "stopped", updatedAt: 100 });
          }
        }
        const service = new SandboxerPrCleanupService({
          store,
          isEnabled: () => enabled,
          now: () => 100,
          openTransport: async ({ connectionId }) => ({
            listToolNames: async () => capability === "none" ? [] : [`${capability}_sandbox`],
            callTool: async (tool, args) => {
              calls.push(`${connectionId}/${args.sandboxId}/${tool}`);
              const outcome = outcomes[Number(String(args.sandboxId).slice(3))];
              return {
                isError: outcome !== "ok",
                content: [{ type: "text", text: outcome === "gone" ? "not found" : outcome === "failed" ? "fixture denied" : "{}" }],
              };
            },
            close: () => { closed.push(connectionId); },
          }),
        });
        const measured = await measureSqliteWrites(async () => {
          const params = { backend, threadId: "thread-0", createdBefore: cutoff };
          return Promise.all([service.cleanupThread(params), service.cleanupThread(params)]);
        });
        expect(measured.result[0]).toBe(measured.result[1]);
        expect(calls.sort()).toEqual(expectedCalls.sort());
        expect(new Set(closed).size).toBe(closed.length);
        expect([measured.writes.commits, measured.writes.statements, measured.writes.rowsChanged])
          .toEqual([commits, commits, commits]);
        const withoutNote = ({ note: _note, ...row }: ThreadSandboxRecord) => row;
        const sorted = (rows: ThreadSandboxRecord[]) => rows.map(withoutNote)
          .sort((a, b) => `${a.connectionId}/${a.sandboxId}`.localeCompare(`${b.connectionId}/${b.sandboxId}`));
        expect(sorted(store.all())).toEqual(sorted([...model.values()]));
      } finally {
        active.db = undefined;
        db.close();
      }
    },
  ), { numRuns: 25 });
});
