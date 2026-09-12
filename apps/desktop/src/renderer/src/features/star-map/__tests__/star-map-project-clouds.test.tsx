import "./foreground-fixture";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { StarMapScreen } from "../StarMapScreen";

/**
 * Projects-lens clouds.
 *
 * A project draws one system: its own cards ringed around its body, and
 * a sub-cloud beside them for each parent thread that has replies. Three
 * earlier shapes failed differently and all are guarded here. A flat ring
 * capped the whole body at sixteen cards with a single dead "+N more"
 * caption. Reusing the Instances lens's seating fixed the caption and
 * broke the placement: every cloud was thrown clear of an INSTANCE's
 * chrome and cleared its neighbours box-to-box, and a project body is a
 * label, so a project with two parent groups seated its clouds at
 * (-477, +224), (+16, -378) and (+314, +417) from its own body — nothing
 * within 400px of the name. Collapsing the whole project into one ring
 * put the cards back but dropped the parent/child grouping entirely.
 *
 * So the assertions below are about *distance*: a project's cards belong
 * to the body that names them, and to no other body — with the sub-clouds
 * intact.
 */

/**
 * How far a project's cards may be from its body.
 *
 * Its own ring reaches ~335px; a sub-cloud sits beside that ring, so its
 * far side is about twice out. Generous on purpose — the defect this
 * guards drew cards at 850px and beyond, past the neighbouring project.
 */
const CLOUD_RADIUS = 700;

function buildDesktopApi(overrides?: Partial<DesktopApi>): DesktopApi {
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

function thread(params: {
  id: string;
  path: string;
  label: string;
  title?: string;
  parentThreadId?: string;
}): NavigationThreadSummary {
  return {
    id: params.id,
    title: params.title ?? `Thread ${params.id}`,
    titleSource: "generated",
    linkedDirectories: [
      { id: `dir-${params.path}`, label: params.label, path: params.path, kind: "local" },
    ],
    source: "codex",
    inbox: { inInbox: false },
    updatedAt: 100,
    ...(params.parentThreadId
      ? { parentThreadId: params.parentThreadId, parentThreadBackend: "codex" }
      : {}),
  } as unknown as NavigationThreadSummary;
}

function renderProjects(
  threads: NavigationThreadSummary[],
  api?: Partial<DesktopApi>,
) {
  window.localStorage.setItem(
    "pwragent.starMap.viewPreferences",
    JSON.stringify({ layout: "projects" }),
  );
  return render(
    <StarMapScreen
      desktopApi={buildDesktopApi(api)}
      localThreads={threads}
      sessionKeys={{}}
      localInstanceLabel="Mac-Mini-M4"
      onOpenLocalThread={() => undefined}
      onFocusLocalInstance={() => undefined}
    />,
  );
}

/**
 * Where each project's body sits, and where its cards sit relative to it.
 *
 * Both come from the inline styles the layout writes, because jsdom
 * measures every box as zero: `.star-map__project-cloud` is positioned at
 * the body, and a card's `left`/`top` are its slot within that body's
 * space (the card's own `margin-left` re-centres it on `left`).
 */
function projectSystems(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>(".star-map__project-cloud")].map(
    (cloud) => ({
      label:
        cloud.querySelector(".star-map-project__name")?.textContent ?? "",
      body: {
        x: Number.parseFloat(cloud.style.left),
        y: Number.parseFloat(cloud.style.top),
      },
      cards: [...cloud.querySelectorAll<HTMLElement>(".star-map-card-shell")].map(
        (card) => ({
          key: card.dataset.cardKey ?? "",
          dx: Number.parseFloat(card.style.left),
          dy: Number.parseFloat(card.style.top),
        }),
      ),
    }),
  );
}

/**
 * Where a thread card sits in CANVAS coordinates, in either lens.
 *
 * Both lenses nest their cards one box deep — `.star-map__project-cloud`
 * at the project's body here, `.star-map__cloud` at the instance's there
 * — so a card's own `left`/`top` are offsets inside it. Summing every
 * positioned box up to the canvas covers both, which is what makes the
 * two readings comparable across a lens switch.
 */
function cardOrigin(shell: HTMLElement): { x: number; y: number } {
  let x = Number.parseFloat(shell.style.left);
  let y = Number.parseFloat(shell.style.top);
  let node = shell.parentElement;
  while (node && !node.classList.contains("star-map__canvas")) {
    const left = Number.parseFloat(node.style.left);
    const top = Number.parseFloat(node.style.top);
    if (Number.isFinite(left)) x += left;
    if (Number.isFinite(top)) y += top;
    node = node.parentElement;
  }
  return { x, y };
}

function chatCardOrigin(container: HTMLElement): { x: number; y: number } {
  const chat = container.querySelector(".star-map-chat-card") as HTMLElement;
  return {
    x: Number.parseFloat(chat.style.left),
    y: Number.parseFloat(chat.style.top),
  };
}

describe("star map projects lens clouds", () => {
  afterEach(() => {
    window.localStorage.removeItem("pwragent.starMap.viewPreferences");
    window.localStorage.removeItem("pwragent.starMap.filterSelection");
  });

  it("rings a project's body with its own cards", async () => {
    const { container } = renderProjects([
      thread({ id: "p1", path: "/repo/alpha", label: "AlphaDir", title: "Root work" }),
      thread({
        id: "c1",
        parentThreadId: "p1",
        path: "/repo/alpha",
        label: "AlphaDir",
        title: "Child one",
      }),
      thread({
        id: "c2",
        parentThreadId: "p1",
        path: "/repo/alpha",
        label: "AlphaDir",
        title: "Child two",
      }),
      thread({ id: "loose", path: "/repo/alpha", label: "AlphaDir" }),
    ]);

    await waitFor(() => {
      expect(projectSystems(container)[0]?.cards).toHaveLength(4);
    });
    const [alpha] = projectSystems(container);

    // The whole complaint, as an assertion: every card is inside the
    // cloud its body draws. The per-parent seating put the nearest one
    // 400px outside it.
    for (const card of alpha.cards) {
      expect(Math.hypot(card.dx, card.dy)).toBeLessThan(CLOUD_RADIUS);
    }
    // ...and off the body's own label, which sits at the centre. Seat 0
    // is held empty for exactly this.
    for (const card of alpha.cards) {
      expect(Math.hypot(card.dx, card.dy)).toBeGreaterThan(100);
    }

    // The parent and its two replies are their own sub-cloud, named by
    // its own pill. A project is the grouping, but it is not the ONLY
    // grouping: a thread and its replies are a unit inside it.
    const pill = container.querySelector(".star-map__cluster-label--parent");
    expect(pill?.textContent).toContain("Root work");
  });

  it("hangs a parent's replies off the parent, above them", async () => {
    const { container } = renderProjects([
      thread({ id: "loose", path: "/repo/alpha", label: "AlphaDir" }),
      thread({ id: "p1", path: "/repo/alpha", label: "AlphaDir", title: "Root work" }),
      thread({
        id: "c1",
        parentThreadId: "p1",
        path: "/repo/alpha",
        label: "AlphaDir",
        title: "Child one",
      }),
      thread({
        id: "c2",
        parentThreadId: "p1",
        path: "/repo/alpha",
        label: "AlphaDir",
        title: "Child two",
      }),
    ]);

    await waitFor(() => {
      expect(projectSystems(container)[0]?.cards).toHaveLength(4);
    });
    const cards = new Map(
      projectSystems(container)[0].cards.map((card) => [card.key, card]),
    );
    const parent = cards.get("pwr_local::codex:p1")!;
    const children = ["c1", "c2"].map(
      (id) => cards.get(`pwr_local::codex:${id}`)!,
    );
    // The parent heads its sub-cloud: it sits above both replies, and
    // each reply is nearer the parent than the project's own loose card.
    const loose = cards.get("pwr_local::codex:loose")!;
    for (const child of children) {
      expect(parent.dy).toBeLessThan(child.dy);
      expect(Math.hypot(child.dx - parent.dx, child.dy - parent.dy)).toBeLessThan(
        Math.hypot(child.dx - loose.dx, child.dy - loose.dy),
      );
    }
  });

  /**
   * The cap is `PROJECT_MAX_CARDS_PER_GROUP`, deliberately higher than
   * the Instances lens's: a project body IS the thing being looked at,
   * and eight cards was less than one page of its thread list.
   */
  it("expands past the per-cloud cap from the chip", async () => {
    renderProjects(
      Array.from({ length: 15 }, (unused, index) =>
        thread({ id: `t${index}`, path: "/repo/alpha", label: "AlphaDir" }),
      ),
    );

    const chip = await screen.findByRole("button", {
      name: /Show 3 more alpha threads/,
    });
    expect(chip.textContent).toBe("+3 more");
    expect(
      screen.getAllByRole("button", { name: /^Open thread:/ }),
    ).toHaveLength(12);

    // Re-query at click time: card measurement re-renders the map.
    fireEvent.click(
      screen.getByRole("button", { name: /Show 3 more alpha threads/ }),
    );
    await waitFor(() => {
      expect(
        screen.getAllByRole("button", { name: /^Open thread:/ }),
      ).toHaveLength(15);
    });
  });

  it("keeps every card nearer its own project than any other", async () => {
    const { container } = renderProjects([
      thread({ id: "a1", path: "/repo/alpha", label: "AlphaDir", title: "Alpha root" }),
      thread({
        id: "a2",
        parentThreadId: "a1",
        path: "/repo/alpha",
        label: "AlphaDir",
        title: "Alpha child",
      }),
      thread({ id: "b1", path: "/repo/beta", label: "BetaDir", title: "Beta root" }),
      thread({
        id: "b2",
        parentThreadId: "b1",
        path: "/repo/beta",
        label: "BetaDir",
        title: "Beta child",
      }),
    ]);

    await waitFor(() => {
      expect(projectSystems(container)).toHaveLength(2);
    });
    const systems = projectSystems(container);
    expect(systems.map((system) => system.label).sort()).toEqual([
      "alpha",
      "beta",
    ]);

    // Two bodies close enough to confuse: a card has to be nearer the
    // project that owns it than the one next door, or the operator reads
    // it as belonging to the wrong project. Clouds seated off their own
    // body failed this outright — a project's cards could land closer to
    // its neighbour's name than to its own.
    for (const system of systems) {
      expect(system.cards.length).toBeGreaterThan(0);
      for (const card of system.cards) {
        const own = Math.hypot(card.dx, card.dy);
        for (const other of systems) {
          if (other === system) continue;
          const toOther = Math.hypot(
            system.body.x + card.dx - other.body.x,
            system.body.y + card.dy - other.body.y,
          );
          expect(own).toBeLessThan(toOther);
        }
      }
    }
  });

  /**
   * The sweep reads this lens's own card geometry. It used to read
   * `cardRects`, which is empty by construction here, so a marquee
   * selected nothing and — in `replace` mode — wiped whatever the cloud
   * pills had selected. Invisible while the lens painted no selected state
   * at all; a broken affordance the moment it did.
   */
  it("sweeps a marquee over project cards", async () => {
    const { container } = renderProjects([
      thread({ id: "a1", path: "/repo/alpha", label: "AlphaDir" }),
      thread({ id: "a2", path: "/repo/alpha", label: "AlphaDir" }),
      thread({ id: "b1", path: "/repo/beta", label: "BetaDir" }),
    ]);
    // Card keys name their owning instance; a sweep against the
    // placeholder id is dropped the moment the durable one lands.
    await waitFor(() => {
      const keys = [
        ...container.querySelectorAll(".star-map-card-shell[data-thread-key]"),
      ].map((shell) => (shell as HTMLElement).dataset.cardKey ?? "");
      expect(keys.length).toBe(3);
      expect(keys.every((key) => key.startsWith("pwr_local::"))).toBe(true);
    });

    const viewport = container.querySelector(".star-map__viewport");
    if (!(viewport instanceof HTMLElement)) throw new Error("no viewport");
    fireEvent.pointerDown(viewport, {
      button: 0,
      shiftKey: true,
      clientX: -4000,
      clientY: -4000,
    });
    fireEvent.pointerMove(window, { clientX: 4000, clientY: 4000 });
    fireEvent.pointerUp(window, { clientX: 4000, clientY: 4000 });

    await waitFor(() => {
      expect(
        container.querySelectorAll(".star-map-card-shell--selected"),
      ).toHaveLength(3);
    });
  });

  /**
   * A chat card says which thread it belongs to by the line to its card.
   * This lens drew none: the tether read the Instances lens's rect map,
   * which is empty by construction here, and then skipped the lens
   * outright. Five open chats over a field of project clouds and nothing
   * saying which cloud any of them came from.
   */
  it("tethers an open chat card to its thread card", async () => {
    const { container } = renderProjects([
      thread({ id: "a1", path: "/repo/alpha", label: "AlphaDir" }),
      thread({ id: "a2", path: "/repo/alpha", label: "AlphaDir" }),
    ]);
    await screen.findByRole("button", { name: /Open thread: Thread a1/ });
    // Re-query at click time: card measurement re-renders the map, and a
    // click on the detached node never reaches React's root listener.
    fireEvent.click(
      screen.getByRole("button", { name: /Open thread: Thread a1/ }),
    );

    await waitFor(() => {
      expect(container.querySelector(".star-map__tether")).not.toBeNull();
    });
    // One dot at each end, as in the Instances lens: a single anchor means
    // an endpoint stopped clearing its own card.
    expect(
      container.querySelectorAll(".star-map__tether-anchor"),
    ).toHaveLength(2);
  });

  /**
   * A chat card holds ONE rect, but the thread card it is tied to sits
   * somewhere completely different in each lens. Switching lens used to
   * leave the card at the other lens's coordinates — stranded over some
   * unrelated project's sky, which reads as "light years away from its
   * thread card".
   */
  it("carries an open chat card into the lens it switches to", async () => {
    // Four projects of four, so the canvas is wider than the offset the
    // card is carrying: `clampChatCardRect` pins a card that would land
    // off the canvas, and a fixture small enough to hit that clamp would
    // pass whether or not the rebase ran.
    const { container } = renderProjects(
      ["alpha", "beta", "gamma", "delta"].flatMap((name) =>
        Array.from({ length: 4 }, (unused, index) =>
          thread({
            id: `${name}${index}`,
            path: `/repo/${name}`,
            label: `${name}Dir`,
          }),
        ),
      ),
    );
    await screen.findByRole("button", { name: /Open thread: Thread alpha0/ });
    // Re-query at click time: card measurement re-renders the map, and a
    // click on the detached node never reaches React's root listener.
    fireEvent.click(
      screen.getByRole("button", { name: /Open thread: Thread alpha0/ }),
    );
    await waitFor(() => {
      expect(container.querySelector(".star-map-chat-card")).not.toBeNull();
    });

    const shellFor = (key: string) =>
      container.querySelector(
        `.star-map-card-shell[data-card-key="${key}"]`,
      ) as HTMLElement;
    const before = cardOrigin(shellFor("pwr_local::codex:alpha0"));
    const chatBefore = chatCardOrigin(container);
    const offset = {
      dx: chatBefore.x - before.x,
      dy: chatBefore.y - before.y,
    };

    fireEvent.click(screen.getByRole("button", { name: /^View$/ }));
    fireEvent.click(screen.getByRole("button", { name: "Instances" }));

    await waitFor(() => {
      expect(cardOrigin(shellFor("pwr_local::codex:alpha0"))).not.toEqual(
        before,
      );
    });
    await waitFor(() => {
      const after = cardOrigin(shellFor("pwr_local::codex:alpha0"));
      const chatAfter = chatCardOrigin(container);
      expect(chatAfter.x - after.x).toBeCloseTo(offset.dx, 5);
      expect(chatAfter.y - after.y).toBeCloseTo(offset.dy, 5);
    });
  });
  /**
   * The lens drew its cards and then refused to let the operator move
   * any of them: arrangement rows are keyed per federation instance and
   * a project is not one, so the drag was left off rather than shipped
   * writing to the Instances lens's rows.
   *
   * It writes to its OWN rows instead, still keyed by the instance that
   * owns the thread — so the offset merges, syncs and last-writer-wins
   * exactly like the one beside it.
   */
  it("drags a card and persists it in the lens's own rows", async () => {
    const writes: {
      instanceId: string;
      threadKey: string;
      dx: number | null;
      dy: number | null;
    }[] = [];
    const setStarMapCardPosition = vi.fn(async (entry: (typeof writes)[number]) => {
      writes.push(entry);
    });
    const { container } = renderProjects(
      [
        thread({ id: "a1", path: "/repo/alpha", label: "AlphaDir" }),
        thread({ id: "a2", path: "/repo/alpha", label: "AlphaDir" }),
        thread({ id: "a3", path: "/repo/alpha", label: "AlphaDir" }),
      ],
      { setStarMapCardPosition } as unknown as Partial<DesktopApi>,
    );
    await waitFor(() => {
      expect(projectSystems(container)[0]?.cards).toHaveLength(3);
    });

    const shell = container.querySelector(
      '.star-map-card-shell[data-card-key="pwr_local::codex:a1"]',
    ) as HTMLElement;
    const startLeft = Number.parseFloat(shell.style.left);
    const startTop = Number.parseFloat(shell.style.top);

    fireEvent.pointerDown(shell, { button: 0, clientX: 500, clientY: 400 });
    await act(async () => {
      fireEvent.pointerMove(window, { clientX: 640, clientY: 470 });
      await new Promise((resolve) =>
        requestAnimationFrame(() => resolve(null)),
      );
    });
    // It moves under the pointer while the gesture is live.
    expect(Number.parseFloat(shell.style.left) - startLeft).toBeCloseTo(140, 0);
    expect(Number.parseFloat(shell.style.top) - startTop).toBeCloseTo(70, 0);

    fireEvent.pointerUp(window, { clientX: 640, clientY: 470 });
    await waitFor(() => {
      expect(setStarMapCardPosition).toHaveBeenCalled();
    });
    // Owned by the instance that owns the thread, in this lens's own row.
    expect(writes[0].instanceId).toBe("pwr_local");
    expect(writes[0].threadKey).toBe("project:codex:a1");
    expect(writes[0].dx).not.toBeNull();
  });

  /**
   * The two radial lenses measure the same card's slot from different
   * bodies, so one row cannot serve both: an offset written here and read
   * back around the instance would move the card by the distance between
   * its project and its machine.
   */
  it("leaves the Instances lens's own offset alone", async () => {
    const entries = [
      {
        instanceId: "pwr_local",
        threadKey: "project:codex:a1",
        dx: 300,
        dy: 200,
        updatedAt: 1,
        by: "pwr_local",
      },
    ];
    const view = renderProjects(
      [
        thread({ id: "a1", path: "/repo/alpha", label: "AlphaDir" }),
        thread({ id: "a2", path: "/repo/alpha", label: "AlphaDir" }),
      ],
      {
        readStarMapArrangement: vi.fn(async () => ({ entries })),
      } as unknown as Partial<DesktopApi>,
    );

    // The Projects lens honours it...
    await waitFor(() => {
      const shell = view.container.querySelector(
        '.star-map-card-shell[data-card-key="pwr_local::codex:a1"]',
      ) as HTMLElement;
      expect(Number.parseFloat(shell.style.left)).toBeCloseTo(300, 0);
      expect(Number.parseFloat(shell.style.top)).toBeCloseTo(200, 0);
    });

    // ...and the Instances lens, reading `codex:a1` rather than
    // `project:codex:a1`, seats it exactly where it would sit with no
    // arrangement at all. Compared against that second render rather
    // than asserted as "not 300", which a lens ignoring every offset
    // would also satisfy.
    const instancesPosition = async (view: {
      container: HTMLElement;
      unmount: () => void;
    }) => {
      fireEvent.click(screen.getByRole("button", { name: /^View$/ }));
      fireEvent.click(screen.getByRole("button", { name: "Instances" }));
      let seat = { x: 0, y: 0 };
      await waitFor(() => {
        const shell = view.container.querySelector(
          '.star-map-card-shell[data-card-key="pwr_local::codex:a1"]',
        ) as HTMLElement;
        expect(shell).not.toBeNull();
        seat = {
          x: Number.parseFloat(shell.style.left),
          y: Number.parseFloat(shell.style.top),
        };
      });
      return seat;
    };
    const placed = await instancesPosition(view);
    view.unmount();

    const bare = renderProjects([
      thread({ id: "a1", path: "/repo/alpha", label: "AlphaDir" }),
      thread({ id: "a2", path: "/repo/alpha", label: "AlphaDir" }),
    ]);
    await waitFor(() => {
      expect(projectSystems(bare.container)[0]?.cards).toHaveLength(2);
    });
    const unplaced = await instancesPosition(bare);

    expect(placed.x).toBeCloseTo(unplaced.x, 5);
    expect(placed.y).toBeCloseTo(unplaced.y, 5);
  });

  /**
   * The second drag of an already-placed card must NOT re-express the
   * drop from its seat again: the stored offset is already measured from
   * the cloud's centre, so folding `seat - centre` in a second time would
   * fling the card by that distance on every drop after the first.
   */
  it("commits a second drag from the offset it already carries", async () => {
    const writes: {
      instanceId: string;
      threadKey: string;
      dx: number | null;
      dy: number | null;
    }[] = [];
    const { container } = renderProjects(
      [
        thread({ id: "a1", path: "/repo/alpha", label: "AlphaDir" }),
        thread({ id: "a2", path: "/repo/alpha", label: "AlphaDir" }),
        thread({ id: "a3", path: "/repo/alpha", label: "AlphaDir" }),
      ],
      {
        setStarMapCardPosition: vi.fn(
          async (entry: (typeof writes)[number]) => {
            writes.push(entry);
          },
        ),
      } as unknown as Partial<DesktopApi>,
    );
    await waitFor(() => {
      expect(projectSystems(container)[0]?.cards).toHaveLength(3);
    });
    const shellFor = () =>
      container.querySelector(
        '.star-map-card-shell[data-card-key="pwr_local::codex:a1"]',
      ) as HTMLElement;

    const drag = async (from: number, to: number) => {
      fireEvent.pointerDown(shellFor(), {
        button: 0,
        clientX: from,
        clientY: 300,
      });
      await act(async () => {
        fireEvent.pointerMove(window, { clientX: to, clientY: 300 });
        await new Promise((resolve) =>
          requestAnimationFrame(() => resolve(null)),
        );
      });
      fireEvent.pointerUp(window, { clientX: to, clientY: 300 });
    };

    await drag(500, 560);
    await waitFor(() => expect(writes).toHaveLength(1));
    const afterFirst = Number.parseFloat(shellFor().style.left);

    await drag(560, 600);
    await waitFor(() => expect(writes).toHaveLength(2));

    // 40px of pointer travel is 40px of stored offset, on top of the
    // first drag's. Re-expressing from the seat a second time would add
    // the seat's whole distance from the cloud centre instead.
    expect(writes[1].dx! - writes[0].dx!).toBeCloseTo(40, 0);
    expect(Number.parseFloat(shellFor().style.left) - afterFirst).toBeCloseTo(
      40,
      0,
    );
  });
  /**
   * "Reset position" has to mean the placement in FRONT of the operator.
   * It read the unscoped row, so in this lens it was missing for a card
   * dragged here — and, for a thread that also carried an Instances
   * offset, it appeared and silently reset that other lens instead.
   */
  it("resets the placement made in this lens, not the other one's", async () => {
    const writes: {
      instanceId: string;
      threadKey: string;
      dx: number | null;
      dy: number | null;
    }[] = [];
    const { container } = renderProjects(
      [
        thread({ id: "a1", path: "/repo/alpha", label: "AlphaDir" }),
        thread({ id: "a2", path: "/repo/alpha", label: "AlphaDir" }),
      ],
      {
        readStarMapArrangement: vi.fn(async () => ({
          entries: [
            {
              instanceId: "pwr_local",
              threadKey: "project:codex:a1",
              dx: 220,
              dy: 140,
              updatedAt: 1,
              by: "pwr_local",
            },
            // The SAME thread, placed in the other lens. Resetting from
            // here must not touch it.
            {
              instanceId: "pwr_local",
              threadKey: "codex:a1",
              dx: -900,
              dy: -700,
              updatedAt: 1,
              by: "pwr_local",
            },
          ],
        })),
        setStarMapCardPosition: vi.fn(
          async (entry: (typeof writes)[number]) => {
            writes.push(entry);
          },
        ),
      } as unknown as Partial<DesktopApi>,
    );

    // Wait for the arrangement read to land: the menu only offers the
    // reset once the card actually carries an offset.
    await waitFor(() => {
      const shell = container.querySelector(
        '.star-map-card-shell[data-card-key="pwr_local::codex:a1"]',
      ) as HTMLElement;
      expect(Number.parseFloat(shell.style.left)).toBeCloseTo(220, 0);
    });
    // Re-query at click time: card measurement re-renders the map.
    await screen.findByRole("button", { name: "Actions for Thread a1" });
    fireEvent.click(
      screen.getByRole("button", { name: "Actions for Thread a1" }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Reset position" }));

    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].threadKey).toBe("project:codex:a1");
    expect(writes[0].dx).toBeNull();
  });

  /**
   * A tether is drawn to a card's rect, and `flightRects` holds every
   * rect whether or not this zoom paints it — so past the overview
   * threshold, where neither radial lens draws a thread card, the line
   * and its anchor dot pointed into empty sky.
   */
  it("draws no tether at the zoom that draws no cards", async () => {
    const { container } = renderProjects([
      thread({ id: "a1", path: "/repo/alpha", label: "AlphaDir" }),
      thread({ id: "a2", path: "/repo/alpha", label: "AlphaDir" }),
    ]);
    await screen.findByRole("button", { name: /Open thread: Thread a1/ });
    fireEvent.click(
      screen.getByRole("button", { name: /Open thread: Thread a1/ }),
    );
    await waitFor(() => {
      expect(container.querySelector(".star-map__tether")).not.toBeNull();
    });

    // Zoom out past the overview threshold: the cards go, and so does
    // the line that pointed at one.
    const viewport = container.querySelector(".star-map__viewport")!;
    await waitFor(() => {
      fireEvent.wheel(viewport, {
        deltaY: 600,
        ctrlKey: true,
        clientX: 400,
        clientY: 300,
      });
      expect(container.querySelector(".star-map-card-shell")).toBeNull();
    });
    expect(container.querySelector(".star-map__tether")).toBeNull();
    expect(container.querySelector(".star-map__tether-anchor")).toBeNull();
  });
});
