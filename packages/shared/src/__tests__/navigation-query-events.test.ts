import { describe, expect, it } from "vitest";
import {
  navigationInvalidationMayChangeMembership,
  navigationQueryEventRequiresRefresh,
} from "../navigation-query-events";
import { isThreadPendingWakeInvalidation } from "../contracts/thread-pending-wakes";

describe("navigation query events", () => {
  it("recognizes direct and federated wake-source changes without membership churn", () => {
    for (const sourceMethod of ["thread/dependencies/updated", "thread/scheduledAction/updated"]) {
      expect(isThreadPendingWakeInvalidation(sourceMethod, {})).toBe(true);
      expect(isThreadPendingWakeInvalidation("navigation/invalidated", { sourceMethod })).toBe(true);
      expect(navigationInvalidationMayChangeMembership(sourceMethod)).toBe(false);
    }
    expect(isThreadPendingWakeInvalidation("thread/subAgents/updated", { navigationChanged: false })).toBe(false);
  });
  // Background tasks that outlive a turn mark the owning row (working for
  // Claude, a running command for Codex), so their start and end must reach
  // the thread list.
  it("refreshes rows when a thread's background tasks change", () => {
    expect(navigationQueryEventRequiresRefresh("thread/backgroundTasks/updated", {
      threadId: "thread", tasks: [],
    })).toBe(true);
    expect(navigationQueryEventRequiresRefresh("thread/backgroundTasks/updated", {
      threadId: "thread",
      tasks: [{ itemId: "command-1", processId: "session-1", command: "pnpm dev", cwd: "/fixture/project" }],
    })).toBe(true);
    expect(navigationInvalidationMayChangeMembership("thread/backgroundTasks/updated")).toBe(false);
  });

  // Claude's own wake-ups change no row; only the thread's Waiting for list re-reads.
  it("keeps a backend's scheduled wakes out of the thread list", () => {
    expect(navigationQueryEventRequiresRefresh("thread/sessionWakes/updated", { threadId: "thread", wakes: [] })).toBe(false);
    expect(navigationInvalidationMayChangeMembership("thread/sessionWakes/updated")).toBe(false);
  });

  // A row carries its owner's CI watch marks, so a viewer's peer row must
  // re-read when a watch is armed, stopped or ends.
  it("refreshes a row, and only that row, when its PR watches change", () => {
    expect(navigationQueryEventRequiresRefresh("thread/prWatches/updated", {
      backend: "codex", threadId: "thread",
    })).toBe(true);
    expect(navigationInvalidationMayChangeMembership("thread/prWatches/updated")).toBe(false);
  });

  it("ignores streamed output", () => {
    expect(navigationQueryEventRequiresRefresh("item/commandExecution/outputDelta")).toBe(false);
  });
});
