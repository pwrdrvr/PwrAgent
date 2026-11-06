import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import fc from "fast-check";
import { useMemo, type ComponentProps } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentEvent, BackendSummary, ScheduledThreadAction, SteerTurnResponse } from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { applyScheduledActionProjection, syncScheduledActionProjections } from "../../../lib/useScheduledThreadActionProjection";
import { navigationQueryFixture } from "../../../test/navigation-query-fixture";
import { Composer as ProductionComposer } from "../Composer";
import { buildThreadComposerScopeKey, useComposerDraftStore } from "../useComposerDraftStore";

function Composer(props: ComponentProps<typeof ProductionComposer>) {
  const desktopApi = useMemo<DesktopApi>(() => ({
    ...props.desktopApi,
    getNavigationQueryPage: async (request) => navigationQueryFixture(request, props),
  }), [props.desktopApi]);
  return <ProductionComposer {...props} desktopApi={desktopApi} />;
}

beforeAll(() => {
  const rect = { bottom: 0, height: 0, left: 0, right: 0, toJSON: () => ({}), top: 0, width: 0, x: 0, y: 0 } as DOMRect;
  const text = Text.prototype as Text & { getClientRects?: () => DOMRect[]; getBoundingClientRect?: () => DOMRect };
  text.getClientRects ??= () => [];
  text.getBoundingClientRect ??= () => rect;
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect ??= () => rect;
});

async function deliverAfterStart(params: { text: string; receiptStarted: boolean; observedStart: boolean; startedDisposition?: boolean; replayQueuedEvent?: boolean }) {
  const listeners = new Set<(event: AgentEvent) => void>();
  let resolve!: (response: SteerTurnResponse) => void;
  const response = new Promise<SteerTurnResponse>((done) => { resolve = done; });
  const steerTurn = vi.fn(() => response);
  const onShowNotice = vi.fn();
  const { result } = renderHook(() => useComposerDraftStore());
  const store = result.current;
  const scope = buildThreadComposerScopeKey("codex", "parent");
  const backend: BackendSummary = {
    kind: "codex", label: "Codex", available: true, methods: ["turn/start", "turn/steer"],
    capabilities: {
      listThreads: true, createThread: true, resumeThread: true, renameThread: false,
      readThread: true, startTurn: true, interruptTurn: true, steerTurn: true,
      transcriptPagination: true, toolUse: false, approvalRequests: true, multiDirectoryThreads: true,
    },
    executionModes: [{ mode: "default", label: "Default Access", available: true, isDefault: true }],
  };
  try {
    render(<Composer activeTurnId="review" backends={[backend]} draftStore={store} skills={[]} onShowNotice={onShowNotice}
      desktopApi={{ steerTurn, onAgentEvent: (listener) => {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      } }}
      thread={{ id: "parent", title: "Review", titleSource: "explicit", source: "codex", executionMode: "default", linkedDirectories: [], inbox: { inInbox: false } }}
    />);
    fireEvent.change(screen.getByLabelText("Reply"), { target: { value: params.text } });
    await act(async () => {
      fireEvent.keyDown(screen.getByLabelText("Reply"), { key: "Enter", metaKey: true });
    });
    expect(steerTurn).toHaveBeenCalledOnce();
    const queued: ScheduledThreadAction = {
      id: "follow-up", backend: "codex", threadId: "parent", kind: "turn", origin: "desktop",
      status: "queued", scheduledFor: 1, createdAt: 1, updatedAt: 2,
      displayText: params.text, turn: { input: [{ type: "text", text: params.text }] }, queueEntryId: "queue-follow-up",
    };
    const started = { ...queued, status: "started" as const, turnId: "follow-up-turn", updatedAt: 3 };
    if (params.observedStart) {
      await act(async () => {
        for (const action of params.replayQueuedEvent ? [queued, started, queued] : [queued, started]) {
          for (const listener of [...listeners]) listener({
            backend: "codex", notification: { method: "thread/scheduledAction/updated", params: { action } },
          });
          applyScheduledActionProjection(store, action);
        }
        syncScheduledActionProjections(store, [], new Set([scope]));
      });
      expect(store.getQueuedTurns(scope)).toEqual([]);
    }
    await act(async () => {
      resolve({ backend: "codex", threadId: "parent", turnId: "review", disposition: params.startedDisposition ? "started" : "scheduled",
        fallbackReason: "native-review", scheduledAction: params.receiptStarted ? started : queued });
      await response;
    });
    expect(store.getQueuedTurns(scope)).toEqual([]);
    expect(screen.queryByLabelText("Queued message")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Pending steer message")).not.toBeInTheDocument();
    expect(onShowNotice).not.toHaveBeenCalled();
    expect(steerTurn).toHaveBeenCalledOnce();
  } finally {
    cleanup();
  }
}

describe("steer fallback projection", () => {
  it("does not resurrect a started follow-up after owner reconciliation", async () => {
    await deliverAfterStart({ text: "Follow up after review", receiptStarted: true, observedStart: true });
  });

  it("does not project a fallback the receipt already reports as started", async () => {
    await deliverAfterStart({ text: "Follow up after review", receiptStarted: true, observedStart: false, startedDisposition: true });
  });

  it("prefers the owner's start over a delayed queued receipt and repeated queue event", async () => {
    await deliverAfterStart({ text: "Follow up after review", receiptStarted: false, observedStart: true, replayQueuedEvent: true });
  });

  // A receipt is a snapshot: an owner start before its arrival always wins,
  // including when the queued snapshot itself was captured before that start.
  it("keeps every already-started fallback out of the queue across response orderings", async () => {
    await fc.assert(fc.asyncProperty(
      fc.string({ maxLength: 20 }).map((text) => `Follow up: ${text}`),
      fc.constantFrom(
        { receiptStarted: true, observedStart: false },
        { receiptStarted: true, observedStart: true },
        { receiptStarted: false, observedStart: true },
      ),
      fc.boolean(),
      async (text, ordering, replayQueuedEvent) => deliverAfterStart({ text, ...ordering, replayQueuedEvent }),
    ), { numRuns: 10 });
  });
});
