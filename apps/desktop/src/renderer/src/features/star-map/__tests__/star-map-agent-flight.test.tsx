import "./foreground-fixture";
import {
  act,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NAVIGATION_QUERY_PROTOCOL_VERSION,
  type NavigationQueryPage,
  type NavigationQueryRequest,
  type NavigationThreadSummary,
  type StarMapCommand,
  type StarMapCommandResult,
  type StarMapFlightTarget,
  type StarMapViewSnapshot,
} from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { StarMapScreen } from "../StarMapScreen";
import { useStarMapCommands } from "../useStarMapCommands";

/**
 * "Fly me to it": an Agent asks the map to show the operator something.
 *
 * The answer matters as much as the flight. The Agent tells the operator
 * what it did from that answer alone, so a flight that reports success
 * while landing on sky - or a failure that never answers - is a turn that
 * lies or hangs.
 */

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

function queryPage(
  request: NavigationQueryRequest,
  threads: readonly NavigationThreadSummary[],
): NavigationQueryPage {
  const entries = request.query.kind === "star-map-geometry"
    ? []
    : threads.map((entry, index) => ({
        row: {
          ...entry,
          ref: { backend: entry.source, threadId: entry.id },
          rowRevision: `row-${entry.id}`,
          ordinaryChildCount: 0,
          nativeSubAgentGroupPresent: false,
          queueCount: 0,
          queueState: "unknown" as const,
        },
        orderKey: index.toString().padStart(10, "0"),
        placement: { kind: "root" as const },
      }));
  return {
    protocol: NAVIGATION_QUERY_PROTOCOL_VERSION,
    queryKey: request.query.kind,
    generation: `generation-${request.query.kind}`,
    ownerEpoch: "owner-epoch",
    countsRevision: `revision-${request.query.kind}`,
    coverage: { state: "complete" },
    counts: { total: threads.length, active: 0, unread: 0, review: 0 },
    entries,
    directories: [],
    complete: true,
  };
}

/** The map's half of the command channel, driven the way main drives it. */
function commandBridge() {
  let listener: ((command: StarMapCommand) => void) | undefined;
  const answers: StarMapCommandResult[] = [];
  const published: StarMapViewSnapshot[] = [];
  let sequence = 0;
  const api: Partial<DesktopApi> = {
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
    onStarMapCommand: vi.fn((callback: (command: StarMapCommand) => void) => {
      listener = callback;
      return () => {
        listener = undefined;
      };
    }),
    resolveStarMapCommand: vi.fn(async (result: StarMapCommandResult) => {
      answers.push(result);
    }),
    publishStarMapView: vi.fn(async (snapshot: StarMapViewSnapshot) => {
      published.push(snapshot);
    }),
  };
  return {
    api,
    published,
    send(target: StarMapFlightTarget): string {
      const requestId = `request-${++sequence}`;
      act(() => {
        listener?.({ requestId, kind: "fly_to", target });
      });
      return requestId;
    },
    async answerTo(requestId: string) {
      await waitFor(() => {
        expect(answers.some((answer) => answer.requestId === requestId))
          .toBe(true);
      });
      return answers.find((answer) => answer.requestId === requestId)!.response;
    },
    async fly(target: StarMapFlightTarget) {
      await waitFor(() => expect(listener).toBeDefined());
      return await this.answerTo(this.send(target));
    },
  };
}

function renderMap(
  api: Partial<DesktopApi>,
  localThreads?: NavigationThreadSummary[],
) {
  return render(
    <StarMapScreen
      desktopApi={api as DesktopApi}
      {...(localThreads ? { localThreads } : {})}
      sessionKeys={{}}
      localInstanceLabel="Mac-Mini-M4"
      onOpenLocalThread={() => undefined}
      onFocusLocalInstance={() => undefined}
    />,
  );
}

describe("Star Map Agent flights", () => {
  beforeEach(() => {
    // Under reduced motion a flight lands in one commit, which is the state
    // these assertions are about. jsdom answers every query with `false`.
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
    vi.useRealTimers();
    window.localStorage.removeItem("pwragent.starMap.filterSelection");
    window.localStorage.removeItem("pwragent.starMap.viewPreferences");
  });

  it("flies to the card an Agent names, and says what it flew to", async () => {
    const bridge = commandBridge();
    const { container } = renderMap(bridge.api, [
      thread("t1", "Windows job wrapper"),
      thread("t2", "Release notarization"),
    ]);
    await waitFor(() => {
      expect(container.querySelector(".star-map-card")).not.toBeNull();
    });
    const canvas = container.querySelector<HTMLElement>(".star-map__canvas");
    const before = canvas?.style.transform;

    const answer = await bridge.fly({
      kind: "thread",
      backend: "codex",
      threadId: "t2",
    });

    expect(answer).toEqual({
      ok: true,
      data: {
        target: "thread",
        label: "Release notarization",
        summoned: false,
      },
    });
    await waitFor(() => {
      expect(canvas?.style.transform).not.toBe(before);
    });
    await waitFor(() => {
      expect(
        container.querySelector(".star-map-card-shell--located"),
      ).not.toBeNull();
    });
  });

  it("loads a thread the map has not, then flies to it", async () => {
    // The map loads its own threads a page at a time, and "fly me to the
    // release runbook thread" is usually about one that is not on it.
    const bridge = commandBridge();
    const loaded = thread("t1", "Windows job wrapper");
    const older = thread("t9", "Release runbook");
    const getNavigationQueryPage = vi.fn(
      async (request: NavigationQueryRequest) => {
        if (request.query.kind === "star-map") {
          return queryPage(request, [loaded]);
        }
        if (request.query.kind === "exact") {
          const asked = new Set(
            request.query.identities.map((ref) => ref.threadId),
          );
          return queryPage(
            request,
            [loaded, older].filter((entry) => asked.has(entry.id)),
          );
        }
        return queryPage(request, []);
      },
    );
    renderMap({ ...bridge.api, getNavigationQueryPage });
    await screen.findByRole("button", {
      name: "Open thread: Windows job wrapper",
    });

    const answer = await bridge.fly({
      kind: "thread",
      backend: "codex",
      threadId: "t9",
    });

    expect(answer).toEqual({
      ok: true,
      data: { target: "thread", label: "Release runbook", summoned: true },
    });
    expect(
      await screen.findByRole("button", { name: "Open thread: Release runbook" }),
    ).toBeTruthy();
  });

  it("says why when the thread never loads", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const bridge = commandBridge();
    renderMap(bridge.api, [thread("t1", "Windows job wrapper")]);
    await screen.findByRole("button", {
      name: "Open thread: Windows job wrapper",
    });
    await waitFor(() => {
      expect(bridge.api.onStarMapCommand).toHaveBeenCalled();
    });

    const requestId = bridge.send({
      kind: "thread",
      backend: "codex",
      threadId: "gone",
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(11_000);
    });

    const answer = await bridge.answerTo(requestId);
    expect(answer).toMatchObject({ ok: false, error: { code: "not_found" } });
    // No owner was named, so the likeliest miss is a peer's thread.
    expect(answer.ok ? "" : answer.error.message).toMatch(/instanceId/);
  });

  it("frames a cloud by the key read_star_map_view reported", async () => {
    const bridge = commandBridge();
    const { container } = renderMap(bridge.api, [
      thread("t1", "Windows job wrapper"),
      thread("t2", "Release notarization"),
    ]);
    // The key the Agent would have read, not one this test made up.
    await waitFor(
      () => {
        expect(
          bridge.published.some((view) =>
            view.threads.some((entry) => entry.rect && entry.cloudKey),
          ),
        ).toBe(true);
      },
      { timeout: 3_000 },
    );
    const view = bridge.published.at(-1)!;
    const cloud = view.clouds.find((entry) =>
      entry.threadKeys.includes("codex:t2"),
    )!;
    const canvas = container.querySelector<HTMLElement>(".star-map__canvas");
    const before = canvas?.style.transform;

    const answer = await bridge.fly({ kind: "cloud", cloudKey: cloud.key });

    expect(answer).toEqual({
      ok: true,
      data: { target: "cloud", label: cloud.label },
    });
    await waitFor(() => {
      expect(canvas?.style.transform).not.toBe(before);
    });
  });

  it("refuses a cloud the map is not drawing", async () => {
    const bridge = commandBridge();
    renderMap(bridge.api, [thread("t1", "Windows job wrapper")]);
    await screen.findByRole("button", {
      name: "Open thread: Windows job wrapper",
    });

    await expect(
      bridge.fly({ kind: "cloud", cloudKey: "no-such-project" }),
    ).resolves.toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("flies to an instance's body without taking the operator's focus", async () => {
    // The operator is usually typing to the manager when this runs; the
    // edge arrows' own flight refocuses the map, which here would pull the
    // caret out of their sentence.
    const bridge = commandBridge();
    const { container } = renderMap(bridge.api, [
      thread("t1", "Windows job wrapper"),
    ]);
    await screen.findByRole("button", {
      name: "Open thread: Windows job wrapper",
    });
    const composer = document.createElement("textarea");
    document.body.append(composer);
    composer.focus();

    const answer = await bridge.fly({
      kind: "instance",
      instanceId: "pwr_local",
    });

    expect(answer).toMatchObject({
      ok: true,
      data: { target: "instance" },
    });
    expect(document.activeElement).toBe(composer);
    expect(container.querySelector(".star-map__canvas")).not.toBeNull();
    composer.remove();
  });
});

describe("useStarMapCommands", () => {
  it("answers a command whose handler throws, rather than leaving it open", async () => {
    let listener: ((command: StarMapCommand) => void) | undefined;
    const resolveStarMapCommand = vi.fn(async () => undefined);
    const desktopApi = {
      onStarMapCommand: (callback: (command: StarMapCommand) => void) => {
        listener = callback;
        return () => {
          listener = undefined;
        };
      },
      resolveStarMapCommand,
    } as unknown as DesktopApi;
    const hook = renderHook(() =>
      useStarMapCommands({
        desktopApi,
        onFlyTo: async () => {
          throw new Error("layout exploded");
        },
      }),
    );

    listener?.({
      requestId: "request-1",
      kind: "fly_to",
      target: { kind: "instance", instanceId: "pwr_local" },
    });

    await waitFor(() => {
      expect(resolveStarMapCommand).toHaveBeenCalledWith({
        requestId: "request-1",
        response: {
          ok: false,
          error: { code: "internal_error", message: "layout exploded" },
        },
      });
    });
    hook.unmount();
    expect(listener).toBeUndefined();
  });
});
