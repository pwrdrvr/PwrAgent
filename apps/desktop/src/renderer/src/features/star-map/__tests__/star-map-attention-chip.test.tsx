import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { StarMapScreen } from "../StarMapScreen";
import {
  countAttentionSignals,
  readStoredFilterSelection,
  threadPassesFilters,
} from "../star-map-filters";

/**
 * The Attention chip: one filter over "unread or working", drawn with the
 * sidebar's own three readouts.
 *
 * These were two chips ("Unread", "Working"), and the Working half had no
 * coverage at all — which is how a filter nobody could see a non-zero
 * number on went unnoticed.
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

    const active = container.querySelector(".star-map__filter-signal--active");
    const review = container.querySelector(".star-map__filter-signal--review");
    expect(active?.textContent).toBe("1");
    expect(active?.getAttribute("data-zero")).toBeNull();
    // Zero is drawn, not hidden: a missing indicator makes an idle chip
    // look broken rather than idle.
    expect(review?.textContent).toBe("0");
    expect(review?.getAttribute("data-zero")).toBe("true");
    // No peers on this map, so the remote readout is absent entirely.
    expect(
      container.querySelector(".star-map__filter-signal--remote-active"),
    ).toBeNull();
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
    const active = container.querySelector(".star-map__filter-signal--active");
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
