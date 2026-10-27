import type {
  ThreadTodo,
  ThreadTodoFeedDelta,
  ThreadTodoFeedSnapshot,
} from "./contracts/thread-todos";

/**
 * Newest first, ties by id descending: the owner store's
 * `created_at DESC, todo_id DESC`, so a card raised in the same millisecond
 * keeps the place a list gave it.
 */
export function compareThreadTodosNewestFirst(left: ThreadTodo, right: ThreadTodo): number {
  return right.createdAt - left.createdAt || (left.id < right.id ? 1 : left.id > right.id ? -1 : 0);
}

/** The cards after a delta, newest first. A delta with no card change returns `todos`. */
export function applyThreadTodoFeedDelta(
  todos: ThreadTodo[],
  delta: ThreadTodoFeedDelta,
): ThreadTodo[] {
  if (!delta.upserts?.length && !delta.removedIds?.length) return todos;
  const byId = new Map(todos.map((todo) => [todo.id, todo]));
  for (const id of delta.removedIds ?? []) byId.delete(id);
  for (const todo of delta.upserts ?? []) byId.set(todo.id, todo);
  return [...byId.values()].sort(compareThreadTodosNewestFirst);
}

/**
 * Follows one revisioned To-do feed: a snapshot, then its deltas in order.
 *
 * A delta from another epoch, a skipped revision, or a resync past the
 * current revision reads one new snapshot. Deltas that arrive while a
 * snapshot is in flight are held and replayed past its revision, so a gap
 * costs one read however many deltas follow it. Deltas at or below the
 * current revision are already reflected and are dropped. Before the first
 * snapshot nothing is followed, so deltas are ignored.
 */
export class ThreadTodoFeedFollower {
  private epoch: string | undefined;
  private revision = 0;
  private syncing: Promise<void> | undefined;
  private again = false;
  private held: ThreadTodoFeedDelta[] = [];
  private closed = false;

  constructor(private readonly options: {
    fetch: () => Promise<ThreadTodoFeedSnapshot>;
    onSnapshot: (snapshot: ThreadTodoFeedSnapshot) => void;
    onDelta: (delta: ThreadTodoFeedDelta) => void;
    onError?: (error: unknown) => void;
  }) {}

  /** Whether a snapshot has been applied and deltas are being followed. */
  get following(): boolean {
    return this.epoch !== undefined;
  }

  /** Resolves once a snapshot is applied, reading one only if none is. */
  ensure(): Promise<void> {
    if (this.syncing) return this.syncing;
    return this.epoch === undefined ? this.sync() : Promise.resolve();
  }

  /** Reads a snapshot. A call during a read asks for one more after it. */
  sync(): Promise<void> {
    if (this.syncing) {
      this.again = true;
      return this.syncing;
    }
    const syncing = this.run();
    this.syncing = syncing;
    return syncing;
  }

  receive(delta: ThreadTodoFeedDelta): void {
    if (this.closed) return;
    if (this.syncing) {
      this.held.push(delta);
      return;
    }
    if (this.epoch === undefined) return;
    if (!this.accept(delta)) void this.sync();
  }

  /** Stops following; a read in flight applies nothing. */
  close(): void {
    this.closed = true;
    this.epoch = undefined;
    this.held = [];
  }

  private async run(): Promise<void> {
    // Start after `sync` stores the promise, so a synchronous failure
    // cannot clear `syncing` before it is set.
    await Promise.resolve();
    try {
      do {
        this.again = false;
        let snapshot: ThreadTodoFeedSnapshot;
        try {
          snapshot = await this.options.fetch();
        } catch (error) {
          this.epoch = undefined;
          this.held = [];
          if (!this.closed) this.options.onError?.(error);
          return;
        }
        if (this.closed) return;
        this.epoch = snapshot.epoch;
        this.revision = snapshot.revision;
        this.options.onSnapshot(snapshot);
        const held = this.held;
        this.held = [];
        for (const delta of held) {
          if (!this.accept(delta)) {
            this.again = true;
            break;
          }
        }
      } while (this.again && !this.closed);
    } finally {
      this.syncing = undefined;
    }
  }

  /** Applies the next delta. False when the feed must be read again. */
  private accept(delta: ThreadTodoFeedDelta): boolean {
    if (delta.epoch === this.epoch && delta.revision <= this.revision) return true;
    if (delta.resync || delta.epoch !== this.epoch || delta.revision !== this.revision + 1) return false;
    this.revision = delta.revision;
    this.options.onDelta(delta);
    return true;
  }
}
