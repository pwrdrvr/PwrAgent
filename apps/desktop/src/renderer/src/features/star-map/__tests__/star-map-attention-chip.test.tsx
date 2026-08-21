import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { StarMapFilterChip } from "../StarMapFilterChip";
import { StarMapScreen } from "../StarMapScreen";
import {
  countAttentionSignals,
  readStoredFilterSelection,
  STAR_MAP_FILTERS,
  threadPassesFilters,
} from "../star-map-filters";

/**
 * The Attention chip: one filter over "unread or working", drawn with the
 * sidebar's own three readouts — the same elements, not a copy.
 *
 * These were two chips ("Unread", "Working"), and the Working half had no
 * coverage at all — which is how a filter nobody could see a non-zero
 * number on went unnoticed. The copy of the readouts that followed then
 * drifted from the tab in two ways nothing here caught: its turns sat in a
 * row where the tab stacks them, and its signal row had lost its layout
 * rule to a stray comment between two CSS selectors. The tests below pin
 * the chip to the tab's own elements and column.
 */

function thread(
  id: string,
  overrides: Partial<NavigationThreadSummary> = {},
): NavigationThreadSummary {
  return {
    id,
    title: `Thread ${id}`,
    titleSource: "generated",
    linkedDirectories: [{ id: "d", label: "a", path: "/repo/a", kind: "local" }],
    source: "codex",
    inbox: { inInbox: false },
    updatedAt: 100,
    ...overrides,
  } as unknown as NavigationThreadSummary;
}

const working = thread("working", { threadStatus: "active" } as never);
const unread = thread("unread", {
  inbox: { inInbox: true, reason: "updated-since-seen" },
} as never);
const idle = thread("idle");

function buildDesktopApi(): DesktopApi {
  return {
    readFederationHealth: vi.fn(async () => ({
      health: {
        enabled: false,
        role: "client" as const,
        status: "disabled" as const,
        instanceId: "pwr_local",
        localCelestialIcon: "sun" as const,
        localLabel: "Harold-MBP",
        localProfileName: "default",
        peers: [],
      },
    })),
    onAgentEvent: vi.fn(() => () => undefined),
  } as unknown as DesktopApi;
}

function renderMap(threads: NavigationThreadSummary[]) {
  return render(
    <StarMapScreen
      desktopApi={buildDesktopApi()}
      localThreads={threads}
      sessionKeys={{}}
      localInstanceLabel="Harold-MBP"
      onOpenLocalThread={() => undefined}
      onFocusLocalInstance={() => undefined}
    />,
  );
}

function chip(): HTMLElement {
  return screen.getByRole("button", { name: /^Attention:/ });
}

describe("star map attention filter", () => {
  it("matches a thread that is unread OR working", () => {
    const selection = { attention: "include" } as const;
    expect(threadPassesFilters({ selection, thread: working })).toBe(true);
    expect(threadPassesFilters({ selection, thread: unread })).toBe(true);
    expect(threadPassesFilters({ selection, thread: idle })).toBe(false);
  });

  /**
   * The half of `isThreadActive` the map used to drop for peers: the
   * renderer-observed thinking state arrives as a session key, and the
   * remote counting path was called without one.
   */
  it("counts a live turn observed only through a session key", () => {
    expect(
      countAttentionSignals({
        selection: {},
        sessionKeys: { thinkingThreadKeys: { "codex:idle": true } },
        threads: [idle],
      }),
    ).toEqual({ activeLocal: 1, activeRemote: 0, unread: 0 });
  });

  it("splits live turns by where they are running", () => {
    const remote = thread("remote", {
      threadStatus: "active",
      federation: { ref: { target: { scope: "remote", instanceId: "peer" } } },
    } as never);
    expect(
      countAttentionSignals({ selection: {}, threads: [working, remote, unread] }),
    ).toEqual({ activeLocal: 1, activeRemote: 1, unread: 1 });
  });

  it("draws a count for each signal, greyed at zero", async () => {
    const { container } = renderMap([working, idle]);
    await waitFor(() => expect(chip()).toBeTruthy());

    const active = container.querySelector(".lens-switch__signal--active");
    const review = container.querySelector(".lens-switch__signal--review");
    expect(active?.textContent).toBe("1");
    expect(active?.getAttribute("data-zero")).toBeNull();
    // Zero is drawn, not hidden: a missing indicator makes an idle chip
    // look broken rather than idle.
    expect(review?.textContent).toBe("0");
    expect(review?.getAttribute("data-zero")).toBe("true");
    // No peers on this map, so the remote readout is absent entirely.
    expect(
      container.querySelector(".lens-switch__signal--remote-active"),
    ).toBeNull();
  });

  it("is its readouts, with no word beside them", async () => {
    // Like the lens tab: the name lives in the accessible name and the hover
    // card, not on the chip. The label was width the band needs for the
    // chips beside it.
    renderMap([working]);
    await waitFor(() => expect(chip()).toBeTruthy());
    expect(chip().textContent).not.toContain("Attention");
    expect(chip().getAttribute("aria-label")).toMatch(/^Attention:/);
    expect(chip().querySelector(".star-map__filter-signals")).not.toBeNull();
    expect(chip().querySelector(".star-map__filter-count")).toBeNull();
  });

  /**
   * The zero state must be a DIFFERENT element, not a stopped scanner:
   * every `ThinkingScanner` is pinned to one document-timeline epoch by a
   * mount-time ref, and an animation CSS stops and restarts under a live
   * element is never re-pinned. See ThinkingScanner.tsx and PR #1187.
   */
  it("swaps the scanner element at zero rather than freezing it", async () => {
    const { container } = renderMap([idle]);
    await waitFor(() => expect(chip()).toBeTruthy());
    const active = container.querySelector(".lens-switch__signal--active");
    expect(active?.querySelector(".lens-switch__dormant-scanner")).not.toBeNull();
    expect(active?.querySelector(".thinking-scanner")).toBeNull();
  });

  it("says both numbers out loud", async () => {
    renderMap([working, unread]);
    await waitFor(() => expect(chip()).toBeTruthy());
    expect(chip().getAttribute("aria-label")).toContain("1 active thread");
    expect(chip().getAttribute("aria-label")).toContain("1 unread");
  });

  /**
   * The remote readout needs a peer the map fronts, which is a federation
   * health round-trip away from `StarMapScreen`; the chip itself is the
   * unit under test here, so render it directly with the counts the screen
   * would hand it.
   */
  const attentionDefinition = STAR_MAP_FILTERS.find(
    (definition) => definition.key === "attention",
  )!;

  function renderChip(
    attention: { activeLocal: number; activeRemote: number; unread: number },
    options: { showRemoteTurns?: boolean; selection?: { attention?: "include" | "exclude" } } = {},
  ) {
    return render(
      <StarMapFilterChip
        definition={attentionDefinition}
        selection={options.selection ?? {}}
        count={0}
        attention={attention}
        showRemoteTurns={options.showRemoteTurns}
        onCycle={() => undefined}
      />,
    );
  }

  it("stacks peer turns under local ones, in the tab's own column", () => {
    // The sidebar tab's layout, element for element: both turn readouts in
    // one `.lens-switch__turns` column, the cookie beside the column rather
    // than in it. A row of three was the drift this replaces.
    const { container } = renderChip(
      { activeLocal: 1, activeRemote: 2, unread: 3 },
      { showRemoteTurns: true },
    );
    const signals = container.querySelector(".star-map__filter-signals")!;
    const turns = signals.querySelector(".lens-switch__turns")!;
    expect(turns).not.toBeNull();
    expect(
      turns.querySelector("[data-attention-active-count]"),
    ).toHaveAttribute("data-attention-active-count", "1");
    expect(
      turns.querySelector("[data-attention-remote-active-count]"),
    ).toHaveAttribute("data-attention-remote-active-count", "2");
    const review = signals.querySelector("[data-attention-review-count]")!;
    expect(review).toHaveAttribute("data-attention-review-count", "3");
    expect(turns.contains(review)).toBe(false);
    // Both live, both sweeping — the remote one is neutral by token, not
    // by being switched off.
    expect(turns.querySelectorAll(".thinking-scanner")).toHaveLength(2);
  });

  it("explains itself in the tab's hover card", async () => {
    renderChip(
      { activeLocal: 1, activeRemote: 2, unread: 3 },
      { showRemoteTurns: true },
    );
    const button = screen.getByRole("button", { name: /^Attention:/ });
    fireEvent.mouseEnter(button);
    const card = await screen.findByRole("tooltip");
    // The same card the sidebar tab opens, lifted above the map's stacking
    // context.
    expect(card).toHaveClass("attention-card");
    expect(card).toHaveClass("star-map-card__tooltip");
    expect(card).toHaveTextContent(
      /AttentionThreads in progress or unreadIn progress hereQuitting interrupts these1In progress elsewhereQuitting leaves these running2Unread3/,
    );
    // With no word on the chip, the card has to say what a click does.
    expect(card).toHaveTextContent("Click to show only these");
    // The consequence lines exist nowhere else, so the card is reachable to
    // a screen reader rather than sighted-only.
    expect(button).toHaveAttribute("aria-describedby", card.id);
  });

  it("names no machine in the card until the map fronts a peer", async () => {
    renderChip({ activeLocal: 1, activeRemote: 0, unread: 0 });
    fireEvent.mouseEnter(screen.getByRole("button", { name: /^Attention:/ }));
    const card = await screen.findByRole("tooltip");
    expect(card).toHaveTextContent(/In progress1/);
    expect(card.textContent).not.toContain("Quitting");
    expect(card.textContent).not.toContain("elsewhere");
  });

  /**
   * An operator who left either old chip on has a stored blob naming a key
   * that no longer exists. Dropping it silently would turn a narrowed map
   * back into an unfiltered one at the next launch.
   */
  it("carries a pre-merge Unread or Working selection forward", () => {
    for (const stored of [
      { unread: "include" },
      { active: "include" },
      { unread: "exclude", active: "include" },
    ]) {
      window.localStorage.setItem(
        "pwragent.starMap.filterSelection",
        JSON.stringify(stored),
      );
      expect(readStoredFilterSelection().attention).toBe("include");
    }

    window.localStorage.setItem(
      "pwragent.starMap.filterSelection",
      JSON.stringify({ active: "exclude" }),
    );
    expect(readStoredFilterSelection().attention).toBe("exclude");
    window.localStorage.removeItem("pwragent.starMap.filterSelection");
  });
});
