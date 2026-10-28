import { randomUUID } from "node:crypto";
import type {
  AgentEvent,
  AppServerBackendKind,
  AppServerThreadSummary,
  ThreadTodo,
  ThreadTodoFeedDelta,
  ThreadTodoFeedSnapshot,
  ThreadTodoMergeMethodPreferences,
} from "@pwragent/shared";
import { buildThreadIdentityKey, compareThreadTodosNewestFirst } from "@pwragent/shared";
import { getMainLogger } from "../log";

const feedLog = getMainLogger("pwragent:thread-todos");

export type ThreadTodoFeedOwner = Pick<AppServerThreadSummary, "id" | "source" | "title" | "archivedAt">
  & { federation?: unknown };

type ThreadScope = { backend: AppServerBackendKind; threadId: string };

export type ThreadTodoFeedSource = {
  /** Open cards and open tracked reviews as cards, for one thread or all. */
  readOpenCards: (scope?: ThreadScope) => ThreadTodo[];
  /** The owner's complete provider listing; usually the sidebar's cache. */
  loadOwners: () => Promise<readonly ThreadTodoFeedOwner[]>;
  /** Private managed sub-agent threads, whose cards stay hidden. */
  managedThreadKeys: () => ReadonlySet<string>;
  withDispatchDefaults: (todos: ThreadTodo[]) => Promise<ThreadTodo[]>;
  mergeMethods: () => ThreadTodoMergeMethodPreferences;
};

/**
 * This owner's open To-do cards, kept live for windows and federation
 * viewers: a snapshot at a revision, then one delta per card change.
 *
 * It is seeded by the first snapshot: every open card, plus one provider
 * listing for which threads can own a card. After that it reads only what
 * an event names. A card change re-reads that thread's cards from SQLite.
 * Archive and delete drop an owner, a rename retitles its cards, and an
 * unarchive or provider refresh reads the listing again. A new thread has
 * no cards, so the listing is read again only when a thread with no owner
 * changes its cards.
 *
 * Every read runs in one queue, so changes apply in the order they were
 * read. The feed reads SQLite and never writes it.
 */
export class ThreadTodoFeed {
  private revision = 0;
  private state: "idle" | "seeding" | "live" = "idle";
  private seeded: Promise<void> | undefined;
  private queue: Promise<void> = Promise.resolve();
  private readonly scheduled = new Set<string>();
  /** Owner thread key → title, from the last listing. */
  private owners = new Map<string, string | undefined>();
  /** Open cards per thread key, before owner filtering. */
  private readonly cards = new Map<string, ThreadTodo[]>();
  /** Published cards by id. */
  private readonly visible = new Map<string, ThreadTodo>();

  constructor(
    private readonly source: ThreadTodoFeedSource,
    private readonly onDelta: (delta: ThreadTodoFeedDelta) => void,
    readonly epoch: string = randomUUID(),
  ) {}

  async snapshot(): Promise<ThreadTodoFeedSnapshot> {
    if (this.state === "idle") {
      this.state = "seeding";
      this.seeded = this.enqueue(() => this.seed(), true);
    }
    await this.seeded;
    return {
      epoch: this.epoch,
      revision: this.revision,
      todos: [...this.visible.values()].sort(compareThreadTodosNewestFirst),
      mergeMethods: this.source.mergeMethods(),
    };
  }

  /** Resolves once every queued read has applied. */
  idle(): Promise<void> {
    return this.queue;
  }

  /** A card, or what its card shows, changed: one thread, or every card. */
  cardsChanged(scope?: ThreadScope): void {
    if (this.state === "idle") return;
    if (!scope) {
      this.schedule("*", () => this.refreshAll());
      return;
    }
    this.schedule(`thread:${buildThreadIdentityKey(scope.backend, scope.threadId)}`,
      () => this.refreshThread(scope));
  }

  /** Thread lifecycle events from this owner's backends. */
  handleBackendEvent(event: AgentEvent): void {
    if (this.state === "idle" || event.federationTarget?.scope === "remote") return;
    const { method, params } = event.notification as { method: string; params: Record<string, unknown> };
    const threadId = typeof params?.threadId === "string" ? params.threadId : undefined;
    switch (method) {
      case "thread/archived":
      case "thread/deleted":
        if (threadId) this.enqueue(() => this.removeOwner(buildThreadIdentityKey(event.backend, threadId)));
        return;
      case "thread/name/updated":
        if (!threadId) return;
        if (typeof params.threadName === "string") {
          const key = buildThreadIdentityKey(event.backend, threadId);
          const title = params.threadName;
          this.enqueue(async () => this.retitle(key, title));
        } else {
          this.schedule("owners", () => this.reloadOwners());
        }
        return;
      case "thread/unarchived":
        this.schedule("owners", () => this.reloadOwners());
        return;
      case "navigation/providerThreads/refreshed":
        // Owners can appear or go; card rows do not change.
        this.schedule("owners", () => this.reloadOwners());
        return;
      case "thread/pullRequests/updated":
      case "thread/modelSettings/updated":
        // Review queues follow PR attachments; dispatch defaults follow the model.
        if (threadId) this.cardsChanged({ backend: event.backend, threadId });
        return;
    }
  }

  /** Runs `task` once, however often it is asked for before it starts. */
  private schedule(key: string, task: () => Promise<void>): void {
    if (this.scheduled.has(key)) return;
    this.scheduled.add(key);
    this.enqueue(async () => {
      this.scheduled.delete(key);
      await task();
    });
  }

  private enqueue(task: () => Promise<void>, seed = false): Promise<void> {
    const run = this.queue.then(async () => {
      if (!seed && this.state !== "live") return;
      await task();
    });
    // A failed read leaves the published cards as they were; the next
    // event for the same cards reads them again.
    this.queue = run.catch((error: unknown) => {
      feedLog.warn("could not update the To-do feed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return run;
  }

  private async seed(): Promise<void> {
    try {
      this.cards.clear();
      for (const todo of this.source.readOpenCards()) this.addCard(todo);
      this.setOwners(await this.source.loadOwners());
      const projected = await this.project([...this.cards.keys()]);
      for (const todo of projected) this.visible.set(todo.id, todo);
      this.state = "live";
    } catch (error) {
      // The next snapshot tries again.
      this.state = "idle";
      this.cards.clear();
      throw error;
    }
  }

  private async refreshThread(scope: ThreadScope): Promise<void> {
    const key = buildThreadIdentityKey(scope.backend, scope.threadId);
    const todos = this.source.readOpenCards(scope);
    if (todos.length > 0) this.cards.set(key, todos);
    else this.cards.delete(key);
    // A thread the listing lacked may be newer than its cached copy; the
    // listing is the sidebar's cache, so asking again costs a lookup.
    if (todos.length > 0 && !this.owners.has(key)) this.setOwners(await this.source.loadOwners());
    await this.publish([key]);
  }

  private async refreshAll(): Promise<void> {
    const keys = new Set(this.cards.keys());
    this.cards.clear();
    for (const todo of this.source.readOpenCards()) this.addCard(todo);
    for (const key of this.cards.keys()) keys.add(key);
    await this.publish([...keys]);
  }

  private async reloadOwners(): Promise<void> {
    const before = this.owners;
    this.setOwners(await this.source.loadOwners());
    const changed = [...this.cards.keys()].filter((key) =>
      before.has(key) !== this.owners.has(key) || before.get(key) !== this.owners.get(key));
    await this.publish(changed);
  }

  private async removeOwner(key: string): Promise<void> {
    this.owners.delete(key);
    await this.publish([key]);
  }

  private async retitle(key: string, title: string): Promise<void> {
    if (!this.owners.has(key) || this.owners.get(key) === title) return;
    this.owners.set(key, title);
    const upserts = [...this.visible.values()]
      .filter((todo) => buildThreadIdentityKey(todo.backend, todo.threadId) === key)
      .map((todo) => ({ ...todo, threadTitle: title }));
    if (upserts.length === 0) return;
    const mergeMethods = this.source.mergeMethods();
    for (const todo of upserts.sort(compareThreadTodosNewestFirst)) {
      this.visible.set(todo.id, todo);
      this.emit(todo, { upsert: todo }, mergeMethods);
    }
  }

  /** Re-projects the named threads' cards and publishes what changed. */
  private async publish(keys: string[]): Promise<void> {
    const scope = new Set(keys);
    const next = new Map((await this.project(keys)).map((todo) => [todo.id, todo]));
    const removed = [...this.visible.values()]
      .filter((todo) => scope.has(buildThreadIdentityKey(todo.backend, todo.threadId)) && !next.has(todo.id))
      .sort(compareThreadTodosNewestFirst);
    const upserts = [...next.values()].sort(compareThreadTodosNewestFirst).filter((todo) => {
      const current = this.visible.get(todo.id);
      return !current || JSON.stringify(current) !== JSON.stringify(todo);
    });
    if (removed.length === 0 && upserts.length === 0) return;
    const mergeMethods = this.source.mergeMethods();
    for (const todo of removed) {
      this.visible.delete(todo.id);
      this.emit(todo, { removedId: todo.id }, mergeMethods);
    }
    for (const todo of upserts) {
      this.visible.set(todo.id, todo);
      this.emit(todo, { upsert: todo }, mergeMethods);
    }
  }

  /** The named threads' cards that an available owner holds, as published. */
  private async project(keys: string[]): Promise<ThreadTodo[]> {
    const managed = this.source.managedThreadKeys();
    const eligible = keys.flatMap((key) => {
      if (!this.owners.has(key) || managed.has(key)) return [];
      const title = this.owners.get(key);
      return (this.cards.get(key) ?? []).map((todo) => title === undefined ? todo : { ...todo, threadTitle: title });
    });
    return eligible.length > 0 ? await this.source.withDispatchDefaults(eligible) : [];
  }

  private setOwners(owners: readonly ThreadTodoFeedOwner[]): void {
    this.owners = new Map(owners
      .filter((owner) => !owner.federation && owner.archivedAt === undefined)
      .map((owner) => [buildThreadIdentityKey(owner.source, owner.id), owner.title]));
  }

  private addCard(todo: ThreadTodo): void {
    const key = buildThreadIdentityKey(todo.backend, todo.threadId);
    const list = this.cards.get(key);
    if (list) list.push(todo);
    else this.cards.set(key, [todo]);
  }

  private emit(
    todo: ThreadTodo,
    change: { upsert: ThreadTodo } | { removedId: string },
    mergeMethods: ThreadTodoMergeMethodPreferences,
  ): void {
    this.revision += 1;
    this.onDelta({
      epoch: this.epoch,
      revision: this.revision,
      backend: todo.backend,
      threadId: todo.threadId,
      ...("upsert" in change ? { upserts: [change.upsert] } : { removedIds: [change.removedId] }),
      mergeMethods,
    });
  }
}
