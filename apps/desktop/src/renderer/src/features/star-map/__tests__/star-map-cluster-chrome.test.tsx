import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { StarMapScreen } from "../StarMapScreen";
import {
  buildInstanceClusters,
  computeClusterCloud,
} from "../star-map-clusters";

/**
 * Orbit-lens project cloud chrome: the label pills, the per-cloud "+N
 * more" expand chips, and the chip hygiene inside a labeled cloud. The
 * geometry itself is pinned in star-map-clusters.test.ts; this file pins
 * what the operator actually sees and clicks.
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
  };
}

function projectThread(
  id: string,
  path: string,
  label: string,
): NavigationThreadSummary {
  return {
    id,
    title: `Thread ${id}`,
    titleSource: "generated",
    linkedDirectories: [
      { id: `dir-${path}`, label, path, kind: "local" },
    ],
    source: "codex",
    inbox: { inInbox: false },
    updatedAt: 100,
  } as unknown as NavigationThreadSummary;
}

function renderOrbit(
  threads: NavigationThreadSummary[],
  api?: Partial<DesktopApi>,
) {
  window.localStorage.setItem(
    "pwragent.starMap.viewPreferences",
    JSON.stringify({ layout: "orbit" }),
  );
  const desktopApi: DesktopApi = { ...buildDesktopApi(), ...api };
  const view = render(
    <StarMapScreen
      desktopApi={desktopApi}
      localThreads={threads}
      sessionKeys={{}}
      localInstanceLabel="Mac-Mini-M4"
      floating={false}
      onClose={() => undefined}
      onOpenLocalThread={() => undefined}
      onFocusLocalInstance={() => undefined}
    />,
  );
  const rerenderThreads = (next: NavigationThreadSummary[]) =>
    view.rerender(
      <StarMapScreen
        desktopApi={desktopApi}
        localThreads={next}
        sessionKeys={{}}
        localInstanceLabel="Mac-Mini-M4"
        floating={false}
        onClose={() => undefined}
        onOpenLocalThread={() => undefined}
        onFocusLocalInstance={() => undefined}
      />,
    );
  return { ...view, rerenderThreads };
}

function cardShell(container: HTMLElement, threadKey: string): HTMLElement {
  const shell = container.querySelector(`[data-thread-key="${threadKey}"]`);
  if (!(shell instanceof HTMLElement)) {
    throw new Error(`No card shell for ${threadKey}`);
  }
  return shell;
}

describe("star map project cloud chrome", () => {
  afterEach(() => {
    window.localStorage.removeItem("pwragent.starMap.viewPreferences");
    window.localStorage.removeItem("pwragent.starMap.filterSelection");
  });

  it("labels each project cloud with its name and total", async () => {
    renderOrbit([
      projectThread("a1", "/repo/alpha", "AlphaDir"),
      projectThread("a2", "/repo/alpha", "AlphaDir"),
      projectThread("b1", "/repo/beta", "BetaDir"),
      projectThread("b2", "/repo/beta", "BetaDir"),
    ]);
    const alphaLabel = await screen.findByRole("button", {
      name: /Select the alpha cards \(2 threads\)/,
    });
    expect(alphaLabel.textContent).toContain("alpha");
    expect(alphaLabel.textContent).toContain("2");
    expect(
      screen.getByRole("button", {
        name: /Select the beta cards \(2 threads\)/,
      }),
    ).toBeTruthy();
  });

  it("keeps every card chip inside a labeled cloud", async () => {
    renderOrbit([
      projectThread("a1", "/repo/alpha", "AlphaDir"),
      projectThread("a2", "/repo/alpha", "AlphaDir"),
    ]);
    await screen.findByRole("button", { name: /Select the alpha cards/ });
    // The cloud groups cards; it must not strip their anatomy — the
    // directory chips render exactly as they would anywhere else.
    expect(screen.getAllByText("AlphaDir").length).toBeGreaterThan(0);
  });

  it("floats a lone card chromeless — no label, no chip", async () => {
    renderOrbit([
      {
        ...projectThread("x", "/repo/gamma", "GammaDir"),
        linkedDirectories: [],
      } as unknown as NavigationThreadSummary,
    ]);
    await screen.findByRole("button", { name: /Open thread: Thread x/ });
    expect(screen.queryByRole("button", { name: /Select the/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /more .* threads/ })).toBeNull();
  });

  it("truncates a big cloud at the group cap and expands on the chip", async () => {
    const threads = Array.from({ length: 12 }, (unused, index) =>
      projectThread(`t${index}`, "/repo/alpha", "AlphaDir"),
    );
    renderOrbit(threads);

    const chip = await screen.findByRole("button", {
      name: /Show 4 more alpha threads/,
    });
    expect(chip.textContent).toBe("+4 more");
    expect(
      screen.getAllByRole("button", { name: /^Open thread:/ }),
    ).toHaveLength(8);

    // Re-query at click time: card measurement re-renders the map, and a
    // node captured by an earlier waitFor can already be detached.
    fireEvent.click(
      screen.getByRole("button", { name: /Show 4 more alpha threads/ }),
    );
    await waitFor(() => {
      expect(
        screen.getAllByRole("button", { name: /^Open thread:/ }),
      ).toHaveLength(12);
    });

    // The chip stays so the cloud can fold back down.
    expect(
      screen.getByRole("button", { name: /Show fewer alpha threads/ })
        .textContent,
    ).toBe("Show fewer");
    fireEvent.click(
      screen.getByRole("button", { name: /Show fewer alpha threads/ }),
    );
    await waitFor(() => {
      expect(
        screen.getAllByRole("button", { name: /^Open thread:/ }),
      ).toHaveLength(8);
    });
  });

  it("selects the cloud's visible cards from the pill", async () => {
    const { container } = renderOrbit([
      projectThread("a1", "/repo/alpha", "AlphaDir"),
      projectThread("a2", "/repo/alpha", "AlphaDir"),
      projectThread("b1", "/repo/beta", "BetaDir"),
    ]);
    const pill = await screen.findByRole("button", {
      name: /Select the alpha cards/,
    });
    expect(pill.getAttribute("aria-pressed")).toBe("false");

    // Re-query at click time — see the expand test above.
    fireEvent.click(
      screen.getByRole("button", { name: /Select the alpha cards/ }),
    );
    await waitFor(() => {
      expect(
        screen
          .getByRole("button", { name: /Select the alpha cards/ })
          .getAttribute("aria-pressed"),
      ).toBe("true");
    });
    expect(
      container.querySelectorAll(".star-map-card-shell--selected"),
    ).toHaveLength(2);

    // Second click releases the same cloud.
    fireEvent.click(
      screen.getByRole("button", { name: /Select the alpha cards/ }),
    );
    await waitFor(() => {
      expect(
        container.querySelectorAll(".star-map-card-shell--selected"),
      ).toHaveLength(0);
    });
  });

  it("anchors a placed card to its cloud when a cloudmate archives away", async () => {
    const threads = [
      projectThread("a1", "/repo/alpha", "AlphaDir"),
      projectThread("a2", "/repo/alpha", "AlphaDir"),
      projectThread("a3", "/repo/alpha", "AlphaDir"),
    ];
    const stored = { dx: 140, dy: 90 };
    const { container, rerenderThreads } = renderOrbit(threads, {
      readStarMapArrangement: vi.fn(async () => ({
        entries: [
          {
            instanceId: "pwr_local",
            threadKey: "codex:a1",
            dx: stored.dx,
            dy: stored.dy,
            updatedAt: 10,
            by: "pwr_local",
          },
        ],
      })),
      setStarMapCardPosition: vi.fn(async () => ({ entries: [] })),
    });

    // jsdom has no ResizeObserver, so every card keeps the estimated
    // height — the same inputs the screen feeds the pure layout, which
    // makes the expected anchor computable here.
    const centerFor = (list: NavigationThreadSummary[]) =>
      computeClusterCloud({
        clusters: buildInstanceClusters({ threads: list }),
        cardWidth: 200,
        heightForThread: () => 112,
      }).clusters[0].center;

    const before = centerFor(threads);
    await waitFor(() => {
      const shell = cardShell(container, "codex:a1");
      expect(shell.style.left).toBe(`${before.x + stored.dx}px`);
      expect(shell.style.top).toBe(`${before.y + stored.dy}px`);
    });

    // A cloudmate archives away: the scatter reflows, the cloud origin
    // shifts a little — and the placed card keeps EXACTLY its stored
    // offset from that origin instead of resetting.
    rerenderThreads(threads.slice(0, 2));
    const after = centerFor(threads.slice(0, 2));
    await waitFor(() => {
      const shell = cardShell(container, "codex:a1");
      expect(shell.style.left).toBe(`${after.x + stored.dx}px`);
      expect(shell.style.top).toBe(`${after.y + stored.dy}px`);
    });
  });

  it("hides a card the moment Archive is chosen", async () => {
    // Never resolves: the point is what happens BEFORE the backend and
    // the next snapshot catch up.
    const archiveThread = vi.fn(
      () => new Promise(() => undefined),
    ) as unknown as DesktopApi["archiveThread"];
    renderOrbit(
      [
        projectThread("a1", "/repo/alpha", "AlphaDir"),
        projectThread("a2", "/repo/alpha", "AlphaDir"),
      ],
      { archiveThread },
    );
    await screen.findByRole("button", { name: /Open thread: Thread a1/ });

    fireEvent.click(
      screen.getByRole("button", { name: "Actions for Thread a1" }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Archive thread" }));

    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: /Open thread: Thread a1/ }),
      ).toBeNull();
    });
    expect(archiveThread).toHaveBeenCalledTimes(1);
    // The rest of the cloud is untouched.
    expect(
      screen.getByRole("button", { name: /Open thread: Thread a2/ }),
    ).toBeTruthy();
  });
});

/**
 * Chat cards are objects in the galaxy, not windows over it: they ride
 * the canvas transform, so panning away and coming back finds them where
 * they were left.
 */
describe("star map chat cards in map space", () => {
  afterEach(() => {
    window.localStorage.removeItem("pwragent.starMap.viewPreferences");
  });

  it("renders the chat card inside the transformed canvas", async () => {
    const { container } = renderOrbit([
      projectThread("a1", "/repo/alpha", "AlphaDir"),
      projectThread("a2", "/repo/alpha", "AlphaDir"),
    ]);
    await screen.findByRole("button", { name: /Open thread: Thread a1/ });
    fireEvent.click(
      screen.getByRole("button", { name: /Open thread: Thread a1/ }),
    );

    await waitFor(() => {
      expect(container.querySelector(".star-map-chat-card")).not.toBeNull();
    });
    // Inside the canvas is what makes it pan and zoom with the map; a
    // card mounted beside the canvas would sit still while the sky moved.
    expect(
      container.querySelector(".star-map__canvas .star-map-chat-card"),
    ).not.toBeNull();
  });

  it("opens the card beside the thread it belongs to, and tethers them", async () => {
    const { container } = renderOrbit([
      projectThread("a1", "/repo/alpha", "AlphaDir"),
      projectThread("a2", "/repo/alpha", "AlphaDir"),
    ]);
    await screen.findByRole("button", { name: /Open thread: Thread a1/ });
    fireEvent.click(
      screen.getByRole("button", { name: /Open thread: Thread a1/ }),
    );

    await waitFor(() => {
      expect(container.querySelector(".star-map__tether")).not.toBeNull();
    });
    const shell = cardShell(container, "codex:a1");
    const chat = container.querySelector(".star-map-chat-card") as HTMLElement;
    // Beside its card rather than cascaded into a corner: the horizontal
    // gap is a card-width or two, not the width of the map.
    const cardLeft = Number.parseFloat(shell.style.left);
    expect(
      Math.abs(Number.parseFloat(chat.style.left) - cardLeft),
    ).toBeLessThan(800);
    // The card end of the pairing says so too.
    expect(shell.className).toContain("star-map-card-shell--chatting");
  });

  it("draws no tether when the thread has no card on the map", async () => {
    const { container, rerenderThreads } = renderOrbit([
      projectThread("a1", "/repo/alpha", "AlphaDir"),
      projectThread("a2", "/repo/alpha", "AlphaDir"),
    ]);
    await screen.findByRole("button", { name: /Open thread: Thread a1/ });
    fireEvent.click(
      screen.getByRole("button", { name: /Open thread: Thread a1/ }),
    );
    await waitFor(() => {
      expect(container.querySelector(".star-map__tether")).not.toBeNull();
    });

    // The thread leaves the map (archived here) while its chat stays open.
    rerenderThreads([projectThread("a2", "/repo/alpha", "AlphaDir")]);
    await waitFor(() => {
      expect(container.querySelector(".star-map__tether")).toBeNull();
    });
    // A line to nowhere is worse than no line, but the chat stays open.
    expect(container.querySelector(".star-map-chat-card")).not.toBeNull();
  });
});
