import "./foreground-fixture";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

function renderProjects(threads: NavigationThreadSummary[]) {
  window.localStorage.setItem(
    "pwragent.starMap.viewPreferences",
    JSON.stringify({ layout: "projects" }),
  );
  return render(
    <StarMapScreen
      desktopApi={buildDesktopApi()}
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
});
