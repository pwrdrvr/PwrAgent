import { describe, expect, it } from "vitest";
import {
  navigationInvalidationMayChangeMembership,
  navigationQueryEventRequiresRefresh,
} from "../navigation-query-events";

describe("navigation query events", () => {
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

  it("ignores streamed output", () => {
    expect(navigationQueryEventRequiresRefresh("item/commandExecution/outputDelta")).toBe(false);
  });
});
