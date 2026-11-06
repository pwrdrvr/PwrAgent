import { describe, expect, it } from "vitest";
import {
  hydrationLifecycleChanged,
  isCurrentHydration,
  transitionHydratedActiveTurn,
  transitionHydratedInteractions,
  transitionThreadHydration,
} from "../thread-session-transitions";

describe("thread hydration ownership", () => {
  it("keeps a newer read owned when an old read settles, then rejects it after eviction", () => {
    const first = transitionThreadHydration(undefined, { type: "begin" });
    if (first.phase !== "loading") throw new Error("Expected loading");
    const second = transitionThreadHydration(first, { type: "begin" });
    if (second.phase !== "loading") throw new Error("Expected loading");
    expect(isCurrentHydration(second, first.attempt)).toBe(false);
    expect(transitionThreadHydration(second, { type: "settle", attempt: first.attempt })).toBe(second);
    const settled = transitionThreadHydration(second, { type: "settle", attempt: second.attempt });
    expect(isCurrentHydration(settled, second.attempt)).toBe(true);
    expect(isCurrentHydration(transitionThreadHydration(settled, { type: "invalidate" }), second.attempt)).toBe(false);
  });

  it("keeps lifecycle ownership after live completion even if an active status follows", () => {
    const attempt = { requestVersion: 1, lifecycle: { revision: 2, turnRevision: 1 } };
    expect(hydrationLifecycleChanged(attempt, { revision: 4, turnRevision: 2 }, true, true)).toBe(true);
    expect(hydrationLifecycleChanged(attempt, { revision: 3, turnRevision: 1 }, true, true)).toBe(false);
    expect(hydrationLifecycleChanged(attempt, { revision: 3, turnRevision: 1 }, true, false)).toBe(true);
  });

  it("preserves a live turn's start time while hydrating an interaction on that turn", () => {
    expect(transitionHydratedActiveTurn({ activeTurnId: "live", activeTurnStartedAt: 42 }, {
      clear: false, pendingTurnId: "live", hasInteraction: true,
    })).toEqual({ activeTurnId: "live", activeTurnStartedAt: 42, backendReportedActive: true });
    expect(transitionHydratedActiveTurn({ activeTurnId: "old", activeTurnStartedAt: 42 }, {
      clear: true, hasInteraction: false, backendReportedActive: false,
    })).toEqual({ activeTurnId: undefined, activeTurnStartedAt: undefined, backendReportedActive: false });
  });

  it("clears interactions independently while retaining active thinking", () => {
    expect(transitionHydratedInteractions({ pendingStatusText: "Waiting for input" }, {
      clearThinking: false, clearInteraction: true, backendReportedActive: true,
    })).toEqual({ pendingStatusText: "Thinking", pendingRequest: undefined, pendingUserInput: undefined, pendingMcpInteraction: undefined });
    expect(transitionHydratedInteractions({ pendingStatusText: "Live status" }, {
      clearThinking: false, clearInteraction: false,
    }).pendingStatusText).toBe("Live status");
  });
});
