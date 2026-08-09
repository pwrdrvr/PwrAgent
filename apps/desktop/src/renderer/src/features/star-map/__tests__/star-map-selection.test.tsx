import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { StarMapScreen } from "../StarMapScreen";

/**
 * Shift-drag selects; a plain drag still pans. Both are click-drag on
 * empty space, so the modifier is what keeps them apart.
 */

function buildDesktopApi(): DesktopApi {
  return {
    readFederationHealth: vi.fn(async () => ({
      health: {
        enabled: false,
        role: "client" as const,
        status: "disabled" as const,
        instanceId: "pwr_local",
        localCelestialIcon: "sun" as const,
        localLabel: "Harold-MBP-M5-Max",
        localProfileName: "default",
        peers: [],
      },
    })),
    onAgentEvent: vi.fn(() => () => undefined),
    readStarMapArrangement: vi.fn(async () => ({ entries: [] })),
    setStarMapCardPosition: vi.fn(async () => undefined),
  } as unknown as DesktopApi;
}

function thread(id: string): NavigationThreadSummary {
  return {
    id,
    title: `Thread ${id}`,
    titleSource: "generated",
    linkedDirectories: [],
    source: "codex",
    inbox: { inInbox: true, reason: "updated-since-seen" },
    updatedAt: 100,
  } as unknown as NavigationThreadSummary;
}

function renderMap(count: number) {
  return render(
    <StarMapScreen
      desktopApi={buildDesktopApi()}
      localThreads={Array.from({ length: count }, (_, index) =>
        thread(`t${index}`),
      )}
      sessionKeys={{}}
      localInstanceLabel="Mac-Mini-M4"
      floating={false}
      onClose={() => undefined}
      onOpenLocalThread={() => undefined}
      onFocusLocalInstance={() => undefined}
    />,
  );
}

function viewport(): HTMLElement {
  const element = document.querySelector(".star-map__viewport");
  if (!(element instanceof HTMLElement)) throw new Error("no viewport");
  return element;
}

function shells(): HTMLElement[] {
  return [...document.querySelectorAll(".star-map-card-shell")].filter(
    (node): node is HTMLElement => node instanceof HTMLElement,
  );
}

async function ready() {
  await waitFor(() => {
    expect(
      screen.getByRole("button", { name: /Open this instance/ }),
    ).toBeTruthy();
  });
}

describe("star map marquee selection", () => {
  afterEach(() => {
    window.localStorage.removeItem("pwragent.starMap.viewPreferences");
    window.localStorage.removeItem("pwragent.starMap.filterSelection");
  });

  it("selects the cards a shift-drag sweeps over", async () => {
    renderMap(4);
    await ready();
    expect(document.querySelector(".star-map-card-shell--selected")).toBeNull();

    // A sweep large enough to cover the whole cloud.
    fireEvent.pointerDown(viewport(), {
      button: 0,
      shiftKey: true,
      clientX: -4000,
      clientY: -4000,
    });
    fireEvent.pointerMove(window, { clientX: 4000, clientY: 4000 });
    fireEvent.pointerUp(window, { clientX: 4000, clientY: 4000 });

    await waitFor(() => {
      expect(
        document.querySelectorAll(".star-map-card-shell--selected").length,
      ).toBeGreaterThan(1);
    });
  });

  it("shows the marquee while the sweep is live and drops it after", async () => {
    renderMap(3);
    await ready();

    fireEvent.pointerDown(viewport(), {
      button: 0,
      shiftKey: true,
      clientX: 100,
      clientY: 100,
    });
    fireEvent.pointerMove(window, { clientX: 400, clientY: 350 });
    await waitFor(() => {
      expect(document.querySelector(".star-map__marquee")).not.toBeNull();
    });

    fireEvent.pointerUp(window, { clientX: 400, clientY: 350 });
    await waitFor(() => {
      expect(document.querySelector(".star-map__marquee")).toBeNull();
    });
  });

  it("leaves a plain drag panning rather than selecting", async () => {
    renderMap(3);
    await ready();

    fireEvent.pointerDown(viewport(), { button: 0, clientX: -4000, clientY: -4000 });
    fireEvent.pointerMove(window, { clientX: 4000, clientY: 4000 });
    fireEvent.pointerUp(window, { clientX: 4000, clientY: 4000 });

    expect(document.querySelector(".star-map__marquee")).toBeNull();
    expect(document.querySelector(".star-map-card-shell--selected")).toBeNull();
  });

  it("carries the rest of the selection when one selected card is dragged", async () => {
    renderMap(4);
    await ready();

    fireEvent.pointerDown(viewport(), {
      button: 0,
      shiftKey: true,
      clientX: -4000,
      clientY: -4000,
    });
    fireEvent.pointerMove(window, { clientX: 4000, clientY: 4000 });
    fireEvent.pointerUp(window, { clientX: 4000, clientY: 4000 });

    await waitFor(() => {
      expect(
        document.querySelectorAll(".star-map-card-shell--selected").length,
      ).toBeGreaterThan(1);
    });

    const selected = shells().filter((shell) =>
      shell.className.includes("--selected"),
    );
    const dragged = selected[0];
    const passenger = selected[1];
    const passengerLeftBefore = Number.parseFloat(passenger.style.left);

    fireEvent.pointerDown(dragged, { button: 0, clientX: 500, clientY: 400 });
    await act(async () => {
      fireEvent.pointerMove(window, { clientX: 560, clientY: 400 });
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    });

    // The passenger travels with the card under the pointer; without the
    // group hand-off it would sit still while its neighbour moved.
    await waitFor(() => {
      expect(Number.parseFloat(passenger.style.left)).not.toBe(
        passengerLeftBefore,
      );
    });
    fireEvent.pointerUp(window, { clientX: 560, clientY: 400 });
  });
});
