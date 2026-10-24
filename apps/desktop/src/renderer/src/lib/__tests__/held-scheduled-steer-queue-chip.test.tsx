import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  ListScheduledThreadActionsResponse,
  NavigationQueueProjection,
  NavigationQueueProjectionRequest,
  NavigationThreadSummary,
  ScheduledThreadAction,
} from "@pwragent/shared";
import {
  buildThreadComposerScopeKey,
  useComposerDraftStore,
} from "../../features/composer/useComposerDraftStore";
import type { DesktopApi } from "../desktop-api";
import { useIndependentQueueProjection } from "../useIndependentQueueProjection";
import { useScheduledThreadActionProjection } from "../useScheduledThreadActionProjection";
import { useThreadQueuedMessageIndicators } from "../useThreadQueuedMessageIndicators";

const thread = {
  id: "grok-thread",
  title: "Local Grok thread",
  source: "acp:grok",
  linkedDirectories: [],
  updatedAt: 1,
} as unknown as NavigationThreadSummary;
const other = {
  id: "other-thread",
  title: "Other thread",
  source: "codex",
  linkedDirectories: [],
  updatedAt: 2,
} as unknown as NavigationThreadSummary;

// A steer held after its target turn ended, a month before this launch. The
// durable action survived the restart; the owner's in-memory FIFO entry did not.
const heldSteer: ScheduledThreadAction = {
  id: "scheduled-action:steer:held",
  backend: "acp:grok",
  threadId: "grok-thread",
  kind: "turn",
  origin: "desktop",
  status: "held",
  scheduledFor: 1,
  displayText: "One more thing",
  turn: { input: [{ type: "text", text: "One more thing" }] },
  queueEntryId: "scheduled-turn:scheduled-action:steer:held",
  errorMessage: "This steering message was held after its target turn ended. Retry it when the provider is ready.",
  manualReleaseRequired: true,
  createdAt: 1,
  updatedAt: 2,
};

function harness(selectedThread?: NavigationThreadSummary) {
  const queueReads = vi.fn(async (request: NavigationQueueProjectionRequest): Promise<NavigationQueueProjection> => ({
    protocol: 2,
    ref: request.ref,
    revision: "empty-fifo",
    readiness: "ready",
    complete: true,
    entries: [],
  }));
  const api = {
    getNavigationQueueProjection: queueReads,
    releaseNavigationQuery: async () => {},
    listScheduledThreadActions: async (): Promise<ListScheduledThreadActionsResponse> => ({
      actions: [heldSteer],
      projectionProtocol: 2,
      revision: "held",
      complete: true,
      observedAt: 10,
    }),
  } as unknown as DesktopApi;
  const threads = [thread, other];
  const hook = renderHook(({ selected }) => {
    const store = useComposerDraftStore();
    useScheduledThreadActionProjection({ composerDraftStore: store, desktopApi: api });
    useIndependentQueueProjection({ composerDraftStore: store, desktopApi: api, selectedThread: selected });
    return {
      store,
      indicators: useThreadQueuedMessageIndicators({ composerDraftStore: store, threads }),
    };
  }, { initialProps: { selected: selectedThread } });
  return { hook, queueReads };
}

describe("a held scheduled steer the owner's FIFO no longer holds", () => {
  it("keeps its Held chip after the owner's complete FIFO reads empty", async () => {
    const { hook, queueReads } = harness(other);
    const scope = buildThreadComposerScopeKey("acp:grok", "grok-thread");
    await waitFor(() => expect(hook.result.current.indicators["acp:grok:grok-thread"]).toBe("held"));
    // Projecting the held steer demands its owner's FIFO; wait for that read
    // to land and be reconciled.
    await waitFor(() => expect(queueReads.mock.calls.some(([request]) =>
      request.ref.threadId === "grok-thread")).toBe(true), { timeout: 2_000 });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });

    expect(hook.result.current.store.getQueuedTurns(scope).map((entry) => entry.id))
      .toEqual(["scheduled-projection:scheduled-action:steer:held"]);
    expect(hook.result.current.indicators["acp:grok:grok-thread"]).toBe("held");
  });

  it("does not flash the Held chip when focus leaves the thread", async () => {
    const { hook, queueReads } = harness(thread);
    await waitFor(() => expect(hook.result.current.indicators["acp:grok:grok-thread"]).toBe("held"));
    await waitFor(() => expect(queueReads).toHaveBeenCalled());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    const reads = queueReads.mock.calls.length;

    hook.rerender({ selected: other });
    await waitFor(() => expect(queueReads.mock.calls.length).toBeGreaterThan(reads), { timeout: 2_000 });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });

    expect(hook.result.current.indicators["acp:grok:grok-thread"]).toBe("held");
  });
});
