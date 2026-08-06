import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { ScheduledThreadAction } from "@pwragent/shared";
import { useComposerDraftStore } from "../../features/composer/useComposerDraftStore";
import type { DesktopApi } from "../desktop-api";
import {
  applyScheduledActionProjection,
  syncScheduledActionProjections,
  useScheduledThreadActionProjection,
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

afterEach(() => {
  vi.useRealTimers();
});

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

  it("turns a failed backend action into a locally recoverable draft", () => {
    const { result } = renderHook(() => useComposerDraftStore());
    const store = result.current;
    const scopeKey = "thread:codex:thread-1";

    applyScheduledActionProjection(store, scheduledAction({
      status: "failed",
      errorMessage: "backend offline",
    }));

    expect(store.getQueuedTurns(scopeKey)).toEqual([
      expect.objectContaining({
        failedScheduledActionId: "scheduled-1",
        errorMessage: "backend offline",
        text: "Follow up",
      }),
    ]);
    expect(
      store.getQueuedTurns(scopeKey)[0]?.scheduledActionId,
    ).toBeUndefined();
  });

  it("periodically reconciles actions changed by another process", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useComposerDraftStore());
    const listScheduledThreadActions = vi.fn()
      .mockResolvedValueOnce({ actions: [], observedAt: 1_000 })
      .mockResolvedValueOnce({
        actions: [scheduledAction()],
        observedAt: 2_000,
      });
    const desktopApi = {
      listScheduledThreadActions,
      onAgentEvent: () => () => undefined,
    } as unknown as DesktopApi;
    const projection = renderHook(() => useScheduledThreadActionProjection({
      composerDraftStore: result.current,
      desktopApi,
    }));

    await act(async () => {
      await Promise.resolve();
    });
    expect(listScheduledThreadActions).toHaveBeenCalledWith({
      federationTarget: undefined,
      includeFailed: true,
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(listScheduledThreadActions).toHaveBeenCalledTimes(2);
    expect(listScheduledThreadActions).toHaveBeenLastCalledWith({
      federationTarget: undefined,
      terminalUpdatedAfter: 1_000,
    });
    expect(
      result.current.getQueuedTurns("thread:codex:thread-1"),
    ).toEqual([
      expect.objectContaining({ scheduledActionId: "scheduled-1" }),
    ]);

    projection.unmount();
    vi.useRealTimers();
  });

  it("suspends remote reconciliation until the peer reconnects", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useComposerDraftStore());
    const listScheduledThreadActions = vi.fn(async () => ({
      actions: [],
      observedAt: 1_000,
    }));
    const federationTarget = {
      scope: "remote" as const,
      instanceId: "peer-one",
    };
    const desktopApi = {
      listScheduledThreadActions,
      onAgentEvent: () => () => undefined,
    } as unknown as DesktopApi;
    const projection = renderHook(
      ({ suspended }) => useScheduledThreadActionProjection({
        composerDraftStore: result.current,
        desktopApi,
        federationTarget,
        suspended,
      }),
      { initialProps: { suspended: false } },
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(listScheduledThreadActions).toHaveBeenCalledTimes(1);

    projection.rerender({ suspended: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(listScheduledThreadActions).toHaveBeenCalledTimes(1);

    projection.rerender({ suspended: false });
    await act(async () => {
      await Promise.resolve();
    });
    expect(listScheduledThreadActions).toHaveBeenCalledTimes(2);

    projection.unmount();
    vi.useRealTimers();
  });

  it("hydrates failures retained before the renderer subscribed", async () => {
    const { result } = renderHook(() => useComposerDraftStore());
    const listScheduledThreadActions = vi.fn(async () => ({
      actions: [scheduledAction({
        status: "failed",
        errorMessage: "failed before mount",
      })],
      observedAt: 2_000,
    }));
    const projection = renderHook(() => useScheduledThreadActionProjection({
      composerDraftStore: result.current,
      desktopApi: {
        listScheduledThreadActions,
        onAgentEvent: () => () => undefined,
      } as unknown as DesktopApi,
    }));

    await act(async () => {
      await Promise.resolve();
    });

    expect(listScheduledThreadActions).toHaveBeenCalledWith({
      federationTarget: undefined,
      includeFailed: true,
    });
    expect(
      result.current.getQueuedTurns("thread:codex:thread-1"),
    ).toEqual([
      expect.objectContaining({
        errorMessage: "failed before mount",
        failedScheduledActionId: "scheduled-1",
      }),
    ]);
    projection.unmount();
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
