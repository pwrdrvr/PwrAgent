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

/**
 * The same thread as a peer's. A remote target is what the provider read is
 * actually keyed by, and it is the only case where the target is an object
 * rather than `undefined` — so it is the only case that can churn.
 */
function remoteThread(): NavigationThreadSummary {
  return {
    ...thread(),
    federation: {
      instanceLabel: "Studio Mac",
      ref: {
        backend: "codex",
        threadId: "t-local",
        target: { scope: "remote", instanceId: "pwr_peer" },
      },
    },
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
    platform: "darwin",
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
    listBackends: vi.fn(async () => ({
      backends: [
        {
          kind: "codex",
          label: "OpenAI",
          available: true,
          executionModes: [],
        },
      ],
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

/** The screen's arrangement, as an element. Every call builds fresh thread
    summaries the way a navigation poll does, which is what makes a re-render
    with it a real test of identity churn. */
function cardWithContextSatellite(
  desktopApi: DesktopApi,
  options?: { threadPricingSummaryEnabled?: boolean; remote?: boolean },
) {
  return (
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
        thread={options?.remote ? remoteThread() : thread()}
        contextOpen
        onToggleContext={() => undefined}
        onToggleTerminal={() => undefined}
        zIndex={40}
      />
      <StarMapContextCard
        cardKey={CARD_KEY}
        desktopApi={desktopApi}
        thread={options?.remote ? remoteThread() : thread()}
        rect={CONTEXT_RECT}
        zIndex={40}
        onClose={() => undefined}
        threadPricingSummaryEnabled={options?.threadPricingSummaryEnabled}
      />
    </>
  );
}

function renderCardWithContextSatellite(
  desktopApi: DesktopApi,
  options?: { threadPricingSummaryEnabled?: boolean; remote?: boolean },
) {
  return render(cardWithContextSatellite(desktopApi, options));
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

  it("names the desktop platform on the Info tab rather than \"Unknown\"", async () => {
    // Info renders `platform` verbatim. Unpassed, the map's rail called
    // every machine "Unknown" while the full window named it.
    const desktopApi = buildApi();
    renderCardWithContextSatellite(desktopApi);

    expect(await satellite().findByText("darwin")).toBeTruthy();
  });

  it("shows the host instance's AI providers, not an unavailable rail", async () => {
    // The satellite was handed `backends={[]}`, so the providers tab read
    // "Status unavailable" on a machine whose providers were fine.
    const desktopApi = buildApi();
    renderCardWithContextSatellite(desktopApi);

    fireEvent.click(satellite().getByRole("tab", { name: "AI provider info" }));

    expect(await satellite().findByText("OpenAI")).toBeTruthy();
    expect(satellite().queryByText("Status unavailable")).toBeNull();
  });

  it("reads a peer thread's providers from the peer, not from this window", async () => {
    // The point of reading per satellite rather than once for the window:
    // a map holds cards over several instances at once, so the providers
    // shown under a peer's card have to be that peer's.
    const desktopApi = buildApi();
    renderCardWithContextSatellite(desktopApi, { remote: true });

    await waitFor(() => {
      expect(desktopApi.listBackends).toHaveBeenCalledWith(
        expect.objectContaining({
          federationTarget: { scope: "remote", instanceId: "pwr_peer" },
        }),
      );
    });
  });

  it("reads the provider list once per thread, not once per render", async () => {
    // The hook refetches whenever its federation target changes identity,
    // and both target sources build a fresh object per call. Handed over
    // inline that is a fetch on every render, forever.
    const desktopApi = buildApi();
    const { rerender } = renderCardWithContextSatellite(desktopApi, {
      remote: true,
    });

    await waitFor(() => {
      expect(desktopApi.listBackends).toHaveBeenCalled();
    });
    const callsAfterMount = vi.mocked(desktopApi.listBackends!).mock.calls
      .length;

    for (let index = 0; index < 3; index += 1) {
      rerender(cardWithContextSatellite(desktopApi, { remote: true }));
    }
    await waitFor(() => {
      expect(desktopApi.readThread).toHaveBeenCalled();
    });

    expect(vi.mocked(desktopApi.listBackends!).mock.calls.length).toBe(
      callsAfterMount,
    );
  });

  it("keeps the map's edits in the rail: no above-composer dock offered", async () => {
    // A chat card has no above-composer work rail, so the dock toggle's
    // "also pinned above the composer" state is a claim the surface cannot
    // honor. Pin it to the rail rather than take the panel's default.
    const desktopApi = buildApi(editEntries());
    renderCardWithContextSatellite(desktopApi);

    await waitFor(() => {
      expect(desktopApi.readThread).toHaveBeenCalled();
    });

    fireEvent.click(satellite().getByRole("tab", { name: "Edits" }));

    const dockToggle = await satellite().findByRole("button", {
      name: "Show above composer",
    });
    expect(dockToggle.getAttribute("aria-pressed")).toBe("false");
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
