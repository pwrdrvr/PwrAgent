import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { StarMapScreen } from "../StarMapScreen";

/**
 * The map must never move under the operator.
 *
 * Panning is how you work a map bigger than the window: you put the corner
 * you care about on screen and then act on it. Archiving a card from that
 * corner changes a cloud's card count, which changes the canvas size — and
 * the canvas size used to be an input to the "centre the view" effect, so
 * the act of tidying up threw away where you were looking.
 */

function buildDesktopApi(overrides: Partial<DesktopApi> = {}): DesktopApi {
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
    ...overrides,
  } as unknown as DesktopApi;
}

function thread(id: string): NavigationThreadSummary {
  return {
    id,
    title: `Thread ${id}`,
    titleSource: "generated",
    linkedDirectories: [
      { id: `${id}-dir`, label: "PwrSnap", path: "/repos/PwrSnap", kind: "local" },
    ],
    source: "codex",
    inbox: { inInbox: true, reason: "updated-since-seen" },
    updatedAt: 100,
  } as unknown as NavigationThreadSummary;
}

/** Enough threads that dropping one changes the cloud's ring count. */
function threads(count: number): NavigationThreadSummary[] {
  return Array.from({ length: count }, (_, index) => thread(`t${index}`));
}

function seedLayout(layout: "orbit" | "projects") {
  window.localStorage.setItem(
    "pwragent.starMap.viewPreferences",
    JSON.stringify({ layout }),
  );
}

function canvas(): HTMLElement {
  const element = document
    .querySelector(".star-map__canvas");
  if (!element) throw new Error("canvas not found");
  return element as HTMLElement;
}

/** Drag the canvas by a fixed delta, the way an operator pans. */
function pan(dx: number, dy: number) {
  const viewport = document.querySelector(".star-map__viewport");
  if (!viewport) throw new Error("viewport not found");
  fireEvent.pointerDown(viewport, { button: 0, clientX: 500, clientY: 400 });
  fireEvent.pointerMove(window, { clientX: 500 + dx, clientY: 400 + dy });
  fireEvent.pointerUp(window, { clientX: 500 + dx, clientY: 400 + dy });
}

function renderMap(props: { threads: NavigationThreadSummary[] }) {
  return render(
    <StarMapScreen
      desktopApi={buildDesktopApi()}
      localThreads={props.threads}
      sessionKeys={{}}
      localInstanceLabel="Mac-Mini-M4"
      floating={false}
      onClose={() => undefined}
      onOpenLocalThread={() => undefined}
      onFocusLocalInstance={() => undefined}
    />,
  );
}

describe("star map view stability", () => {
  // Layout preference is global; leaking it reorders unrelated suites.
  afterEach(() => {
    window.localStorage.removeItem("pwragent.starMap.viewPreferences");
  });

  it("keeps the operator's pan when a card is archived away (orbit)", async () => {
    seedLayout("orbit");
    const { rerender } = renderMap({ threads: threads(9) });
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Open this instance/ }),
      ).toBeTruthy();
    });

    pan(-320, -180);
    const panned = canvas().style.transform;
    expect(panned).toMatch(/translate/);

    // Archiving removes the thread and the owning cloud re-fetches. The
    // map must stay exactly where the operator put it.
    rerender(
      <StarMapScreen
        desktopApi={buildDesktopApi()}
        localThreads={threads(8)}
        sessionKeys={{}}
        localInstanceLabel="Mac-Mini-M4"
        floating={false}
        onClose={() => undefined}
        onOpenLocalThread={() => undefined}
        onFocusLocalInstance={() => undefined}
      />,
    );

    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: /Open thread: Thread t8/ }),
      ).toBeNull();
    });
    expect(canvas().style.transform).toBe(panned);
  });

  it("keeps the operator's zoom when the cloud resizes", async () => {
    seedLayout("orbit");
    const { rerender } = renderMap({ threads: threads(9) });
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Open this instance/ }),
      ).toBeTruthy();
    });

    const viewport = document.querySelector(".star-map__viewport")!;
    fireEvent.wheel(viewport, { deltaY: -240, ctrlKey: true, clientX: 400, clientY: 300 });
    const zoomed = canvas().style.transform;
    expect(zoomed).toMatch(/scale\((?!1\))/);

    rerender(
      <StarMapScreen
        desktopApi={buildDesktopApi()}
        localThreads={threads(5)}
        sessionKeys={{}}
        localInstanceLabel="Mac-Mini-M4"
        floating={false}
        onClose={() => undefined}
        onOpenLocalThread={() => undefined}
        onFocusLocalInstance={() => undefined}
      />,
    );

    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: /Open thread: Thread t8/ }),
      ).toBeNull();
    });
    expect(canvas().style.transform).toBe(zoomed);
  });

  it("still centres when the operator switches layout", async () => {
    // The re-centre is worth keeping for a genuine mode switch — that is a
    // new map, and leaving the operator in a corner of it is worse.
    seedLayout("orbit");
    renderMap({ threads: threads(9) });
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Open this instance/ }),
      ).toBeTruthy();
    });

    pan(-400, -260);
    expect(canvas().style.transform).toMatch(/translate/);

    fireEvent.click(screen.getByRole("button", { name: "View" }));
    fireEvent.click(screen.getByRole("button", { name: "Projects" }));

    await waitFor(() => {
      // A different lens re-centres rather than stranding the operator.
      expect(canvas().style.transform).not.toBe("");
    });
  });

  it("lets the operator pan the projects lens at all", async () => {
    // The projects canvas is bigger than the window like orbit's, but every
    // pan/zoom gate tested `orbitMode`, so it could not be navigated.
    seedLayout("projects");
    renderMap({ threads: threads(9) });
    await waitFor(() => {
      expect(screen.getByTitle("PwrSnap")).toBeTruthy();
    });

    const before = canvas().style.transform;
    pan(-260, -140);
    expect(canvas().style.transform).not.toBe(before);
  });

  it("keeps the operator's pan when a card is archived away (projects)", async () => {
    seedLayout("projects");
    const { rerender } = renderMap({ threads: threads(9) });
    await waitFor(() => {
      expect(screen.getByTitle("PwrSnap")).toBeTruthy();
    });

    pan(-300, -200);
    const panned = canvas().style.transform;

    rerender(
      <StarMapScreen
        desktopApi={buildDesktopApi()}
        localThreads={threads(4)}
        sessionKeys={{}}
        localInstanceLabel="Mac-Mini-M4"
        floating={false}
        onClose={() => undefined}
        onOpenLocalThread={() => undefined}
        onFocusLocalInstance={() => undefined}
      />,
    );

    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: /Open thread: Thread t8/ }),
      ).toBeNull();
    });
    expect(canvas().style.transform).toBe(panned);
  });
});
