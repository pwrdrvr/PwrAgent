import { describe, expect, it, vi } from "vitest";
import type {
  AgentEvent,
  FederationCapability,
  FederationProtocolEnvelope,
  FederationRemoteTarget,
  ListThreadTodosResponse,
  ThreadTodo,
  ThreadTodoFeedDelta,
  ThreadTodoFeedSnapshot,
} from "@pwragent/shared";

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
import { ThreadTodoViewHub } from "../thread-todos/thread-todo-views";

type Runtime = Pick<DesktopFederationRuntime, "remotePeerSupportsTodoFeed" | "setTodoFeedWatches"
  | "onRemoteBackendEvent" | "setRendererEventSubscriptions" | "publishThreadTodoDelta" | "publishThreadTodosChanged"> & {
  localInstanceId: string;
  router: FederationRouter;
  gatewayInstanceId?: string;
  visiblePeers: () => unknown[];
  applyEventSubscription: (envelope: FederationProtocolEnvelope, peerId: string) => boolean;
  publishRemoteBackendEvent: (envelope: FederationProtocolEnvelope, peerId: string) => boolean;
  publishPeerStatus: (instanceId: string, status: string) => void;
};

const owner: FederationRemoteTarget = { scope: "remote", instanceId: "owner_one" };
const prefs = { defaultMethod: "squash" as const, byProject: {} };
const CAPABILITIES: FederationCapability[] = [
  "gateway_relay", "thread_navigation", "thread_detail", "event_subscriptions", "thread_todos", "thread_todo_feed",
];

function card(id: string, createdAt: number): ThreadTodo {
  return { id, backend: "codex", threadId: "t", kind: "reminder", status: "open", title: id, createdAt, updatedAt: createdAt };
}

function connection(peerId: string, sendEnvelope: (envelope: FederationProtocolEnvelope) => void) {
  return { peerId, sessionId: `session:${peerId}`, capabilities: CAPABILITIES, sendEnvelope, close: () => undefined };
}

function runtime(id: string): Runtime {
  const instance = new DesktopFederationRuntime() as unknown as Runtime;
  instance.localInstanceId = id;
  instance.router = new FederationRouter({ localInstanceId: id });
  return instance;
}

/**
 * A viewer that reaches the owner only through a gateway, with the hub that
 * serves the viewer's remote To-do window. `legacyGateway` stands in for a
 * gateway built before the `todo_feed` class: its class filter drops it.
 */
function relayed(options: { legacyGateway?: boolean } = {}) {
  const viewer = runtime("viewer_one");
  const gateway = runtime("gateway_one");
  const ownerRuntime = runtime("owner_one");
  viewer.gatewayInstanceId = "gateway_one";
  ownerRuntime.gatewayInstanceId = "gateway_one";
  viewer.visiblePeers = () => [
    { id: "owner_one", label: "Owner", role: "client", status: "connected", capabilities: CAPABILITIES },
  ];
  const ownerFrames: string[] = [];
  viewer.router.registerConnection(connection("gateway_one", (envelope) => {
    const params = (envelope as { params?: { eventClasses?: string[] } }).params;
    const relayed = options.legacyGateway && params?.eventClasses
      ? { ...envelope, params: { ...params, eventClasses: params.eventClasses.filter((name) => name !== "todo_feed") } }
      : envelope;
    gateway.applyEventSubscription(relayed as FederationProtocolEnvelope, "viewer_one");
  }));
  gateway.router.registerConnection(connection("viewer_one",
    (envelope) => viewer.publishRemoteBackendEvent(envelope, "gateway_one")));
  gateway.router.registerConnection(connection("owner_one",
    (envelope) => ownerRuntime.applyEventSubscription(envelope, "gateway_one")));
  ownerRuntime.router.registerConnection(connection("gateway_one", (envelope) => {
    if (envelope.kind === "notification" && envelope.method === "backend.event") {
      ownerFrames.push((envelope.params as AgentEvent).notification.method);
    }
    gateway.publishRemoteBackendEvent(envelope, "owner_one");
  }));

  // The owner's RPC answers; requests are not what these tests cover.
  let ownerCards = [card("a", 1)];
  let revision = 0;
  const remote = {
    snapshot: vi.fn(async (): Promise<ThreadTodoFeedSnapshot> =>
      ({ epoch: "owner-epoch", revision, todos: ownerCards, mergeMethods: prefs })),
    list: vi.fn(async (): Promise<ListThreadTodosResponse> => ({ todos: ownerCards, mergeMethods: prefs })),
  };
  const sent: ThreadTodoFeedDelta[] = [];
  const hub = new ThreadTodoViewHub({
    local: { snapshot: async () => ({ epoch: "local", revision: 0, todos: [] }) },
    remote: {
      supportsFeed: (target) => viewer.remotePeerSupportsTodoFeed(target),
      watchFeeds: (targets) => viewer.setTodoFeedWatches(targets.map((target) => target.instanceId)),
      ...remote,
    },
    mountedThreads: async () => [],
    hasViewers: () => true,
    send: (_target, delta) => sent.push(delta),
  });
  viewer.onRemoteBackendEvent((event) => hub.handleRemoteEvent(event));
  // The remote window's own navigation subscription.
  viewer.setRendererEventSubscriptions(9, "remote-window", [{
    sourceInstanceId: "owner_one", eventClasses: ["navigation"], threadSelection: { kind: "all" },
  }]);
  return {
    viewer, ownerRuntime, hub, remote, sent, ownerFrames,
    /** The owner changes one card and publishes it both ways it can. */
    ownerAdds: (todo: ThreadTodo) => {
      ownerCards = [todo, ...ownerCards];
      revision += 1;
      ownerRuntime.publishThreadTodoDelta({ epoch: "owner-epoch", revision, backend: "codex", threadId: "t",
        upserts: [todo], mergeMethods: prefs });
      ownerRuntime.publishThreadTodosChanged({ backend: "codex", threadId: "t", at: revision });
    },
  };
}

const upserted = (sent: ThreadTodoFeedDelta[]) => sent.flatMap((delta) => delta.upserts ?? []).map((todo) => todo.id);

describe("To-do feed through a gateway relay", () => {
  it("classifies the acknowledgement as a threadless class of its own", () => {
    expect(federationEventClassForMethod("thread/todos/feedAcknowledged")).toBe("todo_feed");
    expect(federationEventClassForMethod("thread/todos/delta")).toBe("navigation");
    expect(eventMatchesThreadSelection(
      { backend: "codex", notification: { method: "thread/todos/feedAcknowledged", params: { reason: "subscribed" } } },
      "todo_feed",
      { kind: "threads", threads: [] },
    )).toBe(true);
  });

  it("follows a relayed owner behind a capable gateway through deltas, with no list after the snapshot", async () => {
    const { viewer, hub, remote, sent, ownerFrames, ownerAdds } = relayed();
    const snapshot = await hub.snapshot(owner);
    expect(ownerFrames).toContain("thread/todos/feedAcknowledged");
    expect(viewer.remotePeerSupportsTodoFeed(owner)).toBe(true);
    expect(remote.snapshot).toHaveBeenCalledTimes(1);
    expect(remote.list).not.toHaveBeenCalled();
    expect(snapshot.todos.map((todo) => todo.id)).toEqual(["remote-todo:owner_one:a"]);

    for (let index = 1; index <= 4; index++) ownerAdds(card(`n${index}`, 1 + index));
    await Promise.resolve();
    expect(upserted(sent)).toEqual(["n1", "n2", "n3", "n4"].map((id) => `remote-todo:owner_one:${id}`));
    expect(sent.map((delta) => delta.revision)).toEqual([1, 2, 3, 4].map((step) => snapshot.revision + step));
    expect(remote.snapshot).toHaveBeenCalledTimes(1);
    expect(remote.list).not.toHaveBeenCalled();

    // A lost connection clears the proof until the owner acknowledges again.
    viewer.publishPeerStatus("owner_one", "disconnected");
    expect(viewer.remotePeerSupportsTodoFeed(owner)).toBe(false);
    // The gateway replays the subscription before it announces the owner, so
    // the acknowledgement can come first; the announcement must not void it.
    viewer.setTodoFeedWatches([]);
    viewer.setTodoFeedWatches(["owner_one"]);
    viewer.publishPeerStatus("owner_one", "connected");
    expect(viewer.remotePeerSupportsTodoFeed(owner)).toBe(true);
  });

  it("lists a relayed owner behind an older gateway, which never relays the acknowledgement", async () => {
    const { viewer, hub, remote, sent, ownerFrames, ownerAdds } = relayed({ legacyGateway: true });
    const snapshot = await hub.snapshot(owner);
    expect(viewer.remotePeerSupportsTodoFeed(owner)).toBe(false);
    expect(remote.snapshot).not.toHaveBeenCalled();
    expect(remote.list).toHaveBeenCalledTimes(1);
    expect(snapshot.todos.map((todo) => todo.id)).toEqual(["remote-todo:owner_one:a"]);

    ownerAdds(card("n1", 2));
    // The owner sends no delta down a path that did not prove it relays them.
    expect(ownerFrames).not.toContain("thread/todos/delta");
    expect(ownerFrames).not.toContain("thread/todos/feedAcknowledged");
    await vi.waitFor(() => expect(upserted(sent)).toEqual(["remote-todo:owner_one:n1"]));
    expect(remote.list).toHaveBeenCalledTimes(2);
    expect(remote.snapshot).not.toHaveBeenCalled();
  });
});
