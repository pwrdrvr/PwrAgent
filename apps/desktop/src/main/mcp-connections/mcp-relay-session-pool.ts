/**
 * The sessions every thread shares for one PwrSnap or PwrGit connection.
 *
 * Each connection names one role on its relay's command line, and the app
 * keeps no per-thread state, so threads need not hold sessions of their own.
 * Any request may use any session in the pool, except a tool call: a tool
 * call takes a session to itself while it runs, because the server may ask
 * a question mid-call and MCP gives no way to tell which caller it is for.
 * A tool call that finds every session busy opens another, up to `max`, and
 * otherwise waits for one to come free.
 *
 * Sessions stay open once opened. A PwrSnap image link is readable only
 * through the session that returned it, so closing an idle session would
 * break images earlier tool calls returned. The pool is bounded by the most
 * tool calls ever in flight at once.
 */
/**
 * Why a request on a closed pool fails. The gateway passes this text through
 * as its own error, since it carries no upstream content.
 */
export const RELAY_POOL_CLOSED_MESSAGE = "The MCP connection changed while its session was opening. Retry discovery.";

export class RelaySessionPool<S> {
  private readonly sessions: S[] = [];
  /** Sessions a tool call holds, and the thread token that holds each. */
  private readonly holders = new Map<S, string>();
  private readonly waiters: Array<() => void> = [];
  private opening?: Promise<S>;
  private openingCount = 0;
  private closed = false;
  private readonly closing = new AbortController();
  /** A session ended on its own (the app quit or updated) and none is open. */
  ended = false;

  constructor(
    private readonly options: {
      /** `signal` aborts when the pool closes while the session opens. */
      open: (signal: AbortSignal) => Promise<S>;
      close: (session: S) => Promise<void>;
      max: number;
    },
  ) {}

  /** A session for a request that asks no questions: any open one will do. */
  async shared(signal?: AbortSignal): Promise<S> {
    this.assertOpen();
    const idle = this.sessions.find((session) => !this.holders.has(session));
    if (idle !== undefined) return idle;
    if (this.sessions.length > 0) return this.sessions[0]!;
    return await this.openOne(signal, true);
  }

  /**
   * A session no other tool call holds, for `token` until `release` runs.
   * Opens one when every session is busy and the pool has room.
   */
  async exclusive(token: string, signal?: AbortSignal): Promise<{ session: S; release: () => void }> {
    for (;;) {
      this.assertOpen();
      signal?.throwIfAborted();
      const idle = this.sessions.find((session) => !this.holders.has(session));
      if (idle !== undefined) return this.hold(idle, token);
      if (this.sessions.length + this.openingCount < this.options.max) {
        const session = await this.openOne(signal, false);
        if (!this.holders.has(session)) return this.hold(session, token);
        continue;
      }
      await this.waitForRelease(signal);
    }
  }

  /** The thread token whose tool call holds `session`, if one does. */
  holderOf(session: S): string | undefined {
    return this.holders.get(session);
  }

  list(): readonly S[] {
    return [...this.sessions];
  }

  has(session: S): boolean {
    return this.sessions.includes(session);
  }

  get size(): number {
    return this.sessions.length;
  }

  get isOpening(): boolean {
    return this.openingCount > 0;
  }

  /** A session ended by itself. It is dropped; calls it held already failed. */
  remove(session: S): void {
    const index = this.sessions.indexOf(session);
    if (index < 0) return;
    this.sessions.splice(index, 1);
    this.holders.delete(session);
    if (this.sessions.length === 0 && !this.closed) this.ended = true;
    this.wake();
  }

  /** Close every session. Later requests fail; the owner builds a new pool. */
  async close(): Promise<void> {
    this.closed = true;
    this.closing.abort(new Error(RELAY_POOL_CLOSED_MESSAGE));
    const sessions = this.sessions.splice(0);
    this.holders.clear();
    this.wake();
    await Promise.all(sessions.map(async (session) => await this.options.close(session).catch(() => undefined)));
  }

  private hold(session: S, token: string): { session: S; release: () => void } {
    this.holders.set(session, token);
    let released = false;
    return {
      session,
      release: () => {
        if (released) return;
        released = true;
        if (this.holders.get(session) === token) this.holders.delete(session);
        this.wake();
      },
    };
  }

  /**
   * Open a session. Requests that only need some session share one opening;
   * a tool call that needs a free one opens its own.
   */
  private async openOne(requestSignal: AbortSignal | undefined, share: boolean): Promise<S> {
    // A waiter leaves when its request is cancelled or the pool closes.
    const signal = requestSignal
      ? AbortSignal.any([requestSignal, this.closing.signal])
      : this.closing.signal;
    if (share && this.opening) return await abortable(this.opening, signal);
    this.openingCount += 1;
    const opening = (async () => {
      try {
        const session = await this.options.open(this.closing.signal);
        if (this.closed) {
          await this.options.close(session).catch(() => undefined);
          throw new Error(RELAY_POOL_CLOSED_MESSAGE);
        }
        this.sessions.push(session);
        this.ended = false;
        return session;
      } finally {
        this.openingCount -= 1;
        this.wake();
      }
    })();
    if (share) {
      this.opening = opening;
      void opening.catch(() => undefined).finally(() => {
        if (this.opening === opening) this.opening = undefined;
      });
    }
    return await abortable(opening, signal);
  }

  private async waitForRelease(signal?: AbortSignal): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        const index = this.waiters.indexOf(done);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(signal!.reason);
      };
      const done = (): void => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      this.waiters.push(done);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private wake(): void {
    for (const waiter of this.waiters.splice(0)) waiter();
  }

  private assertOpen(): void {
    if (this.closed) throw new Error(RELAY_POOL_CLOSED_MESSAGE);
  }
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return await promise;
  signal.throwIfAborted();
  return await new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error: unknown) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}
