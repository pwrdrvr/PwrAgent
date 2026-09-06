import { applyScheduledActionProjection, syncScheduledActionProjections } from "../../../lib/useScheduledThreadActionProjection";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { NavigationThreadSummary, ScheduledThreadAction } from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { beginLaunchpadComposition, getLaunchpadComposerDestination, handoffLaunchpadComposer, resolveLaunchpadComposerScope } from "../launchpad-composer-handoff";
import { getNextReleasableQueuedTurn, useComposerDraftStore } from "../useComposerDraftStore";

const thread: NavigationThreadSummary = {
  id: "new-thread",
  source: "codex",
  title: "Initial message",
  titleSource: "explicit",
  linkedDirectories: [],
  inbox: { inInbox: false },
  optimisticActiveTurn: { id: "first-turn" },
};
const source = "launchpad:project";
const target = "thread:codex:new-thread";
const draft = (text: string) => ({
  draft: text,
  imageAttachments: [],
  fileAttachments: [],
  skillTokens: [],
});
const queued = (text: string) => ({
  id: text,
  text,
  input: [{ type: "text" as const, text }],
  imageAttachments: [],
  fileAttachments: [],
});

describe("launchpad composer handoff", () => {
  it("moves the latest draft, parked drafts, and ordered follow-ups before selecting the thread", () => {
    const { result } = renderHook(useComposerDraftStore);
    const store = result.current;
    store.set(source, draft("Still typing"));
    store.pushDraft(source, draft("Older draft"));
    store.setQueuedTurns(source, [queued("second"), queued("third")]);
    act(() => handoffLaunchpadComposer(store, "project", thread));
    expect(store.get(target)?.draft).toBe("Still typing");
    expect(store.popDraft(target)?.draft).toBe("Older draft");
    expect(store.getQueuedTurns(target).map((entry) => entry.text)).toEqual(["second", "third"]);
    expect(store.get(source)).toBeUndefined();
    expect(store.getQueuedTurns(source)).toEqual([]);
    expect(resolveLaunchpadComposerScope(store, source)).toBe(target);
  });

  it("retains the destination for an attachment finishing after another launchpad opens", () => {
    const { result } = renderHook(useComposerDraftStore);
    const destination = getLaunchpadComposerDestination(result.current, source);
    act(() => handoffLaunchpadComposer(result.current, "project", thread));
    beginLaunchpadComposition(result.current, source);
    expect(destination.scopeKey).toBe(target);
    expect(getLaunchpadComposerDestination(result.current, source).scopeKey).toBe(source);
  });

  it("steers the created thread even if another conversation is selected", async () => {
    const { result } = renderHook(useComposerDraftStore);
    const steerTurn = vi.fn<NonNullable<DesktopApi["steerTurn"]>>().mockResolvedValue({
      backend: "codex", threadId: thread.id, turnId: "first-turn", disposition: "steered",
    });
    result.current.setQueuedTurns(source, [{ ...queued("correction"), steerWhenReady: true }]);
    act(() => handoffLaunchpadComposer(result.current, "project", thread, { steerTurn }));
    expect(steerTurn).toHaveBeenCalledWith(expect.objectContaining({
      threadId: thread.id,
      expectedTurnId: "first-turn",
      input: [{ type: "text", text: "correction" }],
    }));
    await waitFor(() => expect(result.current.getQueuedTurns(target)).toEqual([]));
  });

  it("holds a failed steer for explicit recovery without losing its content", async () => {
    const { result } = renderHook(useComposerDraftStore);
    const steerTurn = vi.fn().mockRejectedValue(new Error("Connection lost"));
    result.current.setQueuedTurns(source, [{ ...queued("correction"), steerWhenReady: true }]);
    act(() => handoffLaunchpadComposer(result.current, "project", thread, { steerTurn }));
    await waitFor(() => expect(result.current.getQueuedTurns(target)[0]).toMatchObject({
      text: "correction", manualReleaseRequired: true, backendQueuePending: false,
      errorMessage: "Connection lost",
    }));
    expect(getNextReleasableQueuedTurn(result.current.getQueuedTurns(target))).toBeUndefined();
  });

  it.each(["event", "refresh", "early event"])("releases scheduled follow-ups only after positive admission (%s)", (delivery) => {
    const { result } = renderHook(useComposerDraftStore);
    const store = result.current;
    const action: ScheduledThreadAction = {
      id: "scheduled-first", backend: "codex", threadId: thread.id, kind: "turn", origin: "desktop",
      status: "started", scheduledFor: 100, createdAt: 1, updatedAt: 101,
      turnId: "scheduled-turn", displayText: "First message",
    };
    if (delivery === "early event") act(() => applyScheduledActionProjection(store, action));
    store.setQueuedTurns(source, [queued("second"), queued("third")]);
    act(() => handoffLaunchpadComposer(store, "project", {
      ...thread, optimisticActiveTurn: undefined,
      scheduledStart: { actionId: action.id, scheduledFor: 100, state: "scheduled" },
    }));
    if (delivery !== "early event") {
      expect(store.getQueuedTurns(target)[0].manualReleaseRequired).not.toBe(true);
      expect(getNextReleasableQueuedTurn(store.getQueuedTurns(target), 1000)).toBeUndefined();
      // Neither the due time nor a stale/empty refresh proves admission.
      act(() => syncScheduledActionProjections(store, [], new Set([target])));
      expect(getNextReleasableQueuedTurn(store.getQueuedTurns(target), 1000)).toBeUndefined();
      act(() => delivery === "event"
        ? applyScheduledActionProjection(store, action)
        : syncScheduledActionProjections(store, [action]));
    }
    expect(getNextReleasableQueuedTurn(store.getQueuedTurns(target))?.text).toBe("second");
    expect(store.getQueuedTurns(target).map((entry) => entry.text)).toEqual(["second", "third"]);
  });

  it("delivers a scheduled steer when the first action starts", async () => {
    const { result } = renderHook(useComposerDraftStore);
    const steerTurn = vi.fn<NonNullable<DesktopApi["steerTurn"]>>().mockResolvedValue({
      backend: "codex", threadId: thread.id, turnId: "scheduled-turn", disposition: "steered",
    });
    result.current.setQueuedTurns(source, [{ ...queued("correction"), steerWhenReady: true }]);
    act(() => handoffLaunchpadComposer(result.current, "project", {
      ...thread, optimisticActiveTurn: undefined,
      scheduledStart: { actionId: "first", scheduledFor: 100, state: "scheduled" },
    }, { steerTurn }));
    expect(steerTurn).not.toHaveBeenCalled();
    act(() => applyScheduledActionProjection(result.current, {
      id: "first", backend: "codex", threadId: thread.id, kind: "turn", origin: "desktop",
      status: "started", scheduledFor: 100, createdAt: 1, updatedAt: 101,
      turnId: "scheduled-turn", displayText: "First message",
    }));
    expect(steerTurn).toHaveBeenCalledWith(expect.objectContaining({ expectedTurnId: "scheduled-turn" }));
    await waitFor(() => expect(result.current.getQueuedTurns(target)).toEqual([]));
  });

  it("does not release follow-ups ahead of a first message whose setup failed", () => {
    const { result } = renderHook(useComposerDraftStore);
    result.current.setQueuedTurns(source, [queued("second")]);
    act(() => handoffLaunchpadComposer(result.current, "project", {
      ...thread, optimisticActiveTurn: undefined,
    }));
    expect(result.current.getQueuedTurns(target)[0].manualReleaseRequired).toBe(true);
    expect(getNextReleasableQueuedTurn(result.current.getQueuedTurns(target))).toBeUndefined();
  });
});
