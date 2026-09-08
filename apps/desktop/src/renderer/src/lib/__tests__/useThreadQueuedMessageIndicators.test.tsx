import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared";
import {
  buildThreadComposerScopeKey,
  useComposerDraftStore,
  type ComposerDraftStore,
  type ComposerQueuedTurnSnapshot,
} from "../../features/composer/useComposerDraftStore";
import { useThreadQueuedMessageIndicators } from "../useThreadQueuedMessageIndicators";

function makeThread(id: string): NavigationThreadSummary {
  return {
    id,
    title: id,
    titleSource: "explicit",
    source: "codex",
    executionMode: "default",
    updatedAt: 0,
    inbox: { inInbox: false },
    linkedDirectories: [],
  };
}

function makeQueuedTurn(
  overrides: Partial<ComposerQueuedTurnSnapshot> = {},
): ComposerQueuedTurnSnapshot {
  return {
    id: "queued-1",
    text: "hello",
    imageAttachments: [],
    fileAttachments: [],
    ...overrides,
  };
}

function scopeKey(thread: NavigationThreadSummary): string {
  return buildThreadComposerScopeKey(thread.source, thread.id, thread.federation?.ref.target);
}

function renderIndicators(threads: NavigationThreadSummary[]) {
  return renderHook(
    ({ threads: currentThreads }) => {
      const store = useComposerDraftStore();
      const indicators = useThreadQueuedMessageIndicators({
        composerDraftStore: store,
        threads: currentThreads,
      });
      return { store, indicators };
    },
    { initialProps: { threads } },
  );
}

function setQueued(
  store: ComposerDraftStore,
  thread: NavigationThreadSummary,
  turns: ComposerQueuedTurnSnapshot[],
): void {
  act(() => {
    store.setQueuedTurns(scopeKey(thread), turns);
  });
}

describe("useThreadQueuedMessageIndicators", () => {
  it("returns an empty map when no thread has queued turns", () => {
    const { result } = renderIndicators([makeThread("a")]);
    expect(result.current.indicators).toEqual({});
  });

  it("classifies a queued turn without a send time as 'queued'", () => {
    const thread = makeThread("a");
    const { result } = renderIndicators([thread]);
    setQueued(result.current.store, thread, [makeQueuedTurn()]);
    expect(result.current.indicators).toEqual({ "codex:a": "queued" });
  });

  it("classifies a future-dated turn as 'scheduled'", () => {
    const thread = makeThread("a");
    const { result } = renderIndicators([thread]);
    setQueued(result.current.store, thread, [
      makeQueuedTurn({ scheduledSendAt: Date.now() + 60_000 }),
    ]);
    expect(result.current.indicators).toEqual({ "codex:a": "scheduled" });
  });

  it("classifies a durable PR auto-fix countdown as scheduled", () => {
    const thread = {
      ...makeThread("a"),
      prAutoDispatchPending: {
        fingerprint: "fingerprint-1",
        prKey: "github.com/pwrdrvr/PwrAgent#1105",
        prNumber: 1105,
        prUrl: "https://github.com/pwrdrvr/PwrAgent/pull/1105",
        headSha: "a".repeat(40),
        eventKinds: ["ci-failure" as const],
        createdAt: Date.now(),
        scheduledAt: Date.now() + 30_000,
      },
    };
    const { result } = renderIndicators([thread]);
    expect(result.current.indicators).toEqual({ "codex:a": "scheduled" });
  });

  it("classifies an unborn scheduled thread as scheduled without renderer queue state", () => {
    const thread = {
      ...makeThread("a"),
      scheduledStart: {
        actionId: "scheduled-action:1",
        scheduledFor: Date.now() + 30_000,
        state: "scheduled" as const,
      },
    };
    const { result } = renderIndicators([thread]);
    expect(result.current.indicators).toEqual({ "codex:a": "scheduled" });
  });

  it("does not chip an unborn thread whose scheduled start was cancelled", () => {
    const thread = {
      ...makeThread("a"),
      scheduledStart: {
        actionId: "scheduled-action:1",
        scheduledFor: Date.now() + 30_000,
        state: "cancelled" as const,
      },
    };
    const { result } = renderIndicators([thread]);
    expect(result.current.indicators).toEqual({});
  });

  it("prefers 'scheduled' when a thread has both a scheduled and a plain queued turn", () => {
    const thread = makeThread("a");
    const { result } = renderIndicators([thread]);
    setQueued(result.current.store, thread, [
      makeQueuedTurn({ id: "plain" }),
      makeQueuedTurn({ id: "future", scheduledSendAt: Date.now() + 60_000 }),
    ]);
    expect(result.current.indicators).toEqual({ "codex:a": "scheduled" });
  });

  it("treats an already-elapsed send time as 'queued', not 'scheduled'", () => {
    const thread = makeThread("a");
    const { result } = renderIndicators([thread]);
    setQueued(result.current.store, thread, [
      makeQueuedTurn({ scheduledSendAt: Date.now() - 60_000 }),
    ]);
    expect(result.current.indicators).toEqual({ "codex:a": "queued" });
  });

  it("keys indicators by thread identity key across multiple threads", () => {
    const a = makeThread("a");
    const b = makeThread("b");
    const { result } = renderIndicators([a, b]);
    setQueued(result.current.store, a, [makeQueuedTurn()]);
    setQueued(result.current.store, b, [
      makeQueuedTurn({ scheduledSendAt: Date.now() + 60_000 }),
    ]);
    expect(result.current.indicators).toEqual({
      "codex:a": "queued",
      "codex:b": "scheduled",
    });
  });

  it("reactively clears the indicator when the queued turn is released", () => {
    const thread = makeThread("a");
    const { result } = renderIndicators([thread]);
    setQueued(result.current.store, thread, [makeQueuedTurn()]);
    expect(result.current.indicators).toEqual({ "codex:a": "queued" });

    act(() => {
      result.current.store.shiftQueuedTurn(scopeKey(thread));
    });
    expect(result.current.indicators).toEqual({});
  });
});
