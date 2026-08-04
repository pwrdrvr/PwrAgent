import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import type { ScheduledThreadAction } from "@pwragent/shared";
import { useComposerDraftStore } from "../../features/composer/useComposerDraftStore";
import {
  applyScheduledActionProjection,
  syncScheduledActionProjections,
} from "../useScheduledThreadActionProjection";

function scheduledAction(
  overrides: Partial<ScheduledThreadAction> = {},
): ScheduledThreadAction {
  return {
    id: "scheduled-1",
    backend: "codex",
    threadId: "thread-1",
    kind: "turn",
    origin: "desktop",
    status: "scheduled",
    scheduledFor: 20_000,
    displayText: "Follow up",
    turn: { input: [{ type: "text", text: "Follow up" }] },
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

describe("scheduled thread action projections", () => {
  it("hydrates durable scheduled actions without replacing local queue state", () => {
    const { result } = renderHook(() => useComposerDraftStore());
    const store = result.current;
    const scopeKey = "thread:codex:thread-1";
    store.setQueuedTurns(scopeKey, [{
      id: "local-1",
      text: "Local queue entry",
      imageAttachments: [],
      fileAttachments: [],
    }]);

    syncScheduledActionProjections(store, [scheduledAction()]);

    expect(store.getQueuedTurns(scopeKey)).toEqual([
      expect.objectContaining({ id: "local-1" }),
      expect.objectContaining({
        scheduledActionId: "scheduled-1",
        scheduledSendAt: 20_000,
        text: "Follow up",
      }),
    ]);
  });

  it("removes the projection when the backend action becomes terminal", () => {
    const { result } = renderHook(() => useComposerDraftStore());
    const store = result.current;
    const scopeKey = "thread:codex:thread-1";
    applyScheduledActionProjection(store, scheduledAction());

    applyScheduledActionProjection(
      store,
      scheduledAction({ status: "started", turnId: "turn-1" }),
    );

    expect(store.getQueuedTurns(scopeKey)).toEqual([]);
  });

  it("keeps review display copy separate from its editable slash command", () => {
    const { result } = renderHook(() => useComposerDraftStore());
    const store = result.current;
    const scopeKey = "thread:codex:thread-1";

    applyScheduledActionProjection(store, scheduledAction({
      kind: "review",
      displayText: "Review changes against main",
      turn: undefined,
      review: {
        target: { type: "baseBranch", branch: "main" },
        draftText: "/review main",
      },
    }));

    expect(store.getQueuedTurns(scopeKey)).toEqual([
      expect.objectContaining({
        text: "/review main",
        reviewCommand: expect.objectContaining({
          displayText: "Review changes against main",
        }),
      }),
    ]);
  });

  it("removes stale projections when a refresh no longer returns their scope", () => {
    const { result } = renderHook(() => useComposerDraftStore());
    const store = result.current;
    const scopeKey = "thread:codex:thread-1";
    const projectedScopes = syncScheduledActionProjections(
      store,
      [scheduledAction()],
    );

    syncScheduledActionProjections(store, [], projectedScopes);

    expect(store.getQueuedTurns(scopeKey)).toEqual([]);
  });
});
