import { isDeepStrictEqual } from "node:util";
import type {
  GetNavigationSnapshotRequest,
  NavigationDirectorySummary,
  NavigationSnapshot,
  NavigationSnapshotTransportDelta,
  NavigationSnapshotTransportResponse,
  NavigationThreadSummary,
} from "@pwragent/shared";
import {
  buildNavigationSnapshotTransportScopeKey,
  buildThreadIdentityKey,
} from "@pwragent/shared";

type CachedNavigationSnapshot = {
  revision: string;
  snapshot: NavigationSnapshot;
};

const DEFAULT_MAX_CLIENTS = 64;
const DEFAULT_MAX_SCOPES_PER_CLIENT = 8;

type NavigationSnapshotTransportOptions = {
  maxClients?: number;
  maxScopesPerClient?: number;
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
 * Per-client revision cache shared by the Electron IPC and Federation RPC
 * boundaries. Snapshot producers still build complete snapshots; clients
 * that opt into protocol 1 receive deltas at the serialization boundary.
 */
export class NavigationSnapshotTransport {
  private nextRevision = 0;
  private readonly maxClients: number;
  private readonly maxScopesPerClient: number;
  private readonly snapshotsByClient = new Map<
    string | number,
    Map<string, CachedNavigationSnapshot>
  >();

  constructor(options: NavigationSnapshotTransportOptions = {}) {
    this.maxClients = positiveIntegerOrDefault(
      options.maxClients,
      DEFAULT_MAX_CLIENTS,
    );
    this.maxScopesPerClient = positiveIntegerOrDefault(
      options.maxScopesPerClient,
      DEFAULT_MAX_SCOPES_PER_CLIENT,
    );
  }

  clearRenderer(rendererId: number): void {
    this.clearClient(rendererId);
  }

  clearClient(clientId: string | number): void {
    this.snapshotsByClient.delete(clientId);
  }

  clear(): void {
    this.snapshotsByClient.clear();
  }

  private snapshotsForClient(
    clientId: string | number,
  ): Map<string, CachedNavigationSnapshot> {
    const existing = this.snapshotsByClient.get(clientId);
    if (existing) {
      // Map insertion order is the LRU order. Reinsert on access so an active
      // renderer or Federation peer survives pressure from newer clients.
      this.snapshotsByClient.delete(clientId);
      this.snapshotsByClient.set(clientId, existing);
      return existing;
    }

    while (this.snapshotsByClient.size >= this.maxClients) {
      const oldestClientId = this.snapshotsByClient.keys().next().value;
      if (oldestClientId === undefined) break;
      this.snapshotsByClient.delete(oldestClientId);
    }
    const created = new Map<string, CachedNavigationSnapshot>();
    this.snapshotsByClient.set(clientId, created);
    return created;
  }

  private cacheSnapshot(
    clientSnapshots: Map<string, CachedNavigationSnapshot>,
    scopeKey: string,
    cached: CachedNavigationSnapshot,
  ): void {
    clientSnapshots.delete(scopeKey);
    clientSnapshots.set(scopeKey, cached);
    while (clientSnapshots.size > this.maxScopesPerClient) {
      const oldestScopeKey = clientSnapshots.keys().next().value;
      if (oldestScopeKey === undefined) break;
      clientSnapshots.delete(oldestScopeKey);
    }
  }

  encode(params: {
    baseRevision?: string;
    clientId: string | number;
    request: GetNavigationSnapshotRequest;
    snapshot: NavigationSnapshot;
  }): NavigationSnapshotTransportResponse {
    const clientId = params.clientId;
    const scopeKey = buildNavigationSnapshotTransportScopeKey(params.request);
    const clientSnapshots = this.snapshotsForClient(clientId);
    const cached = clientSnapshots.get(scopeKey);
    if (cached) {
      clientSnapshots.delete(scopeKey);
      clientSnapshots.set(scopeKey, cached);
    }

    if (
      !cached
      || params.baseRevision !== cached.revision
      || params.snapshot.backend !== cached.snapshot.backend
      || !isDeepStrictEqual(
        params.snapshot.federationTarget,
        cached.snapshot.federationTarget,
      )
    ) {
      const revision = String(++this.nextRevision);
      this.cacheSnapshot(clientSnapshots, scopeKey, {
        revision,
        snapshot: params.snapshot,
      });
      return {
        kind: "full",
        revision,
        // `unchanged` is global overlay-store history, not proof that this
        // renderer already owns the baseline. A recovery full must apply.
        snapshot: { ...params.snapshot, unchanged: false },
      };
    }

    const revision = String(this.nextRevision + 1);
    const delta = buildDelta({
      baseRevision: cached.revision,
      current: params.snapshot,
      previous: cached.snapshot,
      revision,
    });
    if (!delta) {
      this.cacheSnapshot(clientSnapshots, scopeKey, {
        revision: cached.revision,
        snapshot: params.snapshot,
      });
      return {
        kind: "unchanged",
        revision: cached.revision,
      };
    }

    this.nextRevision += 1;
    this.cacheSnapshot(clientSnapshots, scopeKey, {
      revision,
      snapshot: params.snapshot,
    });
    return delta;
  }
}
