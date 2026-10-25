import { describe, expect, it } from "vitest";
import {
  navigationInvalidationMayChangeMembership,
  navigationQueryEventRequiresRefresh,
} from "../navigation-query-events";

describe("navigation query events", () => {
  // Background tasks that outlive a turn mark the owning row as working, so
  // their start and end must reach the thread list.
  it("refreshes rows when a thread's background tasks change", () => {
    expect(navigationQueryEventRequiresRefresh("thread/backgroundTasks/updated", {
      threadId: "thread", tasks: [],
    })).toBe(true);
    expect(navigationInvalidationMayChangeMembership("thread/backgroundTasks/updated")).toBe(false);
  });

  it("ignores streamed output", () => {
    expect(navigationQueryEventRequiresRefresh("item/commandExecution/outputDelta")).toBe(false);
  });
});
