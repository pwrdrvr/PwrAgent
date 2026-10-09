import { afterEach, expect, it, vi } from "vitest";
import { DesktopBackendRegistry } from "../app-server/backend-registry";
import { buildPwrAgentThreadToolRouter, type PwrAgentThreadInspectionHandler } from "../agent-tools/pwragent-thread-agent-tools";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

afterEach(() => vi.unstubAllEnvs());

it.each([false, true])("budgets self-renaming through the real SQLite store (Agent metadata: %s)", async (agent) => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const temp = createTempStateDb("thread-rename-budget-");
  const db = StateDb.open(temp.dbPath);
  const store = new SqliteOverlayStore(db);
  let title = "Original title";
  const summary = () => ({ id: "ordinary-thread", title, titleSource: "explicit", source: "codex", linkedDirectories: [] });
  const registry = new DesktopBackendRegistry({
    codexClient: {
      close: async () => {},
      getInitializeResult: async () => ({ methods: [] }),
      listThreads: async () => [summary()],
      readThreadName: async () => title,
      renameThread: async ({ threadId, name }: { threadId: string; name: string }) => {
        title = name;
        return { threadId };
      },
      onNotification: () => () => {},
      onPendingRequest: () => () => {},
    } as never,
    overlayStore: store,
    threadTitleGenerationService: null,
  });
  const handler = (registry as unknown as { threadInspectionHandler: PwrAgentThreadInspectionHandler }).threadInspectionHandler;
  const router = buildPwrAgentThreadToolRouter(handler);
  try {
    if (agent) await store.setThreadAgent({ backend: "codex", threadId: "ordinary-thread",
      agent: { name: "Original title", instructions: "Invented fixture instructions" } });
    const { result, writes } = await measureSqliteWrites(() => router.handleMcpToolCall({
      backend: "codex", threadId: "ordinary-thread", tool: "rename_current_thread",
      args: { title: "Investigate rename feedback" },
    }));
    expect(result.isError).not.toBe(true);
    expect(title).toBe("Investigate rename feedback");
    expectSqliteWriteBudget({
      scenario: agent ? "thread-self-rename-agent" : "thread-self-rename",
      writes,
      note: agent
        ? "One self-rename with Agent metadata: existing Agent-name overlay update, 1 commit/~16 KB WAL; 100 renames/day projects ~1.65 MB/day. Notification and Undo state remain in memory, with no idle writes."
        : "One ordinary-thread self-rename: zero commits/WAL bytes, projecting 0 MB/day. Notification and Undo state remain in memory, with no idle writes.",
    });
  } finally {
    await registry.close();
    db.close();
    removeTempStateDbDir(temp.tempDir);
  }
});
