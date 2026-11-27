import { record } from "./scaling-audit-results";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@pwragent/shared/contracts/agent";
import type { DesktopBackendRegistry } from "../app-server/backend-registry";
import { StateDb } from "../state/state-db";
import { getThreadReviewService } from "../thread-reviews/thread-review-runtime";
import {
  installThreadTodoRuntime,
  resetThreadTodoServiceForTests,
} from "../thread-todos/thread-todo-runtime";
import { claudeReviewOutput } from "../claude/claude-review-findings";
import {
  getReviewAutoFixArming,
  resetReviewAutoFixArmingForTests,
} from "../thread-reviews/review-auto-fix";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

let db: StateDb;
vi.mock("../state/app-state", () => ({ getAppStateDb: () => db }));

const THREAD = { backend: "codex" as const, threadId: "review-owner" };
const PR = { provider: "github.com", org: "example", repo: "atlas", number: 7, url: "https://github.com/example/atlas/pull/7" };

describe("review tracking runtime eligibility", () => {
  let temp: ReturnType<typeof createTempStateDb>;
  let onEvent: (event: AgentEvent) => void;
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
  const submitTurnIfIdle = vi.fn(async ({ canAdmit }: { canAdmit: () => Promise<boolean> }) =>
    await canAdmit() ? { status: "started", turnId: "fix-turn" } : { status: "busy" });
  function install(readReviewStackHold?: () => Promise<string | undefined>) {
    submitTurn.mockClear();
    submitTurnIfIdle.mockClear();
    const registry = {
      onEvent: (listener: typeof onEvent) => { onEvent = listener; return () => {}; },
      setPwrAgentThreadTodoHandler: () => {},
      getThreadInfo: () => undefined,
      submitTurn, submitTurnIfIdle,
    } as unknown as DesktopBackendRegistry;
    installThreadTodoRuntime({ registry, broadcast, listProjects: async () => [], readDefaultMergeMethod: () => "squash", readReviewStackHold,
      feed: { loadOwners: async () => [], managedThreadKeys: () => new Set(), onDelta: () => {} } });
  }


  const findingsOutput = (turnId: string, id: string) => ({ backend: THREAD.backend, notification: {
      method: "item/completed" as const, params: { threadId: THREAD.threadId, turnId, item: {
        id, type: "exitedReviewMode", review: "",
        data: { reviewOutput: claudeReviewOutput({ findings: [
          { file: "src/a.ts", line: 3, summary: "Minor naming.", failureScenario: "Confuses readers." },
          { file: "src/b.ts", line: 9, summary: "Drops a write.", failureScenario: "Loses data." },
        ] }, "/repo") },
      } },
    } }) as AgentEvent;

  it.each([0, 8, 16, 32, 64])("visits held Auto-fixes for %i unrelated threads", async (n) => {
    const hold = vi.fn(async () => "CI");
    install(hold);
    for (let i = 0; i < n; i++) {
      const thread = { backend: "codex" as const, threadId: "holder-" + i };
      const turn = "review-" + i;
      getReviewAutoFixArming().starting(thread, "auto-fix").accepted(turn);
      const event = findingsOutput(turn, "code-review-" + i);
      event.notification.params.threadId = thread.threadId;
      onEvent(event);
    }
    await new Promise((resolve) => setImmediate(resolve));
    expect(hold).toHaveBeenCalledTimes(n);
    const reviewLookup = vi.spyOn(getThreadReviewService(), "get");
    try {
      for (const phase of ["terminal", "forge"]) {
        reviewLookup.mockClear();
        hold.mockClear();
        for (let i = 0; i < 8; i++) {
          const key = "unrelated-" + i;
          const notification = phase === "terminal"
            ? { method: "turn/completed", params: { threadId: key, turnId: key, turn: { id: key, status: "completed", output: [] } } }
            : { method: "pullRequest/status/updated", params: { pr: PR } };
          onEvent({ backend: "codex", notification });
          await new Promise((resolve) => setImmediate(resolve));
        }
        expect(submitTurnIfIdle).not.toHaveBeenCalled();
        record({ kind: "held-auto-fix", n, phase, events: 8,
          reviewGets: reviewLookup.mock.calls.length, stackHoldChecks: hold.mock.calls.length });
      }
    } finally {
      reviewLookup.mockRestore();
    }
  });
});
