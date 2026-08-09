import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { StarMapScreen } from "../StarMapScreen";

/**
 * The whole card for a thread, given its open-thread button.
 *
 * The button is only the heading line: the chip flow is its SIBLING inside
 * `.star-map-card`, because chips carry buttons of their own and a button
 * inside a button is invalid (see StarMapThreadCard). Assertions about
 * chips have to scope to the card, not to the button.
 */
function starMapCard(openButton: HTMLElement): HTMLElement {
  const card = openButton.closest(".star-map-card");
  if (!(card instanceof HTMLElement)) {
    throw new Error(
      "Expected the open-thread button to sit inside .star-map-card",
    );
  }
  return card;
}

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

function unreadThread(id: string): NavigationThreadSummary {
  return {
    id,
    title: `Thread ${id}`,
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
  } as unknown as NavigationThreadSummary;
}

function seedLayout(layout: "lanes" | "orbit" | "projects") {
  window.localStorage.setItem(
    "pwragent.starMap.viewPreferences",
    JSON.stringify({ layout }),
  );
}

describe("StarMapScreen", () => {
  // Filter selection and view preferences both persist to localStorage,
  // so without this a test that clicks a chip silently changes the
  // starting state of every test after it.
  afterEach(() => {
    window.localStorage.removeItem("pwragent.starMap.filterSelection");
    window.localStorage.removeItem("pwragent.starMap.viewPreferences");
    window.localStorage.removeItem("pwragent.starMap.filters");
  });

  it("writes load-card membership into the synced arrangement", async () => {
    const setStarMapCardPosition = vi.fn(async () => ({ entries: [] }));
    const desktopApi: DesktopApi = {
      ...buildDesktopApi(),
      readStarMapArrangement: vi.fn(async () => ({ entries: [] })),
      setStarMapCardPosition,
      readFederationInstanceLoad: vi.fn(async () => ({})),
    };
    render(
      <StarMapScreen
        desktopApi={desktopApi}
        localThreads={[]}
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
        screen.queryByRole("button", { name: /^Show load for/ }),
      ).not.toBeNull();
    });
    // Re-query at click time: card measurement re-renders the map, and a node
    // captured by an earlier waitFor can already be detached.
    fireEvent.click(screen.getByRole("button", { name: /^Show load for/ }));

    // Membership IS the arrangement entry, which is what carries the card to
    // every other instance in the fleet.
    await waitFor(() => {
      expect(setStarMapCardPosition).toHaveBeenCalledWith({
        instanceId: "pwr_local",
        threadKey: "system:load",
        dx: 0,
        dy: 0,
      });
    });
  });

  it("renders a load card for an instance the arrangement already places one on", async () => {
    const desktopApi: DesktopApi = {
      ...buildDesktopApi(),
      readStarMapArrangement: vi.fn(async () => ({
        entries: [
          {
            instanceId: "pwr_local",
            threadKey: "system:load",
            dx: 0,
            dy: 0,
            updatedAt: 10,
            by: "pwr_other",
          },
        ],
      })),
      setStarMapCardPosition: vi.fn(async () => ({ entries: [] })),
      readFederationInstanceLoad: vi.fn(async () => ({
        load: {
          loadAvg1: 6.5,
          loadAvg5: 5,
          loadAvg15: 4.25,
          availableMemoryBytes: 2_147_483_648,
          diskFreeBytes: 107_374_182_400,
          sampledAt: Date.now(),
        },
      })),
    };
    const { container } = render(
      <StarMapScreen
        desktopApi={desktopApi}
        localThreads={[unreadThread("t1")]}
        sessionKeys={{}}
        localInstanceLabel="Mac-Mini-M4"
        floating={false}
        onClose={() => undefined}
        onOpenLocalThread={() => undefined}
        onFocusLocalInstance={() => undefined}
      />,
    );

    // An entry written by another instance ("by: pwr_other") is enough: the
    // fleet shares one map, so the card is here without a local click.
    await waitFor(() => {
      expect(container.querySelector(".star-map-load-card")).not.toBeNull();
    });
    await waitFor(() => {
      expect(container.textContent).toContain("6.50");
    });
    expect(container.textContent).toContain("2.0 GB");
    expect(
      screen.getByRole("button", { name: /^Hide load for/ }),
    ).toBeTruthy();
  });

  // Both lenses place the load card themselves, so a membership check
  // present in one and missing in the other is invisible to a single-lens
  // test — which is exactly how the orbit lens shipped a card that could
  // not be dismissed while its toggle flipped happily.
  for (const layout of ["lanes", "orbit"] as const) {
    it(`removes the load card for good when dismissed (${layout})`, async () => {
      seedLayout(layout);
      const setStarMapCardPosition = vi.fn(async () => ({ entries: [] }));
      const desktopApi: DesktopApi = {
        ...buildDesktopApi(),
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
        setStarMapCardPosition,
        readFederationInstanceLoad: vi.fn(async () => ({})),
      };
      const { container } = render(
        <StarMapScreen
          desktopApi={desktopApi}
          localThreads={[unreadThread("t1")]}
          sessionKeys={{}}
          localInstanceLabel="Mac-Mini-M4"
          floating={false}
          onClose={() => undefined}
          onOpenLocalThread={() => undefined}
          onFocusLocalInstance={() => undefined}
        />,
      );
      await waitFor(() => {
        expect(container.querySelector(".star-map-load-card")).not.toBeNull();
      });

      fireEvent.click(
        screen.getByRole("button", { name: /^Remove load card/ }),
      );

      await waitFor(() => {
        expect(container.querySelector(".star-map-load-card")).toBeNull();
      });
      // The toggle and the card must agree: both read the same membership.
      expect(
        screen.getByRole("button", { name: /^Show load for/ }).getAttribute(
          "aria-pressed",
        ),
      ).toBe("false");
      expect(setStarMapCardPosition).toHaveBeenCalledWith({
        instanceId: "pwr_local",
        threadKey: "system:load",
        dx: null,
        dy: null,
      });
    });
  }

  it("removes the load card for good when dismissed", async () => {
    const setStarMapCardPosition = vi.fn(async () => ({ entries: [] }));
    let emit: ((event: unknown) => void) | undefined;
    const desktopApi: DesktopApi = {
      ...buildDesktopApi(),
      onAgentEvent: vi.fn((listener: (event: unknown) => void) => {
        emit = listener;
        return () => undefined;
      }),
      readStarMapArrangement: vi.fn(async () => ({
        entries: [
          {
            instanceId: "pwr_local",
            threadKey: "system:load",
            dx: 30,
            dy: 40,
            updatedAt: 10,
            by: "pwr_local",
          },
        ],
      })),
      setStarMapCardPosition,
      readFederationInstanceLoad: vi.fn(async () => ({})),
    } as unknown as DesktopApi;
    const { container } = render(
      <StarMapScreen
        desktopApi={desktopApi}
        localThreads={[]}
        sessionKeys={{}}
        localInstanceLabel="Mac-Mini-M4"
        floating={false}
        onClose={() => undefined}
        onOpenLocalThread={() => undefined}
        onFocusLocalInstance={() => undefined}
      />,
    );
    await waitFor(() => {
      expect(container.querySelector(".star-map-load-card")).not.toBeNull();
    });

    fireEvent.click(
      screen.getByRole("button", { name: /^Remove load card/ }),
    );

    // Dismiss must UNPLACE the card, not merely clear its drag offset —
    // otherwise it reappears at its default spot, which is the one place a
    // dragged-away card was moved to escape.
    await waitFor(() => {
      expect(container.querySelector(".star-map-load-card")).toBeNull();
    });
    expect(setStarMapCardPosition).toHaveBeenCalledWith({
      instanceId: "pwr_local",
      threadKey: "system:load",
      dx: null,
      dy: null,
    });

    // And it stays gone once the durable tombstone echoes back off the bus.
    emit?.({
      notification: {
        method: "starMap/arrangement/changed",
        params: {
          entries: [
            {
              instanceId: "pwr_local",
              threadKey: "system:load",
              dx: null,
              dy: null,
              updatedAt: 20,
              by: "pwr_local",
            },
          ],
        },
      },
    });
    await waitFor(() => {
      expect(container.querySelector(".star-map-load-card")).toBeNull();
    });
  });

  it("keeps a dragged load card's position across close and reopen", async () => {
    const setStarMapCardPosition = vi.fn(async () => ({ entries: [] }));
    const desktopApi: DesktopApi = {
      ...buildDesktopApi(),
      readStarMapArrangement: vi.fn(async () => ({
        entries: [
          // Shown...
          {
            instanceId: "pwr_local",
            threadKey: "system:load",
            dx: 0,
            dy: 0,
            updatedAt: 10,
            by: "pwr_local",
          },
          // ...and dragged well away from its default spot.
          {
            instanceId: "pwr_local",
            threadKey: "system:load:position",
            dx: -120,
            dy: 260,
            updatedAt: 10,
            by: "pwr_local",
          },
        ],
      })),
      setStarMapCardPosition,
      readFederationInstanceLoad: vi.fn(async () => ({})),
    };
    const { container } = render(
      <StarMapScreen
        desktopApi={desktopApi}
        localThreads={[]}
        sessionKeys={{}}
        localInstanceLabel="Mac-Mini-M4"
        floating={false}
        onClose={() => undefined}
        onOpenLocalThread={() => undefined}
        onFocusLocalInstance={() => undefined}
      />,
    );
    const shell = async () =>
      await waitFor(() => {
        const node = container.querySelector<HTMLElement>(
          ".star-map-load-shell",
        );
        if (!node) throw new Error("no load card");
        return node;
      });

    const placed = await shell();
    const left = placed.style.left;
    const top = placed.style.top;
    expect(left).not.toBe("0px");

    fireEvent.click(screen.getByRole("button", { name: /^Remove load card/ }));
    await waitFor(() => {
      expect(container.querySelector(".star-map-load-shell")).toBeNull();
    });
    // Closing writes ONLY the membership key. Position lives under its own
    // key, so a close cannot forget where the operator put the card.
    expect(setStarMapCardPosition).toHaveBeenCalledWith({
      instanceId: "pwr_local",
      threadKey: "system:load",
      dx: null,
      dy: null,
    });
    expect(setStarMapCardPosition).not.toHaveBeenCalledWith(
      expect.objectContaining({ threadKey: "system:load:position" }),
    );

    fireEvent.click(screen.getByRole("button", { name: /^Show load for/ }));
    const reopened = await shell();
    expect(reopened.style.left).toBe(left);
    expect(reopened.style.top).toBe(top);
  });

  it("paints the load card above the thread cards it sits among", async () => {
    const desktopApi: DesktopApi = {
      ...buildDesktopApi(),
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
    };
    const { container } = render(
      <StarMapScreen
        desktopApi={desktopApi}
        localThreads={[unreadThread("t1"), unreadThread("t2")]}
        sessionKeys={{}}
        localInstanceLabel="Mac-Mini-M4"
        floating={false}
        onClose={() => undefined}
        onOpenLocalThread={() => undefined}
        onFocusLocalInstance={() => undefined}
      />,
    );

    const load = await waitFor(() => {
      const node = container.querySelector<HTMLElement>(".star-map-load-shell");
      if (!node) throw new Error("no load card");
      return node;
    });
    const threadZ = [
      ...container.querySelectorAll<HTMLElement>(".star-map-card-shell"),
    ]
      .filter((shell) => shell.dataset.threadKey)
      .map((shell) => Number(shell.style.zIndex));

    // An operator-summoned readout hiding behind a thread card reads as a
    // broken button, so it outranks every card in its cloud.
    expect(threadZ.length).toBeGreaterThan(0);
    expect(Number(load.style.zIndex)).toBeGreaterThan(Math.max(...threadZ));
  });

  it("puts the load card in the same selection and snapping geometry as threads", async () => {
    const setStarMapCardPosition = vi.fn(async () => ({ entries: [] }));
    const desktopApi: DesktopApi = {
      ...buildDesktopApi(),
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
      setStarMapCardPosition,
      readFederationInstanceLoad: vi.fn(async () => ({})),
    };
    const { container } = render(
      <StarMapScreen
        desktopApi={desktopApi}
        localThreads={[unreadThread("t1"), unreadThread("t2")]}
        sessionKeys={{}}
        localInstanceLabel="Mac-Mini-M4"
        floating={false}
        onClose={() => undefined}
        onOpenLocalThread={() => undefined}
        onFocusLocalInstance={() => undefined}
      />,
    );
    const loadShell = await waitFor(() => {
      const node = container.querySelector<HTMLElement>(".star-map-load-shell");
      if (!node) throw new Error("no load card");
      return node;
    });

    // It is placed by hand like any other card, so it carries a card key —
    // which is what puts it in `cardRects` (a snap target and guide source)
    // and lets the shared group-move find its element.
    expect(loadShell.dataset.cardKey).toBe("pwr_local::system:load:position");

    // A marquee over the whole cloud sweeps it up with the threads.
    fireEvent.pointerDown(
      container.querySelector(".star-map__viewport")!,
      { button: 0, shiftKey: true, clientX: -4000, clientY: -4000 },
    );
    fireEvent.pointerMove(window, { clientX: 4000, clientY: 4000 });
    fireEvent.pointerUp(window, { clientX: 4000, clientY: 4000 });

    await waitFor(() => {
      expect(
        container.querySelector(
          ".star-map-load-shell.star-map-card-shell--selected",
        ),
      ).not.toBeNull();
    });
  });

  it("does not move a single thread card when the load card opens", async () => {
    const setStarMapCardPosition = vi.fn(async () => ({ entries: [] }));
    const desktopApi: DesktopApi = {
      ...buildDesktopApi(),
      readStarMapArrangement: vi.fn(async () => ({ entries: [] })),
      setStarMapCardPosition,
      readFederationInstanceLoad: vi.fn(async () => ({})),
    };
    const { container } = render(
      <StarMapScreen
        desktopApi={desktopApi}
        localThreads={[unreadThread("t1"), unreadThread("t2")]}
        sessionKeys={{}}
        localInstanceLabel="Mac-Mini-M4"
        floating={false}
        onClose={() => undefined}
        onOpenLocalThread={() => undefined}
        onFocusLocalInstance={() => undefined}
      />,
    );

    const cardPositions = () =>
      [...container.querySelectorAll<HTMLElement>(".star-map-card-shell")]
        .filter((shell) => shell.dataset.threadKey)
        .map((shell) => `${shell.dataset.threadKey}@${shell.style.top}`);

    await waitFor(() => {
      expect(cardPositions().length).toBe(2);
    });
    const before = cardPositions();

    fireEvent.click(screen.getByRole("button", { name: /^Show load for/ }));
    await waitFor(() => {
      expect(container.querySelector(".star-map-load-card")).not.toBeNull();
    });

    // The load card appends below the column instead of taking the slot
    // nearest the star. Card offsets are stored RELATIVE to a slot, so a
    // shifting slot would drag hand-placed cards with it — reflow here is a
    // data-integrity problem, not a cosmetic one.
    expect(cardPositions()).toEqual(before);
  });

  // Mirrors the sidebar row's invariant (see thread-row-chips.test.tsx):
  // the chips carry real buttons, so nesting them inside the card's own
  // button is `nested-interactive` — invalid and unoperable.
  it("keeps the chip flow OUTSIDE the open-thread button", async () => {
    const { container } = render(
      <StarMapScreen
        desktopApi={buildDesktopApi()}
        localThreads={[unreadThread("t1")]}
        sessionKeys={{}}
        localInstanceLabel="Mac-Mini-M4"
        floating={false}
        onClose={() => undefined}
        onOpenLocalThread={() => undefined}
        onFocusLocalInstance={() => undefined}
      />,
    );
    await waitFor(() => {
      expect(container.querySelector(".star-map-card__open")).not.toBeNull();
    });
    const openButton = container.querySelector(".star-map-card__open")!;
    const flow = container.querySelector(".star-map-card__chips");
    expect(flow).not.toBeNull();
    expect(openButton.tagName).toBe("BUTTON");
    expect(openButton.contains(flow)).toBe(false);
    expect(
      openButton.querySelector('button, a, [tabindex], [role="button"]'),
    ).toBeNull();
  });

  it("renders the single-instance map with attention cards sans Local/Worktree labels", async () => {
    const desktopApi = buildDesktopApi();
    const onOpenLocalThread = vi.fn();
    render(
      <StarMapScreen
        desktopApi={desktopApi}
        localThreads={[unreadThread("t1")]}
        sessionKeys={{}}
        localInstanceLabel="Mac-Mini-M4"
        floating={false}
        onClose={() => undefined}
        onOpenLocalThread={onOpenLocalThread}
        onFocusLocalInstance={() => undefined}
      />,
    );

    expect(screen.getByRole("region", { name: "Star Map" })).toBeTruthy();
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Open this instance \(Mac-Mini-M4\)/ }),
      ).toBeTruthy();
    });

    const card = screen.getByRole("button", { name: /Open thread: Thread t1/ });
    const cardBody = starMapCard(card);
    expect(cardBody.textContent).toContain("PwrSnap");
    expect(cardBody.textContent).not.toMatch(/local/i);
    expect(cardBody.textContent).not.toMatch(/worktree/i);

    // Clicking a card floats a chat card over the map rather than
    // navigating away from it; the full thread view is one click further,
    // behind the card's own Open button.
    fireEvent.click(card);
    const chat = await screen.findByRole("region", {
      name: "Chat: Thread t1",
    });
    expect(onOpenLocalThread).not.toHaveBeenCalled();

    fireEvent.click(
      within(chat).getByRole("button", {
        name: /Open Thread t1 in the full thread view/,
      }),
    );
    expect(onOpenLocalThread).toHaveBeenCalledTimes(1);
  });

  it("raises an already-open chat card instead of stacking a duplicate", async () => {
    render(
      <StarMapScreen
        desktopApi={buildDesktopApi()}
        localThreads={[unreadThread("t1")]}
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
        screen.getByRole("button", { name: /Open this instance \(Mac-Mini-M4\)/ }),
      ).toBeTruthy();
    });
    const card = screen.getByRole("button", { name: /Open thread: Thread t1/ });
    fireEvent.click(card);
    await screen.findByRole("region", { name: "Chat: Thread t1" });
    fireEvent.click(card);

    expect(
      screen.getAllByRole("region", { name: "Chat: Thread t1" }),
    ).toHaveLength(1);
  });

  it("closes a chat card from its close button", async () => {
    render(
      <StarMapScreen
        desktopApi={buildDesktopApi()}
        localThreads={[unreadThread("t1")]}
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
        screen.getByRole("button", { name: /Open this instance \(Mac-Mini-M4\)/ }),
      ).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: /Open thread: Thread t1/ }));
    const chat = await screen.findByRole("region", { name: "Chat: Thread t1" });
    fireEvent.click(
      within(chat).getByRole("button", { name: "Close chat: Thread t1" }),
    );

    await waitFor(() => {
      expect(
        screen.queryByRole("region", { name: "Chat: Thread t1" }),
      ).toBeNull();
    });
  });

  it("cycles a filter chip neutral -> only -> exclude", async () => {
    render(
      <StarMapScreen
        desktopApi={buildDesktopApi()}
        localThreads={[unreadThread("t2")]}
        sessionKeys={{}}
        floating={false}
        onClose={() => undefined}
        onOpenLocalThread={() => undefined}
        onFocusLocalInstance={() => undefined}
      />,
    );

    const card = () =>
      screen.queryByRole("button", { name: /Open thread: Thread t2/ });
    expect(card()).toBeTruthy();

    // Scope to the chip row: thread cards also expose an "Unread" status.
    const filterRow = screen.getByRole("group", { name: "Thread filters" });
    const unreadChip = within(filterRow).getByRole("button", {
      name: /^Unread:/,
    });

    // First click isolates rather than hides — the thread IS unread, so it
    // survives. Under the old all-on model this click removed it.
    fireEvent.click(unreadChip);
    expect(card()).toBeTruthy();

    // Second click flips the same chip to exclude.
    fireEvent.click(
      within(filterRow).getByRole("button", { name: /^Unread:/ }),
    );
    expect(card()).toBeNull();

    // Third click returns to neutral.
    fireEvent.click(
      within(filterRow).getByRole("button", { name: /^Unread:/ }),
    );
    expect(card()).toBeTruthy();
  });

  it("shows every card when no filter is selected", async () => {
    // The old model's "all chips off" state showed an empty map; neutral
    // has no such dead end.
    render(
      <StarMapScreen
        desktopApi={buildDesktopApi()}
        localThreads={[unreadThread("t3")]}
        sessionKeys={{}}
        floating={false}
        onClose={() => undefined}
        onOpenLocalThread={() => undefined}
        onFocusLocalInstance={() => undefined}
      />,
    );
    expect(
      screen.getByRole("button", { name: /Open thread: Thread t3/ }),
    ).toBeTruthy();
  });

  it("closes on Escape", async () => {
    const onClose = vi.fn();
    render(
      <StarMapScreen
        desktopApi={buildDesktopApi()}
        localThreads={[]}
        sessionKeys={{}}
        floating={false}
        onClose={onClose}
        onOpenLocalThread={() => undefined}
        onFocusLocalInstance={() => undefined}
      />,
    );
    fireEvent.keyDown(screen.getByRole("region", { name: "Star Map" }), {
      key: "Escape",
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("refocuses the layer when the floating thread closes so Escape works again", () => {
    const props = {
      desktopApi: buildDesktopApi(),
      localThreads: [],
      sessionKeys: {},
      onClose: () => undefined,
      onOpenLocalThread: () => undefined,
      onFocusLocalInstance: () => undefined,
    };
    const { rerender } = render(<StarMapScreen {...props} floating />);
    const region = screen.getByRole("region", { name: "Star Map" });
    // While the float is up, focus lives in the thread view — simulate it
    // being elsewhere, then close the float.
    (document.activeElement as HTMLElement | null)?.blur?.();
    expect(document.activeElement).not.toBe(region);
    rerender(<StarMapScreen {...props} floating={false} />);
    expect(document.activeElement).toBe(region);
  });

  it("offers a visible exit because the map covers the header toggle", async () => {
    const onClose = vi.fn();
    render(
      <StarMapScreen
        desktopApi={buildDesktopApi()}
        localThreads={[]}
        sessionKeys={{}}
        floating={false}
        onClose={onClose}
        onOpenLocalThread={() => undefined}
        onFocusLocalInstance={() => undefined}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Close Star Map" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("disambiguates two profiles on one machine, local included", async () => {
    const desktopApi: DesktopApi = {
      readFederationHealth: vi.fn(async () => ({
        health: {
          enabled: true,
          role: "gateway" as const,
          status: "listening" as const,
          instanceId: "pwr_local",
          localLabel: "Harold-MBP-M5-Max",
          localProfileName: "default",
          peers: [
            {
              id: "pwr_dev",
              // Same machine, different profile: raw labels collide.
              label: "Harold-MBP-M5-Max",
              profileName: "dev",
              role: "client" as const,
              status: "disconnected" as const,
              capabilities: [],
            },
          ],
        },
      })) as unknown as DesktopApi["readFederationHealth"],
      onAgentEvent: vi.fn(() => () => undefined),
    };
    render(
      <StarMapScreen
        desktopApi={desktopApi}
        localThreads={[]}
        sessionKeys={{}}
        floating={false}
        onClose={() => undefined}
        onOpenLocalThread={() => undefined}
        onFocusLocalInstance={() => undefined}
      />,
    );

    await waitFor(() => {
      expect(
        screen.getByRole("button", {
          name: /Open this instance \(Harold-MBP-M5-Max \/ default\)/,
        }),
      ).toBeTruthy();
    });
    expect(
      screen.getByRole("button", {
        name: /Open remote viewer for Harold-MBP-M5-Max \/ dev/,
      }),
    ).toBeTruthy();
    // The generic placeholder must never stand in for a real instance.
    expect(screen.queryByText("This instance")).toBeNull();
  });

  it("subscribes only to bounded Star Map event classes while mounted", async () => {
    const setFederationEventSubscriptions = vi.fn(async (request) => request);
    const desktopApi: DesktopApi = {
      readFederationHealth: vi.fn(async () => ({
        health: {
          enabled: true,
          role: "gateway" as const,
          status: "listening" as const,
          instanceId: "pwr_local",
          peers: [{
            id: "pwr_remote",
            label: "Remote",
            role: "client" as const,
            status: "connected" as const,
            capabilities: [
              "event_subscriptions",
              "thread_navigation",
              "scheduled_actions",
            ],
          }],
        },
      })) as unknown as DesktopApi["readFederationHealth"],
      getNavigationSnapshot: vi.fn(async () => ({
        backend: "all",
        fetchedAt: 1_000,
        threads: [],
        inboxThreadKeys: [],
        directories: [],
        launchpadDefaults: {
          backend: "codex",
          executionMode: "default",
        },
      })) as unknown as DesktopApi["getNavigationSnapshot"],
      onAgentEvent: vi.fn(() => () => undefined),
      setFederationEventSubscriptions,
    };
    const rendered = render(
      <StarMapScreen
        desktopApi={desktopApi}
        localThreads={[]}
        sessionKeys={{}}
        floating={false}
        onClose={() => undefined}
        onOpenLocalThread={() => undefined}
        onFocusLocalInstance={() => undefined}
      />,
    );

    await waitFor(() => {
      expect(setFederationEventSubscriptions).toHaveBeenCalledWith({
        consumer: "star_map",
        subscriptions: [{
          sourceInstanceId: "pwr_remote",
          eventClasses: [
            "navigation",
            "star_map",
            "scheduled_actions",
          ],
        }],
      });
    });
    expect(setFederationEventSubscriptions).not.toHaveBeenCalledWith(
      expect.objectContaining({
        subscriptions: [expect.objectContaining({
          eventClasses: expect.arrayContaining([
            "transcript",
            "pending_requests",
          ]),
        })],
      }),
    );

    rendered.unmount();
    expect(setFederationEventSubscriptions).toHaveBeenLastCalledWith({
      consumer: "star_map",
      subscriptions: [],
    });
  });

  it("drops the machine-name chip from cards - the lane already says which instance", async () => {
    render(
      <StarMapScreen
        desktopApi={buildDesktopApi()}
        localThreads={[
          {
            ...unreadThread("t9"),
            federation: {
              ref: {
                backend: "codex",
                target: { scope: "remote", instanceId: "pwr_peer" },
                threadId: "t9",
              },
              instanceLabel: "Harold-MBP-M2-Max",
            },
          } as unknown as NavigationThreadSummary,
        ]}
        sessionKeys={{}}
        floating={false}
        onClose={() => undefined}
        onOpenLocalThread={() => undefined}
        onFocusLocalInstance={() => undefined}
      />,
    );
    await waitFor(() => {
      expect(screen.getByRole("region", { name: "Star Map" })).toBeTruthy();
    });
    expect(screen.queryByText("Harold-MBP-M2-Max")).toBeNull();
  });

  it("shows only the project and open PRs on a card by default", async () => {
    const thread = {
      ...unreadThread("t7"),
      gitBranch: "agent/some-branch",
      prs: [
        {
          provider: "github",
          number: 10,
          org: "pwrdrvr",
          repo: "PwrAgnt",
          state: "passing",
          url: "https://example.test/10",
        },
        {
          provider: "github",
          number: 11,
          org: "pwrdrvr",
          repo: "PwrAgnt",
          state: "merged",
          url: "https://example.test/11",
        },
      ],
    } as unknown as NavigationThreadSummary;
    render(
      <StarMapScreen
        desktopApi={buildDesktopApi()}
        localThreads={[thread]}
        sessionKeys={{}}
        floating={false}
        onClose={() => undefined}
        onOpenLocalThread={() => undefined}
        onFocusLocalInstance={() => undefined}
      />,
    );
    const card = starMapCard(
      await screen.findByRole("button", { name: /Open thread: Thread t7/ }),
    );
    // Project chip stays; provider and branch are opt-in.
    expect(card.textContent).toContain("PwrSnap");
    expect(card.textContent).not.toContain("OpenAI");
    expect(card.textContent).not.toContain("agent/some-branch");
    // Open PR only - the merged one is hidden.
    expect(card.textContent).toContain("#10");
    expect(card.textContent).not.toContain("#11");
  });

  it("hides offline instances when the view option is set", async () => {
    window.localStorage.clear();
    const desktopApi: DesktopApi = {
      readFederationHealth: vi.fn(async () => ({
        health: {
          enabled: true,
          role: "gateway" as const,
          status: "listening" as const,
          instanceId: "pwr_local",
          localLabel: "Local",
          peers: [
            {
              id: "pwr_off",
              label: "Sleepy-Dev-Box",
              profileName: "dev",
              role: "client" as const,
              status: "disconnected" as const,
              capabilities: [],
            },
          ],
        },
      })) as unknown as DesktopApi["readFederationHealth"],
      onAgentEvent: vi.fn(() => () => undefined),
    };
    render(
      <StarMapScreen
        desktopApi={desktopApi}
        localThreads={[]}
        sessionKeys={{}}
        floating={false}
        onClose={() => undefined}
        onOpenLocalThread={() => undefined}
        onFocusLocalInstance={() => undefined}
      />,
    );
    await waitFor(() => {
      // Disambiguated label: the profile suffix rides along.
      expect(screen.getByText(/Sleepy-Dev-Box/)).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: "View" }));
    fireEvent.click(screen.getByLabelText("Hide offline instances"));
    await waitFor(() => {
      expect(screen.queryByText(/Sleepy-Dev-Box/)).toBeNull();
    });
    // The local instance is never hidden by this option.
    expect(screen.getByText("Local")).toBeTruthy();
  });

  it("archives a thread from the card kebab and refreshes its cloud", async () => {
    const archiveThread = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "t1",
    }));
    const onRefreshLocalThreads = vi.fn();
    render(
      <StarMapScreen
        desktopApi={{ ...buildDesktopApi(), archiveThread } as unknown as DesktopApi}
        localThreads={[unreadThread("t1")]}
        sessionKeys={{}}
        localInstanceLabel="Mac-Mini-M4"
        floating={false}
        onClose={() => undefined}
        onOpenLocalThread={() => undefined}
        onFocusLocalInstance={() => undefined}
        onRefreshLocalThreads={onRefreshLocalThreads}
      />,
    );

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Open this instance \(Mac-Mini-M4\)/ }),
      ).toBeTruthy();
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Actions for Thread t1" }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Archive thread" }));

    await waitFor(() => {
      expect(archiveThread).toHaveBeenCalledWith(
        expect.objectContaining({ backend: "codex", threadId: "t1" }),
      );
    });
    await waitFor(() => {
      expect(onRefreshLocalThreads).toHaveBeenCalled();
    });
  });

  it("surfaces an archive failure instead of silently dropping it", async () => {
    const archiveThread = vi.fn(async () => {
      throw new Error("peer is offline");
    });
    render(
      <StarMapScreen
        desktopApi={{ ...buildDesktopApi(), archiveThread } as unknown as DesktopApi}
        localThreads={[unreadThread("t1")]}
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
        screen.getByRole("button", { name: /Open this instance \(Mac-Mini-M4\)/ }),
      ).toBeTruthy();
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Actions for Thread t1" }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Archive thread" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/peer is offline/);
  });

  it("closes the kebab on Escape without running anything", async () => {
    const archiveThread = vi.fn();
    render(
      <StarMapScreen
        desktopApi={{ ...buildDesktopApi(), archiveThread } as unknown as DesktopApi}
        localThreads={[unreadThread("t1")]}
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
        screen.getByRole("button", { name: /Open this instance \(Mac-Mini-M4\)/ }),
      ).toBeTruthy();
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Actions for Thread t1" }),
    );
    expect(screen.getByRole("menu")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("menu")).toBeNull();
    });
    expect(archiveThread).not.toHaveBeenCalled();
  });

  it("groups threads under project suns and swaps the project chip for the instance", async () => {
    window.localStorage.setItem(
      "pwragent.starMap.viewPreferences",
      JSON.stringify({ layout: "projects" }),
    );
    try {
      render(
        <StarMapScreen
          desktopApi={buildDesktopApi()}
          localThreads={[unreadThread("t1")]}
          sessionKeys={{}}
          localInstanceLabel="Mac-Mini-M4"
          floating={false}
          onClose={() => undefined}
          onOpenLocalThread={() => undefined}
          onFocusLocalInstance={() => undefined}
        />,
      );

      // The fixture's linked directory is /tmp/pwrsnap, so the sun is the
      // repo folder rather than the worktree label.
      const sun = await screen.findByText("pwrsnap");
      expect(sun).toBeTruthy();

      const card = starMapCard(
        screen.getByRole("button", {
          name: /Open thread: Thread t1/,
        }),
      );
      // The project is the sun, so its chip is redundant here.
      expect(card.textContent).not.toContain("PwrSnap");
    } finally {
      window.localStorage.removeItem("pwragent.starMap.viewPreferences");
    }
  });

  /** Body-relative position of a card, read off its rendered shell. */
  function cardPosition(threadKey: string): { dx: number; dy: number } {
    const shell = document.querySelector<HTMLElement>(
      `[data-thread-key="${threadKey}"]`,
    );
    if (!shell) throw new Error(`no card shell for ${threadKey}`);
    return {
      dx: Number.parseFloat(shell.style.left),
      dy: Number.parseFloat(shell.style.top),
    };
  }

  function dragCard(
    threadKey: string,
    delta: { dx: number; dy: number },
  ): void {
    const shell = document.querySelector<HTMLElement>(
      `[data-thread-key="${threadKey}"]`,
    );
    if (!shell) throw new Error(`no card shell for ${threadKey}`);
    fireEvent.pointerDown(shell, { button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(window, { clientX: delta.dx, clientY: delta.dy });
    fireEvent.pointerUp(window);
  }

  it("drops two cards from one cloud onto the same spot, whatever their slots", async () => {
    // The whole point of a body-centred region: the drag geometry is a
    // property of the cloud, not of where a card happens to start. Drives
    // it through the real wiring, so a per-card radius would fail here
    // even though the pure geometry tests pass.
    const committed = new Map<string, { dx: number; dy: number }>();
    const setStarMapCardPosition = vi.fn(
      async (request: {
        threadKey: string;
        dx: number | null;
        dy: number | null;
      }) => {
        committed.set(request.threadKey, {
          dx: request.dx ?? 0,
          dy: request.dy ?? 0,
        });
        return { entries: [] };
      },
    );
    render(
      <StarMapScreen
        desktopApi={
          { ...buildDesktopApi(), setStarMapCardPosition } as unknown as DesktopApi
        }
        localThreads={[unreadThread("t1"), unreadThread("t2")]}
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
        screen.getByRole("button", { name: /Open thread: Thread t1/ }),
      ).toBeTruthy();
    });

    // Stacked in one lane, so the two cards start at different distances
    // from the body — which used to hand them different regions.
    const first = cardPosition("codex:t1");
    const second = cardPosition("codex:t2");
    expect(second.dy).not.toBeCloseTo(first.dy);

    // Same destination for both, out past the detent so resistance applies.
    const target = { dx: -900, dy: -600 };
    dragCard("codex:t1", {
      dx: target.dx - first.dx,
      dy: target.dy - first.dy,
    });
    dragCard("codex:t2", {
      dx: target.dx - second.dx,
      dy: target.dy - second.dy,
    });

    await waitFor(() => {
      expect(committed.size).toBe(2);
    });
    const landedFirst = {
      dx: first.dx + committed.get("codex:t1")!.dx,
      dy: first.dy + committed.get("codex:t1")!.dy,
    };
    const landedSecond = {
      dx: second.dx + committed.get("codex:t2")!.dx,
      dy: second.dy + committed.get("codex:t2")!.dy,
    };
    expect(landedFirst.dx).toBeCloseTo(landedSecond.dx);
    expect(landedFirst.dy).toBeCloseTo(landedSecond.dy);
    // And they got there: an island well outside the cloud, not a card
    // pinned to the edge of its own little bubble.
    expect(Math.hypot(landedFirst.dx, landedFirst.dy)).toBeGreaterThan(600);
  });

  it("offers a way back for a card parked away from its cloud", async () => {
    const setStarMapCardPosition = vi.fn(async () => ({ entries: [] }));
    const readStarMapArrangement = vi.fn(async () => ({
      entries: [
        {
          instanceId: "pwr_local",
          threadKey: "codex:t1",
          dx: -1800,
          dy: -1400,
          updatedAt: 1,
          by: "pwr_local",
        },
      ],
    }));
    render(
      <StarMapScreen
        desktopApi={
          {
            ...buildDesktopApi(),
            readStarMapArrangement,
            setStarMapCardPosition,
          } as unknown as DesktopApi
        }
        localThreads={[unreadThread("t1")]}
        sessionKeys={{}}
        localInstanceLabel="Mac-Mini-M4"
        floating={false}
        onClose={() => undefined}
        onOpenLocalThread={() => undefined}
        onFocusLocalInstance={() => undefined}
      />,
    );

    // A lane does not pan, so a card dragged this far out is off the
    // window with no way to grab it again.
    await waitFor(() => {
      expect(cardPosition("codex:t1").dx).toBeLessThan(-1000);
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Actions for Thread t1" }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Reset position" }));

    await waitFor(() => {
      expect(setStarMapCardPosition).toHaveBeenCalledWith(
        expect.objectContaining({ threadKey: "codex:t1", dx: null, dy: null }),
      );
    });
    // Optimistic, so the card is back in its slot without a round trip.
    expect(cardPosition("codex:t1").dx).toBeCloseTo(0);
  });

  it("keeps the reset action off a card that has not been moved", async () => {
    render(
      <StarMapScreen
        desktopApi={
          {
            ...buildDesktopApi(),
            setStarMapCardPosition: vi.fn(async () => ({ entries: [] })),
          } as unknown as DesktopApi
        }
        localThreads={[unreadThread("t1")]}
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
        screen.getByRole("button", { name: "Actions for Thread t1" }),
      ).toBeTruthy();
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Actions for Thread t1" }),
    );
    expect(screen.queryByRole("menuitem", { name: "Reset position" })).toBeNull();
  });

  it("explains an empty map rather than showing a blank star field", async () => {
    render(
      <StarMapScreen
        desktopApi={buildDesktopApi()}
        localThreads={[unreadThread("t9")]}
        sessionKeys={{}}
        floating={false}
        onClose={() => undefined}
        onOpenLocalThread={() => undefined}
        onFocusLocalInstance={() => undefined}
      />,
    );

    const filterRow = screen.getByRole("group", { name: "Thread filters" });
    // Exclude the only reason this card is on the map.
    const unread = () =>
      within(filterRow).getByRole("button", { name: /^Unread:/ });
    fireEvent.click(unread());
    fireEvent.click(unread());

    expect(
      screen.queryByRole("button", { name: /Open thread: Thread t9/ }),
    ).toBeNull();
    // Without this the operator cannot tell a filtered map from a broken
    // one: the star field renders either way.
    const status = await screen.findByRole("status");
    expect(status.textContent).toMatch(/No threads match these filters/);
  });

  it("offers a way back from any selection", async () => {
    render(
      <StarMapScreen
        desktopApi={buildDesktopApi()}
        localThreads={[unreadThread("t10")]}
        sessionKeys={{}}
        floating={false}
        onClose={() => undefined}
        onOpenLocalThread={() => undefined}
        onFocusLocalInstance={() => undefined}
      />,
    );

    const filterRow = screen.getByRole("group", { name: "Thread filters" });
    // Nothing to clear yet, so the affordance stays out of the strip.
    expect(
      within(filterRow).queryByRole("button", { name: "Clear" }),
    ).toBeNull();

    fireEvent.click(
      within(filterRow).getByRole("button", { name: /^Unread:/ }),
    );
    fireEvent.click(within(filterRow).getByRole("button", { name: "Clear" }));

    expect(
      within(filterRow).queryByRole("button", { name: "Clear" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: /Open thread: Thread t10/ }),
    ).toBeTruthy();
  });

  it("does not claim an unfiltered empty map is a filter problem", async () => {
    // A fleet with nothing to show is a different state; blaming the
    // filters there would be a lie.
    render(
      <StarMapScreen
        desktopApi={buildDesktopApi()}
        localThreads={[]}
        sessionKeys={{}}
        floating={false}
        onClose={() => undefined}
        onOpenLocalThread={() => undefined}
        onFocusLocalInstance={() => undefined}
      />,
    );
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("names hidden instances when they are what emptied the map", async () => {
    // Hidden peers are never fetched, so their threads cannot be counted.
    // Without naming the setting, the map looks identical to an idle
    // fleet — the same ambiguity the filter message exists to remove.
    window.localStorage.setItem(
      "pwragent.starMap.viewPreferences",
      JSON.stringify({ hideOfflineInstances: true }),
    );
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
          peers: [
            {
              id: "pwr_peer",
              label: "M4 Mini",
              role: "client" as const,
              status: "disconnected" as const,
              capabilities: [],
            },
          ],
        },
      })),
      onAgentEvent: vi.fn(() => () => undefined),
    } as unknown as DesktopApi;

    render(
      <StarMapScreen
        desktopApi={desktopApi}
        localThreads={[]}
        sessionKeys={{}}
        floating={false}
        onClose={() => undefined}
        onOpenLocalThread={() => undefined}
        onFocusLocalInstance={() => undefined}
      />,
    );

    const status = await screen.findByRole("status");
    expect(status.textContent).toMatch(/No threads on the visible instances/);
    expect(status.textContent).toMatch(/1 offline instance is hidden/);

    fireEvent.click(
      within(status).getByRole("button", { name: "Show offline instances" }),
    );
    await waitFor(() => {
      expect(screen.queryByRole("status")).toBeNull();
    });
  });

  it("stays silent when an idle fleet is genuinely empty", async () => {
    // No filters, nothing hidden — there is no setting to blame, and
    // inventing one would be worse than saying nothing.
    render(
      <StarMapScreen
        desktopApi={buildDesktopApi()}
        localThreads={[]}
        sessionKeys={{}}
        floating={false}
        onClose={() => undefined}
        onOpenLocalThread={() => undefined}
        onFocusLocalInstance={() => undefined}
      />,
    );
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Open this instance/ }),
      ).toBeTruthy();
    });
    expect(screen.queryByRole("status")).toBeNull();
  });
});
