import fc from "fast-check";
import { afterEach, expect, it, vi } from "vitest";
import type { AppServerThreadSummary } from "@pwragent/shared";
import { DesktopBackendRegistry } from "../app-server/backend-registry";
import { buildPwrAgentThreadToolRouter, type PwrAgentThreadInspectionHandler } from "../agent-tools/pwragent-thread-agent-tools";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

afterEach(() => vi.unstubAllEnvs());

function fixture(rows: AppServerThreadSummary[]) {
  const temp = createTempStateDb("native-title-cost-");
  const db = StateDb.open(temp.dbPath);
  const store = new SqliteOverlayStore(db);
  const registry = new DesktopBackendRegistry({
    codexClient: {
      close: async () => {},
      getInitializeResult: async () => ({ methods: [] }),
      listThreads: async () => structuredClone(rows),
      readThreadName: async (threadId: string) => rows.find(row => row.id === threadId)?.title,
      renameThread: async ({ threadId, name }: { threadId: string; name: string }) => {
        rows.find(row => row.id === threadId)!.title = name;
        return { threadId };
      },
      onNotification: () => () => {},
      onPendingRequest: () => () => {},
    } as never,
    overlayStore: store,
    threadTitleGenerationService: null,
  });
  return { store, registry, async close() {
    await registry.close();
    db.close();
    removeTempStateDbDir(temp.tempDir);
  } };
}

it("generated native renames retain provider authority without another overlay commit", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  await fc.assert(fc.asyncProperty(fc.boolean(), fc.uniqueArray(fc.nat(10000), { minLength: 1, maxLength: 5 }), async (agent, names) => {
    const rows: AppServerThreadSummary[] = [{ id: "thread", source: "codex", title: "Before", titleSource: "explicit", linkedDirectories: [] }];
    const host = fixture(rows);
    const identity = { backend: "codex" as const, threadId: "thread" };
    const handler = (host.registry as unknown as { threadInspectionHandler: PwrAgentThreadInspectionHandler }).threadInspectionHandler;
    const router = buildPwrAgentThreadToolRouter(handler);
    try {
      if (agent) await host.store.setThreadAgent({ ...identity, agent: { name: "Before", instructions: "Invented fixture instructions" } });
      for (const value of names) {
        const name = `Native ${value}`;
        const { result, writes } = await measureSqliteWrites(() => router.handleMcpToolCall({
          ...identity, tool: "rename_current_thread", args: { title: name },
        }));
        expect(result.isError).not.toBe(true);
        expect(rows[0].title).toBe(name);
        expect((await host.registry.listThreads({ backend: "codex", enrichDirectories: false }))[0].title).toBe(name);
        if (agent) expect((await host.store.getThreadOverlayState(identity))?.agent?.name).toBe(name);
        // The native provider already persists this explicit title. Only an
        // existing Agent name needs an overlay write (the inherited budget).
        expect(writes.commits).toBe(agent ? 1 : 0);
      }
    } finally { await host.close(); }
  }), { numRuns: 15 });
});

it("generated listings project canonical titles from the rows already loaded", async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.constantFrom("native", "pending", "confirmed", "superseded"), { minLength: 1, maxLength: 20 }), async modes => {
    const rows: AppServerThreadSummary[] = modes.map((_, i) => ({ id: `thread-${i}`, source: "codex", title: `Native ${i}`, titleSource: "explicit", linkedDirectories: [] }));
    const host = fixture(rows);
    try {
      for (const [i, mode] of modes.entries()) {
        if (mode === "native") continue;
        await host.store.updateThreadMetadata({ backend: "codex", threadId: rows[i].id }, {
          title: { text: `Owner ${i}`, source: "derived",
            ...(mode === "pending" ? {} : { nativeName: mode === "confirmed" ? rows[i].title : "Previous native name" }) },
        });
      }
      await host.registry["subAgentStartupReconciliation"];
      const metadataReads = vi.spyOn(host.store, "getThreadMetadata");
      try {
        const listed = await host.registry.listThreads({ backend: "codex", enrichDirectories: false });
        // The provider and acknowledged owner facts are independent oracles;
        // projecting them must not reload full rows and transcript histories.
        expect(listed.map(row => row.title)).toEqual(modes.map((mode, i) => mode === "pending" || mode === "confirmed" ? `Owner ${i}` : `Native ${i}`));
        expect(metadataReads).not.toHaveBeenCalled();
      } finally { metadataReads.mockRestore(); }
    } finally { await host.close(); }
  }), { numRuns: 15 });
});
