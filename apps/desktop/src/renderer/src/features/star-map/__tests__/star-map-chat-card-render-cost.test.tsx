import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";

/**
 * Counting stand-ins for the card's two children.
 *
 * Both delegate to the real component, so this measures the card as it
 * actually ships rather than a skeleton of it. The mocks stay plain
 * function components on purpose: the memo that makes this test pass lives
 * in `StarMapChatCard`, over the imported child, so dropping it there makes
 * the counts climb again. Re-memoizing in this file would keep the spec
 * green over an unmemoized card, which is the one thing it must not do.
 */
vi.mock("../../composer/CompactComposer", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../composer/CompactComposer")>();
  return { ...actual, CompactComposer: vi.fn(actual.CompactComposer) };
});
vi.mock("../../thread-detail/TranscriptList", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../thread-detail/TranscriptList")>();
  return { ...actual, TranscriptList: vi.fn(actual.TranscriptList) };
});

import { CompactComposer } from "../../composer/CompactComposer";
import { TranscriptList } from "../../thread-detail/TranscriptList";
import { StarMapChatCard } from "../StarMapChatCard";
import { resetComposerMentionSourcesCache } from "../../composer/useComposerMentionSources";

const RECT = { left: 40, top: 40, width: 420, height: 520 };

function localThread(
  overrides: Partial<NavigationThreadSummary> = {},
): NavigationThreadSummary {
  return {
    id: "t-local",
    title: "Local work",
    titleSource: "generated",
    linkedDirectories: [],
    source: "codex",
    inbox: { inInbox: false },
    updatedAt: 1,
    ...overrides,
  } as unknown as NavigationThreadSummary;
}

/**
 * The card has more than one agent-event subscriber — the thread session
 * and the lazy skill list — so a fake that remembers only the last listener
 * to register silently measures nothing.
 */
function streamingApi(overrides: Partial<DesktopApi> = {}): {
  desktopApi: DesktopApi;
  emitDelta: (index: number) => void;
} {
  const listeners: Array<(event: unknown) => void> = [];
  const desktopApi = {
    readThread: vi.fn(async () => ({
      backend: "codex",
      threadId: "t-local",
      threadStatus: "active",
      replay: {
        entries: [],
        messages: [],
        pagination: { supportsPagination: false, hasPreviousPage: false },
      },
    })),
    startTurn: vi.fn(async () => ({
      backend: "codex",
      threadId: "t-local",
      turnId: "turn-live",
    })),
    onAgentEvent: vi.fn((listener: (event: unknown) => void) => {
      listeners.push(listener);
      return () => undefined;
    }),
    ...overrides,
  } as unknown as DesktopApi;

  const emitDelta = (index: number): void => {
    const event = {
      backend: "codex",
      notification: {
        method: "item/agentMessage/delta",
        params: {
          threadId: "t-local",
          turnId: "turn-live",
          itemId: "item-live",
          delta: `chunk-${index} `,
        },
      },
    };
    for (const listener of listeners) listener(event);
  };

  return { desktopApi, emitDelta };
}

function renderCard(desktopApi: DesktopApi, onOpenFull = () => undefined) {
  return render(
    <StarMapChatCard
      cardKey="card-1"
      desktopApi={desktopApi}
      onClose={() => undefined}
      onOpenFull={onOpenFull}
      onRaise={() => undefined}
      onRectChange={() => undefined}
      rect={RECT}
      thread={localThread()}
      scale={1}
      bounds={{ width: 4000, height: 3000 }}
      onToggleContext={() => undefined}
      onToggleTerminal={() => undefined}
      zIndex={40}
    />
  );
}

/**
 * Let the initial `readThread` land before anything is streamed. Hydration
 * rewrites the session wholesale, so a delta emitted into the gap has its
 * turn id thrown away — a race in the harness, not in the card.
 */
async function settleInitialRead(desktopApi: DesktopApi): Promise<void> {
  await waitFor(() => {
    expect(desktopApi.readThread).toHaveBeenCalled();
  });
  await act(async () => {
    await Promise.resolve();
  });
}

const composerRenders = (): number => vi.mocked(CompactComposer).mock.calls.length;
const transcriptRenders = (): number => vi.mocked(TranscriptList).mock.calls.length;

/**
 * Codex streams fixed 8 KiB deltas at roughly 444 a second, and every one of
 * them lands in the card's thread session. The transcript re-rendering at
 * that rate is the point of the surface; the composer re-rendering with it
 * is pure waste, multiplied by however many cards the map has open.
 */
describe("StarMapChatCard streaming render cost", () => {
  beforeEach(() => {
    vi.mocked(CompactComposer).mockClear();
    vi.mocked(TranscriptList).mockClear();
    resetComposerMentionSourcesCache();
  });

  it("does not re-render the composer for streamed deltas", async () => {
    const { desktopApi, emitDelta } = streamingApi();
    renderCard(desktopApi);
    await screen.findByRole("textbox", { name: "Message Local work" });
    await settleInitialRead(desktopApi);

    const composerBaseline = composerRenders();
    const transcriptBaseline = transcriptRenders();
    const deltas = 20;
    for (let index = 0; index < deltas; index += 1) {
      act(() => {
        emitDelta(index);
      });
    }

    // Proves the harness actually drove the card: without this a fake that
    // dropped its listener would report a perfect composer score.
    expect(transcriptRenders() - transcriptBaseline).toBeGreaterThanOrEqual(
      deltas,
    );
    expect(composerRenders() - composerBaseline).toBe(0);
  });

  it("still steers the turn it hydrated onto", async () => {
    // The memo boundary's real hazard is a composer left holding a stale
    // `send`. The turn id lands with the thread read, which resolves after
    // first paint, so a composer frozen at mount would steer at nothing and
    // the card would report that it cannot identify the running turn.
    const steerTurn = vi.fn(async () => ({
      backend: "codex",
      threadId: "t-local",
      turnId: "turn-live",
      disposition: "steered" as const,
    }));
    const { desktopApi, emitDelta } = streamingApi({
      readThread: vi.fn(async () => ({
        backend: "codex",
        threadId: "t-local",
        threadStatus: "active",
        replay: {
          entries: [
            {
              type: "message",
              id: "m-live",
              role: "assistant",
              text: "working on it",
              parts: [{ type: "text", text: "working on it" }],
              createdAt: 1,
              turn: { id: "turn-live", status: "in_progress" },
            },
          ],
          messages: [],
          pagination: { supportsPagination: false, hasPreviousPage: false },
        },
      })),
      steerTurn,
    } as unknown as Partial<DesktopApi>);
    renderCard(desktopApi);
    const input = await screen.findByRole("textbox", {
      name: "Message Local work",
    });
    await settleInitialRead(desktopApi);
    for (let index = 0; index < 5; index += 1) {
      act(() => {
        emitDelta(index);
      });
    }

    await screen.findByRole("button", { name: "Steer" });
    fireEvent.change(input, { target: { value: "and check the logs" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(steerTurn).toHaveBeenCalledWith(
        expect.objectContaining({ expectedTurnId: "turn-live" }),
      );
    });
  });

  it("keeps the kebab actions wired through the stream", async () => {
    const onOpenFull = vi.fn();
    const { desktopApi, emitDelta } = streamingApi();
    renderCard(desktopApi, onOpenFull);
    await screen.findByRole("textbox", { name: "Message Local work" });
    await settleInitialRead(desktopApi);
    for (let index = 0; index < 5; index += 1) {
      act(() => {
        emitDelta(index);
      });
    }

    fireEvent.click(await screen.findByRole("button", { name: "More actions" }));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Open in full view" }),
    );

    expect(onOpenFull).toHaveBeenCalledTimes(1);
  });
});
