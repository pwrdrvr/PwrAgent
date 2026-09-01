import {
  buildThreadIdentityKey,
  type AppServerBackendKind,
  type AppServerThreadSummary,
  type AppServerThreadTitleSource,
} from "@pwragent/shared";

/**
 * Where a piece of thread information came from. Higher-trust sources are not
 * ranked here: recency wins, and the source is retained for diagnostics and for
 * callers that must distinguish a provider-derived label from an operator's
 * explicit rename.
 */
export type ThreadInfoSource =
  | "lifecycle-notification"
  | "local-rename"
  | "provider-list"
  | "remote-navigation"
  | "remote-pin";

/**
 * The identity of a thread as this process knows it. `instanceId` is absent for
 * threads this instance owns and present for a mounted peer's thread, so a
 * local thread and a remote thread that happen to share a backend and id can
 * never collapse into one entry.
 */
export type ThreadInfoIdentity = {
  backend: AppServerBackendKind;
  instanceId?: string;
  threadId: string;
};

/**
 * A field this store tracks. Adding one is the whole cost of teaching the store
 * about a new piece of display metadata; every merge, retention, and freshness
 * rule already applies to it.
 */
export type ThreadInfoFields = {
  archived: boolean;
  projectLabel: string;
  title: string;
  titleSource: AppServerThreadTitleSource;
  updatedAt: number;
};

export type ThreadInfoFieldName = keyof ThreadInfoFields;

type ThreadInfoFieldEntry<Name extends ThreadInfoFieldName> = {
  observationSequence: number;
  source: ThreadInfoSource;
  value: ThreadInfoFields[Name];
};

type ThreadInfoSummaryEntry = {
  /**
   * Whether the listing that produced this row ran directory enrichment.
   * An unenriched row can be missing worktree paths, so a caller that needs
   * them must not be handed one — see `getSummary`.
   */
  enriched: boolean;
  observationSequence: number;
  value: AppServerThreadSummary;
};

type ThreadInfoEntry = {
  fields: {
    [Name in ThreadInfoFieldName]?: ThreadInfoFieldEntry<Name>;
  };
  /** Highest sequence any accepted field on this entry carries. */
  lastObservedSequence: number;
  summary?: ThreadInfoSummaryEntry;
};

/**
 * What the store knows about one thread right now. Every field is optional and
 * a missing field means exactly one thing: nothing has ever been observed for
 * it. It never means a read failed, a provider was slow, or a cache lapsed.
 */
export type ThreadInfo = {
  archived?: boolean;
  identity: ThreadInfoIdentity;
  /** Sequence of the newest accepted observation, for ordering diagnostics. */
  lastObservedSequence: number;
  projectLabel?: string;
  title?: string;
  titleSource?: AppServerThreadTitleSource;
  updatedAt?: number;
};

/** A batch of facts about one thread, as some source observed them. */
export type ThreadInfoObservation = {
  identity: ThreadInfoIdentity;
  /**
   * Sequence this observation was taken at. Asynchronous readers MUST reserve
   * this before the read begins — see `reserveObservationSequence`.
   */
  observationSequence: number;
  source: ThreadInfoSource;
} & Partial<ThreadInfoFields>;

const TRACKED_FIELDS: readonly ThreadInfoFieldName[] = [
  "archived",
  "projectLabel",
  "title",
  "titleSource",
  "updatedAt",
];

function identityKey(identity: ThreadInfoIdentity): string {
  const threadKey = buildThreadIdentityKey(identity.backend, identity.threadId);
  return identity.instanceId ? `${identity.instanceId}::${threadKey}` : threadKey;
}

/**
 * A title that carries no information. `fallback` is what a provider returns
 * when it has nothing better than the thread id, so accepting one would let a
 * list refresh overwrite a real name with a uuid — the regression this store
 * exists to make unrepresentable.
 */
function isUsableTitle(
  title: string | undefined,
  titleSource: AppServerThreadTitleSource | undefined,
): boolean {
  if (titleSource === "fallback") {
    return false;
  }
  return (title?.trim().length ?? 0) > 0;
}

/**
 * The process-lifetime record of what PwrAgent knows about each thread it has
 * seen, keyed by thread identity rather than by the shape of the query that
 * happened to reveal it.
 *
 * The distinction that motivates this store: a *query cache* answers "which
 * threads match Q, in what order", is invalidated by any mutation, and is
 * correctly forgotten. An *information store* answers "what is thread X
 * called", and forgetting it is never correct — the previous answer is still
 * the best answer available until a newer one arrives.
 *
 * PwrAgent previously had only the query cache, so a mutation anywhere erased
 * the display metadata for every thread, and any read that had to re-derive it
 * could regress a named row back to a uuid while a provider round trip was in
 * flight. Reads here are synchronous, cannot fail, and cannot start I/O.
 *
 * Ordering is by monotonic sequence, never by wall clock, so this is safe on
 * the render path and unaffected by clock adjustment.
 */
export class ThreadInfoStore {
  private readonly entries = new Map<string, ThreadInfoEntry>();
  private observationSequence = 0;

  /**
   * Take the sequence an observation will be recorded at. An asynchronous
   * reader must call this BEFORE it starts, not when it finishes.
   *
   * This is the rule that makes late completions harmless. A provider list
   * that starts, is overtaken by a rename, and completes afterwards carries the
   * older sequence it reserved, so its stale rows lose to the rename instead of
   * silently reverting it.
   */
  reserveObservationSequence(): number {
    this.observationSequence += 1;
    return this.observationSequence;
  }

  /**
   * Record what a source observed. Only positive facts are merged: a field the
   * observation omits is left alone, because "this read did not mention the
   * title" and "this thread has no title" are different claims and only the
   * caller knows which one it is making.
   *
   * Returns the fields this observation actually changed, which lets callers
   * skip downstream work when a refresh confirmed what was already known.
   */
  observe(observation: ThreadInfoObservation): ThreadInfoFieldName[] {
    const threadId = observation.identity.threadId.trim();
    if (!threadId) {
      return [];
    }
    const identity: ThreadInfoIdentity = {
      backend: observation.identity.backend,
      threadId,
      ...(observation.identity.instanceId
        ? { instanceId: observation.identity.instanceId }
        : {}),
    };
    const key = identityKey(identity);
    const entry = this.entries.get(key) ?? {
      fields: {},
      lastObservedSequence: 0,
    };

    // A title and its source describe one fact. Validating them together stops
    // a fallback source from arriving without its title and downgrading a name
    // the store already holds.
    const titleIsUsable = isUsableTitle(observation.title, observation.titleSource);
    const changed: ThreadInfoFieldName[] = [];

    for (const field of TRACKED_FIELDS) {
      const value = observation[field];
      if (value === undefined) {
        continue;
      }
      if ((field === "title" || field === "titleSource") && !titleIsUsable) {
        continue;
      }
      if (field === "projectLabel" && !String(value).trim()) {
        continue;
      }
      const existing = entry.fields[field];
      if (
        existing
        && existing.observationSequence > observation.observationSequence
      ) {
        continue;
      }
      const normalized =
        field === "title" || field === "projectLabel"
          ? (String(value).trim() as ThreadInfoFields[typeof field])
          : value;
      if (existing && existing.value === normalized) {
        // Still a fresher confirmation of the same fact, so the sequence moves
        // even though no caller needs to hear about a change.
        existing.observationSequence = observation.observationSequence;
        existing.source = observation.source;
        continue;
      }
      (entry.fields as Record<string, unknown>)[field] = {
        observationSequence: observation.observationSequence,
        source: observation.source,
        value: normalized,
      };
      changed.push(field);
    }

    entry.lastObservedSequence = Math.max(
      entry.lastObservedSequence,
      observation.observationSequence,
    );
    this.entries.set(key, entry);
    return changed;
  }

  /**
   * What this process knows about a thread. Synchronous, allocation-light, and
   * safe on any path — including a 500ms UI poll — because it can neither wait
   * nor fail. `undefined` means this thread has never been observed at all.
   */
  get(identity: ThreadInfoIdentity): ThreadInfo | undefined {
    const threadId = identity.threadId.trim();
    if (!threadId) {
      return undefined;
    }
    const entry = this.entries.get(
      identityKey({ ...identity, threadId }),
    );
    if (!entry) {
      return undefined;
    }
    const info: ThreadInfo = {
      identity: {
        backend: identity.backend,
        threadId,
        ...(identity.instanceId ? { instanceId: identity.instanceId } : {}),
      },
      lastObservedSequence: entry.lastObservedSequence,
    };
    for (const field of TRACKED_FIELDS) {
      const stored = entry.fields[field];
      if (stored !== undefined) {
        (info as Record<string, unknown>)[field] = stored.value;
      }
    }
    return info;
  }

  /**
   * Record the whole row a listing returned, so a later point query about this
   * thread can be answered without walking the collection again.
   *
   * `enriched` records whether the listing ran directory enrichment. It is not
   * a quality score: an unenriched row is complete for callers that asked for
   * an unenriched listing and incomplete for callers that did not, and only
   * the reader knows which it is.
   */
  observeSummary(params: {
    enriched: boolean;
    identity: ThreadInfoIdentity;
    observationSequence: number;
    summary: AppServerThreadSummary;
  }): void {
    const threadId = params.identity.threadId.trim();
    if (!threadId) {
      return;
    }
    const key = identityKey({ ...params.identity, threadId });
    const entry = this.entries.get(key) ?? {
      fields: {},
      lastObservedSequence: 0,
    };
    const existing = entry.summary;
    // An enriched row is not replaced by an unenriched one taken at the same
    // moment: both are current, and only one can answer a directory question.
    const supersedes =
      !existing
      || existing.observationSequence < params.observationSequence
      || (existing.observationSequence === params.observationSequence
        && params.enriched
        && !existing.enriched);
    if (supersedes) {
      entry.summary = {
        enriched: params.enriched,
        observationSequence: params.observationSequence,
        value: params.summary,
      };
    }
    entry.lastObservedSequence = Math.max(
      entry.lastObservedSequence,
      params.observationSequence,
    );
    this.entries.set(key, entry);
  }

  /**
   * The last row a listing returned for this thread, or `undefined` when none
   * has been observed at the requested enrichment level.
   *
   * Deliberately survives thread-list cache invalidation. Invalidation means
   * "the ordering and membership of that query may have changed", which says
   * nothing about where this thread's workspace is. A caller that needs
   * post-mutation provider truth must go to the provider explicitly.
   */
  getSummary(
    identity: ThreadInfoIdentity,
    options?: { requireEnriched?: boolean },
  ): AppServerThreadSummary | undefined {
    const threadId = identity.threadId.trim();
    if (!threadId) {
      return undefined;
    }
    const summary = this.entries.get(identityKey({ ...identity, threadId }))
      ?.summary;
    if (!summary) {
      return undefined;
    }
    if (options?.requireEnriched && !summary.enriched) {
      return undefined;
    }
    return summary.value;
  }

  /** The display title, or `undefined` when none has ever been observed. */
  getTitle(identity: ThreadInfoIdentity): string | undefined {
    return this.get(identity)?.title;
  }

  /**
   * Drop a thread the owning provider no longer has. This is the ONLY way an
   * entry leaves the store, and it is deliberately not reachable from cache
   * invalidation: invalidation means "the query result may be stale", which
   * says nothing about whether the thread still exists or what it is called.
   */
  forget(identity: ThreadInfoIdentity): void {
    this.entries.delete(identityKey(identity));
  }

  /** Drop every thread belonging to a peer that unmounted. */
  forgetInstance(instanceId: string): void {
    const prefix = `${instanceId}::`;
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) {
        this.entries.delete(key);
      }
    }
  }

  /** Entry count, for budget assertions and memory diagnostics. */
  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}
