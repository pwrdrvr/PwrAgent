import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  FederationPeerSummary,
  NavigationThreadSummary,
} from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { StarMapScreen } from "../StarMapScreen";

/**
 * The map must not tour itself while it loads.
 *
 * A fleet arrives in pieces: health lands, peers enrol one at a time, each
 * one's navigation snapshot arrives on its own round trip, and the real
 * height of every card lands later still as the browser measures it. Every
 * one of those resizes the canvas — and the canvas was what the opening
 * view was placed against, so the map re-centred on a moving target over
 * and over before the fleet had finished arriving. Opening the Star Map
 * looked like it was flying itself somewhere.
 *
 * The rule here: the map opens on the home cluster, and that cluster does
 * not move on screen while the canvas grows around it.
 */

const VIEWPORT = { width: 1280, height: 800 };

function peer(id: string): FederationPeerSummary {
  return {
    id,
    label: id,
    status: "connected",
    capabilities: ["thread_navigation"],
  } as unknown as FederationPeerSummary;
}

type LoadingFleet = {
  desktopApi: DesktopApi;
  /** Enrol another peer, the way a real one arrives: health, then event. */
  announce: (peerId: string) => Promise<void>;
};

/**
 * A fleet that arrives over time rather than all at once.
 *
 * Peers land through the same path the app uses — a `peerStatus/changed`
 * notification, then a re-read of health — because that is what makes the
 * canvas grow in stages, which is the whole subject of these tests.
 */
function buildLoadingFleet(
  threadsByPeer: Map<string, NavigationThreadSummary[]>,
): LoadingFleet {
  const peers: FederationPeerSummary[] = [];
  const listeners = new Set<(event: { notification: { method: string } }) => void>();
  const desktopApi = {
    readFederationHealth: vi.fn(async () => ({
      health: {
        enabled: true,
        role: "gateway" as const,
        status: "listening" as const,
        instanceId: "pwr_local",
        localCelestialIcon: "sun" as const,
        localLabel: "Harold-MBP-M5-Max",
        localProfileName: "default",
        peers: [...peers],
      },
    })),
    getNavigationSnapshot: vi.fn(
      async (request: { federationTarget: { instanceId: string } }) => ({
        threads:
          threadsByPeer.get(request.federationTarget.instanceId) ?? [],
      }),
    ),
    onAgentEvent: vi.fn((listener: (event: { notification: { method: string } }) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
  } as unknown as DesktopApi;

  return {
    desktopApi,
    announce: async (peerId: string) => {
      peers.push(peer(peerId));
      await act(async () => {
        for (const listener of listeners) {
          listener({ notification: { method: "federation/peerStatus/changed" } });
        }
        await Promise.resolve();
      });
      await settle();
    },
  };
}

function thread(id: string, project: string): NavigationThreadSummary {
  return {
    id,
    title: `Thread ${id}`,
    titleSource: "generated",
    linkedDirectories: [
      {
        id: `${project}-dir`,
        label: project,
        path: `/repos/${project}`,
        kind: "local",
      },
    ],
    source: "codex",
    inbox: { inInbox: true, reason: "updated-since-seen" },
    updatedAt: 100,
  } as unknown as NavigationThreadSummary;
}

function threads(
  count: number,
  project: string,
  prefix: string,
): NavigationThreadSummary[] {
  return Array.from({ length: count }, (_, index) =>
    thread(`${prefix}${index}`, project),
  );
}

function parseTransform(raw: string): { x: number; y: number; scale: number } {
  const match = /translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/.exec(
    raw,
  );
  if (!match) throw new Error(`unparsable transform: ${raw}`);
  return { x: Number(match[1]), y: Number(match[2]), scale: Number(match[3]) };
}

/**
 * Where the local instance's body lands in the window, in viewport pixels.
 *
 * Composed the way the operator sees it: the body's canvas position put
 * through the canvas transform. Asserting on the transform alone would
 * agree with the bug — a view chasing a moving anchor and a view holding a
 * still one both change — and asserting on the body's canvas position
 * alone would too, since content moving inside a growing canvas is exactly
 * what is supposed to happen. Only the composition tells them apart.
 */
function homeBodyScreenPosition(): { x: number; y: number } {
  const canvas = document.querySelector(".star-map__canvas") as HTMLElement;
  if (!canvas) throw new Error("canvas not found");
  const view = parseTransform(canvas.style.transform);
  const body = document.querySelector(".star-map-instance--local");
  const anchor = body?.closest(".star-map__anchor") as HTMLElement | null;
  if (!anchor) throw new Error("local instance body not on the map");
  return {
    x: view.x + Number.parseFloat(anchor.style.left) * view.scale,
    y: view.y + Number.parseFloat(anchor.style.top) * view.scale,
  };
}

/**
 * Where a project's cloud lands in the window, in viewport pixels.
 *
 * Composed the same way `homeBodyScreenPosition` is, and for the same
 * reason: the projects lens normalises its canvas around whatever it has
 * seated, so a project's own canvas position moves on every snapshot and
 * neither half of the composition means anything on its own.
 */
function projectCloudScreenPosition(label: string): { x: number; y: number } {
  const canvas = document.querySelector(".star-map__canvas") as HTMLElement;
  if (!canvas) throw new Error("canvas not found");
  const view = parseTransform(canvas.style.transform);
  const name = [...document.querySelectorAll(".star-map-project__name")].find(
    (node) => node.textContent === label,
  );
  const cloud = name?.closest(".star-map__project-cloud") as HTMLElement | null;
  if (!cloud) throw new Error(`project not on the map: ${label}`);
  return {
    x: view.x + Number.parseFloat(cloud.style.left) * view.scale,
    y: view.y + Number.parseFloat(cloud.style.top) * view.scale,
  };
}

/** Let pending snapshots, measurements and placements settle. */
async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
}

function renderMap(props: {
  desktopApi: DesktopApi;
  localThreads: NavigationThreadSummary[];
}) {
  return (
    <StarMapScreen
      desktopApi={props.desktopApi}
      localThreads={props.localThreads}
      sessionKeys={{}}
      localInstanceLabel="Mac-Mini-M4"
      onOpenLocalThread={() => undefined}
      onFocusLocalInstance={() => undefined}
    />
  );
}

function seedLayout(layout: "lanes" | "orbit" | "projects") {
  window.localStorage.setItem(
    "pwragent.starMap.viewPreferences",
    JSON.stringify({ layout }),
  );
}

async function openMap(fleet: LoadingFleet) {
  const rendered = render(
    renderMap({ desktopApi: fleet.desktopApi, localThreads: [] }),
  );
  await waitFor(() => {
    expect(
      screen.getAllByRole("button", { name: /Open this instance/ }).length,
    ).toBeGreaterThan(0);
  });
  await settle();
  return rendered;
}

/**
 * Open straight into the projects lens.
 *
 * Unlike the instance lenses, this one draws nothing at all until some
 * thread has a project to pool into, so it opens with this machine's own
 * threads already in hand rather than with an empty feed.
 */
async function openProjectsMap(
  fleet: LoadingFleet,
  localThreads: NavigationThreadSummary[],
) {
  const rendered = render(
    renderMap({ desktopApi: fleet.desktopApi, localThreads }),
  );
  await waitFor(() => {
    expect(document.querySelector(".star-map__project-cloud")).toBeTruthy();
  });
  await settle();
  return rendered;
}

function fleetThreads() {
  return new Map([
    ["pwr_a", threads(12, "Alpha", "a")],
    ["pwr_b", threads(9, "Beta", "b")],
    ["pwr_c", threads(17, "Gamma", "c")],
  ]);
}

describe("star map load drift", () => {
  // Layout preference is global; leaking it reorders unrelated suites.
  afterEach(() => {
    window.localStorage.removeItem("pwragent.starMap.viewPreferences");
    window.localStorage.removeItem("pwragent.starMap.filterSelection");
  });

  it("opens on the home cluster rather than on the middle of the canvas", async () => {
    seedLayout("orbit");
    const fleet = buildLoadingFleet(fleetThreads());
    await openMap(fleet);
    // One peer is enough to pull the canvas's middle away from the hub:
    // children seat on a jittered ring, so the bounding box grows further
    // on one side than the other.
    await fleet.announce("pwr_a");

    expect(homeBodyScreenPosition()).toEqual({
      x: VIEWPORT.width / 2,
      y: VIEWPORT.height / 2,
    });
  });

  it("holds the home cluster still while the fleet loads (orbit)", async () => {
    seedLayout("orbit");
    const fleet = buildLoadingFleet(fleetThreads());
    const { rerender } = await openMap(fleet);
    const opened = homeBodyScreenPosition();

    // Peers enrol one at a time, each answering with its own thread feed.
    for (const peerId of ["pwr_a", "pwr_b", "pwr_c"]) {
      await fleet.announce(peerId);
      expect(homeBodyScreenPosition()).toEqual(opened);
    }

    // Then this machine's own threads land, which grows its cloud and
    // pushes every peer further out again.
    rerender(
      renderMap({
        desktopApi: fleet.desktopApi,
        localThreads: threads(14, "PwrSnap", "l"),
      }),
    );
    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: /Open thread: Thread l0/ }),
      ).toBeTruthy();
    });
    await settle();

    expect(homeBodyScreenPosition()).toEqual(opened);
  });

  it("opens on the heaviest project", async () => {
    seedLayout("projects");
    const fleet = buildLoadingFleet(fleetThreads());
    // This machine's own project is the biggest one on the map until a
    // peer's snapshot says otherwise.
    await openProjectsMap(fleet, threads(14, "PwrSnap", "l"));
    await fleet.announce("pwr_a");

    // Not merely on the middle of the canvas, which is the bounding box of
    // whatever has been laid out so far and moves as the fleet arrives.
    expect(projectCloudScreenPosition("PwrSnap")).toEqual({
      x: VIEWPORT.width / 2,
      y: VIEWPORT.height / 2,
    });
  });

  it("holds the anchored project still while the fleet loads (projects)", async () => {
    seedLayout("projects");
    const fleet = buildLoadingFleet(fleetThreads());
    await openProjectsMap(fleet, threads(14, "PwrSnap", "l"));
    const opened = projectCloudScreenPosition("PwrSnap");

    // Each peer pools its threads into a project of its own, and every
    // project already seated is re-seated around the new mass spread — a
    // canvas resize on each snapshot, from a different bounding box.
    for (const peerId of ["pwr_a", "pwr_b"]) {
      await fleet.announce(peerId);
      expect(projectCloudScreenPosition("PwrSnap")).toEqual(opened);
    }
  });

  it("hands the first seat to a heavier project without moving the map", async () => {
    seedLayout("projects");
    const fleet = buildLoadingFleet(fleetThreads());
    await openProjectsMap(fleet, threads(14, "PwrSnap", "l"));
    const seat = projectCloudScreenPosition("PwrSnap");

    // Gamma is bigger than this machine's own project, so it takes the
    // first seat the moment its snapshot lands. The map still holds: the
    // seat is the core itself, so the new occupant lands exactly where the
    // old one sat. This is why the anchor re-reads the seat rather than
    // latching onto the project that opened on it — a latch would ride
    // PwrSnap outward and drag the whole map after it.
    await fleet.announce("pwr_c");

    expect(projectCloudScreenPosition("Gamma")).toEqual(seat);
  });

  it("holds the home cluster still while the fleet loads (lanes)", async () => {
    seedLayout("lanes");
    const fleet = buildLoadingFleet(fleetThreads());
    await openMap(fleet);
    const opened = homeBodyScreenPosition();

    // Lanes re-order their row around the hub as instances arrive, so each
    // peer shifts every body's canvas position by half a lane.
    for (const peerId of ["pwr_a", "pwr_b", "pwr_c"]) {
      await fleet.announce(peerId);
      expect(homeBodyScreenPosition()).toEqual(opened);
    }
  });
});
