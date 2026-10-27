import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@pwragent/shared";
import type { DesktopBackendRegistry } from "../app-server/backend-registry";
import type { PwrAgentThreadTodoHandler } from "../agent-tools/pwragent-thread-todo-agent-tools";
import { StateDb } from "../state/state-db";
import { getThreadReviewService } from "../thread-reviews/thread-review-runtime";
import {
  getThreadTodoService,
  installThreadTodoRuntime,
  resetThreadTodoServiceForTests,
} from "../thread-todos/thread-todo-runtime";
import { claudeReviewOutput } from "../claude/claude-review-findings";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

let db: StateDb;
vi.mock("../state/app-state", () => ({ getAppStateDb: () => db }));

const THREAD = { backend: "codex" as const, threadId: "review-owner" };
const PR = { provider: "github.com", org: "example", repo: "atlas", number: 7, url: "https://github.com/example/atlas/pull/7" };

describe("review tracking runtime eligibility", () => {
  let temp: ReturnType<typeof createTempStateDb>;
  let onEvent: (event: AgentEvent) => void;
  let handler: PwrAgentThreadTodoHandler;
  const broadcast = vi.fn();

  beforeEach(() => {
    temp = createTempStateDb("pwragent-review-runtime-");
    db = StateDb.open(temp.dbPath);
    broadcast.mockClear();
  });
  afterEach(() => {
    resetThreadTodoServiceForTests();
    db.close();
    removeTempStateDbDir(temp.tempDir);
  });

  function install() {
    const registry = {
      onEvent: (listener: typeof onEvent) => { onEvent = listener; return () => {}; },
      setPwrAgentThreadTodoHandler: (value: PwrAgentThreadTodoHandler) => { handler = value; },
    } as unknown as DesktopBackendRegistry;
    installThreadTodoRuntime({ registry, broadcast, listProjects: async () => [], readDefaultMergeMethod: () => "squash" });
  }

  function complete(id: string, withPr = false) {
    onEvent({ backend: THREAD.backend, notification: {
      method: "item/completed", params: { threadId: THREAD.threadId, turnId: "turn", item: {
        id, type: "exitedReviewMode", review: "Inspect this result.",
        ...(withPr ? { data: { context: { workspacePath: "/repo", pullRequest: PR } } } : {}),
      } },
    } });
  }

  it("refreshes a card's projected defaults when its raising thread changes model settings", () => {
    install();
    onEvent({ backend: THREAD.backend, notification: {
      method: "thread/modelSettings/updated", params: { threadId: THREAD.threadId, model: "gpt-6.1-sol", reasoningEffort: "high" },
    } });
    expect(broadcast).toHaveBeenCalledExactlyOnceWith({ ...THREAD, at: expect.any(Number) });
    onEvent({ backend: THREAD.backend, federationTarget: { scope: "remote", instanceId: "peer" }, notification: {
      method: "thread/modelSettings/updated", params: { threadId: THREAD.threadId, model: "gpt-6.1-sol" },
    } });
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it("does not import startup overlays or historical thread reads, but records new completions", () => {
    const old = { type: "review" as const, id: "managed-review:old:result", review: "Old review.", createdAt: Date.now() - 35 * 86_400_000 };
    db.raw.prepare("INSERT INTO threads (thread_id, payload) VALUES (?, ?)")
      .run(`codex:${THREAD.threadId}`, JSON.stringify({ ...THREAD, managedReviewEntries: [old] }));
    install();
    expect(getThreadReviewService().list({ status: "all" })).toEqual([]);
    handler.importReviews!(THREAD, [old, { ...old, id: "native-old" }, { ...old, id: "native-undated", createdAt: undefined }]);
    expect(getThreadReviewService().list({ status: "all" })).toEqual([]);
    complete("new-live");
    expect(getThreadReviewService().list().map((review) => review.sourceKey)).toEqual(["new-live"]);
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it("refreshes the queue on attachment changes and archives detached reviews too", () => {
    const setPrs = (prs: unknown[]) => db.raw.prepare("INSERT OR REPLACE INTO threads (thread_id, payload) VALUES (?, ?)")
      .run(`codex:${THREAD.threadId}`, JSON.stringify({ ...THREAD, prs }));
    setPrs([PR]);
    install();
    complete("managed-review:new:result", true);
    expect(getThreadReviewService().list()).toHaveLength(1);
    setPrs([]);
    broadcast.mockClear();
    onEvent({ backend: THREAD.backend, notification: { method: "thread/pullRequests/updated", params: { threadId: THREAD.threadId, prs: [] } } });
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining(THREAD));
    expect(getThreadReviewService().list()).toEqual([]);
    onEvent({ backend: THREAD.backend, notification: { method: "thread/archived", params: { threadId: THREAD.threadId } } });
    setPrs([PR]);
    expect(getThreadReviewService().list()).toEqual([]);
    expect(getThreadReviewService().list({ status: "dismissed" })[0]?.resolution?.note).toBe("Thread archived.");
  });

  it("refreshes owner projections on rename, restore, and archive even without a row mutation", () => {
    install();
    const notifications: AgentEvent["notification"][] = [
      { method: "thread/name/updated", params: { threadId: THREAD.threadId, threadName: "New title" } },
      { method: "thread/unarchived", params: { threadId: THREAD.threadId } },
      { method: "thread/archived", params: { threadId: THREAD.threadId } },
    ];
    for (const notification of notifications) onEvent({ backend: THREAD.backend, notification });
    expect(broadcast).toHaveBeenCalledTimes(3);
    expect(broadcast).toHaveBeenLastCalledWith(expect.objectContaining(THREAD));
    expect(getThreadReviewService().list({ status: "all" })).toEqual([]);
  });

  it("tracks a Claude findings report and the outcomes Claude reports for it later", () => {
    install();
    const claude = { backend: "claude" as const, threadId: "claude-owner" };
    const reviewOutput = claudeReviewOutput({ findings: [
      { file: "src/a.ts", line: 3, summary: "First.", failureScenario: "Breaks.", category: "correctness" },
      { file: "src/b.ts", line: 9, summary: "Second.", failureScenario: "Breaks too." },
    ] }, "/repo");
    onEvent({ backend: "claude", notification: {
      method: "item/completed", params: { threadId: claude.threadId, turnId: "turn-1", item: {
        id: "toolu_review", type: "exitedReviewMode", review: "", data: { reviewOutput, reviewer: { backend: "claude" } },
      } },
    } });
    const [review] = getThreadReviewService().list();
    expect(review).toMatchObject({ ...claude, sourceKey: "toolu_review", origin: "automatic" });
    expect(review!.items.map((item) => [item.title, item.status])).toEqual([["First.", "open"], ["Second.", "open"]]);
    expect(review!.items.map((item) => item.category)).toEqual(["correctness", undefined]);

    const outcomes = { threadId: claude.threadId, turnId: "turn-2", reviewId: "toolu_review", outcomes: [{ index: 1, outcome: "fixed" as const }] };
    // A peer's event never settles local work.
    onEvent({ backend: "claude", federationTarget: { scope: "remote", instanceId: "peer" },
      notification: { method: "thread/review/outcomesReported", params: outcomes } });
    expect(getThreadReviewService().list()[0]!.items.map((item) => item.status)).toEqual(["open", "open"]);
    onEvent({ backend: "claude", notification: { method: "thread/review/outcomesReported", params: outcomes } });
    expect(getThreadReviewService().list()[0]!.items.map((item) => item.status)).toEqual(["open", "addressed"]);
    expect(broadcast).toHaveBeenCalledTimes(2);
  });

  it("defers an agent's finding only to a to-do card its own thread raised", () => {
    install();
    const review = getThreadReviewService().record(THREAD, {
      sourceKey: "artifact", title: "Code review", items: [{ title: "Handle cancellation" }],
    });
    const itemId = review.items[0]!.id;
    const { todo } = getThreadTodoService().add({ ...THREAD, input: { title: "Handle cancellation in the export queue" } });
    const { todo: elsewhere } = getThreadTodoService().add({
      backend: THREAD.backend, threadId: "other-thread", input: { title: "Another thread's card" },
    });
    expect(() => handler.reviews!.update(THREAD, {
      id: review.id, itemId, status: "deferred", note: "Later.", todoId: elsewhere.id,
    })).toThrow("No to-do card with that todoId belongs to this thread.");
    const { todo: closed } = getThreadTodoService().add({ ...THREAD, input: { title: "Already dismissed" } });
    getThreadTodoService().resolve({ id: closed.id, status: "dismissed" });
    expect(() => handler.reviews!.update(THREAD, {
      id: review.id, itemId, status: "deferred", note: "Later.", todoId: closed.id,
    })).toThrow("That to-do card is closed.");
    expect(getThreadReviewService().get(review.id)?.items[0]?.status).toBe("open");
    const deferred = handler.reviews!.update(THREAD, {
      id: review.id, itemId, status: "deferred", note: "Needs a design pass.", todoId: todo.id,
    });
    expect(deferred.items[0]).toMatchObject({
      status: "deferred",
      resolution: { actor: "agent", note: "Needs a design pass.", todo: { id: todo.id, title: todo.title } },
    });
    expect(deferred.status).toBe("handled");
  });

  it("refreshes all local To-dos when provider discovery or authentication recovery finishes", () => {
    install();
    const notification: AgentEvent["notification"] = {
      method: "navigation/providerThreads/refreshed", params: { failedProviders: 0 },
    };
    onEvent({ backend: "codex", notification,
      federationTarget: { scope: "remote", instanceId: "peer" } });
    expect(broadcast).not.toHaveBeenCalled();
    onEvent({ backend: "codex", notification });
    // This global inventory event can restore ACP owners as well as Codex.
    expect(broadcast).toHaveBeenCalledExactlyOnceWith({ at: expect.any(Number) });
    expect(getThreadReviewService().list({ status: "all" })).toEqual([]);
  });
});
