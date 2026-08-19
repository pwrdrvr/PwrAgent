import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  AppServerThreadEntry,
  NavigationThreadSummary,
} from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { StarMapChatCard } from "../StarMapChatCard";
import { StarMapContextCard } from "../StarMapSatelliteCards";

const CARD_KEY = "card-1";
const CHAT_RECT = { left: 40, top: 40, width: 420, height: 520 };
const CONTEXT_RECT = { left: 480, top: 40, width: 320, height: 520 };

function thread(): NavigationThreadSummary {
  return {
    id: "t-local",
    title: "Local work",
    titleSource: "generated",
    linkedDirectories: [],
    source: "codex",
    inbox: { inInbox: false },
    updatedAt: 1,
  } as unknown as NavigationThreadSummary;
}

/** One turn that wrote a file, the way the Edits tab reads a transcript. */
function editEntries(): AppServerThreadEntry[] {
  return [
    {
      type: "activity",
      id: "a1",
      summary: "activity",
      turn: { id: "turn-1" },
      details: [
        {
          id: "d1",
          kind: "write",
          label: "Update StarMapSatelliteCards.tsx",
          path: "apps/desktop/src/StarMapSatelliteCards.tsx",
          fileDiff: {
            kind: "update",
            diff: "@@",
            additions: 12,
            removals: 3,
          },
        },
      ],
    } as unknown as AppServerThreadEntry,
  ];
}

/**
 * A thread read that carries pricing, exactly as the full window's session
 * receives it. The rail in the full window renders a summary card from this;
 * the star map's satellite has to reach the same rows.
 */
function buildApi(entries: AppServerThreadEntry[] = []): DesktopApi {
  return {
    readThread: vi.fn(async () => ({
      backend: "codex",
      threadId: "t-local",
      replay: {
        entries,
        messages: [],
        pagination: { supportsPagination: false, hasPreviousPage: false },
      },
      pricing: {
        lines: [],
        summaries: [
          {
            backend: "codex",
            cachedInputTokens: 17_800_000,
            currency: "USD",
            inputTokens: 465_800,
            outputTokens: 60_200,
            pricedUsageLineCount: 4,
            provider: "openai",
            reasoningOutputTokens: 22_500,
            threadId: "t-local",
            totalCostMicros: 13_680_000,
            totalTokens: 18_300_000,
            uncachedInputTokens: 465_800,
            unpricedUsageLineCount: 0,
            updatedAt: 1_700_000_000_000,
            usageLineCount: 4,
          },
        ],
      },
    })),
    startTurn: vi.fn(async () => ({
      backend: "codex",
      threadId: "t-local",
      turnId: "turn-1",
    })),
    onAgentEvent: vi.fn(() => () => undefined),
  } as unknown as DesktopApi;
}

/** The screen's arrangement: the card owns the session, the satellite docks
    beside it as a sibling. */
/** The satellite's own subtree. Scoping every assertion to it is what keeps
    the test about the satellite rather than about the window containing the
    text somewhere. */
function satellite() {
  return within(
    screen.getByRole("region", { name: "Thread context: Local work" }),
  );
}

function renderCardWithContextSatellite(
  desktopApi: DesktopApi,
  options?: { threadPricingSummaryEnabled?: boolean },
) {
  return render(
    <>
      <StarMapChatCard
        cardKey={CARD_KEY}
        desktopApi={desktopApi}
        onClose={() => undefined}
        onOpenFull={() => undefined}
        onRaise={() => undefined}
        onRectChange={() => undefined}
        rect={CHAT_RECT}
        scale={1}
        bounds={{ width: 4000, height: 3000 }}
        thread={thread()}
        contextOpen
        onToggleContext={() => undefined}
        onToggleTerminal={() => undefined}
        zIndex={40}
      />
      <StarMapContextCard
        cardKey={CARD_KEY}
        desktopApi={desktopApi}
        thread={thread()}
        rect={CONTEXT_RECT}
        zIndex={40}
        onClose={() => undefined}
        threadPricingSummaryEnabled={options?.threadPricingSummaryEnabled}
      />
    </>,
  );
}

describe("star map context satellite data", () => {
  it("shows the loaded thread's pricing, not an empty rail", async () => {
    // The satellite renders the same ThreadContextPanel the full window
    // does, but the session that carries pricing belongs to the chat card.
    // Without a hand-off the rail claimed the thread had no usage at all
    // while the full window showed a $13.68 summary for the same thread.
    const desktopApi = buildApi();
    renderCardWithContextSatellite(desktopApi);

    await waitFor(() => {
      expect(desktopApi.readThread).toHaveBeenCalled();
    });

    fireEvent.click(satellite().getByRole("tab", { name: "Pricing" }));

    expect(await satellite().findByText("Pricing summary")).toBeTruthy();
    expect(
      satellite().queryByText("No usage pricing recorded yet."),
    ).toBeNull();
  });

  it("honors the operator's pricing setting rather than the rail default", async () => {
    // The map reads the same Settings -> Pricing switch the full window
    // does. Left unplumbed, the satellite defaulted to "on" and showed a
    // thread's spend on a surface the operator had switched off.
    const desktopApi = buildApi();
    renderCardWithContextSatellite(desktopApi, {
      threadPricingSummaryEnabled: false,
    });

    await waitFor(() => {
      expect(desktopApi.readThread).toHaveBeenCalled();
    });

    expect(satellite().queryByRole("tab", { name: "Pricing" })).toBeNull();
  });

  it("shows the turn's edited files, collected from the host's transcript", async () => {
    const desktopApi = buildApi(editEntries());
    renderCardWithContextSatellite(desktopApi);

    await waitFor(() => {
      expect(desktopApi.readThread).toHaveBeenCalled();
    });

    fireEvent.click(satellite().getByRole("tab", { name: "Edits" }));

    expect(await satellite().findByText("Edited 1 file")).toBeTruthy();
    expect(
      satellite().getByText("Update StarMapSatelliteCards.tsx"),
    ).toBeTruthy();
  });
});
