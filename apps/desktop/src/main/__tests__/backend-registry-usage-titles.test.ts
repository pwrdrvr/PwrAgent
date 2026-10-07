import type { AgentEvent, AppServerBackendKind, ThreadUsageLineRecord } from "@pwragent/shared";
import { buildLegacyEncodedThreadIdentityKey } from "@pwragent/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopBackendRegistry } from "../app-server/backend-registry";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import type { StateDb } from "../state/state-db";
import { openInMemoryStateDb } from "./sqlite-test-utils";

describe("DesktopBackendRegistry usage titles", () => {
  let stateDb: StateDb;
  let store: SqliteOverlayStore;
  let registry: DesktopBackendRegistry;
  const window = { from: Date.UTC(2026, 9, 3), to: Date.UTC(2026, 9, 4) };
  const listThreads = vi.fn(async () => []);

  beforeEach(() => {
    stateDb = openInMemoryStateDb();
    store = new SqliteOverlayStore(stateDb);
    listThreads.mockClear();
    registry = new DesktopBackendRegistry({
      codexClient: {
        close: async () => {},
        getInitializeResult: async () => ({ methods: [] }),
        listThreads,
        onNotification: () => () => {},
        onPendingRequest: () => () => {},
      } as never,
      overlayStore: store,
      threadTitleGenerationService: null,
    });
  });

  afterEach(async () => {
    await registry.close();
    stateDb.close();
  });

  it("records the helper runner's account when its parent belongs to another backend", async () => {
    await (registry as unknown as {
      writeSystemHelperSubAgent(params: unknown): Promise<void>;
    }).writeSystemHelperSubAgent({
      backend: "acp:grok", threadId: "parent",
      subAgent: { monitorId: "system:title-helper:test", task: "Name the thread", status: "success",
        createdAt: Date.now(), updatedAt: Date.now() },
      usage: { result: { accountKey: "actual-helper-account", helperThreadId: "codex-helper",
        helperTurnId: "helper-turn", model: "gpt-5.6-luna" },
      snapshot: { model: "gpt-5.6-luna", tokenUsage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 } } },
    });
    const { lines } = await store.readThreadPricing({ backend: "acp:grok", threadId: "parent" });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ accountKey: "actual-helper-account", provider: "openai", scope: "monitor" });
  });

  const rememberTitle = async (backend: AppServerBackendKind, threadId: string, title: string) => {
    await (registry as unknown as { emit(event: AgentEvent): Promise<void> }).emit({
      backend,
      notification: {
        method: "thread/name/updated",
        params: { threadId, threadName: title },
      },
    });
  };

  const writeUsage = async (overrides: Partial<ThreadUsageLineRecord> = {}) => {
    await store.upsertThreadUsageLine({ line: {
      backend: "codex", threadId: "thread-1", usageLineId: "line-1", turnId: "turn-1",
      source: "live", scope: "turn", status: "finalized", turnUsageAttributed: true,
      createdAt: window.from + 1000, startedAt: window.from + 1000, completedAt: window.from + 2000,
      inputTokens: 1000, cachedInputTokens: 200, uncachedInputTokens: 800,
      outputTokens: 300, reasoningOutputTokens: 100, totalTokens: 1300,
      provider: "openai", priceStatus: "unpriced", currency: "USD", cachedInputCostMicros: 0,
      uncachedInputCostMicros: 0, outputCostMicros: 0, totalCostMicros: 0,
      ...overrides,
    } });
  };

  it.each(["codex", "acp:grok"] as const)("uses a known %s title before navigation has indexed the thread", async (backend) => {
    await writeUsage({ backend });
    await rememberTitle(backend, "thread-1", "Known local thread");
    expect(registry.getThreadInfo({ backend, threadId: "thread-1" })?.title).toBe("Known local thread");
    expect((await store.readUsageActivity(window)).rows[0].title).toBe("thread-1");

    const snapshot = await registry.readUsageActivity(window);

    expect(snapshot.rows[0].title).toBe("Known local thread");
    expect(listThreads).not.toHaveBeenCalled();
    expect(stateDb.raw.prepare("SELECT count(*) AS count FROM thread_search_documents").get()).toEqual({ count: 0 });
  });

  it("uses the latest known rename instead of a stale indexed title on every row", async () => {
    await writeUsage();
    await writeUsage({ usageLineId: "line-2", turnId: "turn-2" });
    stateDb.raw.prepare(`
      INSERT INTO thread_search_documents
        (identity_key, backend, thread_id, title, linked_directories_json, display_json, indexed_at)
      VALUES (?, 'codex', 'thread-1', 'Old indexed title', '[]', '{}', ?)
    `).run(buildLegacyEncodedThreadIdentityKey("codex", "thread-1"), window.from);
    await rememberTitle("codex", "thread-1", "First rename");
    expect((await registry.readUsageActivity(window)).rows.map((row) => row.title)).toEqual(["First rename", "First rename"]);
    await rememberTitle("codex", "thread-1", "Latest rename");

    expect((await registry.readUsageActivity(window)).rows.map((row) => row.title)).toEqual(["Latest rename", "Latest rename"]);
    expect(listThreads).not.toHaveBeenCalled();
  });

  it("keeps historical titles and unknown ids without borrowing another backend's title", async () => {
    await writeUsage();
    await writeUsage({ threadId: "unknown", usageLineId: "unknown-line" });
    await rememberTitle("acp:grok", "thread-1", "Other backend's thread");
    stateDb.raw.prepare("INSERT INTO thread_usage_titles (identity_key, title) VALUES (?, ?)")
      .run(buildLegacyEncodedThreadIdentityKey("codex", "thread-1"), "Historical title");

    const snapshot = await registry.readUsageActivity(window);

    expect(snapshot.rows.find((row) => row.line.threadId === "thread-1")?.title).toBe("Historical title");
    expect(snapshot.rows.find((row) => row.line.threadId === "unknown")?.title).toBe("unknown");
    expect(listThreads).not.toHaveBeenCalled();
  });

  it("names background helper rollups with the known parent thread title", async () => {
    await writeUsage({
      threadId: "helper", scope: "monitor", parentThreadId: "thread-1",
      sourceItemId: "system:token-miser:helper",
    });
    await rememberTitle("codex", "thread-1", "Parent thread");
    await rememberTitle("codex", "helper", "Internal helper");

    const snapshot = await registry.readUsageActivity(window);

    expect(snapshot.rows).toHaveLength(1);
    expect(snapshot.rows[0]).toMatchObject({
      title: "Parent thread", line: { threadId: "thread-1" }, rollup: { kind: "token-miser", count: 1 },
    });
    expect(listThreads).not.toHaveBeenCalled();
  });
});
