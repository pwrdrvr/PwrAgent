import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  AppServerThreadSummary,
  ThreadSubAgentSummary,
} from "@pwragent/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";

let stateDb: StateDb;
let store: SqliteOverlayStore;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "pwragent-reactions-test-"));
  stateDb = StateDb.open(path.join(tempDir, "state.db"));
  store = new SqliteOverlayStore(stateDb);
});

afterEach(() => {
  stateDb.close();
  rmSync(tempDir, { recursive: true, force: true });
});

function buildThreadSummary(
  overrides: Partial<AppServerThreadSummary> = {},
): AppServerThreadSummary {
  return {
    id: "thread-1",
    title: "Thread 1",
    titleSource: "explicit",
    linkedDirectories: [],
    source: "codex",
    updatedAt: 1000,
    ...overrides,
  };
}

async function addTestReactions(target: SqliteOverlayStore, threadId = "thread-1") {
  await target.setThreadReaction({
    backend: "codex",
    threadId,
    emoji: "👀",
    present: true,
  });
  await target.setThreadReaction({
    backend: "codex",
    threadId,
    emoji: "✅",
    present: true,
  });
}

describe("SqliteOverlayStore — thread reactions", () => {
  it("starts with no reactions on a thread that has never been touched", async () => {
    const overlay = await store.getThreadOverlayState({
      backend: "codex",
      threadId: "thread-1",
    });
    expect(overlay).toBeUndefined();
  });

  it("adds a reaction with present=true and surfaces it through getThreadOverlayState", async () => {
    const next = await store.setThreadReaction({
      backend: "codex",
      threadId: "thread-1",
      emoji: "✅",
      present: true,
    });

    expect(next.reactions).toEqual(["✅"]);

    const overlay = await store.getThreadOverlayState({
      backend: "codex",
      threadId: "thread-1",
    });
    expect(overlay?.reactions).toEqual(["✅"]);
  });

  it("preserves insertion order when multiple reactions are added", async () => {
    await store.setThreadReaction({
      backend: "codex",
      threadId: "thread-1",
      emoji: "👀",
      present: true,
    });
    await store.setThreadReaction({
      backend: "codex",
      threadId: "thread-1",
      emoji: "✅",
      present: true,
    });
    await store.setThreadReaction({
      backend: "codex",
      threadId: "thread-1",
      emoji: "🚀",
      present: true,
    });

    const overlay = await store.getThreadOverlayState({
      backend: "codex",
      threadId: "thread-1",
    });
    expect(overlay?.reactions).toEqual(["👀", "✅", "🚀"]);
  });

  it("is idempotent — setting the same reaction twice does not duplicate", async () => {
    await store.setThreadReaction({
      backend: "codex",
      threadId: "thread-1",
      emoji: "✅",
      present: true,
    });
    const next = await store.setThreadReaction({
      backend: "codex",
      threadId: "thread-1",
      emoji: "✅",
      present: true,
    });

    expect(next.reactions).toEqual(["✅"]);
  });

  it("removes a reaction with present=false and leaves the rest in order", async () => {
    await store.setThreadReaction({
      backend: "codex",
      threadId: "thread-1",
      emoji: "👀",
      present: true,
    });
    await store.setThreadReaction({
      backend: "codex",
      threadId: "thread-1",
      emoji: "✅",
      present: true,
    });
    await store.setThreadReaction({
      backend: "codex",
      threadId: "thread-1",
      emoji: "🚀",
      present: true,
    });

    const next = await store.setThreadReaction({
      backend: "codex",
      threadId: "thread-1",
      emoji: "✅",
      present: false,
    });

    expect(next.reactions).toEqual(["👀", "🚀"]);
  });

  it("removing a reaction that was never present is a no-op", async () => {
    const next = await store.setThreadReaction({
      backend: "codex",
      threadId: "thread-1",
      emoji: "❌",
      present: false,
    });

    expect(next.reactions).toEqual([]);
  });

  it("scopes reactions per (backend, threadId) — same id on different backend is independent", async () => {
    await store.setThreadReaction({
      backend: "codex",
      threadId: "thread-1",
      emoji: "✅",
      present: true,
    });
    await store.setThreadReaction({
      backend: "grok",
      threadId: "thread-1",
      emoji: "❌",
      present: true,
    });

    const codex = await store.getThreadOverlayState({
      backend: "codex",
      threadId: "thread-1",
    });
    const grok = await store.getThreadOverlayState({
      backend: "grok",
      threadId: "thread-1",
    });

    expect(codex?.reactions).toEqual(["✅"]);
    expect(grok?.reactions).toEqual(["❌"]);
  });

  it("survives a database close + reopen", async () => {
    await store.setThreadReaction({
      backend: "codex",
      threadId: "thread-1",
      emoji: "🎉",
      present: true,
    });

    const dbPath = path.join(tempDir, "state.db");
    stateDb.close();

    const reopened = StateDb.open(dbPath);
    const reopenedStore = new SqliteOverlayStore(reopened);
    const overlay = await reopenedStore.getThreadOverlayState({
      backend: "codex",
      threadId: "thread-1",
    });
    expect(overlay?.reactions).toEqual(["🎉"]);
    reopened.close();

    // Re-open the original handle so afterEach's close doesn't double-close.
    stateDb = StateDb.open(dbPath);
    store = new SqliteOverlayStore(stateDb);
  });

  it("preserves reactions when a single instance refreshes thread metadata", async () => {
    await addTestReactions(store);

    await store.reconcileNavigationSnapshot({
      backend: "codex",
      fetchedAt: 2000,
      threads: [
        buildThreadSummary({
          model: "gpt-5.4",
          reasoningEffort: "high",
          fastMode: true,
          updatedAt: 1500,
        }),
      ],
    });

    const overlay = await store.getThreadOverlayState({
      backend: "codex",
      threadId: "thread-1",
    });
    expect(overlay?.reactions).toEqual(["👀", "✅"]);
  });

  it("preserves immutable usage activities during first navigation snapshot reconciliation", async () => {
    await store.persistThreadUsageActivity({
      backend: "codex",
      threadId: "thread-1",
      activity: {
        type: "activity",
        id: "live-turn-usage-turn-1",
        summary: "Turn usage: 100 uncached in · 200 cached · 30 out",
        status: "completed",
        createdAt: 1500,
        turn: {
          id: "turn-1",
          status: "completed",
        },
        details: [
          {
            id: "live-turn-usage-turn-1-input",
            kind: "read",
            label: "Input: 300 tokens (100 uncached, 200 cached)",
            status: "completed",
          },
        ],
      },
    });

    await store.reconcileNavigationSnapshot({
      backend: "codex",
      fetchedAt: 2000,
      threads: [buildThreadSummary({ updatedAt: 1500 })],
    });

    const overlay = await store.getThreadOverlayState({
      backend: "codex",
      threadId: "thread-1",
    });
    expect(overlay?.immutableUsageActivities).toHaveLength(1);
    expect(overlay?.immutableUsageActivities?.[0]?.summary).toBe(
      "Turn usage: 100 uncached in · 200 cached · 30 out",
    );
  });

  it("persists completed monitor usage activities", async () => {
    const persisted = await store.persistThreadUsageActivity({
      backend: "codex",
      threadId: "thread-1",
      activity: {
        type: "activity",
        id: "monitor-1:usage:completion:1500",
        summary: "Monitor usage: 100 uncached in · 200 cached · 30 out",
        status: "completed",
        createdAt: 1500,
        details: [
          {
            id: "monitor-1:usage:completion:1500-input",
            kind: "read",
            label: "Input: 300 tokens (100 uncached, 200 cached)",
            status: "completed",
          },
        ],
      },
    });

    expect(persisted.persisted).toBe(true);
    const overlay = await store.getThreadOverlayState({
      backend: "codex",
      threadId: "thread-1",
    });
    expect(overlay?.immutableUsageActivities).toHaveLength(1);
    expect(overlay?.immutableUsageActivities?.[0]?.summary).toBe(
      "Monitor usage: 100 uncached in · 200 cached · 30 out",
    );
  });

  it("reloads sub-agent summaries with exact usage and list price data", async () => {
    const subAgent: ThreadSubAgentSummary = {
      monitorId: "monitor-1",
      task: "Watch a long-running command.",
      status: "success",
      createdAt: 1500,
      updatedAt: 2500,
      preferredModel: "gpt-5.4-mini",
      preferredReasoningEffort: "low",
      monitorThreadId: "monitor-thread-1",
      monitorTurnId: "monitor-turn-1",
      lastMessage: "The command completed.",
      outcome: "success",
      completedAt: 2500,
      completionSource: {
        type: "monitor_tool",
      },
      monitorUsage: {
        model: "gpt-5.4-mini",
        summary:
          "800 uncached in · 200 cached · 50 out (10 reasoning) · <$0.001 list price",
        tokenUsage: {
          inputTokens: 1000,
          cachedInputTokens: 200,
          uncachedInputTokens: 800,
          outputTokens: 50,
          reasoningOutputTokens: 10,
          totalTokens: 1060,
        },
        cost: {
          model: "gpt-5.4-mini",
          totalUsd: 0.00084,
        },
      },
      pollIntervalSeconds: 30,
      heartbeatIntervalSeconds: 30,
      startupTimeoutSeconds: 45,
    };

    await store.upsertThreadSubAgent({
      backend: "codex",
      threadId: "thread-1",
      subAgent,
    });
    await store.reconcileNavigationSnapshot({
      backend: "codex",
      fetchedAt: 3000,
      threads: [buildThreadSummary({ updatedAt: 2000 })],
    });

    const dbPath = path.join(tempDir, "state.db");
    stateDb.close();

    const reopened = StateDb.open(dbPath);
    const reopenedStore = new SqliteOverlayStore(reopened);
    const overlay = await reopenedStore.getThreadOverlayState({
      backend: "codex",
      threadId: "thread-1",
    });
    const snapshot = await reopenedStore.reconcileNavigationSnapshot({
      backend: "codex",
      fetchedAt: 4000,
      threads: [buildThreadSummary({ updatedAt: 2000 })],
    });
    expect(overlay?.subAgents).toEqual([subAgent]);
    expect(snapshot.threads[0]?.subAgents).toEqual([subAgent]);
    reopened.close();

    stateDb = StateDb.open(dbPath);
    store = new SqliteOverlayStore(stateDb);
  });

  it("preserves reactions when another sqlite handle performs an unrelated overlay write", async () => {
    await addTestReactions(store);

    const secondDb = StateDb.open(path.join(tempDir, "state.db"));
    const secondStore = new SqliteOverlayStore(secondDb);
    try {
      await secondStore.markThreadSeen({
        backend: "codex",
        threadId: "thread-1",
        seenAt: 2500,
        seenUpdatedAt: 2000,
      });
    } finally {
      secondDb.close();
    }

    const overlay = await store.getThreadOverlayState({
      backend: "codex",
      threadId: "thread-1",
    });
    expect(overlay?.reactions).toEqual(["👀", "✅"]);
  });
});
