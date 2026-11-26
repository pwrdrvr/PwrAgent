import "./foreground-fixture";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NAVIGATION_QUERY_PROTOCOL_VERSION,
  type NavigationQueryPage,
  type NavigationQueryRequest,
  type NavigationThreadSummary,
} from "@pwragent/shared/contracts/navigation";
import type { WriteStarMapWorkspaceRequest } from "@pwragent/shared/contracts/star-map";
import type { DesktopApi } from "../../../lib/desktop-api";
import { StarMapScreen } from "../StarMapScreen";

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function parseTransform(raw: string): { x: number; y: number; scale: number } {
  const match = /translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/.exec(
    raw,
  );
  if (!match) throw new Error(`unparsable transform: ${raw}`);
  return { x: Number(match[1]), y: Number(match[2]), scale: Number(match[3]) };
}

function remoteThread(id: string, project: string): NavigationThreadSummary {
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
    federation: {
      ref: {
        backend: "codex",
        threadId: id,
        target: { scope: "remote", instanceId: "pwr_remote" },
      },
      instanceLabel: "M2 Max",
      peerStatus: "connected",
    },
  } as unknown as NavigationThreadSummary;
}

function queryPage(
  request: NavigationQueryRequest,
  rows: NavigationThreadSummary[],
): NavigationQueryPage {
  return {
    protocol: NAVIGATION_QUERY_PROTOCOL_VERSION,
    queryKey: request.query.kind,
    generation: `${request.query.kind}-${rows.length}`,
    ownerEpoch: "epoch-1",
    countsRevision: `rev-${rows.length}`,
    coverage: { state: "complete" },
    counts: {
      total: rows.length,
      active: 0,
      unread: rows.length,
      review: rows.length,
    },
    entries:
      request.query.kind === "star-map-geometry"
        ? []
        : rows.map((thread, index) => ({
            row: {
              ...thread,
              ref: {
                backend: thread.source,
                threadId: thread.id,
                ownerInstanceId:
                  request.federationTarget?.scope === "remote"
                    ? request.federationTarget.instanceId
                    : "pwr_local",
              },
              rowRevision: `row-${thread.id}`,
              ordinaryChildCount: 0,
              nativeSubAgentGroupPresent: false,
              queueCount: 0,
              queueState: "unknown" as const,
            },
            orderKey: index.toString().padStart(10, "0"),
            placement: { kind: "root" as const },
          })),
    directories: [],
    complete: true,
  };
}

function bodyScreenPosition(instanceSelector: string): { x: number; y: number } {
  const canvas = document.querySelector<HTMLElement>(".star-map__canvas");
  if (!canvas) throw new Error("canvas not found");
  const view = parseTransform(canvas.style.transform);
  const body = document.querySelector(instanceSelector);
  const anchor = body?.closest<HTMLElement>(".star-map__anchor");
  if (!anchor) throw new Error(`anchor not found for ${instanceSelector}`);
  return {
    x: view.x + Number.parseFloat(anchor.style.left) * view.scale,
    y: view.y + Number.parseFloat(anchor.style.top) * view.scale,
  };
}

describe("StarMapScreen view restore and offline instance defaults", () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  it("keeps the home body in view instead of restoring a stale view onto empty sky", async () => {
    const remoteSnapshot = createDeferred<NavigationQueryPage>();
    const desktopApi = {
      readFederationHealth: vi.fn(async () => ({
        health: {
          enabled: true,
          role: "gateway" as const,
          status: "listening" as const,
          instanceId: "pwr_local",
          localLabel: "M5 Max",
          peers: [
            {
              id: "pwr_remote",
              label: "M2 Max",
              role: "client" as const,
              status: "connected" as const,
              capabilities: ["thread_navigation"],
              navigationQueryProtocol: NAVIGATION_QUERY_PROTOCOL_VERSION,
            },
          ],
        },
      })),
      getNavigationQueryPage: vi.fn(() => remoteSnapshot.promise),
      readStarMapWorkspace: vi.fn(async () => ({
        workspace: {
          version: 1 as const,
          revision: 5,
          updatedAt: 100,
          cards: [],
          // Saved from an earlier, much larger 12-instance canvas: on the
          // current canvas this points far into empty space past every body.
          views: { orbit: { x: -9000, y: -9000, scale: 1 } },
        },
      })),
      onAgentEvent: vi.fn(() => () => undefined),
    } as unknown as DesktopApi;

    render(
      <StarMapScreen
        desktopApi={desktopApi}
        localThreads={[]}
        sessionKeys={{}}
        localInstanceLabel="M5 Max"
        onOpenLocalThread={() => undefined}
        onFocusLocalInstance={() => undefined}
      />,
    );

    await waitFor(() => {
      expect(document.querySelector(".star-map-instance--local")).not.toBeNull();
    });
    const before = bodyScreenPosition(".star-map-instance--local");
    expect(before.x).toBeCloseTo(640, 0);
    expect(before.y).toBeCloseTo(400, 0);

    await act(async () => {
      remoteSnapshot.resolve(
        queryPage(
          {
            protocol: NAVIGATION_QUERY_PROTOCOL_VERSION,
            consumer: "star-map",
            federationTarget: { scope: "remote", instanceId: "pwr_remote" },
            query: { kind: "lens", lens: "attention" },
          },
          Array.from({ length: 24 }, (_, index) =>
            remoteThread(`r-${index}`, `proj-${index % 4}`),
          ),
        ),
      );
      await remoteSnapshot.promise;
    });

    await waitFor(() => {
      expect(
        document.querySelectorAll(".star-map-card").length,
      ).toBeGreaterThan(0);
    });
    const after = bodyScreenPosition(".star-map-instance--local");
    // Must stay centred on the local body rather than jumping to empty sky.
    expect(after.x).toBeGreaterThan(0);
    expect(after.x).toBeLessThan(1280);
    expect(after.y).toBeGreaterThan(0);
    expect(after.y).toBeLessThan(800);
  });

  it("does not double-shift a restored view when the orbit anchor moves on the settle frame", async () => {
    const remoteSnapshot = createDeferred<NavigationQueryPage>();
    const desktopApi = {
      readFederationHealth: vi.fn(async () => ({
        health: {
          enabled: true,
          role: "gateway" as const,
          status: "listening" as const,
          instanceId: "pwr_local",
          localLabel: "M5 Max",
          peers: [
            {
              id: "pwr_remote",
              label: "M2 Max",
              role: "client" as const,
              status: "connected" as const,
              capabilities: ["thread_navigation"],
              navigationQueryProtocol: NAVIGATION_QUERY_PROTOCOL_VERSION,
            },
          ],
        },
      })),
      getNavigationQueryPage: vi.fn(() => remoteSnapshot.promise),
      readStarMapWorkspace: vi.fn(async () => ({
        workspace: {
          version: 1 as const,
          revision: 6,
          updatedAt: 200,
          cards: [],
          // Anchored directly to the local body at scale 0.75: no matter how
          // far the canvas origin shifts when M2 Max's threads arrive, M5 Max
          // must stay right at viewport centre (640, 400).
          views: {
            orbit: {
              x: 0,
              y: 0,
              scale: 0.75,
              anchor: { kind: "instance" as const, instanceId: "pwr_local" },
              anchorDx: 0,
              anchorDy: 0,
            },
          },
        },
      })),
      onAgentEvent: vi.fn(() => () => undefined),
    } as unknown as DesktopApi;

    render(
      <StarMapScreen
        desktopApi={desktopApi}
        localThreads={[]}
        sessionKeys={{}}
        localInstanceLabel="M5 Max"
        onOpenLocalThread={() => undefined}
        onFocusLocalInstance={() => undefined}
      />,
    );

    await waitFor(() => {
      expect(document.querySelector(".star-map-instance--local")).not.toBeNull();
    });
    const localAnchorBefore = Number.parseFloat(
      document
        .querySelector(".star-map-instance--local")!
        .closest<HTMLElement>(".star-map__anchor")!.style.left,
    );

    await act(async () => {
      remoteSnapshot.resolve(
        queryPage(
          {
            protocol: NAVIGATION_QUERY_PROTOCOL_VERSION,
            consumer: "star-map",
            federationTarget: { scope: "remote", instanceId: "pwr_remote" },
            query: { kind: "lens", lens: "attention" },
          },
          Array.from({ length: 24 }, (_, index) =>
            remoteThread(`r-${index}`, `proj-${index % 4}`),
          ),
        ),
      );
      await remoteSnapshot.promise;
    });

    await waitFor(() => {
      const canvas = document.querySelector<HTMLElement>(".star-map__canvas");
      expect(parseTransform(canvas!.style.transform).scale).toBeCloseTo(0.75);
    });
    // Confirm precondition: the orbit anchor actually shifted on settle.
    const localAnchorAfter = Number.parseFloat(
      document
        .querySelector(".star-map-instance--local")!
        .closest<HTMLElement>(".star-map__anchor")!.style.left,
    );
    expect(Math.abs(localAnchorAfter - localAnchorBefore)).toBeGreaterThan(50);

    const after = bodyScreenPosition(".star-map-instance--local");
    expect(after.x).toBeCloseTo(640, 0);
    expect(after.y).toBeCloseTo(400, 0);
  });

  it("hides offline instances by default and upgrades legacy unversioned preferences", async () => {
    // Simulate an existing operator who previously saved another view option
    // while `hideOfflineInstances: false` was the serialized default.
    window.localStorage.setItem(
      "pwragent.starMap.viewPreferences",
      JSON.stringify({ layout: "orbit", hideOfflineInstances: false }),
    );
    const desktopApi = {
      readFederationHealth: vi.fn(async () => ({
        health: {
          enabled: true,
          role: "gateway" as const,
          status: "listening" as const,
          instanceId: "pwr_local",
          localLabel: "M5 Max",
          peers: [
            {
              id: "pwr_m2",
              label: "M2 Max",
              role: "client" as const,
              status: "connected" as const,
              capabilities: [],
            },
            {
              id: "pwr_win",
              label: "WindowsVM",
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
        localInstanceLabel="M5 Max"
        onOpenLocalThread={() => undefined}
        onFocusLocalInstance={() => undefined}
      />,
    );

    const canvas = () =>
      document.querySelector<HTMLElement>(".star-map__canvas")!;
    await waitFor(() => {
      expect(within(canvas()).getByText("M2 Max")).toBeTruthy();
    });
    // Disconnected peer must not appear on the canvas or in edge arrows.
    expect(screen.queryByText(/WindowsVM/)).toBeNull();
  });

  it("keeps a cold-start saved view framing a restored floating chat card in open sky", async () => {
    // Saved view is anchored to the local body but offset into open sky where
    // a restored chat card sits (`instanceDx: 900, instanceDy: 0`), far enough
    // that the local body itself is off-screen while the restored chat card is
    // squarely in the viewport.
    const desktopApi = {
      readFederationHealth: vi.fn(async () => ({
        health: {
          enabled: true,
          role: "gateway" as const,
          status: "listening" as const,
          instanceId: "pwr_local",
          localLabel: "M5 Max",
          peers: [],
        },
      })),
      readStarMapWorkspace: vi.fn(async () => ({
        workspace: {
          version: 1 as const,
          revision: 4,
          updatedAt: 100,
          cards: [
            {
              key: "pwr_local::codex:t-floating",
              ownerInstanceId: "pwr_local",
              thread: {
                id: "t-floating",
                inbox: { inInbox: true },
                linkedDirectories: [],
                source: "codex" as const,
                title: "Floating chat in open sky",
                titleSource: "derived" as const,
              },
              geometry: {
                anchor: { kind: "instance" as const, instanceId: "pwr_local" },
                dx: 900,
                dy: 0,
                instanceDx: 900,
                instanceDy: 0,
                fallbackRect: { left: 1200, top: 200, width: 420, height: 520 },
              },
              contextOpen: false,
              terminalOpen: false,
            },
          ],
          views: {
            orbit: {
              x: -900,
              y: 0,
              scale: 0.85,
              anchor: { kind: "instance" as const, instanceId: "pwr_local" },
              anchorDx: 1050,
              anchorDy: 200,
            },
          },
        },
      })),
      onAgentEvent: vi.fn(() => () => undefined),
    } as unknown as DesktopApi;

    render(
      <StarMapScreen
        desktopApi={desktopApi}
        localThreads={[]}
        sessionKeys={{}}
        localInstanceLabel="M5 Max"
        onOpenLocalThread={() => undefined}
        onFocusLocalInstance={() => undefined}
      />,
    );

    await screen.findByRole("region", {
      name: "Chat: Floating chat in open sky",
    });
    await waitFor(() => {
      const canvas = document.querySelector<HTMLElement>(".star-map__canvas");
      expect(parseTransform(canvas!.style.transform).scale).toBeCloseTo(0.85);
    });
  });

  it("does not persist a mismatched anchor kind when switching layouts during a pending wheel pan", async () => {
    const writes: WriteStarMapWorkspaceRequest[] = [];
    const writeStarMapWorkspace = vi.fn(
      async (request: WriteStarMapWorkspaceRequest) => {
        writes.push(request);
        return {
          workspace: {
            ...request.workspace,
            revision: request.baseRevision + 1,
            updatedAt: 300,
          },
        };
      },
    );
    const localThread: NavigationThreadSummary = {
      id: "t-proj",
      title: "Project thread",
      titleSource: "generated",
      linkedDirectories: [
        {
          id: "proj-alpha-dir",
          label: "Alpha",
          path: "/repos/Alpha",
          kind: "local",
        },
      ],
      source: "codex",
      inbox: { inInbox: true, reason: "updated-since-seen" },
      updatedAt: 100,
    } as unknown as NavigationThreadSummary;

    const desktopApi = {
      readFederationHealth: vi.fn(async () => ({
        health: {
          enabled: true,
          role: "gateway" as const,
          status: "listening" as const,
          instanceId: "pwr_local",
          localLabel: "M5 Max",
          peers: [],
        },
      })),
      readStarMapWorkspace: vi.fn(async () => ({
        workspace: {
          version: 1 as const,
          revision: 1,
          updatedAt: 100,
          cards: [],
          views: {
            projects: {
              x: 0,
              y: 0,
              scale: 0.9,
              anchor: { kind: "project" as const, projectKey: "/repos/Alpha" },
              anchorDx: 0,
              anchorDy: 0,
            },
          },
        },
      })),
      writeStarMapWorkspace,
      onAgentEvent: vi.fn(() => () => undefined),
    } as unknown as DesktopApi;

    render(
      <StarMapScreen
        desktopApi={desktopApi}
        localThreads={[localThread]}
        sessionKeys={{}}
        localInstanceLabel="M5 Max"
        onOpenLocalThread={() => undefined}
        onFocusLocalInstance={() => undefined}
      />,
    );

    await waitFor(() => {
      expect(document.querySelector(".star-map-instance--local")).not.toBeNull();
    });

    // Start a trackpad wheel pan in orbit (leaving wheelIdleTimer pending).
    const viewport = document.querySelector<HTMLElement>(".star-map__viewport")!;
    fireEvent.wheel(viewport, { deltaX: 40, deltaY: 30 });

    // Switch layout to Projects before the wheel idle timer fires.
    fireEvent.click(screen.getByRole("button", { name: "View" }));
    fireEvent.click(screen.getByRole("button", { name: "Projects" }));

    await waitFor(() => {
      expect(document.querySelector(".star-map__project-cloud")).not.toBeNull();
    });
    // Allow any queued writes to flush.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
    });

    // No write may ever store a `kind: "project"` anchor under `views.orbit`.
    for (const request of writes) {
      const orbitAnchor = request.workspace.views.orbit?.anchor;
      if (orbitAnchor) {
        expect(orbitAnchor.kind).toBe("instance");
      }
    }
  });
});
