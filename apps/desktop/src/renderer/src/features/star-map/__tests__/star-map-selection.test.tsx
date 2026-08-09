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

function renderMap(
  count: number,
  overrides?: { desktopApi?: DesktopApi; onClose?: () => void },
) {
  const desktopApi = overrides?.desktopApi ?? buildDesktopApi();
  const screenFor = (threadCount: number) => (
    <StarMapScreen
      desktopApi={desktopApi}
      localThreads={Array.from({ length: threadCount }, (_, index) =>
        thread(`t${index}`),
      )}
      sessionKeys={{}}
      localInstanceLabel="Mac-Mini-M4"
      floating={false}
      onClose={overrides?.onClose ?? (() => undefined)}
      onOpenLocalThread={() => undefined}
      onFocusLocalInstance={() => undefined}
    />
  );
  const result = render(screenFor(count));
  return {
    ...result,
    /** Re-render with a different thread count, as a filter change would. */
    showThreads: (next: number) => result.rerender(screenFor(next)),
  };
}

/** Sweep the whole cloud, so every card lands in the selection. */
function sweepEverything(modifier: "shiftKey" | "metaKey" = "shiftKey") {
  fireEvent.pointerDown(viewport(), {
    button: 0,
    [modifier]: true,
    clientX: -4000,
    clientY: -4000,
  });
  fireEvent.pointerMove(window, { clientX: 4000, clientY: 4000 });
  fireEvent.pointerUp(window, { clientX: 4000, clientY: 4000 });
}

function selectedShells(): HTMLElement[] {
  return shells().filter((shell) => shell.className.includes("--selected"));
}

function viewport(): HTMLElement {
  const element = document.querySelector(".star-map__viewport");
  if (!(element instanceof HTMLElement)) throw new Error("no viewport");
  return element;
}

/**
 * THREAD card shells, in render order.
 *
 * Keyed on `[data-thread-key]` rather than the `.star-map-card-shell` class,
 * because that class is shared with non-thread cards on the map (the
 * instance load card). Every assertion here indexes into this list, so a
 * fixture that happened to open a load card would silently shift them all
 * and fail looking like a selection bug.
 */
function shells(): HTMLElement[] {
  return [...document.querySelectorAll(".star-map-card-shell[data-thread-key]")]
    .filter((node): node is HTMLElement => node instanceof HTMLElement);
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

describe("star map selection is amendable", () => {
  afterEach(() => {
    window.localStorage.removeItem("pwragent.starMap.viewPreferences");
    window.localStorage.removeItem("pwragent.starMap.filterSelection");
  });

  it("reports how many cards are selected", async () => {
    renderMap(4);
    await ready();
    expect(screen.queryByText(/cards selected/)).toBeNull();

    sweepEverything();
    await waitFor(() => {
      expect(screen.getByText(/\d+ cards selected/)).toBeTruthy();
    });
    expect(screen.getByText(`${selectedShells().length} cards selected`)).toBeTruthy();
  });

  it("clears the selection on a click on empty canvas", async () => {
    renderMap(4);
    await ready();
    sweepEverything();
    await waitFor(() => expect(selectedShells().length).toBeGreaterThan(1));

    // Press and release in the same spot: a click, not an abandoned pan.
    fireEvent.pointerDown(viewport(), { button: 0, clientX: 300, clientY: 300 });
    fireEvent.pointerUp(window, { clientX: 300, clientY: 300 });

    await waitFor(() => expect(selectedShells()).toHaveLength(0));
  });

  it("keeps the selection when a pan is released somewhere else", async () => {
    renderMap(4);
    await ready();
    sweepEverything();
    await waitFor(() => expect(selectedShells().length).toBeGreaterThan(1));
    const before = selectedShells().length;

    fireEvent.pointerDown(viewport(), { button: 0, clientX: 300, clientY: 300 });
    fireEvent.pointerMove(window, { clientX: 460, clientY: 380 });
    fireEvent.pointerUp(window, { clientX: 460, clientY: 380 });

    expect(selectedShells()).toHaveLength(before);
  });

  it("drops the selection on Escape before it closes the map", async () => {
    const onClose = vi.fn();
    renderMap(4, { onClose });
    await ready();
    sweepEverything();
    await waitFor(() => expect(selectedShells().length).toBeGreaterThan(1));

    const layer = document.querySelector(".star-map");
    if (!(layer instanceof HTMLElement)) throw new Error("no layer");
    fireEvent.keyDown(layer, { key: "Escape" });

    await waitFor(() => expect(selectedShells()).toHaveLength(0));
    expect(onClose).not.toHaveBeenCalled();

    // Nothing left to unwind, so the second press closes.
    fireEvent.keyDown(layer, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("takes a card back out of the selection on a modifier-click", async () => {
    renderMap(4);
    await ready();
    sweepEverything();
    await waitFor(() => expect(selectedShells().length).toBeGreaterThan(1));
    const before = selectedShells().length;

    fireEvent.pointerDown(selectedShells()[0], {
      button: 0,
      shiftKey: true,
      clientX: 500,
      clientY: 400,
    });

    await waitFor(() => expect(selectedShells()).toHaveLength(before - 1));
  });

  it("extends the selection on a Cmd-sweep and replaces it on a Shift-sweep", async () => {
    renderMap(4);
    await ready();
    sweepEverything();
    await waitFor(() => expect(selectedShells().length).toBeGreaterThan(1));
    const before = selectedShells().length;

    // A sweep over empty space. In add mode it takes nothing away...
    fireEvent.pointerDown(viewport(), {
      button: 0,
      metaKey: true,
      clientX: 6000,
      clientY: 6000,
    });
    fireEvent.pointerMove(window, { clientX: 6200, clientY: 6200 });
    fireEvent.pointerUp(window, { clientX: 6200, clientY: 6200 });
    expect(selectedShells()).toHaveLength(before);

    // ...while the same sweep in replace mode starts a fresh, empty one.
    fireEvent.pointerDown(viewport(), {
      button: 0,
      shiftKey: true,
      clientX: 6000,
      clientY: 6000,
    });
    fireEvent.pointerMove(window, { clientX: 6200, clientY: 6200 });
    fireEvent.pointerUp(window, { clientX: 6200, clientY: 6200 });
    await waitFor(() => expect(selectedShells()).toHaveLength(0));
  });

  it("remembers cards that left the map but does not move them", async () => {
    const desktopApi = buildDesktopApi();
    const { showThreads } = renderMap(4, { desktopApi });
    await ready();
    sweepEverything();
    await waitFor(() => expect(selectedShells().length).toBe(4));

    // Two cards leave — a filter change, or the instance that owns them
    // dropping for a moment.
    showThreads(2);
    await waitFor(() => expect(shells()).toHaveLength(2));
    // Still remembered: an instance that flaps must not silently cost the
    // operator every card it owns.
    expect(screen.getByText("4 cards selected")).toBeTruthy();

    const dragged = selectedShells()[0];
    fireEvent.pointerDown(dragged, { button: 0, clientX: 500, clientY: 400 });
    await act(async () => {
      fireEvent.pointerMove(window, { clientX: 560, clientY: 400 });
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    });
    fireEvent.pointerUp(window, { clientX: 560, clientY: 400 });

    // The absent cards take no offset. Committing one would land invisibly
    // and only surface when the card came back.
    const setCardPosition = desktopApi.setStarMapCardPosition;
    if (!setCardPosition) throw new Error("no setStarMapCardPosition");
    const moved = vi.mocked(setCardPosition).mock.calls;
    expect(moved.length).toBeGreaterThan(0);
    for (const call of moved) {
      expect(JSON.stringify(call)).not.toMatch(/t2|t3/);
    }
  });
});
