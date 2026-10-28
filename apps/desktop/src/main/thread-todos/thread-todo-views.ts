import { randomUUID } from "node:crypto";
import type {
  AgentEvent,
  AppServerBackendKind,
  FederationRemoteTarget,
  ListThreadTodosRequest,
  ListThreadTodosResponse,
  ThreadTodo,
  ThreadTodoFeedDelta,
  ThreadTodoFeedSnapshot,
  ThreadTodoMergeMethodPreferences,
  ThreadTodosChangedEvent,
  TodoUnavailableInstance,
} from "@pwragent/shared";
import {
  compareThreadTodosNewestFirst,
  THREAD_TODO_FEED_ACKNOWLEDGED_METHOD,
  ThreadTodoFeedFollower,
} from "@pwragent/shared";
import { projectRemoteThreadTodo, remoteThreadTodoId } from "../federation/federation-thread-todos";
import { expectedNavigationReadFailure } from "../../shared/navigation-ipc-result";

type Mount = { target: FederationRemoteTarget; backend: AppServerBackendKind; threadId: string };

export type ThreadTodoViewHubOptions = {
  /** This owner's live feed. */
  local: { snapshot: () => Promise<ThreadTodoFeedSnapshot> };
  remote: {
    /** The owner sends this viewer deltas: see `remotePeerSupportsTodoFeed`. */
    supportsFeed: (target: FederationRemoteTarget) => boolean;
    /**
     * The owners a remote view shows. A relayed owner's feed is followed
     * once it acknowledges the watch, which arrives as a remote event.
     */
    watchFeeds: (targets: FederationRemoteTarget[]) => void;
    /** `threadTodos.snapshot`: owner-local ids. */
    snapshot: (target: FederationRemoteTarget) => Promise<ThreadTodoFeedSnapshot>;
    /** `threadTodos.list`: owner-local ids; a quiet footnote when unavailable. */
    list: (target: FederationRemoteTarget, request: ListThreadTodosRequest) => Promise<ListThreadTodosResponse>;
  };
  /** Remote threads pinned into the main window. */
  mountedThreads: () => Promise<Mount[]>;
  /** Whether a window shows this view: none for the local view, else its owner. */
  hasViewers: (target: FederationRemoteTarget | undefined) => boolean;
  send: (target: FederationRemoteTarget | undefined, delta: ThreadTodoFeedDelta) => void;
  onUnavailable?: (error: unknown) => void;
};

/** How long a busy owner's view waits before it reads the owner once more. */
export const THREAD_TODO_BUSY_RETRY_MS = 1_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** One task at a time; asks during a run make one more run after it. */
class Coalesced {
  private running: Promise<void> | undefined;
  private again = false;

  constructor(private readonly task: () => Promise<void>) {}

  run(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    const running = this.loop();
    this.running = running;
    return running;
  }

  private async loop(): Promise<void> {
    await Promise.resolve();
    try {
      do {
        this.again = false;
        await this.task();
      } while (this.again);
    } finally {
      this.running = undefined;
    }
  }
}

/**
 * What one kind of window shows, with its own revision: one delta per card
 * change. Cards come from named sources, so one source's read replaces only
 * its own cards and status. Until the first snapshot is served no window
 * holds a revision of it, so it sends nothing.
 */
class TodoView {
  readonly epoch = randomUUID();
  private revision = 0;
  private sending = false;
  private readonly cards = new Map<string, { todo: ThreadTodo; source: string }>();
  private mergeMethods: ThreadTodoMergeMethodPreferences | undefined;
  private readonly errors = new Map<string, string[]>();
  private readonly unavailable = new Map<string, TodoUnavailableInstance[]>();

  constructor(private readonly send: (delta: ThreadTodoFeedDelta) => void) {}

  snapshot(): ThreadTodoFeedSnapshot {
    this.sending = true;
    const errors = this.errorList();
    const unavailable = this.unavailableList();
    return {
      epoch: this.epoch,
      revision: this.revision,
      todos: [...this.cards.values()].map((entry) => entry.todo).sort(compareThreadTodosNewestFirst),
      ...(this.mergeMethods ? { mergeMethods: this.mergeMethods } : {}),
      ...(errors.length > 0 ? { errors } : {}),
      ...(unavailable.length > 0 ? { unavailableInstances: unavailable } : {}),
    };
  }

  replaceSource(source: string, todos: ThreadTodo[]): void {
    const next = new Set(todos.map((todo) => todo.id));
    const removed = [...this.cards.entries()]
      .filter(([id, entry]) => entry.source === source && !next.has(id))
      .map(([, entry]) => entry.todo)
      .sort(compareThreadTodosNewestFirst);
    for (const todo of removed) this.remove(todo.id);
    for (const todo of [...todos].sort(compareThreadTodosNewestFirst)) this.upsert(source, todo);
  }

  upsert(source: string, todo: ThreadTodo): void {
    const current = this.cards.get(todo.id);
    if (current?.source === source && same(current.todo, todo)) return;
    this.cards.set(todo.id, { todo, source });
    this.emit({ upserts: [todo] });
  }

  remove(id: string): void {
    if (this.cards.delete(id)) this.emit({ removedIds: [id] });
  }

  setMergeMethods(mergeMethods: ThreadTodoMergeMethodPreferences | undefined): void {
    if (!mergeMethods || same(mergeMethods, this.mergeMethods)) return;
    this.mergeMethods = mergeMethods;
    this.emit({ mergeMethods });
  }

  setStatus(source: string, errors?: readonly string[], unavailable?: readonly TodoUnavailableInstance[]): void {
    const beforeErrors = this.errorList();
    const beforeUnavailable = this.unavailableList();
    if (errors?.length) this.errors.set(source, [...errors]);
    else this.errors.delete(source);
    if (unavailable?.length) this.unavailable.set(source, [...unavailable]);
    else this.unavailable.delete(source);
    const change: Partial<ThreadTodoFeedDelta> = {};
    const nextErrors = this.errorList();
    const nextUnavailable = this.unavailableList();
    if (!same(beforeErrors, nextErrors)) change.errors = nextErrors;
    if (!same(beforeUnavailable, nextUnavailable)) change.unavailableInstances = nextUnavailable;
    if (Object.keys(change).length > 0) this.emit(change);
  }

  /** Drops a source's cards and status. */
  clearSource(source: string): void {
    this.replaceSource(source, []);
    this.setStatus(source);
  }

  private errorList(): string[] {
    return [...this.errors.values()].flat();
  }

  private unavailableList(): TodoUnavailableInstance[] {
    return [...new Map([...this.unavailable.values()].flat()
      .map((instance) => [instance.instanceId, instance])).values()];
  }

  private emit(change: Partial<ThreadTodoFeedDelta>): void {
    this.revision += 1;
    if (this.sending) this.send({ ...change, epoch: this.epoch, revision: this.revision });
  }
}

type RemoteView = {
  target: FederationRemoteTarget;
  view: TodoView;
  mode: "feed" | "list" | undefined;
  follower: ThreadTodoFeedFollower;
  listing: Coalesced;
  /** The one deferred read a busy owner gets. */
  busyRetry?: ReturnType<typeof setTimeout>;
  busyRetrySpent: boolean;
};

type MountEntry = {
  key: string;
  mount: Mount;
  source: string;
  refresh: Coalesced;
  /** The one deferred re-list a busy owner gets. */
  busyRetry?: ReturnType<typeof setTimeout>;
  busyRetrySpent: boolean;
};

/**
 * The To-do state each window shows, kept in step with its owners.
 *
 * The main window shows this owner's live feed plus its pinned remote
 * threads. A remote window shows one owner. An owner that sends this viewer
 * deltas is read once with `threadTodos.snapshot` and then followed through
 * them; any other owner is listed again on each of its change markers. A
 * relayed owner is listed until its feed acknowledgement arrives, then
 * followed. Either way a window receives deltas: one snapshot, then one
 * delta per card that changed. A pinned thread is listed when it is pinned,
 * after a reconnect, and on each of its owner's change markers for it.
 */
export class ThreadTodoViewHub {
  private localView: TodoView | undefined;
  private readonly localFollower: ThreadTodoFeedFollower;
  private readonly remoteViews = new Map<string, RemoteView>();
  private readonly mounts = new Map<string, MountEntry>();

  constructor(private readonly options: ThreadTodoViewHubOptions) {
    this.localFollower = new ThreadTodoFeedFollower({
      fetch: () => this.options.local.snapshot(),
      onSnapshot: (snapshot) => {
        const view = this.local();
        view.replaceSource("local", snapshot.todos);
        view.setMergeMethods(snapshot.mergeMethods);
        view.setStatus("local");
      },
      onDelta: (delta) => {
        const view = this.local();
        for (const id of delta.removedIds ?? []) view.remove(id);
        for (const todo of delta.upserts ?? []) view.upsert("local", todo);
        view.setMergeMethods(delta.mergeMethods);
      },
      onError: (error) => this.local().setStatus("local", [errorMessage(error)]),
    });
  }

  /** The window's view at its current revision. */
  async snapshot(target: FederationRemoteTarget | undefined): Promise<ThreadTodoFeedSnapshot> {
    if (target) {
      const remote = this.remoteView(target);
      await this.resyncRemote(remote);
      return remote.view.snapshot();
    }
    const view = this.local();
    await Promise.all([this.localFollower.ensure(), this.syncMounts()]);
    return view.snapshot();
  }

  /** A delta from this owner's feed. */
  localDelta(delta: ThreadTodoFeedDelta): void {
    this.localFollower.receive(delta);
  }

  /** A local change marker; reads the feed again if its last read failed. */
  localChanged(): void {
    if (this.localView && !this.localFollower.following) void this.localFollower.ensure();
  }

  handleRemoteEvent(event: AgentEvent): void {
    const target = event.federationTarget;
    if (target?.scope !== "remote") return;
    const method = event.notification.method;
    const params = event.notification.params as Partial<ThreadTodoFeedDelta & ThreadTodosChangedEvent>;
    const isDelta = method === "thread/todos/delta";
    // Its `thread/todoDetails/changed` companion names the same change for
    // detail viewers; reading both would list twice.
    const isMarker = method === "thread/todos/changed";
    const isReconnect = method === "federation/eventStream/changed";
    const isFeedAcknowledged = method === THREAD_TODO_FEED_ACKNOWLEDGED_METHOD;
    if (!isDelta && !isMarker && !isReconnect && !isFeedAcknowledged) return;

    let remote = this.remoteViews.get(target.instanceId);
    if (remote && !this.options.hasViewers(target)) {
      // No window holds a full stream from this owner any more, so its
      // deltas would read as gaps. A new window starts a new view.
      this.dropRemote(remote);
      remote = undefined;
    }
    if (remote) {
      if (isReconnect) void this.resyncRemote(remote);
      // The owner now sends deltas; a view that was listing reads its feed.
      else if (isFeedAcknowledged && remote.mode !== "feed") void this.resyncRemote(remote);
      else if (isDelta && remote.mode === "feed") {
        remote.follower.receive(params as ThreadTodoFeedDelta);
        // A failed read stops the feed; the owner's next change reads it again.
        if (!remote.follower.following) void this.resyncRemote(remote);
      }
      else if (isMarker && remote.mode === "list") void remote.listing.run();
    }

    if (isFeedAcknowledged) return;
    const mounts = [...this.mounts.values()].filter((entry) => entry.mount.target.instanceId === target.instanceId);
    if (mounts.length === 0) return;
    if (isReconnect) {
      for (const entry of mounts) void this.relistMount(entry);
      return;
    }
    // A pinned thread follows its markers, never deltas: a list does not
    // seed the owner's feed, which sends deltas only once a snapshot has.
    if (!isMarker) return;
    for (const entry of mounts) {
      if (params.backend === undefined
        || (entry.mount.backend === params.backend && entry.mount.threadId === params.threadId)) {
        void this.relistMount(entry);
      }
    }
  }

  /** Reads every remote view and pinned thread again after a peer change. */
  peerStatusChanged(): void {
    for (const remote of [...this.remoteViews.values()]) {
      if (this.options.hasViewers(remote.target)) void this.resyncRemote(remote);
      else this.dropRemote(remote);
    }
    for (const entry of this.mounts.values()) void this.relistMount(entry);
  }

  private local(): TodoView {
    this.localView ??= new TodoView((delta) => this.options.send(undefined, delta));
    return this.localView;
  }

  private remoteView(target: FederationRemoteTarget): RemoteView {
    const existing = this.remoteViews.get(target.instanceId);
    if (existing) return existing;
    const view = new TodoView((delta) => this.options.send(target, delta));
    const remote: RemoteView = {
      target, view, mode: undefined, busyRetrySpent: false,
      follower: new ThreadTodoFeedFollower({
        fetch: () => this.options.remote.snapshot(target),
        // A read that finishes after the view went back to listing is
        // dropped; the next switch to the feed reads it again.
        onSnapshot: (snapshot) => {
          if (remote.mode !== "feed") return;
          this.clearBusyRetry(remote);
          view.replaceSource("owner", snapshot.todos.map((todo) =>
            projectRemoteThreadTodo(todo, target, snapshot.mergeMethods)));
          view.setMergeMethods(snapshot.mergeMethods);
          view.setStatus("owner", snapshot.errors, snapshot.unavailableInstances);
        },
        onDelta: (delta) => {
          if (remote.mode !== "feed") return;
          for (const id of delta.removedIds ?? []) view.remove(remoteThreadTodoId(target, id));
          for (const todo of delta.upserts ?? []) {
            view.upsert("owner", projectRemoteThreadTodo(todo, target, delta.mergeMethods));
          }
          view.setMergeMethods(delta.mergeMethods);
        },
        onError: (error) => {
          if (remote.mode === "feed") this.remoteFailed(remote, error);
        },
      }),
      listing: new Coalesced(async () => {
        try {
          const response = await this.options.remote.list(target, { status: "open" });
          // The view switched to the feed while this read was out; the
          // snapshot is newer.
          if (remote.mode !== "list") return;
          this.clearBusyRetry(remote);
          view.replaceSource("owner", response.todos.map((todo) =>
            projectRemoteThreadTodo(todo, target, response.mergeMethods)));
          view.setMergeMethods(response.mergeMethods);
          view.setStatus("owner", response.errors, response.unavailableInstances);
        } catch (error) {
          if (remote.mode === "list") this.remoteFailed(remote, error);
        }
      }),
    };
    this.remoteViews.set(target.instanceId, remote);
    this.watchFeeds();
    return remote;
  }

  /**
   * A busy owner is transient: its view keeps the last cards with no error
   * and reads the owner once more. Any other failure shows.
   */
  private remoteFailed(remote: RemoteView, error: unknown): void {
    if (expectedNavigationReadFailure(error)?.code !== "navigation_busy") {
      this.options.onUnavailable?.(error);
      remote.view.setStatus("owner", [errorMessage(error)]);
      return;
    }
    if (remote.busyRetry || remote.busyRetrySpent) return;
    remote.busyRetrySpent = true;
    remote.busyRetry = setTimeout(() => {
      remote.busyRetry = undefined;
      if (this.remoteViews.get(remote.target.instanceId) === remote) void this.resyncRemote(remote, true);
    }, THREAD_TODO_BUSY_RETRY_MS);
  }

  private clearBusyRetry(remote: RemoteView): void {
    clearTimeout(remote.busyRetry);
    remote.busyRetry = undefined;
  }

  /** Each read a window or the owner asks for earns one busy retry. */
  private async resyncRemote(remote: RemoteView, busyRetry = false): Promise<void> {
    if (!busyRetry) remote.busyRetrySpent = false;
    if (this.options.remote.supportsFeed(remote.target)) {
      remote.mode = "feed";
      await remote.follower.refresh();
    } else {
      remote.mode = "list";
      await remote.listing.run();
    }
  }

  private dropRemote(remote: RemoteView): void {
    this.clearBusyRetry(remote);
    remote.follower.close();
    this.remoteViews.delete(remote.target.instanceId);
    this.watchFeeds();
  }

  private watchFeeds(): void {
    this.options.remote.watchFeeds([...this.remoteViews.values()].map((remote) => remote.target));
  }

  private async syncMounts(): Promise<void> {
    const next = new Map<string, Mount>();
    for (const mount of await this.options.mountedThreads()) {
      next.set(JSON.stringify([mount.target.instanceId, mount.backend, mount.threadId]), mount);
    }
    const view = this.local();
    for (const [key, entry] of this.mounts) {
      if (next.has(key)) continue;
      this.mounts.delete(key);
      clearTimeout(entry.busyRetry);
      view.clearSource(entry.source);
    }
    const added: MountEntry[] = [];
    for (const [key, mount] of next) {
      if (this.mounts.has(key)) continue;
      const source = `mount:${key}`;
      const entry: MountEntry = { key, mount, source, busyRetrySpent: false,
        refresh: new Coalesced(() => this.refreshMount(entry)) };
      this.mounts.set(key, entry);
      added.push(entry);
    }
    await Promise.all(added.map((entry) => this.relistMount(entry)));
  }

  /** Each pin, marker, reconnect or peer change earns one busy re-list. */
  private relistMount(entry: MountEntry, busyRetry = false): Promise<void> {
    if (!busyRetry) entry.busyRetrySpent = false;
    return entry.refresh.run();
  }

  private async refreshMount(entry: MountEntry): Promise<void> {
    const { mount, source } = entry;
    const view = this.local();
    try {
      const response = await this.options.remote.list(mount.target,
        { status: "open", backend: mount.backend, threadId: mount.threadId });
      clearTimeout(entry.busyRetry);
      entry.busyRetry = undefined;
      view.replaceSource(source, response.todos.map((todo) =>
        projectRemoteThreadTodo(todo, mount.target, response.mergeMethods)));
      view.setStatus(source, response.errors, response.unavailableInstances);
    } catch (error) {
      // A busy owner is transient: the thread keeps its last cards with no
      // error and is listed once more. Any other failure shows.
      if (expectedNavigationReadFailure(error)?.code === "navigation_busy") {
        if (entry.busyRetry || entry.busyRetrySpent) return;
        entry.busyRetrySpent = true;
        entry.busyRetry = setTimeout(() => {
          entry.busyRetry = undefined;
          if (this.mounts.get(entry.key) === entry) void this.relistMount(entry, true);
        }, THREAD_TODO_BUSY_RETRY_MS);
        return;
      }
      this.options.onUnavailable?.(error);
      view.replaceSource(source, []);
      view.setStatus(source, [`${mount.target.instanceId}: ${errorMessage(error)}`]);
    }
  }
}
