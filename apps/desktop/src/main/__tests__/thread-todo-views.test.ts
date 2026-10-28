import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentEvent, FederationRemoteTarget, ListThreadTodosResponse, ThreadTodo, ThreadTodoFeedDelta, ThreadTodoFeedSnapshot,
} from "@pwragent/shared";
import { THREAD_TODO_BUSY_RETRY_MS } from "@pwragent/shared";
import { ThreadTodoViewHub } from "../thread-todos/thread-todo-views";

const peer: FederationRemoteTarget = { scope: "remote", instanceId: "peer" };
const prefs = { defaultMethod: "squash" as const, byProject: {} };

function card(id: string, threadId: string, createdAt: number, extra: Partial<ThreadTodo> = {}): ThreadTodo {
  return { id, backend: "codex", threadId, kind: "reminder", status: "open", title: id,
    createdAt, updatedAt: createdAt, ...extra };
}

function remoteId(id: string): string {
  return `remote-todo:peer:${id}`;
}

function harness(options: {
  local?: ThreadTodoFeedSnapshot;
  capable?: () => boolean;
  remoteSnapshots?: ThreadTodoFeedSnapshot[];
  list?: (request: Record<string, unknown>) => ListThreadTodosResponse;
  mounts?: Array<{ target: FederationRemoteTarget; backend: "codex"; threadId: string }>;
  hasViewers?: () => boolean;
} = {}) {
  const sent: Array<{ instanceId?: string; delta: ThreadTodoFeedDelta }> = [];
  const remoteSnapshots = [...(options.remoteSnapshots ?? [])];
  const local = { snapshot: vi.fn(async () => options.local ?? { epoch: "local", revision: 0, todos: [], mergeMethods: prefs }) };
  const remote = {
    supportsFeed: vi.fn(() => options.capable?.() ?? false),
    watchFeeds: vi.fn(),
    snapshot: vi.fn(async () => remoteSnapshots.length > 1 ? remoteSnapshots.shift()! : remoteSnapshots[0]!),
    list: vi.fn(async (_target: FederationRemoteTarget, request: Record<string, unknown>) =>
      options.list?.(request) ?? { todos: [] }),
  };
  const hub = new ThreadTodoViewHub({
    local, remote,
    mountedThreads: async () => options.mounts ?? [],
    hasViewers: options.hasViewers ?? (() => true),
    send: (target, delta) => sent.push({ instanceId: target?.instanceId, delta }),
  });
  return { hub, local, remote, sent };
}

function ownerEvent(method: string, params: unknown): AgentEvent {
  return { backend: "codex", federationTarget: peer, notification: { method, params } } as AgentEvent;
}

describe("ThreadTodoViewHub", () => {
  it("relays each local card change to the main window as one delta and never lists", async () => {
    const { hub, local, remote, sent } = harness({ local: { epoch: "local", revision: 2,
      todos: [card("seed", "t", 0)], mergeMethods: prefs } });
    const snapshot = await hub.snapshot(undefined);
    expect(snapshot.todos.map((todo) => todo.id)).toEqual(["seed"]);
    for (let revision = 3; revision <= 7; revision++) {
      hub.localDelta({ epoch: "local", revision, backend: "codex", threadId: "t",
        upserts: [card(`c${revision}`, "t", revision)], mergeMethods: prefs });
    }
    expect(sent).toHaveLength(5);
    expect(sent.every((entry) => entry.instanceId === undefined)).toBe(true);
    expect(sent.map((entry) => entry.delta.revision))
      .toEqual([1, 2, 3, 4, 5].map((step) => snapshot.revision + step));
    expect(sent.every((entry) => entry.delta.epoch === snapshot.epoch)).toBe(true);
    expect(local.snapshot).toHaveBeenCalledTimes(1);
    expect(remote.list).not.toHaveBeenCalled();
    // The local feed is live, so the window's next snapshot reads nothing.
    expect((await hub.snapshot(undefined)).todos).toHaveLength(6);
    expect(local.snapshot).toHaveBeenCalledTimes(1);
  });

  it("follows a capable owner's deltas in a remote window and re-snapshots once on a gap", async () => {
    const { hub, remote, sent } = harness({ capable: () => true, remoteSnapshots: [
      { epoch: "owner", revision: 1, todos: [card("a", "t", 1)], mergeMethods: prefs },
      { epoch: "owner", revision: 6, todos: [card("a", "t", 1), card("b", "t", 2), card("c", "t", 3)], mergeMethods: prefs },
    ] });
    const snapshot = await hub.snapshot(peer);
    expect(snapshot.todos.map((todo) => todo.id)).toEqual([remoteId("a")]);
    expect(snapshot.todos[0]).toMatchObject({ federationTarget: peer, mergeMethod: "squash" });
    hub.handleRemoteEvent(ownerEvent("thread/todos/delta", { epoch: "owner", revision: 2, backend: "codex",
      threadId: "t", upserts: [card("b", "t", 2)], mergeMethods: prefs }));
    expect(sent.map((entry) => entry.delta.upserts?.[0]?.id)).toEqual([remoteId("b")]);
    expect(sent[0]!.instanceId).toBe("peer");
    // Revision 3 never arrived.
    hub.handleRemoteEvent(ownerEvent("thread/todos/delta", { epoch: "owner", revision: 4, backend: "codex",
      threadId: "t", upserts: [card("x", "t", 9)], mergeMethods: prefs }));
    hub.handleRemoteEvent(ownerEvent("thread/todos/delta", { epoch: "owner", revision: 5, backend: "codex",
      threadId: "t", upserts: [card("y", "t", 9)], mergeMethods: prefs }));
    await vi.waitFor(() => expect(sent.map((entry) => entry.delta.upserts?.[0]?.id))
      .toEqual([remoteId("b"), remoteId("c")]));
    expect(remote.snapshot).toHaveBeenCalledTimes(2);
    expect(remote.list).not.toHaveBeenCalled();
    // Markers are for owners that send no deltas.
    hub.handleRemoteEvent(ownerEvent("thread/todos/changed", { backend: "codex", threadId: "t", at: 1 }));
    expect(remote.list).not.toHaveBeenCalled();
  });

  it("serves an owner without the capability through the list fallback", async () => {
    let todos = [card("a", "t", 1)];
    const { hub, remote, sent } = harness({ list: () => ({ todos, mergeMethods: prefs }) });
    expect((await hub.snapshot(peer)).todos.map((todo) => todo.id)).toEqual([remoteId("a")]);
    expect(remote.list).toHaveBeenCalledWith(peer, { status: "open" });
    expect(remote.snapshot).not.toHaveBeenCalled();
    todos = [card("b", "t", 2)];
    hub.handleRemoteEvent(ownerEvent("thread/todos/changed", { backend: "codex", threadId: "t", at: 2 }));
    hub.handleRemoteEvent(ownerEvent("thread/todoDetails/changed", { backend: "codex", threadId: "t", at: 2 }));
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(sent.map((entry) => [entry.delta.removedIds, entry.delta.upserts?.map((todo) => todo.id)]))
      .toEqual([[[remoteId("a")], undefined], [undefined, [remoteId("b")]]]);
    expect(remote.list).toHaveBeenCalledTimes(2);
  });

  it("keeps the quiet footnote for a disconnected owner", async () => {
    const unavailable = { instanceId: "peer", label: "Studio Mac", reason: "disconnected" as const };
    const { hub } = harness({ list: () => ({ todos: [], unavailableInstances: [unavailable] }) });
    const snapshot = await hub.snapshot(peer);
    expect(snapshot.unavailableInstances).toEqual([unavailable]);
    expect(snapshot.errors).toBeUndefined();
  });

  it("lists a mounted remote thread on its own markers, since a list never seeds the owner's feed", async () => {
    let todos = [card("a", "t", 1)];
    const { hub, remote, sent } = harness({ capable: () => true, mounts: [{ target: peer, backend: "codex", threadId: "t" }],
      list: () => ({ todos, mergeMethods: prefs }) });
    const snapshot = await hub.snapshot(undefined);
    expect(snapshot.todos.map((todo) => todo.id)).toEqual([remoteId("a")]);
    expect(remote.list).toHaveBeenCalledWith(peer, { status: "open", backend: "codex", threadId: "t" });
    // Deltas, another thread's marker and the detail companion read nothing.
    hub.handleRemoteEvent(ownerEvent("thread/todos/delta", { epoch: "owner", revision: 40, backend: "codex",
      threadId: "t", removedIds: ["a"], mergeMethods: prefs }));
    hub.handleRemoteEvent(ownerEvent("thread/todos/changed", { backend: "codex", threadId: "unmounted", at: 1 }));
    hub.handleRemoteEvent(ownerEvent("thread/todoDetails/changed", { backend: "codex", threadId: "t", at: 1 }));
    await Promise.resolve();
    expect(remote.list).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([]);
    todos = [];
    hub.handleRemoteEvent(ownerEvent("thread/todos/changed", { backend: "codex", threadId: "t", at: 2 }));
    await vi.waitFor(() => expect(sent.map((entry) => entry.delta.removedIds)).toEqual([[remoteId("a")]]));
    expect(remote.list).toHaveBeenCalledTimes(2);
    expect(remote.snapshot).not.toHaveBeenCalled();
    // A reconnect re-reads the mounted thread.
    hub.handleRemoteEvent(ownerEvent("federation/eventStream/changed", { instanceId: "peer", epoch: "s2" }));
    await vi.waitFor(() => expect(remote.list).toHaveBeenCalledTimes(3));
  });

  it("reads a capable owner once for windows that open together", async () => {
    const { hub, remote } = harness({ capable: () => true, remoteSnapshots: [
      { epoch: "owner", revision: 1, todos: [card("a", "t", 1)], mergeMethods: prefs },
    ] });
    const [first, second] = await Promise.all([hub.snapshot(peer), hub.snapshot(peer)]);
    expect(first.todos).toEqual(second.todos);
    expect(remote.snapshot).toHaveBeenCalledTimes(1);
  });

  it("switches a listed owner to its feed when it acknowledges the watch, and lists no more", async () => {
    let acknowledged = false;
    const { hub, remote, sent } = harness({ capable: () => acknowledged,
      list: () => ({ todos: [card("a", "t", 1)], mergeMethods: prefs }),
      remoteSnapshots: [{ epoch: "owner", revision: 3, todos: [card("a", "t", 1), card("b", "t", 2)], mergeMethods: prefs }] });
    expect((await hub.snapshot(peer)).todos.map((todo) => todo.id)).toEqual([remoteId("a")]);
    expect(remote.watchFeeds).toHaveBeenLastCalledWith([peer]);
    expect(remote.list).toHaveBeenCalledTimes(1);

    acknowledged = true;
    hub.handleRemoteEvent(ownerEvent("thread/todos/feedAcknowledged", { reason: "subscribed" }));
    await vi.waitFor(() => expect(sent.map((entry) => entry.delta.upserts?.[0]?.id)).toEqual([remoteId("b")]));
    expect(remote.snapshot).toHaveBeenCalledTimes(1);
    for (let revision = 4; revision <= 6; revision++) {
      hub.handleRemoteEvent(ownerEvent("thread/todos/delta", { epoch: "owner", revision, backend: "codex",
        threadId: "t", upserts: [card(`c${revision}`, "t", revision)], mergeMethods: prefs }));
      hub.handleRemoteEvent(ownerEvent("thread/todos/changed", { backend: "codex", threadId: "t", at: revision }));
    }
    await Promise.resolve();
    expect(sent.slice(1).map((entry) => entry.delta.upserts?.[0]?.id))
      .toEqual([remoteId("c4"), remoteId("c5"), remoteId("c6")]);
    // A repeated acknowledgement, from a re-sent subscription, reads nothing.
    hub.handleRemoteEvent(ownerEvent("thread/todos/feedAcknowledged", { reason: "subscribed" }));
    await Promise.resolve();
    expect(remote.snapshot).toHaveBeenCalledTimes(1);
    expect(remote.list).toHaveBeenCalledTimes(1);
  });

  it("drops a listing that returns after the view switched to the feed", async () => {
    let acknowledged = false;
    let answer: ((response: ListThreadTodosResponse) => void) | undefined;
    const { hub, remote, sent } = harness({ capable: () => acknowledged,
      remoteSnapshots: [{ epoch: "owner", revision: 1, todos: [card("new", "t", 2)], mergeMethods: prefs }] });
    remote.list.mockResolvedValueOnce({ todos: [], mergeMethods: prefs });
    await hub.snapshot(peer);
    remote.list.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    hub.handleRemoteEvent(ownerEvent("thread/todos/changed", { backend: "codex", threadId: "t", at: 1 }));
    await vi.waitFor(() => expect(answer).toBeDefined());
    acknowledged = true;
    hub.handleRemoteEvent(ownerEvent("thread/todos/feedAcknowledged", { reason: "subscribed" }));
    await vi.waitFor(() => expect(sent.map((entry) => entry.delta.upserts?.[0]?.id)).toEqual([remoteId("new")]));
    // The older listing still names a card the snapshot no longer has.
    answer!({ todos: [card("stale", "t", 1)], mergeMethods: prefs });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent.flatMap((entry) => entry.delta.upserts ?? []).map((todo) => todo.id)).toEqual([remoteId("new")]);
  });

  it("stops watching an owner's feed once no window shows it", async () => {
    let viewers = true;
    const { hub, remote } = harness({ hasViewers: () => viewers });
    await hub.snapshot(peer);
    expect(remote.watchFeeds).toHaveBeenLastCalledWith([peer]);
    viewers = false;
    hub.peerStatusChanged();
    expect(remote.watchFeeds).toHaveBeenLastCalledWith([]);
  });

  it("drops a remote view no window shows, so a sparse stream cannot read as a gap", async () => {
    let viewers = true;
    const { hub, remote } = harness({ capable: () => true, hasViewers: () => viewers, remoteSnapshots: [
      { epoch: "owner", revision: 1, todos: [], mergeMethods: prefs },
    ] });
    await hub.snapshot(peer);
    viewers = false;
    hub.handleRemoteEvent(ownerEvent("thread/todos/delta", { epoch: "owner", revision: 9, backend: "codex",
      threadId: "t", upserts: [card("a", "t", 1)], mergeMethods: prefs }));
    await Promise.resolve();
    expect(remote.snapshot).toHaveBeenCalledTimes(1);
  });

  describe("a busy owner", () => {
    // How a peer's NavigationQueryError reaches this instance over federation.
    const busy = () => Object.assign(new Error("handler_failed: [navigation_busy] Navigation changed during its owner read."), {
      code: "handler_failed",
    });
    const reconnect = () => ownerEvent("federation/eventStream/changed", { instanceId: "peer", epoch: "s2" });
    const flush = (ms = 0) => vi.advanceTimersByTimeAsync(ms);
    const errorsSent = (sent: Array<{ delta: ThreadTodoFeedDelta }>) => sent.flatMap((entry) => entry.delta.errors ?? []);
    const upsertsSent = (sent: Array<{ delta: ThreadTodoFeedDelta }>) =>
      sent.flatMap((entry) => entry.delta.upserts?.map((todo) => todo.id) ?? []);

    afterEach(() => { vi.useRealTimers(); });

    function busyFeed() {
      vi.useFakeTimers();
      return harness({ capable: () => true, remoteSnapshots: [
        { epoch: "owner", revision: 1, todos: [card("a", "t", 1)], mergeMethods: prefs },
        { epoch: "owner", revision: 2, todos: [card("a", "t", 1), card("b", "t", 2)], mergeMethods: prefs },
      ] });
    }

    it("keeps its last cards without an error and reads it once more after a short delay", async () => {
      const { hub, remote, sent } = busyFeed();
      await hub.snapshot(peer);
      remote.snapshot.mockRejectedValueOnce(busy());
      hub.handleRemoteEvent(reconnect());
      await flush();
      expect(remote.snapshot).toHaveBeenCalledTimes(2);
      expect(sent).toEqual([]);
      await flush(THREAD_TODO_BUSY_RETRY_MS);
      expect(remote.snapshot).toHaveBeenCalledTimes(3);
      expect(upsertsSent(sent)).toEqual([remoteId("b")]);
      expect(errorsSent(sent)).toEqual([]);
    });

    it("reads a still-busy owner only once more, then again on its next delta", async () => {
      const { hub, remote, sent } = busyFeed();
      await hub.snapshot(peer);
      remote.snapshot.mockRejectedValueOnce(busy()).mockRejectedValueOnce(busy());
      hub.handleRemoteEvent(reconnect());
      await flush(THREAD_TODO_BUSY_RETRY_MS * 10);
      expect(remote.snapshot).toHaveBeenCalledTimes(3);
      expect(sent).toEqual([]);
      // The feed stopped following, so the owner's next delta reads it again.
      hub.handleRemoteEvent(ownerEvent("thread/todos/delta", { epoch: "owner", revision: 2, backend: "codex",
        threadId: "t", upserts: [card("b", "t", 2)], mergeMethods: prefs }));
      await flush();
      expect(remote.snapshot).toHaveBeenCalledTimes(4);
      expect(upsertsSent(sent)).toEqual([remoteId("b")]);
    });

    it("re-lists a busy owner without the feed once, quietly", async () => {
      vi.useFakeTimers();
      const list = vi.fn((): ListThreadTodosResponse => ({ todos: [card("a", "t", 1)], mergeMethods: prefs }));
      const { hub, remote, sent } = harness({ list });
      await hub.snapshot(peer);
      remote.list.mockRejectedValueOnce(busy());
      list.mockReturnValue({ todos: [card("b", "t", 2)], mergeMethods: prefs });
      hub.handleRemoteEvent(ownerEvent("thread/todos/changed", { backend: "codex", threadId: "t", at: 2 }));
      await flush();
      expect(sent).toEqual([]);
      await flush(THREAD_TODO_BUSY_RETRY_MS);
      expect(remote.list).toHaveBeenCalledTimes(3);
      expect(upsertsSent(sent)).toEqual([remoteId("b")]);
      expect(errorsSent(sent)).toEqual([]);
    });

    it("still shows a failure that is not owner contention, without reading again", async () => {
      const { hub, remote, sent } = busyFeed();
      await hub.snapshot(peer);
      remote.snapshot.mockRejectedValueOnce(Object.assign(new Error("handler_failed: Unexpected failure"), { code: "handler_failed" }));
      hub.handleRemoteEvent(reconnect());
      await flush(THREAD_TODO_BUSY_RETRY_MS * 10);
      expect(remote.snapshot).toHaveBeenCalledTimes(2);
      expect(errorsSent(sent)).toEqual(["handler_failed: Unexpected failure"]);
    });

    describe("of a thread pinned into the main window", () => {
      const mounts = [{ target: peer, backend: "codex" as const, threadId: "t" }];
      const changed = () => ownerEvent("thread/todos/changed", { backend: "codex", threadId: "t", at: 2 });

      function pinned() {
        vi.useFakeTimers();
        const list = vi.fn((): ListThreadTodosResponse => ({ todos: [card("a", "t", 1)], mergeMethods: prefs }));
        return { list, ...harness({ list, mounts }) };
      }

      it("keeps the thread's last cards without an error and re-lists it once", async () => {
        const { hub, remote, sent, list } = pinned();
        await hub.snapshot(undefined);
        remote.list.mockRejectedValueOnce(busy());
        list.mockReturnValue({ todos: [card("b", "t", 2)], mergeMethods: prefs });
        hub.handleRemoteEvent(changed());
        await flush();
        expect(remote.list).toHaveBeenCalledTimes(2);
        expect(sent).toEqual([]);
        await flush(THREAD_TODO_BUSY_RETRY_MS);
        expect(remote.list).toHaveBeenCalledTimes(3);
        expect(upsertsSent(sent)).toEqual([remoteId("b")]);
        expect(errorsSent(sent)).toEqual([]);
      });

      it("re-lists a still-busy thread only once", async () => {
        const { hub, remote, sent } = pinned();
        await hub.snapshot(undefined);
        remote.list.mockRejectedValueOnce(busy()).mockRejectedValueOnce(busy());
        hub.handleRemoteEvent(changed());
        await flush(THREAD_TODO_BUSY_RETRY_MS * 10);
        expect(remote.list).toHaveBeenCalledTimes(3);
        expect(sent).toEqual([]);
      });

      it("still shows a failure that is not owner contention, without re-listing", async () => {
        const { hub, remote, sent } = pinned();
        await hub.snapshot(undefined);
        remote.list.mockRejectedValueOnce(new Error("Owner store failed"));
        hub.handleRemoteEvent(changed());
        await flush(THREAD_TODO_BUSY_RETRY_MS * 10);
        expect(remote.list).toHaveBeenCalledTimes(2);
        expect(errorsSent(sent)).toEqual(["peer: Owner store failed"]);
      });

      it("drops a pending re-list when the thread is unpinned", async () => {
        vi.useFakeTimers();
        const current = [...mounts];
        const { hub, remote } = harness({ mounts: current, list: () => ({ todos: [card("a", "t", 1)], mergeMethods: prefs }) });
        await hub.snapshot(undefined);
        remote.list.mockRejectedValueOnce(busy());
        hub.handleRemoteEvent(changed());
        await flush();
        current.length = 0;
        await hub.snapshot(undefined);
        await flush(THREAD_TODO_BUSY_RETRY_MS * 10);
        expect(remote.list).toHaveBeenCalledTimes(2);
      });
    });

    it("cancels a pending read when no window shows the owner any more", async () => {
      let viewers = true;
      vi.useFakeTimers();
      const { hub, remote } = harness({ capable: () => true, hasViewers: () => viewers, remoteSnapshots: [
        { epoch: "owner", revision: 1, todos: [], mergeMethods: prefs },
      ] });
      await hub.snapshot(peer);
      remote.snapshot.mockRejectedValueOnce(busy());
      hub.handleRemoteEvent(reconnect());
      await flush();
      viewers = false;
      hub.peerStatusChanged();
      await flush(THREAD_TODO_BUSY_RETRY_MS * 10);
      expect(remote.snapshot).toHaveBeenCalledTimes(2);
    });
  });
});
