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
    // Wait for federation health before selecting anything: card keys name
    // their instance, and the map drops a selection swept against the
    // placeholder id the moment the durable one lands.
    await screen.findByText(/Harold-MBP-M5-Max/);
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
/**
 * Pulled far out, a card is an unreadable smudge that still costs a whole
 * subtree to mount. The map trades every card for one label per cloud, so
 * the fleet stays legible AND the DOM shrinks exactly when it would
 * otherwise be at its largest.
 */
describe("star map overview zoom", () => {
  afterEach(() => {
    window.localStorage.removeItem("pwragent.starMap.viewPreferences");
  });

  it("drops cards for named clouds when zoomed out, and brings them back", async () => {
    const { container } = renderOrbit([
      projectThread("a1", "/repo/alpha", "AlphaDir"),
      projectThread("a2", "/repo/alpha", "AlphaDir"),
      projectThread("b1", "/repo/beta", "BetaDir"),
      projectThread("b2", "/repo/beta", "BetaDir"),
    ]);
    await screen.findByRole("button", { name: /Select the alpha cards/ });
    expect(
      container.querySelectorAll(".star-map-card-shell").length,
    ).toBeGreaterThan(0);

    const viewport = container.querySelector(
      ".star-map__viewport",
    ) as HTMLElement;
    // Positive deltaY with ctrl is pinch-out; one step lands on MIN_ZOOM.
    fireEvent.wheel(viewport, {
      deltaY: 240,
      ctrlKey: true,
      clientX: 400,
      clientY: 300,
    });

    await waitFor(() => {
      expect(container.querySelectorAll(".star-map-card-shell")).toHaveLength(
        0,
      );
    });
    // The clouds are still named, which is the whole point of going out.
    expect(
      screen.getByRole("button", { name: /Select the alpha cards/ }),
    ).toBeTruthy();
    expect(
      container.querySelectorAll(".star-map__cluster-label--overview").length,
    ).toBe(2);

    // The instance has to come with them. Its cards are gone at this
    // zoom, so the body and its name are the only things saying which
    // machine you are looking at — and a 13px pill at 0.12 scale paints
    // at a pixel and a half.
    const anchor = container.querySelector(
      ".star-map__anchor",
    ) as HTMLElement;
    expect(anchor.className).toContain("star-map__anchor--overview");
    const instanceScale = /scale\(([\d.]+)\)/.exec(anchor.style.transform);
    expect(instanceScale).not.toBeNull();
    expect(Number(instanceScale![1])).toBeGreaterThan(1);
    // Counter-scaled by the SAME factor as the cloud names, or the two
    // would drift apart as the operator kept pulling out.
    const label = container.querySelector(
      ".star-map__cluster-label--overview",
    ) as HTMLElement;
    expect(/scale\(([\d.]+)\)/.exec(label.style.transform)?.[1]).toBe(
      instanceScale![1],
    );
    // And it still names the machine.
    expect(anchor.textContent).toContain("Harold-MBP-M5-Max");

    // Coming back in restores the cards rather than stranding the map in
    // an overview it cannot leave. Each pinch step doubles the scale, so
    // climbing back from the floor past the threshold takes a few.
    for (let step = 0; step < 3; step += 1) {
      fireEvent.wheel(viewport, {
        deltaY: -240,
        ctrlKey: true,
        clientX: 400,
        clientY: 300,
      });
    }
    await waitFor(() => {
      expect(
        container.querySelectorAll(".star-map-card-shell").length,
      ).toBeGreaterThan(0);
    });
    // Back at reading zoom the instance drops its counter-scale rather
    // than staying blown up over the cards.
    expect(
      (container.querySelector(".star-map__anchor") as HTMLElement).style
        .transform,
    ).not.toContain("scale(");
  });
});

describe("star map load card in overview", () => {
  afterEach(() => {
    window.localStorage.removeItem("pwragent.starMap.viewPreferences");
  });

  it("scales and parks clear of the counter-scaled instance", async () => {
    const { container } = renderOrbit(
      [
        projectThread("a1", "/repo/alpha", "AlphaDir"),
        projectThread("a2", "/repo/alpha", "AlphaDir"),
      ],
      {
        readStarMapArrangement: vi.fn(async () => ({
          entries: [
            {
              instanceId: "pwr_local",
              threadKey: "system:load",
              dx: 0,
              dy: 0,
              updatedAt: 10,
              by: "pwr_local",
            },
          ],
        })),
        setStarMapCardPosition: vi.fn(async () => ({ entries: [] })),
        readFederationInstanceLoad: vi.fn(async () => ({})),
      },
    );
    await waitFor(() => {
      expect(container.querySelector(".star-map-load-card")).not.toBeNull();
    });
    const shell = container.querySelector(
      ".star-map-load-shell",
    ) as HTMLElement;
    const nearTop = Number.parseFloat(shell.style.top);

    fireEvent.wheel(
      container.querySelector(".star-map__viewport") as HTMLElement,
      { deltaY: 240, ctrlKey: true, clientX: 400, clientY: 300 },
    );

    await waitFor(() => {
      expect(
        (container.querySelector(".star-map-load-shell") as HTMLElement).style
          .transform,
      ).toContain("scale(");
    });
    const far = container.querySelector(".star-map-load-shell") as HTMLElement;
    const scale = Number(
      /scale\(([\d.]+)\)/.exec(far.style.transform)![1],
    );
    expect(scale).toBeGreaterThan(1);
    // Parked further out by the same factor, so the readout clears the
    // instance that just grew underneath it instead of being buried.
    expect(Number.parseFloat(far.style.top)).toBeCloseTo(nearTop * scale, 5);
    // Same factor as the instance, so the two stay one readable group.
    const anchor = container.querySelector(
      ".star-map__anchor",
    ) as HTMLElement;
    expect(/scale\(([\d.]+)\)/.exec(anchor.style.transform)![1]).toBe(
      String(scale),
    );
  });
});

describe("clicking the sky releases focus back to the map", () => {
  afterEach(() => {
    window.localStorage.removeItem("pwragent.starMap.viewPreferences");
  });

  it("takes focus off a chat composer so the flight keys work again", async () => {
    // The pan's preventDefault suppresses the browser's default focus
    // change, so a press on bare sky never blurred the composer (or a
    // terminal) — the WASD guard kept seeing keys aimed at text, and the
    // only way out was closing the map.
    const { container } = renderOrbit([
      projectThread("a1", "/repo/alpha", "AlphaDir"),
      projectThread("a2", "/repo/alpha", "AlphaDir"),
    ]);
    await screen.findByRole("button", { name: /Open thread: Thread a1/ });
    fireEvent.click(
      screen.getByRole("button", { name: /Open thread: Thread a1/ }),
    );
    const composer = (await screen.findByRole("textbox", {
      name: /Message Thread a1/,
    })) as HTMLTextAreaElement;
    composer.focus();
    expect(document.activeElement).toBe(composer);

    fireEvent.pointerDown(
      container.querySelector(".star-map__viewport") as HTMLElement,
      { button: 0, clientX: 40, clientY: 600 },
    );

    // Focus lands on the map layer — where Escape and the flight keys
    // already listen — not merely off the composer.
    expect(document.activeElement).toBe(
      container.querySelector(".star-map"),
    );
  });
});

describe("star map load card overview fixes", () => {
  afterEach(() => {
    window.localStorage.removeItem("pwragent.starMap.viewPreferences");
  });

  const loadCardApi = {
    readStarMapArrangement: vi.fn(async () => ({
      entries: [
        {
          instanceId: "pwr_local",
          threadKey: "system:load",
          dx: 0,
          dy: 60,
          updatedAt: 10,
          by: "pwr_local",
        },
      ],
    })),
    setStarMapCardPosition: vi.fn(async () => ({ entries: [] })),
    readFederationInstanceLoad: vi.fn(async () => ({})),
  };

  function renderLanes(threads: NavigationThreadSummary[]) {
    window.localStorage.setItem(
      "pwragent.starMap.viewPreferences",
      JSON.stringify({ layout: "lanes" }),
    );
    const desktopApi: DesktopApi = { ...buildDesktopApi(), ...loadCardApi };
    return render(
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
  }

  it("never scales in the lanes lens, where nothing else does", async () => {
    // `overview` is derived from view.scale alone and lanes zooms through
    // the same clamp, so without the orbit gate a lane's load card
    // ballooned over its own unscaled column.
    const { container } = renderLanes([
      projectThread("a1", "/repo/alpha", "AlphaDir"),
    ]);
    await waitFor(() => {
      expect(container.querySelector(".star-map-load-card")).not.toBeNull();
    });

    fireEvent.wheel(
      container.querySelector(".star-map__viewport") as HTMLElement,
      { deltaY: 240, ctrlKey: true, clientX: 400, clientY: 300 },
    );

    await waitFor(() => {
      const canvas = container.querySelector(
        ".star-map__canvas",
      ) as HTMLElement;
      expect(canvas.style.transform).toContain("scale(0.");
    });
    const shell = container.querySelector(
      ".star-map-load-shell",
    ) as HTMLElement;
    expect(shell.style.transform).not.toContain("scale(");
  });

  it("scales a hand-placed offset with the base, and refuses drags", async () => {
    const setStarMapCardPosition = vi.fn(async () => ({ entries: [] }));
    const { container } = renderOrbit(
      [projectThread("a1", "/repo/alpha", "AlphaDir")],
      { ...loadCardApi, setStarMapCardPosition },
    );
    await waitFor(() => {
      expect(container.querySelector(".star-map-load-card")).not.toBeNull();
    });
    const nearTop = Number.parseFloat(
      (container.querySelector(".star-map-load-shell") as HTMLElement).style
        .top,
    );

    fireEvent.wheel(
      container.querySelector(".star-map__viewport") as HTMLElement,
      { deltaY: 240, ctrlKey: true, clientX: 400, clientY: 300 },
    );
    await waitFor(() => {
      expect(
        (container.querySelector(".star-map-load-shell") as HTMLElement).style
          .transform,
      ).toContain("scale(");
    });

    const shell = container.querySelector(
      ".star-map-load-shell",
    ) as HTMLElement;
    const scale = Number(/scale\(([\d.]+)\)/.exec(shell.style.transform)![1]);
    // The WHOLE position scales — base and stored offset together — so a
    // hand-placed card keeps its place in the group that grew around it.
    expect(Number.parseFloat(shell.style.top)).toBeCloseTo(
      nearTop * scale,
      5,
    );

    // And a drag in this state commits nothing: an offset measured against
    // the scaled base would re-read as a different position at zoom 1.
    setStarMapCardPosition.mockClear();
    fireEvent.pointerDown(shell, { button: 0, clientX: 300, clientY: 300 });
    fireEvent.pointerMove(window, { clientX: 420, clientY: 360 });
    fireEvent.pointerUp(window, { clientX: 420, clientY: 360 });
    expect(setStarMapCardPosition).not.toHaveBeenCalled();
  });
});

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
    // The card end of the pairing says so too — and says it to a screen
    // reader, not only to the eye.
    expect(shell.className).toContain("star-map-card-shell--chatting");
    const open = shell.querySelector(".star-map-card__open")!;
    const described = open.getAttribute("aria-describedby");
    expect(described).toBeTruthy();
    expect(shell.querySelector(`#${described}`)?.textContent).toContain(
      "Chat card open",
    );
    // The button still NAMES its action; the state is a description.
    expect(open.getAttribute("aria-label")).toBe("Open thread: Thread a1");
  });

  it("scrolls the transcript instead of panning the galaxy", async () => {
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

    const canvas = container.querySelector(".star-map__canvas") as HTMLElement;
    const chat = container.querySelector(".star-map-chat-card") as HTMLElement;
    const before = canvas.style.transform;

    // The card is inside the canvas, so its wheel events reach the
    // viewport's listener; the map must leave them alone.
    fireEvent.wheel(chat, { deltaY: 240 });
    expect(canvas.style.transform).toBe(before);

    // Bare sky still pans, so the exception is scoped to the card.
    fireEvent.wheel(
      container.querySelector(".star-map__viewport") as HTMLElement,
      { deltaY: 240 },
    );
    await waitFor(() => {
      expect(canvas.style.transform).not.toBe(before);
    });
  });

  it("docks satellite cards to their chat card as one group", async () => {
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

    fireEvent.click(
      screen.getByRole("button", { name: /Show thread context/ }),
    );
    await waitFor(() => {
      expect(container.querySelector(".star-map-context-card")).not.toBeNull();
    });

    // Docked, not overlapping: the satellite starts past the host's right
    // edge, top-aligned. Both live INSIDE the canvas so they pan together.
    const chat = container.querySelector(".star-map-chat-card") as HTMLElement;
    const satellite = container.querySelector(
      ".star-map-context-card",
    ) as HTMLElement;
    expect(
      container.querySelector(".star-map__canvas .star-map-context-card"),
    ).not.toBeNull();
    expect(Number.parseFloat(satellite.style.left)).toBeGreaterThan(
      Number.parseFloat(chat.style.left) + Number.parseFloat(chat.style.width),
    );
    expect(satellite.style.top).toBe(chat.style.top);

    // The panel fills the card it was given: the width var is pinned to
    // card-minus-spine, so the 380px fallback cannot overflow and leave a
    // blank strip where the misfit was clipped.
    const body = satellite.querySelector(
      ".star-map-satellite-card__body",
    ) as HTMLElement;
    expect(body.style.getPropertyValue("--context-rail-effective")).toBe(
      `${Number.parseFloat(satellite.style.width) - 48}px`,
    );

    // It closes from its own title bar too.
    fireEvent.click(
      screen.getByRole("button", { name: /Close thread context/ }),
    );
    await waitFor(() => {
      expect(container.querySelector(".star-map-context-card")).toBeNull();
    });
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
