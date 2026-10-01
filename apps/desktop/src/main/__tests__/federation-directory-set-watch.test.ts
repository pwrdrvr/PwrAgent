import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, FederationCapability, FederationProtocolEnvelope } from "@pwragent/shared";

const announcer = vi.hoisted(() => ({ setWatched: vi.fn(), observe: vi.fn() }));
vi.mock("../app-server/navigation-query-source", async (importOriginal) => ({
  ...await importOriginal<typeof import("../app-server/navigation-query-source")>(),
  getNavigationDirectorySetAnnouncer: () => announcer,
}));

import {
  DesktopFederationRuntime,
  eventMatchesThreadSelection,
  federationEventClassForMethod,
} from "../federation/federation-runtime";
import { FederationRouter } from "../federation/federation-router";

type Runtime = {
  localInstanceId: string;
  router: FederationRouter;
  visiblePeers: () => unknown[];
  applyEventSubscription: (envelope: FederationProtocolEnvelope, peerId: string) => boolean;
  forwardLocalBackendEvent: (event: AgentEvent) => void;
  publishRemoteBackendEvent: (envelope: FederationProtocolEnvelope, peerId: string) => boolean;
  publishPeerStatus: (instanceId: string, status: string) => void;
  removeEventSubscriptionsForPeer: (peerId: string) => void;
  watchRemoteDirectorySet: (instanceId: string) => { generation: number } | undefined;
  setEventSubscriptions: DesktopFederationRuntime["setEventSubscriptions"];
};

/** A subscription notification's parameters. */
const paramsOf = (envelope: FederationProtocolEnvelope) =>
  (envelope as { params?: unknown }).params as { eventClasses: string[]; threadSelection?: unknown };

const VIEWER_CAPABILITIES: FederationCapability[] = ["thread_navigation", "event_subscriptions"];
const OWNER_CAPABILITIES: FederationCapability[] = [
  "thread_navigation", "event_subscriptions", "navigation_directory_set_events",
];

/**
 * A viewer and an owner joined by routers. `relay` rewrites each viewer
 * subscription on its way to the owner, the way an intermediate gateway can,
 * or holds it (undefined) as a slow path does.
 */
function federation(options: {
  ownerCapabilities?: FederationCapability[];
  relay?: (envelope: FederationProtocolEnvelope) => FederationProtocolEnvelope | undefined;
} = {}) {
  const ownerCapabilities = options.ownerCapabilities ?? OWNER_CAPABILITIES;
  const owner = new DesktopFederationRuntime() as unknown as Runtime;
  owner.localInstanceId = "owner_one";
  owner.router = new FederationRouter({ localInstanceId: "owner_one" });
  const viewer = new DesktopFederationRuntime() as unknown as Runtime;
  viewer.localInstanceId = "viewer_one";
  viewer.router = new FederationRouter({ localInstanceId: "viewer_one" });
  let ownerStatus = "connected";
  viewer.visiblePeers = () => [{
    id: "owner_one", label: "Owner", role: "client", status: ownerStatus, capabilities: ownerCapabilities,
  }];
  const subscriptions: FederationProtocolEnvelope[] = [];
  const delivered: string[] = [];
  viewer.router.registerConnection({
    peerId: "owner_one",
    capabilities: ownerCapabilities,
    sendEnvelope: (envelope) => {
      subscriptions.push(envelope);
      const relayed = options.relay ? options.relay(envelope) : envelope;
      if (relayed) owner.applyEventSubscription(relayed, "viewer_one");
    },
  });
  owner.router.registerConnection({
    peerId: "viewer_one",
    capabilities: VIEWER_CAPABILITIES,
    sendEnvelope: (envelope) => {
      if (envelope.kind === "notification" && envelope.method === "backend.event") {
        delivered.push((envelope.params as AgentEvent).notification.method);
      }
      viewer.publishRemoteBackendEvent(envelope, "owner_one");
    },
  });
  return {
    owner,
    viewer,
    subscriptions,
    delivered,
    setOwnerStatus: (status: string) => {
      ownerStatus = status;
      viewer.publishPeerStatus("owner_one", status);
    },
    ownerPublishes: (method: string, params: Record<string, unknown> = {}) =>
      owner.forwardLocalBackendEvent({ backend: "codex", notification: { method, params } } as AgentEvent),
  };
}

describe("directory-set watch", () => {
  beforeEach(() => {
    announcer.setWatched.mockClear();
  });

  it("classifies the announcement as a threadless class of its own", () => {
    expect(federationEventClassForMethod("navigation/directorySet/changed")).toBe("directory_set");
    expect(eventMatchesThreadSelection(
      { backend: "codex", notification: { method: "navigation/directorySet/changed", params: { reason: "changed" } } },
      "directory_set",
      { kind: "threads", threads: [] },
    )).toBe(true);
  });

  it("goes live only on the owner's acknowledgement, and moves with every announcement", () => {
    const { viewer, subscriptions, delivered, ownerPublishes } = federation();

    const first = viewer.watchRemoteDirectorySet("owner_one");
    expect(subscriptions).toHaveLength(1);
    expect(paramsOf(subscriptions[0]!)).toMatchObject({ eventClasses: ["directory_set"] });
    // Watching never widens another class's demand through a legacy relay.
    expect(paramsOf(subscriptions[0]!).threadSelection).not.toEqual({ kind: "all" });
    expect(announcer.setWatched).toHaveBeenLastCalledWith(true);
    expect(delivered).toEqual(["navigation/directorySet/changed"]);
    expect(first).toEqual({ generation: expect.any(Number) });

    // Asking again sends nothing and keeps the generation.
    expect(viewer.watchRemoteDirectorySet("owner_one")).toEqual(first);
    expect(subscriptions).toHaveLength(1);

    // Turn and row traffic never reaches a directory-set subscriber.
    ownerPublishes("turn/completed", { threadId: "thread-1" });
    ownerPublishes("navigation/invalidated", { sourceMethod: "thread/started", threadId: "thread-1" });
    expect(viewer.watchRemoteDirectorySet("owner_one")).toEqual(first);

    ownerPublishes("navigation/directorySet/changed", { reason: "changed" });
    const changed = viewer.watchRemoteDirectorySet("owner_one");
    expect(changed!.generation).toBeGreaterThan(first!.generation);
    expect(delivered).toEqual(["navigation/directorySet/changed", "navigation/directorySet/changed"]);
  });

  it("re-acknowledges a re-sent subscription under a new generation", () => {
    let hold = false;
    const held: FederationProtocolEnvelope[] = [];
    const { owner, viewer, subscriptions, ownerPublishes } = federation({
      relay: (envelope) => {
        if (!hold) return envelope;
        held.push(envelope);
        return undefined;
      },
    });
    const first = viewer.watchRemoteDirectorySet("owner_one")!;

    // Another consumer's demand re-sends the aggregate subscription. Until
    // the owner acknowledges it, nothing read before may be trusted.
    hold = true;
    viewer.setEventSubscriptions("pins", [{
      sourceInstanceId: "owner_one", eventClasses: ["navigation"], threadSelection: { kind: "threads", threads: [] },
    }]);
    expect(subscriptions).toHaveLength(2);
    expect(viewer.watchRemoteDirectorySet("owner_one")).toBeUndefined();

    owner.applyEventSubscription(held[0]!, "viewer_one");
    const second = viewer.watchRemoteDirectorySet("owner_one")!;
    expect(second.generation).toBeGreaterThan(first.generation);

    // Per-class selections now ride the wire; announcements still arrive.
    ownerPublishes("navigation/directorySet/changed", { reason: "changed" });
    expect(viewer.watchRemoteDirectorySet("owner_one")!.generation).toBeGreaterThan(second.generation);
  });

  it("drops the watch on a status change until the owner acknowledges again", () => {
    const { viewer, setOwnerStatus } = federation();
    const first = viewer.watchRemoteDirectorySet("owner_one")!;

    setOwnerStatus("offline");
    expect(viewer.watchRemoteDirectorySet("owner_one")).toBeUndefined();
    setOwnerStatus("connected");
    expect(viewer.watchRemoteDirectorySet("owner_one")).toBeUndefined();
    // The reconnect replays desired subscriptions; the owner acknowledges.
    viewer.setEventSubscriptions("pins", [{
      sourceInstanceId: "owner_one", eventClasses: ["navigation"], threadSelection: { kind: "threads", threads: [] },
    }]);
    expect(viewer.watchRemoteDirectorySet("owner_one")!.generation).toBeGreaterThan(first.generation);
  });

  it("never goes live through a relay that drops the class", () => {
    const { viewer, subscriptions, delivered } = federation({
      relay: (envelope) => ({
        ...envelope,
        params: {
          ...paramsOf(envelope),
          eventClasses: paramsOf(envelope).eventClasses
            .filter((eventClass) => eventClass !== "directory_set"),
        },
      }) as FederationProtocolEnvelope,
    });
    expect(viewer.watchRemoteDirectorySet("owner_one")).toBeUndefined();
    expect(subscriptions).toHaveLength(1);
    expect(delivered).toEqual([]);
    expect(viewer.watchRemoteDirectorySet("owner_one")).toBeUndefined();
  });

  it("does not watch an owner that cannot announce", () => {
    const { viewer, subscriptions } = federation({
      ownerCapabilities: ["thread_navigation", "event_subscriptions"],
    });
    expect(viewer.watchRemoteDirectorySet("owner_one")).toBeUndefined();
    expect(subscriptions).toEqual([]);
  });

  it("releases a peer's watch once the menus stop asking about it", () => {
    vi.useFakeTimers();
    try {
      const { viewer, subscriptions } = federation();
      const first = viewer.watchRemoteDirectorySet("owner_one")!;

      // Each check keeps the watch for another ten minutes.
      vi.advanceTimersByTime(9 * 60_000);
      expect(viewer.watchRemoteDirectorySet("owner_one")).toEqual(first);
      vi.advanceTimersByTime(9 * 60_000);
      expect(subscriptions).toHaveLength(1);
      expect(announcer.setWatched).toHaveBeenLastCalledWith(true);

      vi.advanceTimersByTime(60_000);
      expect(subscriptions).toHaveLength(2);
      expect(paramsOf(subscriptions[1]!).eventClasses).not.toContain("directory_set");
      expect(announcer.setWatched).toHaveBeenLastCalledWith(false);

      // A later watch starts over under a generation no earlier read carries.
      const next = viewer.watchRemoteDirectorySet("owner_one")!;
      expect(subscriptions).toHaveLength(3);
      expect(next.generation).toBeGreaterThan(first.generation);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops the owner's announcer when its last watcher leaves", () => {
    const { owner, viewer } = federation();
    viewer.watchRemoteDirectorySet("owner_one");
    expect(announcer.setWatched).toHaveBeenLastCalledWith(true);
    owner.removeEventSubscriptionsForPeer("viewer_one");
    expect(announcer.setWatched).toHaveBeenLastCalledWith(false);
  });
});
