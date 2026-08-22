import {
  act,
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

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

describe("StarMapScreen", () => {
  it("marks a card whose thread holds an unsent draft", async () => {
    // Drafts ride a prop of their own rather than `sessionKeys`, which the
    // screen only trusts for local cards — a draft is this window's own
    // composer state, so no peer has to confirm it.
    const { container } = render(
      <StarMapScreen
        desktopApi={buildDesktopApi()}
        localThreads={[unreadThread("t1"), unreadThread("t2")]}
        sessionKeys={{}}
        draftThreadKeys={{ "codex:t1": true }}
        localInstanceLabel="Mac-Mini-M4"
        onOpenLocalThread={() => undefined}
        onFocusLocalInstance={() => undefined}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector(".star-map-card")).not.toBeNull();
    });

    const drafted = starMapCard(
      screen.getByRole("button", { name: "Open thread: Thread t1" }),
    );
    expect(
      drafted.querySelector('[data-thread-draft="unsent"]'),
    ).not.toBeNull();

    const undrafted = starMapCard(
      screen.getByRole("button", { name: "Open thread: Thread t2" }),
    );
    expect(undrafted.querySelector('[data-thread-draft="unsent"]')).toBeNull();
  });

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
    // The invariant under guard lives in the LANES branch: thread slots
    // are computed as if the load card did not exist. Orbit gives the
    // load card a fixed slot that provably cannot move cards, so running
    // this under the orbit default would make the test vacuous.
    seedLayout("lanes");
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

  it("refreshes a remote card only after its accepted reply is marked seen", async () => {
    const remoteTarget = {
      scope: "remote" as const,
      instanceId: "pwr_peer",
    };
    const remoteUnreadThread = {
      ...unreadThread("remote"),
      federation: {
        instanceLabel: "Studio Mac",
        ref: {
          backend: "codex" as const,
          target: remoteTarget,
          threadId: "remote",
        },
      },
    } as NavigationThreadSummary;
    const remoteSeenThread = {
      ...remoteUnreadThread,
      inbox: { inInbox: false, lastSeenUpdatedAt: 100 },
    } as NavigationThreadSummary;
    const markSeen = createDeferred<void>();
    const onUserRepliedToThread = vi.fn(() => markSeen.promise);
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: 1_000,
      threads:
        getNavigationSnapshot.mock.calls.length === 1
          ? [remoteUnreadThread]
          : [remoteSeenThread],
      inboxThreadKeys:
        getNavigationSnapshot.mock.calls.length === 1
          ? ["codex:remote"]
          : [],
      directories: [],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));
    const startTurn = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "remote",
      turnId: "turn-remote",
    }));
    const desktopApi = {
      readFederationHealth: vi.fn(async () => ({
        health: {
          enabled: true,
          role: "gateway" as const,
          status: "listening" as const,
          instanceId: "pwr_local",
          localLabel: "Local Mac",
          peers: [{
            id: "pwr_peer",
            label: "Studio Mac",
            role: "client" as const,
            status: "connected" as const,
            capabilities: ["thread_navigation" as const],
          }],
        },
      })),
      getNavigationSnapshot,
      onAgentEvent: vi.fn(() => () => undefined),
      readThread: vi.fn(async () => ({
        backend: "codex" as const,
        threadId: "remote",
        replay: {
          entries: [],
          messages: [],
          pagination: { supportsPagination: false, hasPreviousPage: false },
        },
      })),
      startTurn,
    } as unknown as DesktopApi;

    render(
      <StarMapScreen
        desktopApi={desktopApi}
        localThreads={[]}
        sessionKeys={{}}
        onOpenLocalThread={() => undefined}
        onUserRepliedToThread={onUserRepliedToThread}
        onFocusLocalInstance={() => undefined}
      />,
    );

    const remoteOpenButton = await screen.findByRole("button", {
      name: "Open thread: Thread remote",
    });
    expect(
      starMapCard(remoteOpenButton).querySelector(
        '[data-thread-status="unread"]',
      ),
    ).not.toBeNull();
    fireEvent.click(remoteOpenButton);
    const chat = await screen.findByRole("region", {
      name: "Chat: Thread remote",
    });
    const input = within(chat).getByRole("textbox", {
      name: "Message Thread remote",
    });
    fireEvent.change(input, { target: { value: "ship the fix" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(startTurn).toHaveBeenCalled();
      expect(onUserRepliedToThread).toHaveBeenCalledWith(remoteUnreadThread);
    });
    expect(getNavigationSnapshot).toHaveBeenCalledTimes(1);

    await act(async () => {
      markSeen.resolve();
      await markSeen.promise;
    });

    await waitFor(() => {
      expect(getNavigationSnapshot).toHaveBeenCalledTimes(2);
    });
    expect(getNavigationSnapshot).toHaveBeenLastCalledWith({
      federationTarget: remoteTarget,
    });
    await waitFor(() => {
      expect(
        starMapCard(
          screen.getByRole("button", {
            name: "Open thread: Thread remote",
          }),
        ).querySelector('[data-thread-status="unread"]'),
      ).toBeNull();
    });
  });

  it("raises an already-open chat card instead of stacking a duplicate", async () => {
    render(
      <StarMapScreen
        desktopApi={buildDesktopApi()}
        localThreads={[unreadThread("t1")]}
        sessionKeys={{}}
        localInstanceLabel="Mac-Mini-M4"
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

  it("keeps a stopped monitor disabled until local navigation refreshes", async () => {
    let resolveRefresh: (() => void) | undefined;
    const refreshPending = new Promise<void>((resolve) => {
      resolveRefresh = resolve;
    });
    const onRefreshLocalThreads = vi.fn(() => refreshPending);
    const stopSubAgent = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "t1",
      monitorId: "monitor-1",
      stoppedAt: Date.now(),
    }));
    render(
      <StarMapScreen
        desktopApi={{
          ...buildDesktopApi(),
          stopSubAgent,
        } as unknown as DesktopApi}
        localThreads={[
          {
            ...unreadThread("t1"),
            subAgents: [
              {
                monitorId: "monitor-1",
                task: "Watch production",
                status: "running",
                createdAt: Date.now(),
                updatedAt: Date.now(),
                backend: "codex",
                monitorThreadId: "monitor-thread",
                monitorTurnId: "monitor-turn",
              },
            ],
          },
        ]}
        sessionKeys={{}}
        localInstanceLabel="Mac-Mini-M4"
        onOpenLocalThread={() => undefined}
        onFocusLocalInstance={() => undefined}
        onRefreshLocalThreads={onRefreshLocalThreads}
      />,
    );

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Open thread: Thread t1/ }),
      ).toBeTruthy();
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Open thread: Thread t1" }),
    );
    const stop = await screen.findByRole("button", {
      name: "Stop sub-agent: Watch production",
    });
    fireEvent.click(stop);

    await waitFor(() => {
      expect(onRefreshLocalThreads).toHaveBeenCalledTimes(1);
    });
    expect(stop.textContent).toBe("Stopping…");
    expect((stop as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(stop);
    expect(stopSubAgent).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveRefresh?.();
      await refreshPending;
    });
    await waitFor(() => {
      expect((stop as HTMLButtonElement).disabled).toBe(false);
    });
  });

  it("closes a chat card from its close button", async () => {
    render(
      <StarMapScreen
        desktopApi={buildDesktopApi()}
        localThreads={[unreadThread("t1")]}
        sessionKeys={{}}
        localInstanceLabel="Mac-Mini-M4"
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
      name: /^Attention:/,
    });

    // First click isolates rather than hides — the thread IS unread, so it
    // survives. Under the old all-on model this click removed it.
    fireEvent.click(unreadChip);
    expect(card()).toBeTruthy();

    // Second click flips the same chip to exclude.
    fireEvent.click(
      within(filterRow).getByRole("button", { name: /^Attention:/ }),
    );
    expect(card()).toBeNull();

    // Third click returns to neutral.
    fireEvent.click(
      within(filterRow).getByRole("button", { name: /^Attention:/ }),
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
        onOpenLocalThread={() => undefined}
        onFocusLocalInstance={() => undefined}
      />,
    );
    expect(
      screen.getByRole("button", { name: /Open thread: Thread t3/ }),
    ).toBeTruthy();
  });

  it("swallows a bare Escape — closing the window is the OS chrome's job", () => {
    const outerKeyDown = vi.fn();
    render(
      <div onKeyDown={outerKeyDown}>
        <StarMapScreen
          desktopApi={buildDesktopApi()}
          localThreads={[]}
          sessionKeys={{}}
          onOpenLocalThread={() => undefined}
          onFocusLocalInstance={() => undefined}
        />
      </div>,
    );
    fireEvent.keyDown(screen.getByRole("region", { name: "Star Map" }), {
      key: "Escape",
    });
    // With nothing selected, Escape neither escapes the map (the reflexive
    // "dismiss the popover" tap must not reach a window-level handler) nor
    // tears anything down.
    expect(outerKeyDown).not.toHaveBeenCalled();
    expect(screen.getByRole("region", { name: "Star Map" })).toBeTruthy();
  });

  it("focuses the layer on mount so the camera keys work immediately", () => {
    render(
      <StarMapScreen
        desktopApi={buildDesktopApi()}
        localThreads={[]}
        sessionKeys={{}}
        onOpenLocalThread={() => undefined}
        onFocusLocalInstance={() => undefined}
      />,
    );
    expect(document.activeElement).toBe(
      screen.getByRole("region", { name: "Star Map" }),
    );
  });

  it("carries no in-map close affordance — the map lives in its own window", () => {
    render(
      <StarMapScreen
        desktopApi={buildDesktopApi()}
        localThreads={[]}
        sessionKeys={{}}
        onOpenLocalThread={() => undefined}
        onFocusLocalInstance={() => undefined}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Close Star Map" }),
    ).toBeNull();
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
          threadSelection: { kind: "all" },
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
        onOpenLocalThread={() => undefined}
        onFocusLocalInstance={() => undefined}
      />,
    );
    await waitFor(() => {
      // Disambiguated label: the profile suffix rides along. The name can
      // show more than once — the body sits off-screen at the opening
      // view, so its edge arrow names it too — and hiding the instance
      // has to take every one of them with it.
      expect(screen.getAllByText(/Sleepy-Dev-Box/).length).toBeGreaterThan(0);
    });

    fireEvent.click(screen.getByRole("button", { name: "View" }));
    fireEvent.click(screen.getByLabelText("Hide offline instances"));
    await waitFor(() => {
      expect(screen.queryAllByText(/Sleepy-Dev-Box/)).toHaveLength(0);
    });
    // The local instance is never hidden by this option.
    expect(screen.getByText("Local")).toBeTruthy();
  });

  it("archives a thread from the card kebab and refreshes its cloud", async () => {
    const archiveThread = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "t1",
    }));
    const onRefreshLocalThreads = vi.fn(async () => undefined);
    render(
      <StarMapScreen
        desktopApi={{ ...buildDesktopApi(), archiveThread } as unknown as DesktopApi}
        localThreads={[unreadThread("t1")]}
        sessionKeys={{}}
        localInstanceLabel="Mac-Mini-M4"
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

  it("renames a thread from the card kebab and wears the new title at once", async () => {
    const renameThread = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "t1",
      renamedAt: 1,
    }));
    const onRefreshLocalThreads = vi.fn(async () => undefined);
    render(
      <StarMapScreen
        desktopApi={{ ...buildDesktopApi(), renameThread } as unknown as DesktopApi}
        localThreads={[unreadThread("t1")]}
        sessionKeys={{}}
        localInstanceLabel="Mac-Mini-M4"
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
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename thread…" }));

    const input = screen.getByLabelText("Thread name") as HTMLInputElement;
    // Seeded with the current title, so a small correction does not mean
    // retyping the whole name.
    expect(input.value).toBe("Thread t1");
    fireEvent.change(input, { target: { value: "  Star chart cleanup  " } });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));

    await waitFor(() => {
      expect(renameThread).toHaveBeenCalledWith(
        expect.objectContaining({
          backend: "codex",
          name: "Star chart cleanup",
          threadId: "t1",
        }),
      );
    });
    // The props still carry the old title — the card must not wait for the
    // feed to catch up before it shows the rename.
    expect(
      screen.getByRole("button", { name: "Open thread: Star chart cleanup" }),
    ).toBeTruthy();
    await waitFor(() => {
      expect(onRefreshLocalThreads).toHaveBeenCalled();
    });
  });

  it("puts the old title back when a rename is refused", async () => {
    const renameThread = vi.fn(async () => {
      throw new Error("peer is offline");
    });
    render(
      <StarMapScreen
        desktopApi={{ ...buildDesktopApi(), renameThread } as unknown as DesktopApi}
        localThreads={[unreadThread("t1")]}
        sessionKeys={{}}
        localInstanceLabel="Mac-Mini-M4"
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
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename thread…" }));
    fireEvent.change(screen.getByLabelText("Thread name"), {
      target: { value: "Star chart cleanup" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/peer is offline/);
    expect(
      screen.getByRole("button", { name: "Open thread: Thread t1" }),
    ).toBeTruthy();
  });

  it("hands the title back to the feed when someone else renames the thread", async () => {
    // The optimistic title is released by the feed moving OFF the title
    // the rename replaced — not by it reporting this window's name. A
    // second window renaming the same thread reports a title this one
    // never asked for, and watching for our own would pin the card to a
    // name nothing agrees with for the life of the window.
    const renameThread = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "t1",
      renamedAt: 1,
    }));
    const desktopApi = {
      ...buildDesktopApi(),
      renameThread,
    } as unknown as DesktopApi;
    const { rerender } = render(
      <StarMapScreen
        desktopApi={desktopApi}
        localThreads={[unreadThread("t1")]}
        sessionKeys={{}}
        localInstanceLabel="Mac-Mini-M4"
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
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename thread…" }));
    fireEvent.change(screen.getByLabelText("Thread name"), {
      target: { value: "Star chart cleanup" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));

    await waitFor(() => {
      expect(renameThread).toHaveBeenCalled();
    });
    expect(
      screen.getByRole("button", { name: "Open thread: Star chart cleanup" }),
    ).toBeTruthy();

    rerender(
      <StarMapScreen
        desktopApi={desktopApi}
        localThreads={[
          { ...unreadThread("t1"), title: "Renamed from the sidebar" },
        ]}
        sessionKeys={{}}
        localInstanceLabel="Mac-Mini-M4"
        onOpenLocalThread={() => undefined}
        onFocusLocalInstance={() => undefined}
      />,
    );

    await waitFor(() => {
      expect(
        screen.getByRole("button", {
          name: "Open thread: Renamed from the sidebar",
        }),
      ).toBeTruthy();
    });
  });

  it("marks a seen thread unread from the card kebab", async () => {
    const markThreadSeen = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "t1",
      seenAt: 5,
    }));
    render(
      <StarMapScreen
        desktopApi={
          { ...buildDesktopApi(), markThreadSeen } as unknown as DesktopApi
        }
        localThreads={[
          {
            ...unreadThread("t1"),
            inbox: { inInbox: false },
          } as NavigationThreadSummary,
        ]}
        sessionKeys={{}}
        localInstanceLabel="Mac-Mini-M4"
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
    // A seen card has nothing to mark seen, and the reverse entry is the
    // one that applies.
    expect(screen.queryByRole("menuitem", { name: "Mark as seen" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Mark as unread" }));

    await waitFor(() => {
      expect(markThreadSeen).toHaveBeenCalledWith(
        expect.objectContaining({
          backend: "codex",
          threadId: "t1",
          // One tick behind the thread's own `updatedAt`, the same
          // watermark the thread list writes.
          seenUpdatedAt: 99,
        }),
      );
    });
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
    // The expected drop coordinates were computed under the lanes
    // geometry; the default lens is orbit now, so pin the layout the
    // numbers assume rather than inheriting whatever the default is.
    seedLayout("lanes");
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
        onOpenLocalThread={() => undefined}
        onFocusLocalInstance={() => undefined}
      />,
    );

    const filterRow = screen.getByRole("group", { name: "Thread filters" });
    // Exclude the only reason this card is on the map.
    const unread = () =>
      within(filterRow).getByRole("button", { name: /^Attention:/ });
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

  // The narrow-window rendering of the same filters. CSS decides which of
  // the two is displayed (`@media` beside `.star-map__filters`); jsdom
  // loads no stylesheet, so both are in the tree here and the menu can be
  // driven directly. What matters is that it drives the SAME state as the
  // strip — a popover that filtered a different map would be worse than
  // no popover at all.
  it("filters from the collapsed menu the same way the strip does", async () => {
    render(
      <StarMapScreen
        desktopApi={buildDesktopApi()}
        localThreads={[unreadThread("t11")]}
        sessionKeys={{}}
        onOpenLocalThread={() => undefined}
        onFocusLocalInstance={() => undefined}
      />,
    );

    // Closed, the trigger is the only thing that says the map is filtered,
    // so its name carries the count rather than only its badge.
    const trigger = screen.getByRole("button", { name: "Thread filters" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger);

    const panel = screen.getByRole("dialog", { name: "Thread filters" });
    // Exclude the only reason this card is on the map, through the popover.
    const unread = () =>
      within(panel).getByRole("button", { name: /^Attention:/ });
    fireEvent.click(unread());
    fireEvent.click(unread());

    expect(
      screen.queryByRole("button", { name: /Open thread: Thread t11/ }),
    ).toBeNull();
    const status = await screen.findByRole("status");
    expect(status.textContent).toMatch(/No threads match these filters/);
    // The strip is the same control set, not a parallel one: it has to
    // show the state the popover just set.
    const strip = screen.getByRole("group", { name: "Thread filters" });
    expect(
      within(strip).getByRole("button", { name: /^Attention: hidden/ }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Thread filters: 1 active" }),
    ).toBeTruthy();

    fireEvent.click(within(panel).getByRole("button", { name: "Clear" }));
    expect(
      screen.getByRole("button", { name: /Open thread: Thread t11/ }),
    ).toBeTruthy();
    // Clearing closes the door behind it — there is nothing left to set.
    expect(screen.queryByRole("dialog", { name: "Thread filters" })).toBeNull();
  });

  it("offers a way back from any selection", async () => {
    render(
      <StarMapScreen
        desktopApi={buildDesktopApi()}
        localThreads={[unreadThread("t10")]}
        sessionKeys={{}}
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
      within(filterRow).getByRole("button", { name: /^Attention:/ }),
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
