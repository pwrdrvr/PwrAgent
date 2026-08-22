import { memo } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";

/**
 * What the edge arrows are allowed to cost per frame.
 *
 * The overlay deliberately re-renders on every PAINTED frame — that is the
 * whole point, and the behavioural spec pins it. What it must not do is
 * re-render when nothing about the map moved: `targets` is rebuilt by the
 * screen on essentially every render (it hangs off the streamed thread
 * feed and off `view.scale`), so a reference-equality `memo` was a no-op —
 * ten screen renders with no body moved produced ten overlay renders and
 * ten full geometry passes, on the surface whose entire `paintView` design
 * exists to keep that path cheap.
 *
 * The counting stand-in preserves the REAL memo boundary by re-wrapping the
 * real component's inner function together with its real comparator; the
 * same shape as star-map-chat-card-render-cost.test.tsx.
 */
const renders = { count: 0 };

vi.mock("../StarMapEdgeArrows", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../StarMapEdgeArrows")>();
  const real = actual.StarMapEdgeArrows as unknown as {
    type: (props: never) => unknown;
    compare: ((a: never, b: never) => boolean) | null;
  };
  return {
    ...actual,
    StarMapEdgeArrows: memo((props: never) => {
      renders.count += 1;
      return real.type(props) as never;
    }, real.compare ?? undefined),
  };
});

const { StarMapScreen } = await import("../StarMapScreen");

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
  } as unknown as DesktopApi;
}

function thread(id: string, updatedAt = 100): NavigationThreadSummary {
  return {
    id,
    title: `Thread ${id}`,
    titleSource: "generated",
    linkedDirectories: [
      { id: `${id}-dir`, label: "PwrSnap", path: "/repos/PwrSnap", kind: "local" },
    ],
    source: "codex",
    inbox: { inInbox: true, reason: "updated-since-seen" },
    updatedAt,
  } as unknown as NavigationThreadSummary;
}

function canvas(): HTMLElement {
  const element = document.querySelector(".star-map__canvas");
  if (!(element instanceof HTMLElement)) throw new Error("no canvas");
  return element;
}

function viewport(): HTMLElement {
  const element = document.querySelector(".star-map__viewport");
  if (!(element instanceof HTMLElement)) throw new Error("no viewport");
  return element;
}

function arrowCount(): number {
  return document.querySelectorAll(".star-map__edge-arrow").length;
}

describe("star map edge arrow render cost", () => {
  afterEach(() => {
    window.localStorage.removeItem("pwragent.starMap.viewPreferences");
    window.localStorage.removeItem("pwragent.starMap.filterSelection");
    renders.count = 0;
  });

  it("does not re-render when the thread feed churns but no body moves", async () => {
    window.localStorage.setItem(
      "pwragent.starMap.viewPreferences",
      JSON.stringify({ layout: "orbit" }),
    );
    const threads = Array.from({ length: 6 }, (_, index) => thread(`t${index}`));
    const { rerender } = render(
      <StarMapScreen
        desktopApi={buildDesktopApi()}
        localThreads={threads}
        sessionKeys={{}}
        localInstanceLabel="Mac-Mini-M4"
        onOpenLocalThread={() => undefined}
        onFocusLocalInstance={() => undefined}
      />,
    );
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Open this instance/ })).toBeTruthy();
    });
    // Get at least one arrow on screen so the overlay has real work to do.
    fireEvent.pointerDown(viewport(), { button: 0, clientX: 500, clientY: 400 });
    fireEvent.pointerMove(window, { clientX: -500, clientY: 400 });
    fireEvent.pointerUp(window, { clientX: -500, clientY: 400 });
    await waitFor(() => {
      expect(arrowCount()).toBeGreaterThan(0);
    });

    const baseline = renders.count;
    // Ten fresh snapshots of the SAME threads: new arrays, new objects,
    // nothing moved. This is what a streaming turn looks like to the
    // screen, and it used to cost ten overlay renders.
    for (let round = 0; round < 10; round += 1) {
      const churned = threads.map((entry) => ({ ...entry }));
      rerender(
        <StarMapScreen
          desktopApi={buildDesktopApi()}
          localThreads={churned}
          sessionKeys={{}}
          localInstanceLabel="Mac-Mini-M4"
          onOpenLocalThread={() => undefined}
          onFocusLocalInstance={() => undefined}
        />,
      );
    }
    expect(renders.count - baseline).toBe(0);
  });

  it("still re-renders once per painted frame of a gesture", async () => {
    // The other half of the contract: the memo must not be so eager that
    // the arrows stop tracking the map. A held drag paints frames without
    // committing to React, and each one has to reach the overlay.
    window.localStorage.setItem(
      "pwragent.starMap.viewPreferences",
      JSON.stringify({ layout: "orbit" }),
    );
    render(
      <StarMapScreen
        desktopApi={buildDesktopApi()}
        localThreads={Array.from({ length: 6 }, (_, index) => thread(`t${index}`))}
        sessionKeys={{}}
        localInstanceLabel="Mac-Mini-M4"
        onOpenLocalThread={() => undefined}
        onFocusLocalInstance={() => undefined}
      />,
    );
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Open this instance/ })).toBeTruthy();
    });

    const baseline = renders.count;
    const before = canvas().style.transform;
    fireEvent.pointerDown(viewport(), { button: 0, clientX: 900, clientY: 400 });
    for (let frame = 1; frame <= 3; frame += 1) {
      fireEvent.pointerMove(window, {
        clientX: 900 - frame * 120,
        clientY: 400,
      });
      await act(async () => {
        await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
      });
    }
    fireEvent.pointerUp(window, { clientX: 540, clientY: 400 });
    // The gesture really moved the map...
    expect(canvas().style.transform).not.toBe(before);
    // ...and the overlay tracked it rather than sitting still.
    expect(renders.count).toBeGreaterThan(baseline);
  });
});
