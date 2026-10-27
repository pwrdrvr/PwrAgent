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
import { compareThreadTodosNewestFirst, ThreadTodoFeedFollower } from "@pwragent/shared";
import { projectRemoteThreadTodo, remoteThreadTodoId } from "../federation/federation-thread-todos";

type Mount = { target: FederationRemoteTarget; backend: AppServerBackendKind; threadId: string };

export type ThreadTodoViewHubOptions = {
  /** This owner's live feed. */
  local: { snapshot: () => Promise<ThreadTodoFeedSnapshot> };
  remote: {
    /** The owner advertises `thread_todo_feed` and is connected. */
    supportsFeed: (target: FederationRemoteTarget) => boolean;
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

  get busy(): boolean {
    return this.running !== undefined;
  }

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
};

type MountEntry = { mount: Mount; source: string; refresh: Coalesced };

/**
 * The To-do state each window shows, kept in step with its owners.
 *
 * The main window shows this owner's live feed plus its pinned remote
 * threads. A remote window shows one owner. An owner that advertises
 * `thread_todo_feed` is read once with `threadTodos.snapshot` and then
 * followed through its deltas; an older owner is listed again on each of its
 * change markers. Either way a window receives deltas: one snapshot, then
 * one delta per card that changed. A pinned thread is listed when it is
 * pinned and after a reconnect; between those its owner's deltas, or its
 * markers for an older owner, keep it current.
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
    const isMarker = method === "thread/todos/changed" || method === "thread/todoDetails/changed";
    const isReconnect = method === "federation/eventStream/changed";
    if (!isDelta && !isMarker && !isReconnect) return;

    let remote = this.remoteViews.get(target.instanceId);
    if (remote && !this.options.hasViewers(target)) {
      // No window holds a full stream from this owner any more, so its
      // deltas would read as gaps. A new window starts a new view.
      this.dropRemote(remote);
      remote = undefined;
    }
    if (remote) {
      if (isReconnect) void this.resyncRemote(remote);
      else if (isDelta && remote.mode === "feed") remote.follower.receive(params as ThreadTodoFeedDelta);
      else if (isMarker && remote.mode === "list") void remote.listing.run();
    }

    const mounts = [...this.mounts.values()].filter((entry) => entry.mount.target.instanceId === target.instanceId);
    if (mounts.length === 0) return;
    if (isReconnect) {
      for (const entry of mounts) void entry.refresh.run();
      return;
    }
    const feed = this.options.remote.supportsFeed(target);
    const matching = mounts.filter((entry) => params.backend === undefined
      || (entry.mount.backend === params.backend && entry.mount.threadId === params.threadId));
    if (isMarker && !feed) {
      for (const entry of matching) void entry.refresh.run();
    } else if (isDelta && feed && params.backend !== undefined) {
      for (const entry of matching) this.applyMountDelta(entry, params as ThreadTodoFeedDelta);
    }
  }

  /** Reads every remote view and pinned thread again after a peer change. */
  peerStatusChanged(): void {
    for (const remote of [...this.remoteViews.values()]) {
      if (this.options.hasViewers(remote.target)) void this.resyncRemote(remote);
      else this.dropRemote(remote);
    }
    for (const entry of this.mounts.values()) void entry.refresh.run();
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
      target, view, mode: undefined,
      follower: new ThreadTodoFeedFollower({
        fetch: () => this.options.remote.snapshot(target),
        onSnapshot: (snapshot) => {
          view.replaceSource("owner", snapshot.todos.map((todo) =>
            projectRemoteThreadTodo(todo, target, snapshot.mergeMethods)));
          view.setMergeMethods(snapshot.mergeMethods);
          view.setStatus("owner", snapshot.errors, snapshot.unavailableInstances);
        },
        onDelta: (delta) => {
          for (const id of delta.removedIds ?? []) view.remove(remoteThreadTodoId(target, id));
          for (const todo of delta.upserts ?? []) {
            view.upsert("owner", projectRemoteThreadTodo(todo, target, delta.mergeMethods));
          }
          view.setMergeMethods(delta.mergeMethods);
        },
        onError: (error) => {
          this.options.onUnavailable?.(error);
          view.setStatus("owner", [errorMessage(error)]);
        },
      }),
      listing: new Coalesced(async () => {
        try {
          const response = await this.options.remote.list(target, { status: "open" });
          view.replaceSource("owner", response.todos.map((todo) =>
            projectRemoteThreadTodo(todo, target, response.mergeMethods)));
          view.setMergeMethods(response.mergeMethods);
          view.setStatus("owner", response.errors, response.unavailableInstances);
        } catch (error) {
          this.options.onUnavailable?.(error);
          view.setStatus("owner", [errorMessage(error)]);
        }
      }),
    };
    this.remoteViews.set(target.instanceId, remote);
    return remote;
  }

  private async resyncRemote(remote: RemoteView): Promise<void> {
    if (this.options.remote.supportsFeed(remote.target)) {
      remote.mode = "feed";
      await remote.follower.sync();
    } else {
      remote.mode = "list";
      await remote.listing.run();
    }
  }

  private dropRemote(remote: RemoteView): void {
    remote.follower.close();
    this.remoteViews.delete(remote.target.instanceId);
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
      view.clearSource(entry.source);
    }
    const added: MountEntry[] = [];
    for (const [key, mount] of next) {
      if (this.mounts.has(key)) continue;
      const source = `mount:${key}`;
      const entry: MountEntry = { mount, source, refresh: new Coalesced(() => this.refreshMount(mount, source)) };
      this.mounts.set(key, entry);
      added.push(entry);
    }
    await Promise.all(added.map((entry) => entry.refresh.run()));
  }

  private async refreshMount(mount: Mount, source: string): Promise<void> {
    const view = this.local();
    try {
      const response = await this.options.remote.list(mount.target,
        { status: "open", backend: mount.backend, threadId: mount.threadId });
      view.replaceSource(source, response.todos.map((todo) =>
        projectRemoteThreadTodo(todo, mount.target, response.mergeMethods)));
      view.setStatus(source, response.errors, response.unavailableInstances);
    } catch (error) {
      this.options.onUnavailable?.(error);
      view.replaceSource(source, []);
      view.setStatus(source, [`${mount.target.instanceId}: ${errorMessage(error)}`]);
    }
  }

  /**
   * A pinned thread's own delta. The sparse stream skips other threads'
   * revisions, so it is applied without a gap check; a reconnect lists the
   * thread again. A delta during a list could predate it, so it lists again.
   */
  private applyMountDelta(entry: MountEntry, delta: ThreadTodoFeedDelta): void {
    if (entry.refresh.busy) {
      void entry.refresh.run();
      return;
    }
    const view = this.local();
    const target = entry.mount.target;
    for (const id of delta.removedIds ?? []) view.remove(remoteThreadTodoId(target, id));
    for (const todo of delta.upserts ?? []) {
      view.upsert(entry.source, projectRemoteThreadTodo(todo, target, delta.mergeMethods));
    }
  }
}
