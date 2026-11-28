type RetainedSession = {
  interacted: boolean;
  lastTouchedAt: number;
  thinkingSinceAt?: number;
  backendReportedActive?: boolean;
  pendingMcpInteraction?: unknown;
  pendingRequest?: unknown;
  pendingUserInput?: unknown;
  staleThinkingRecheckAt?: number;
};

type SessionIndicators = {
  thinkingThreadKeys: Record<string, boolean>;
  approvalRequestThreadKeys: Record<string, boolean>;
  inputRequestThreadKeys: Record<string, boolean>;
  staleThinkingRechecks: Record<string, number>;
};

const MAX_VIEW_ONLY_THREADS = 10;

function isProtected(key: string, session: RetainedSession, selected?: string) {
  return key === selected || session.interacted || session.thinkingSinceAt !== undefined;
}

export function hasPendingInteraction(session: RetainedSession): boolean {
  return Boolean(session.pendingMcpInteraction || session.pendingRequest || session.pendingUserInput);
}

export function backgroundThinkingRecheckAt(session: RetainedSession | undefined): number | undefined {
  // Keep the original deadline on the session while a request or active backend
  // blocks cleanup. Becoming eligible again must republish even an expired deadline.
  return session && !session.backendReportedActive && !hasPendingInteraction(session)
    ? session.staleThinkingRecheckAt
    : undefined;
}

function setKey<T extends boolean | number>(
  record: Record<string, T>,
  key: string,
  value: T | undefined,
): Record<string, T> {
  if (record[key] === value) return record;
  if (value !== undefined) return { ...record, [key]: value };
  const next = { ...record };
  delete next[key];
  return next;
}

/** Window-local transcripts with immutable snapshots for the selected thread and sidebar. */
export class ThreadSessionCache<T extends RetainedSession> {
  private sessions = new Map<string, T>();
  private retentionSelection?: string;
  private readonly listeners = new Set<() => void>();
  private summary: SessionIndicators = {
    thinkingThreadKeys: {},
    approvalRequestThreadKeys: {},
    inputRequestThreadKeys: {},
    staleThinkingRechecks: {},
  };

  constructor(private readonly onEvict?: (key: string) => void) {}

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  readonly getSummary = () => this.summary;

  get(key: string | undefined) {
    return key === undefined ? undefined : this.sessions.get(key);
  }

  set(key: string, session: T, selected: string | undefined, thinking: boolean) {
    const previous = this.sessions.get(key);
    this.sessions.set(key, session);
    this.updateIndicators(key, session, thinking);
    // A protected thread's timestamp never changes its place in the cache.
    const protectedNow = isProtected(key, session, selected);
    if (!previous || this.retentionSelection !== selected
      || protectedNow !== isProtected(key, previous, selected)
      || (!protectedNow && session.lastTouchedAt !== previous.lastTouchedAt)) {
      this.retain(selected);
    }
    for (const listener of this.listeners) listener();
  }

  remove(keys: readonly string[], selected?: string) {
    for (const key of keys) {
      if (key === selected) continue;
      this.sessions.delete(key);
      this.updateIndicators(key, undefined, false);
      this.onEvict?.(key);
    }
    for (const listener of this.listeners) listener();
  }

  private updateIndicators(key: string, session: T | undefined, thinking: boolean) {
    const previous = this.summary;
    const thinkingThreadKeys = setKey(previous.thinkingThreadKeys, key, thinking || undefined);
    const approvalRequestThreadKeys = setKey(previous.approvalRequestThreadKeys, key, session?.pendingRequest ? true : undefined);
    const inputRequestThreadKeys = setKey(previous.inputRequestThreadKeys, key, session?.pendingUserInput ? true : undefined);
    const staleThinkingRechecks = setKey(previous.staleThinkingRechecks, key, backgroundThinkingRecheckAt(session));
    if (previous.thinkingThreadKeys !== thinkingThreadKeys || previous.approvalRequestThreadKeys !== approvalRequestThreadKeys
      || previous.inputRequestThreadKeys !== inputRequestThreadKeys || previous.staleThinkingRechecks !== staleThinkingRechecks) {
      this.summary = { ...previous, thinkingThreadKeys, approvalRequestThreadKeys, inputRequestThreadKeys, staleThinkingRechecks };
    }
  }

  private retain(selected: string | undefined) {
    // Preserve the previous stable order on ties, including a formerly selected
    // session moving from the protected prefix into the ten view-only slots.
    const retained = new Map<string, T>();
    const viewOnly: Array<[string, T]> = [];
    for (const [key, session] of this.sessions) {
      if (isProtected(key, session, selected)) retained.set(key, session);
      else viewOnly.push([key, session]);
    }
    viewOnly.sort((left, right) => right[1].lastTouchedAt - left[1].lastTouchedAt);
    for (const [index, [key, session]] of viewOnly.entries()) {
      if (index < MAX_VIEW_ONLY_THREADS) retained.set(key, session);
      else {
        this.updateIndicators(key, undefined, false);
        this.onEvict?.(key);
      }
    }
    this.sessions = retained;
    this.retentionSelection = selected;
  }
}
