import { isDeepStrictEqual } from "node:util";
import type {
  GetNavigationSnapshotRequest,
  NavigationDirectorySummary,
  NavigationSnapshot,
  NavigationSnapshotTransportDelta,
  NavigationSnapshotTransportResponse,
  NavigationSnapshotTransportSelection,
  NavigationThreadSummary,
} from "@pwragent/shared";
import {
  buildNavigationSnapshotTransportScopeKey,
  buildThreadIdentityKey,
  normalizeThreadIdentityKey,
} from "@pwragent/shared";

type CachedNavigationSnapshot = {
  revision: string;
  snapshot: NavigationSnapshot;
};

type CachedNavigationScope = {
  changes: NavigationSnapshotTransportDelta[];
  current: CachedNavigationSnapshot;
};

const DEFAULT_MAX_SCOPES = 8;
const DEFAULT_MAX_CHANGES_PER_SCOPE = 4;

type NavigationSnapshotTransportOptions = {
  maxChangesPerScope?: number;
  maxScopes?: number;
};

function positiveIntegerOrDefault(
  value: number | undefined,
  fallback: number,
): number {
  return value !== undefined && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

function threadKey(thread: NavigationThreadSummary): string {
  return buildThreadIdentityKey(thread.source, thread.id);
}

function selectionHasKey(selected: ReadonlySet<string>, key: string): boolean {
  return selected.has(normalizeThreadIdentityKey(key) ?? key);
}

function filterSnapshot(
  snapshot: NavigationSnapshot,
  selection: NavigationSnapshotTransportSelection,
): NavigationSnapshot {
  if (selection.kind === "all") return snapshot;
  const selected = new Set(selection.threadKeys);
  return {
    ...snapshot,
    threads: snapshot.threads.filter((thread) => selected.has(threadKey(thread))),
    inboxThreadKeys: snapshot.inboxThreadKeys.filter((key) =>
      selectionHasKey(selected, key)
    ),
    // Sparse consumers (messaging bindings and pinned summaries) consume
    // thread rows, not the owner's directory lens. Keeping directory models
    // out also means an unrelated directory edit cannot wake or inflate them.
    directories: [],
  };
}

function filterDelta(
  delta: NavigationSnapshotTransportDelta,
  selection: NavigationSnapshotTransportSelection,
): NavigationSnapshotTransportDelta {
  if (selection.kind === "all") return delta;
  const selected = new Set(selection.threadKeys);
  return {
    ...delta,
    removedThreadKeys: delta.removedThreadKeys.filter((key) =>
      selectionHasKey(selected, key)
    ),
    upsertedThreads: delta.upsertedThreads.filter((thread) =>
      selected.has(threadKey(thread))
    ),
    ...(delta.threadKeys
      ? {
          threadKeys: delta.threadKeys.filter((key) =>
            selectionHasKey(selected, key)
          ),
        }
      : {}),
    removedDirectoryKeys: [],
    upsertedDirectories: [],
    ...(delta.directoryKeys ? { directoryKeys: [] } : {}),
    ...(delta.addedInboxThreadKeys
      ? {
          addedInboxThreadKeys: delta.addedInboxThreadKeys.filter((key) =>
            selectionHasKey(selected, key)
          ),
        }
      : {}),
    ...(delta.removedInboxThreadKeys
      ? {
          removedInboxThreadKeys: delta.removedInboxThreadKeys.filter((key) =>
            selectionHasKey(selected, key)
          ),
        }
      : {}),
    ...(delta.inboxThreadKeys
      ? {
          inboxThreadKeys: delta.inboxThreadKeys.filter((key) =>
            selectionHasKey(selected, key)
          ),
        }
      : {}),
  };
}

function keysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length
    && left.every((key, index) => key === right[index]);
}

function buildKeySequenceChanges(
  currentKeys: string[],
  previousKeys: string[],
): {
  addedKeys: string[];
  changed: boolean;
  order?: string[];
  removedKeys: string[];
} {
  const previousKeySet = new Set(previousKeys);
  const currentKeySet = new Set(currentKeys);
  const removedKeys = previousKeys.filter((key) => !currentKeySet.has(key));
  const addedKeys = currentKeys.filter((key) => !previousKeySet.has(key));
  const implicitOrder = [
    ...previousKeys.filter((key) => currentKeySet.has(key)),
    ...addedKeys,
  ];
  return {
    addedKeys,
    changed: !keysEqual(currentKeys, previousKeys),
    ...(!keysEqual(currentKeys, implicitOrder) ? { order: currentKeys } : {}),
    removedKeys,
  };
}

function buildKeyedChanges<T>(params: {
  current: T[];
  key: (value: T) => string;
  previous: T[];
}): {
  currentKeys: string[];
  removedKeys: string[];
  upserted: T[];
} {
  const previousByKey = new Map(
    params.previous.map((value) => [params.key(value), value]),
  );
  const currentKeys = params.current.map(params.key);
  const currentKeySet = new Set(currentKeys);
  return {
    currentKeys,
    removedKeys: params.previous
      .map(params.key)
      .filter((key) => !currentKeySet.has(key)),
    upserted: params.current.filter((value) => {
      const previous = previousByKey.get(params.key(value));
      return previous === undefined || !isDeepStrictEqual(previous, value);
    }),
  };
}

function buildDelta(params: {
  baseRevision: string;
  current: NavigationSnapshot;
  previous: NavigationSnapshot;
  revision: string;
}): NavigationSnapshotTransportDelta | undefined {
  const threadChanges = buildKeyedChanges({
    current: params.current.threads,
    key: threadKey,
    previous: params.previous.threads,
  });
  const previousThreadKeys = params.previous.threads.map(threadKey);
  const directoryChanges = buildKeyedChanges<NavigationDirectorySummary>({
    current: params.current.directories,
    key: (directory) => directory.key,
    previous: params.previous.directories,
  });
  const previousDirectoryKeys = params.previous.directories.map(
    (directory) => directory.key,
  );
  const inboxChanges = buildKeySequenceChanges(
    params.current.inboxThreadKeys,
    params.previous.inboxThreadKeys,
  );
  const launchpadDefaultsChanged = !isDeepStrictEqual(
    params.current.launchpadDefaults,
    params.previous.launchpadDefaults,
  );
  const threadOrderChanges = buildKeySequenceChanges(
    threadChanges.currentKeys,
    previousThreadKeys,
  );
  const directoryOrderChanges = buildKeySequenceChanges(
    directoryChanges.currentKeys,
    previousDirectoryKeys,
  );
  const changed =
    threadChanges.removedKeys.length > 0
    || threadChanges.upserted.length > 0
    || threadOrderChanges.changed
    || directoryChanges.removedKeys.length > 0
    || directoryChanges.upserted.length > 0
    || directoryOrderChanges.changed
    || inboxChanges.changed
    || launchpadDefaultsChanged;
  if (!changed) {
    return undefined;
  }

  return {
    kind: "delta",
    baseRevision: params.baseRevision,
    revision: params.revision,
    fetchedAt: params.current.fetchedAt,
    removedThreadKeys: threadChanges.removedKeys,
    upsertedThreads: threadChanges.upserted,
    ...(threadOrderChanges.order
      ? { threadKeys: threadOrderChanges.order }
      : {}),
    removedDirectoryKeys: directoryChanges.removedKeys,
    upsertedDirectories: directoryChanges.upserted,
    ...(directoryOrderChanges.order
      ? { directoryKeys: directoryOrderChanges.order }
      : {}),
    ...(inboxChanges.addedKeys.length > 0
      ? { addedInboxThreadKeys: inboxChanges.addedKeys }
      : {}),
    ...(inboxChanges.removedKeys.length > 0
      ? { removedInboxThreadKeys: inboxChanges.removedKeys }
      : {}),
    ...(inboxChanges.order
      ? { inboxThreadKeys: inboxChanges.order }
      : {}),
    ...(launchpadDefaultsChanged
      ? { launchpadDefaults: params.current.launchpadDefaults }
      : {}),
  };
}

/**
 * Bounded shared revision history for navigation snapshot scopes. Clients own
 * their materialized snapshots and send only their last revision; the server
 * retains no per-client state. If a revision falls out of history, the caller
 * receives a fresh full baseline.
 */
export class NavigationSnapshotTransport {
  private nextRevision = 0;
  private readonly maxChangesPerScope: number;
  private readonly maxScopes: number;
  private readonly scopes = new Map<string, CachedNavigationScope>();

  constructor(options: NavigationSnapshotTransportOptions = {}) {
    this.maxChangesPerScope = positiveIntegerOrDefault(
      options.maxChangesPerScope,
      DEFAULT_MAX_CHANGES_PER_SCOPE,
    );
    this.maxScopes = positiveIntegerOrDefault(
      options.maxScopes,
      DEFAULT_MAX_SCOPES,
    );
  }

  clear(): void {
    this.scopes.clear();
  }

  private cacheScope(scopeKey: string, scope: CachedNavigationScope): void {
    this.scopes.delete(scopeKey);
    this.scopes.set(scopeKey, scope);
    while (this.scopes.size > this.maxScopes) {
      const oldestScopeKey = this.scopes.keys().next().value;
      if (oldestScopeKey === undefined) break;
      this.scopes.delete(oldestScopeKey);
    }
  }

  private full(
    scope: CachedNavigationScope,
    selection: NavigationSnapshotTransportSelection,
  ): NavigationSnapshotTransportResponse {
    return {
      kind: "full",
      revision: scope.current.revision,
      snapshot: {
        ...filterSnapshot(scope.current.snapshot, selection),
        unchanged: false,
      },
    };
  }

  private responseSince(
    scope: CachedNavigationScope,
    baseRevision: string | undefined,
    selection: NavigationSnapshotTransportSelection,
  ): NavigationSnapshotTransportResponse {
    if (!baseRevision) return this.full(scope, selection);
    if (baseRevision === scope.current.revision) {
      return {
        kind: "unchanged",
        revision: scope.current.revision,
      };
    }
    const start = scope.changes.findIndex(
      (change) => change.baseRevision === baseRevision,
    );
    if (start < 0) return this.full(scope, selection);
    const changes = scope.changes.slice(start).map((change) =>
      filterDelta(change, selection)
    );
    for (let index = 1; index < changes.length; index += 1) {
      if (changes[index]!.baseRevision !== changes[index - 1]!.revision) {
        return this.full(scope, selection);
      }
    }
    if (changes.at(-1)?.revision !== scope.current.revision) {
      return this.full(scope, selection);
    }
    if (changes.length === 1) return changes[0]!;
    return {
      kind: "changes",
      baseRevision,
      revision: scope.current.revision,
      changes,
    };
  }

  encode(params: {
    baseRevision?: string;
    request: GetNavigationSnapshotRequest;
    scopeKey?: string;
    selection?: NavigationSnapshotTransportSelection;
    snapshot: NavigationSnapshot;
  }): NavigationSnapshotTransportResponse {
    const scopeKey =
      params.scopeKey ?? buildNavigationSnapshotTransportScopeKey(params.request);
    const selection = params.selection ?? { kind: "all" };
    let scope = this.scopes.get(scopeKey);
    if (!scope) {
      scope = {
        changes: [],
        current: {
          revision: String(++this.nextRevision),
          snapshot: params.snapshot,
        },
      };
      this.cacheScope(scopeKey, scope);
      return this.full(scope, selection);
    }

    if (params.snapshot.fetchedAt < scope.current.snapshot.fetchedAt) {
      this.cacheScope(scopeKey, scope);
      return this.responseSince(scope, params.baseRevision, selection);
    }
    if (
      params.snapshot.backend !== scope.current.snapshot.backend
      || !isDeepStrictEqual(
        params.snapshot.federationTarget,
        scope.current.snapshot.federationTarget,
      )
    ) {
      scope = {
        changes: [],
        current: {
          revision: String(++this.nextRevision),
          snapshot: params.snapshot,
        },
      };
      this.cacheScope(scopeKey, scope);
      return this.full(scope, selection);
    }

    const revision = String(this.nextRevision + 1);
    const delta = buildDelta({
      baseRevision: scope.current.revision,
      current: params.snapshot,
      previous: scope.current.snapshot,
      revision,
    });
    if (delta) {
      this.nextRevision += 1;
      scope.changes.push(delta);
      if (scope.changes.length > this.maxChangesPerScope) {
        scope.changes.splice(
          0,
          scope.changes.length - this.maxChangesPerScope,
        );
      }
      scope.current = {
        revision,
        snapshot: params.snapshot,
      };
    } else {
      scope.current.snapshot = params.snapshot;
    }
    this.cacheScope(scopeKey, scope);
    return this.responseSince(scope, params.baseRevision, selection);
  }
}
