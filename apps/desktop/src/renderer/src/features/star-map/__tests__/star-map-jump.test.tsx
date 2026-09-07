import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NAVIGATION_QUERY_PROTOCOL_VERSION,
  type NavigationQueryRequest,
  type NavigationThreadSummary,
} from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { STAR_MAP_ESTIMATED_CARD_HEIGHT } from "../star-map-layout";
import { StarMapScreen } from "../StarMapScreen";

/** The viewport the screen assumes until a real measurement arrives. */
const VIEWPORT = { width: 1280, height: 800 };

function px(value: string | undefined): number {
  return Number.parseFloat(value ?? "0");
}

/**
 * ⌘K on the map: find a thread by name, and go to it.
 *
 * The map is the one surface where "the card is somewhere off to the left,
 * three clouds over" is a real answer, so the palette's job here is not to
 * scroll a list — it is to summon the card if the lens is not drawing one
 * and then fly the camera to it. Both halves are asserted; the geometry the
 * flight lands on is `star-map-flight.test.ts`.
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

function thread(
  id: string,
  title: string,
  overrides: Partial<NavigationThreadSummary> = {},
): NavigationThreadSummary {
  return {
    id,
    title,
    titleSource: "generated",
    linkedDirectories: [
      {
        id: "dir-1",
        label: "PwrSnap",
        path: "/tmp/pwrsnap",
        kind: "worktree",
      },
    ],
    source: "codex",
    inbox: { inInbox: true, reason: "updated-since-seen" },
    updatedAt: 100,
    ...overrides,
  } as unknown as NavigationThreadSummary;
}

/** A thread that matches no attention chip: seen, idle, no PR, nothing to push. */
function quietThread(id: string, title: string): NavigationThreadSummary {
  return thread(id, title, {
    inbox: { inInbox: false },
  } as Partial<NavigationThreadSummary>);
}

function renderMap(threads: NavigationThreadSummary[]) {
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

async function openPalette(): Promise<void> {
  fireEvent.keyDown(window, { key: "k", metaKey: true });
  await screen.findByRole("dialog", { name: "Fly to thread" });
}

function search(query: string): void {
  fireEvent.change(screen.getByRole("textbox", { name: "Fly to thread" }), {
    target: { value: query },
  });
}

/**
 * Pick a palette row. Scoped to the dialog: a thread already on the map
 * also has a card button carrying its title, and an unscoped query would
 * resolve to two elements — or worse, to the card, which is not what a
 * search result click is.
 */
async function pickResult(title: RegExp): Promise<void> {
  const palette = screen.getByRole("dialog", { name: "Fly to thread" });
  fireEvent.click(await within(palette).findByRole("button", { name: title }));
}

describe("Star Map ⌘K", () => {
  beforeEach(() => {
    // The flight animates over half a second of animation frames; under
    // reduced motion it lands in one commit, which is the state these
    // assertions are about. jsdom answers every media query with `false`.
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: query.includes("prefers-reduced-motion"),
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        onchange: null,
        dispatchEvent: () => false,
      })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.removeItem("pwragent.starMap.filterSelection");
    window.localStorage.removeItem("pwragent.starMap.viewPreferences");
  });

  it("opens on ⌘K and closes on a second press", async () => {
    renderMap([thread("t1", "Windows job wrapper")]);
    await openPalette();

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Fly to thread" }),
      ).toBeNull();
    });
  });

  it("flies the camera to the card the operator picked", async () => {
    const { container } = renderMap([
      thread("t1", "Windows job wrapper"),
      thread("t2", "Release notarization"),
    ]);
    await waitFor(() => {
      expect(container.querySelector(".star-map-card")).not.toBeNull();
    });
    const canvas = container.querySelector<HTMLElement>(".star-map__canvas");
    const before = canvas?.style.transform;

    await openPalette();
    search("notarization");
    await pickResult(/Release notarization/);

    await waitFor(() => {
      expect(canvas?.style.transform).not.toBe(before);
    });
    // The card is where the LAYOUT put it — the flight does not move cards,
    // so measuring the destination off the card's own position is measuring
    // the transform against something the feature did not choose.
    const shell = container.querySelector<HTMLElement>(
      '[data-thread-key="codex:t2"]',
    );
    const cloud = shell?.closest<HTMLElement>(".star-map__cloud");
    // Cards are centred on their slot horizontally (`marginLeft: -w/2`) and
    // hang from it vertically, so the middle of the card is half an
    // (unmeasured, therefore estimated) card down.
    const centerX = px(cloud?.style.left) + px(shell?.style.left);
    const centerY =
      px(cloud?.style.top)
      + px(shell?.style.top)
      + STAR_MAP_ESTIMATED_CARD_HEIGHT / 2;
    // Landing zoom is the readable one: below it the map stops drawing
    // cards, so an arrival at overview zoom would centre on empty sky.
    expect(canvas?.style.transform).toBe(
      `translate(${VIEWPORT.width / 2 - centerX}px, ${
        VIEWPORT.height / 2 - centerY
      }px) scale(1)`,
    );
    // And the card says it is the one that was asked for.
    await waitFor(() => {
      expect(
        container.querySelector(".star-map-card-shell--located"),
      ).not.toBeNull();
    });
  });

  it("plops a card onto the map when the filters were hiding its thread", async () => {
    // "Unread only" is a chip the operator set; the thread they then go
    // looking for by name is a seen one, so the lens is drawing no card for
    // it at all. A flight alone would land on sky.
    window.localStorage.setItem(
      "pwragent.starMap.filterSelection",
      JSON.stringify({ unread: "include" }),
    );
    const { container } = renderMap([
      thread("t1", "Windows job wrapper"),
      quietThread("t2", "Release notarization"),
    ]);
    await waitFor(() => {
      expect(container.querySelector(".star-map-card")).not.toBeNull();
    });
    expect(
      screen.queryByRole("button", { name: "Open thread: Release notarization" }),
    ).toBeNull();

    await openPalette();
    search("notarization");
    await pickResult(/Release notarization/);

    await waitFor(() => {
      expect(
        screen.queryByRole("button", {
          name: "Open thread: Release notarization",
        }),
      ).not.toBeNull();
    });
    // The chip itself is untouched: this is one card the operator asked for
    // by name, not a filter that quietly stopped applying.
    expect(
      screen.getByRole("button", { name: /^Attention: showing only these/ }),
    ).not.toBeNull();
    expect(
      screen.queryByRole("button", { name: "Open thread: Windows job wrapper" }),
    ).not.toBeNull();
  });

  it("keeps the summoned card on the map after the flight", async () => {
    window.localStorage.setItem(
      "pwragent.starMap.filterSelection",
      JSON.stringify({ unread: "include" }),
    );
    const { container, rerender } = renderMap([
      thread("t1", "Windows job wrapper"),
      quietThread("t2", "Release notarization"),
    ]);
    await waitFor(() => {
      expect(container.querySelector(".star-map-card")).not.toBeNull();
    });

    await openPalette();
    search("notarization");
    await pickResult(/Release notarization/);
    await screen.findByRole("button", {
      name: "Open thread: Release notarization",
    });

    // A later navigation snapshot must not take the card away again — the
    // summon is what keeps it, not the render that happened to follow it.
    rerender(
      <StarMapScreen
        desktopApi={buildDesktopApi()}
        localThreads={[
          thread("t1", "Windows job wrapper"),
          quietThread("t2", "Release notarization"),
          thread("t3", "Composer PR chips"),
        ]}
        sessionKeys={{}}
        localInstanceLabel="Mac-Mini-M4"
        onOpenLocalThread={() => undefined}
        onFocusLocalInstance={() => undefined}
      />,
    );
    await waitFor(() => {
      expect(
        screen.queryByRole("button", {
          name: "Open thread: Release notarization",
        }),
      ).not.toBeNull();
    });
  });

  it("flies to a peer's card without cloning it onto the local cloud", async () => {
    // A card key names its OWNING instance, and the owner of a search hit
    // is not always the instance the picker happens to be sitting on: this
    // thread lives on pwr_remote, so its card is keyed pwr_remote::codex:r1
    // while the pick knows only the thread. Resolving the card key from the
    // local instance instead would miss the card that is already on the map
    // — and then summon a duplicate of it under the local cloud.
    const remoteThread = thread("r1", "Remote work", {
      federation: {
        instanceLabel: "Remote",
        ref: {
          backend: "codex",
          threadId: "r1",
          target: { scope: "remote", instanceId: "pwr_remote" },
        },
      },
    });
    const desktopApi = {
      readFederationHealth: vi.fn(async () => ({
        health: {
          enabled: true,
          role: "gateway",
          status: "listening",
          instanceId: "pwr_local",
          localCelestialIcon: "sun",
          localLabel: "Harold-MBP-M5-Max",
          localProfileName: "default",
          peers: [
            {
              id: "pwr_remote",
              label: "Remote",
              role: "client",
              status: "connected",
              capabilities: ["thread_navigation"],
              navigationQueryProtocol: NAVIGATION_QUERY_PROTOCOL_VERSION,
            },
          ],
        },
      })),
      getNavigationQueryPage: vi.fn(async (request: NavigationQueryRequest) => ({
        protocol: NAVIGATION_QUERY_PROTOCOL_VERSION,
        queryKey: request.query.kind,
        generation: `pwr_remote-${request.query.kind}`,
        ownerEpoch: "pwr_remote-epoch",
        countsRevision: "pwr_remote-revision",
        coverage: { state: "complete" as const },
        counts: { total: 1, active: 0, unread: 1, review: 1 },
        entries: request.query.kind === "star-map-geometry"
          ? []
          : [{
              row: {
                ...remoteThread,
                ref: {
                  backend: "codex" as const,
                  threadId: "r1",
                  ownerInstanceId: "pwr_remote",
                },
                rowRevision: "remote-r1",
                ordinaryChildCount: 0,
                nativeSubAgentGroupPresent: false,
                queueCount: 0,
                queueState: "unknown" as const,
              },
              orderKey: "0000000000",
              placement: { kind: "root" as const },
            }],
        directories: [],
        complete: true,
      })),
      onAgentEvent: vi.fn(() => () => undefined),
    } as unknown as DesktopApi;

    const { container } = render(
      <StarMapScreen
        desktopApi={desktopApi}
        localThreads={[thread("t1", "Windows job wrapper")]}
        sessionKeys={{}}
        localInstanceLabel="Mac-Mini-M4"
        onOpenLocalThread={() => undefined}
        onFocusLocalInstance={() => undefined}
      />,
    );
    await screen.findByRole("button", { name: "Open thread: Remote work" });
    const canvas = container.querySelector<HTMLElement>(".star-map__canvas");
    const before = canvas?.style.transform;

    await openPalette();
    search("Remote work");
    await pickResult(/Remote work/);

    await waitFor(() => {
      expect(canvas?.style.transform).not.toBe(before);
    });
    // Exactly one card: the peer's, not a summoned copy beside it.
    expect(
      screen.getAllByRole("button", { name: "Open thread: Remote work" }),
    ).toHaveLength(1);
  });

  it("offers the palette to the pointer as well as the keyboard", async () => {
    renderMap([thread("t1", "Windows job wrapper")]);
    fireEvent.click(
      screen.getByRole("button", { name: "Find a thread on the map" }),
    );
    await screen.findByRole("dialog", { name: "Fly to thread" });
  });
});
