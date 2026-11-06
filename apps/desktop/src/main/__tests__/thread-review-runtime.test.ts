import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@pwragent/shared";
import type { DesktopBackendRegistry } from "../app-server/backend-registry";
import type { PwrAgentThreadTodoHandler } from "../agent-tools/pwragent-thread-todo-agent-tools";
import { StateDb } from "../state/state-db";
import { getThreadReviewService } from "../thread-reviews/thread-review-runtime";
import {
  getThreadTodoService,
  installThreadTodoRuntime,
  readProjectMergeMethodPreference,
  resetThreadTodoServiceForTests,
} from "../thread-todos/thread-todo-runtime";
import { claudeReviewOutput } from "../claude/claude-review-findings";
import {
  getReviewAutoFixArming,
  readReviewAutoFixStatus,
  resetReviewAutoFixArmingForTests,
} from "../thread-reviews/review-auto-fix";
import { localThreadTodoOperations } from "../thread-todos/thread-todo-operations";
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
    resetReviewAutoFixArmingForTests();
    db.close();
    removeTempStateDbDir(temp.tempDir);
  });

  const submitTurn = vi.fn(async () => ({ status: "queued" }));
  function install() {
    submitTurn.mockClear();
    const registry = {
      onEvent: (listener: typeof onEvent) => { onEvent = listener; return () => {}; },
      setPwrAgentThreadTodoHandler: (value: PwrAgentThreadTodoHandler) => { handler = value; },
      submitTurn,
    } as unknown as DesktopBackendRegistry;
    installThreadTodoRuntime({ registry, broadcast, listProjects: async () => [], readDefaultMergeMethod: () => "squash",
      feed: { loadOwners: async () => [], managedThreadKeys: () => new Set(), onDelta: () => {} } });
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
  /**
   * Rule: a review started with auto-fix hands its open findings to the
   * thread's own agent the moment it lands, as a turn that queues behind any
   * running one. A review started to wait, or one that lands in another
   * turn, sends nothing.
   */
  describe("auto-fix", () => {
    const findingsOutput = (turnId: string, id: string) => ({ backend: THREAD.backend, notification: {
      method: "item/completed" as const, params: { threadId: THREAD.threadId, turnId, item: {
        id, type: "exitedReviewMode", review: "",
        data: { reviewOutput: claudeReviewOutput({ findings: [
          { file: "src/a.ts", line: 3, summary: "Minor naming.", failureScenario: "Confuses readers." },
          { file: "src/b.ts", line: 9, summary: "Drops a write.", failureScenario: "Loses data." },
        ] }, "/repo") },
      } },
    } }) as AgentEvent;

    it("sends the thread's agent the open findings when an armed review lands", async () => {
      install();
      getReviewAutoFixArming().starting(THREAD, "auto-fix").accepted("review-turn");
      onEvent(findingsOutput("review-turn", "armed-review"));
      await vi.waitFor(() => expect(submitTurn).toHaveBeenCalledTimes(1));
      const [review] = getThreadReviewService().list();
      const call = (submitTurn.mock.calls as unknown as [Record<string, unknown>][])[0]![0];
      expect(call).toMatchObject({
        ...THREAD,
        origin: "automation",
        messageOrigin: { kind: "pwragent", reviewAutoFix: { reviewId: review!.id, findingCount: 2 } },
      });
      const text = (call.input as { text: string }[])[0]!.text;
      expect(text).toContain("Decide which ones to fix.");
      expect(text).toContain("`update_review_item`");
      // Once only: the same artifact again sends nothing more.
      onEvent(findingsOutput("review-turn", "armed-review"));
      await Promise.resolve();
      expect(submitTurn).toHaveBeenCalledTimes(1);
    });

    it("sends nothing for a review started to wait, or one PwrAgent did not start", async () => {
      install();
      getReviewAutoFixArming().starting(THREAD, "wait").accepted("wait-turn");
      onEvent(findingsOutput("wait-turn", "waiting-review"));
      onEvent(findingsOutput("typed-turn", "typed-review"));
      await Promise.resolve();
      expect(getThreadReviewService().list()).toHaveLength(2);
      expect(submitTurn).not.toHaveBeenCalled();
    });

    it("sends nothing once an armed review's turn ended without a result", async () => {
      install();
      getReviewAutoFixArming().starting(THREAD, "auto-fix").accepted("review-turn");
      onEvent({ backend: THREAD.backend, notification: {
        method: "turn/completed", params: { threadId: THREAD.threadId, turnId: "review-turn",
          turn: { id: "review-turn", status: "interrupted" } },
      } } as AgentEvent);
      onEvent(findingsOutput("later-turn", "later-review"));
      await Promise.resolve();
      expect(submitTurn).not.toHaveBeenCalled();
    });

    /**
     * Rule: viewers learn a running review is armed, and Don't auto-fix
     * keeps it from fixing when it lands. Each change reaches them on the
     * thread's to-do change event.
     */
    it("lists an armed running review and disarms it", async () => {
      install();
      broadcast.mockClear();
      getReviewAutoFixArming().starting(THREAD, "auto-fix").accepted("review-turn");
      expect(broadcast).toHaveBeenCalledWith(expect.objectContaining(THREAD));
      expect(localThreadTodoOperations.readReviewAutoFix(THREAD).status.armedTurnIds).toEqual(["review-turn"]);
      expect(localThreadTodoOperations.disarmReviewAutoFix({ ...THREAD, turnId: "review-turn" }))
        .toEqual({ disarmed: true, status: { armedTurnIds: [], runs: {} } });
      onEvent(findingsOutput("review-turn", "disarmed-review"));
      await Promise.resolve();
      expect(submitTurn).not.toHaveBeenCalled();
    });

    /**
     * Rule: the card follows the Auto-fix turn by the review id its queue
     * entry carries: queued, then running, then finished.
     */
    it("follows the Auto-fix turn through the queue", async () => {
      install();
      getReviewAutoFixArming().starting(THREAD, "auto-fix").accepted("review-turn");
      onEvent(findingsOutput("review-turn", "queued-review"));
      await vi.waitFor(() => expect(submitTurn).toHaveBeenCalledTimes(1));
      const [review] = getThreadReviewService().list();
      const queue = (status: string) => onEvent({ backend: THREAD.backend, notification: {
        method: "thread/turnQueue/updated", params: { threadId: THREAD.threadId, queueEntryId: "entry", status,
          messageOrigin: { kind: "pwragent", reviewAutoFix: { reviewId: review!.id, findingCount: 2 } } },
      } } as AgentEvent);
      broadcast.mockClear();
      queue("queued");
      expect(readReviewAutoFixStatus(THREAD).runs[review!.id]?.phase).toBe("queued");
      expect(broadcast).toHaveBeenCalledWith(expect.objectContaining(THREAD));
      queue("started");
      expect(readReviewAutoFixStatus(THREAD).runs[review!.id]?.phase).toBe("running");
      queue("terminal");
      expect(readReviewAutoFixStatus(THREAD).runs[review!.id]?.phase).toBe("finished");
    });

    it("tells the card why the Auto-fix send failed", async () => {
      install();
      submitTurn.mockRejectedValueOnce(new Error("Thread is locked."));
      getReviewAutoFixArming().starting(THREAD, "auto-fix").accepted("review-turn");
      onEvent(findingsOutput("review-turn", "refused-review"));
      const [review] = getThreadReviewService().list();
      await vi.waitFor(() => expect(readReviewAutoFixStatus(THREAD).runs[review!.id])
        .toEqual({ phase: "failed", at: expect.any(Number), reason: "Thread is locked." }));
    });

    it("drops a failed send once someone settles a finding", async () => {
      install();
      submitTurn.mockRejectedValueOnce(new Error("Thread is locked."));
      getReviewAutoFixArming().starting(THREAD, "auto-fix").accepted("review-turn");
      onEvent(findingsOutput("review-turn", "refused-review"));
      const [review] = getThreadReviewService().list();
      await vi.waitFor(() => expect(readReviewAutoFixStatus(THREAD).runs[review!.id]?.phase).toBe("failed"));
      broadcast.mockClear();
      // The operator fixed it by hand, and the agent recorded the fix.
      getThreadReviewService().update(
        { id: review!.id, itemId: review!.items[0]!.id, status: "addressed", note: "Fixed by hand." }, "agent");
      expect(readReviewAutoFixStatus(THREAD).runs[review!.id]).toBeUndefined();
      expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ backend: THREAD.backend, threadId: THREAD.threadId }));
    });

    it("keeps a failed send when only the reviewer reports its own outcomes", async () => {
      install();
      submitTurn.mockRejectedValueOnce(new Error("Thread is locked."));
      getReviewAutoFixArming().starting(THREAD, "auto-fix").accepted("review-turn");
      onEvent(findingsOutput("review-turn", "refused-review"));
      const [review] = getThreadReviewService().list();
      await vi.waitFor(() => expect(readReviewAutoFixStatus(THREAD).runs[review!.id]?.phase).toBe("failed"));
      const settled = getThreadReviewService().applyReportedOutcomes(THREAD, review!.sourceKey, [{ index: 0, outcome: "fixed" }]);
      expect(settled?.items[0]?.status).toBe("addressed");
      expect(readReviewAutoFixStatus(THREAD).runs[review!.id]?.phase).toBe("failed");
    });
  });
});

describe("project merge-method preference", () => {
  let temp: ReturnType<typeof createTempStateDb>;
  beforeEach(() => {
    temp = createTempStateDb("pwragent-merge-pref-");
    db = StateDb.open(temp.dbPath);
  });
  afterEach(() => {
    resetThreadTodoServiceForTests();
    db.close();
    removeTempStateDbDir(temp.tempDir);
  });

  it("shares the to-do cards' per-project pick and publishes a new one to open to-do views", async () => {
    const onDelta = vi.fn();
    const registry = {
      onEvent: () => () => {},
      setPwrAgentThreadTodoHandler: () => {},
      resolveThreadPrimaryDirectory: async () => ({ id: "atlas", label: "atlas", path: "/work/atlas" }),
    } as unknown as DesktopBackendRegistry;
    installThreadTodoRuntime({ registry, broadcast: vi.fn(), listProjects: async () => [], readDefaultMergeMethod: () => "squash",
      feed: { loadOwners: async () => [], managedThreadKeys: () => new Set(), onDelta } });

    const first = await readProjectMergeMethodPreference(registry, THREAD);
    expect(first.remembered).toBeUndefined();
    first.remember!("rebase");
    // A pick that changed no card still reaches open merge cards' labels.
    const byProject = getThreadTodoService().mergeMethodPreferences().byProject;
    expect(Object.values(byProject)).toEqual(["rebase"]);
    expect(onDelta).toHaveBeenCalledTimes(1);
    expect(onDelta.mock.calls[0]![0]).toMatchObject({ mergeMethods: { defaultMethod: "squash", byProject } });

    const second = await readProjectMergeMethodPreference(registry, THREAD);
    expect(second.remembered).toBe("rebase");
    onDelta.mockClear();
    second.remember!("rebase");
    expect(onDelta).not.toHaveBeenCalled();
  });

  it("has no pick to read or keep for a thread without a project", async () => {
    const registry = { resolveThreadPrimaryDirectory: async () => undefined } as unknown as DesktopBackendRegistry;
    await expect(readProjectMergeMethodPreference(registry, THREAD)).resolves.toEqual({});
  });
});
