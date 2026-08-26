import type {
  NavigationDirectorySummary,
  NavigationSnapshot,
  NavigationSnapshotTransportDelta,
  NavigationSnapshotTransportResponse,
  NavigationThreadSummary,
} from "./contracts/navigation";
import { federatedThreadIdentityKey } from "./contracts/federation";
import { buildThreadIdentityKey } from "./contracts/navigation";

export type NavigationSnapshotTransportState = {
  revision: string;
  snapshot: NavigationSnapshot;
};

function threadKey(thread: NavigationThreadSummary): string {
  return thread.federation?.ref
    ? federatedThreadIdentityKey(thread.federation.ref)
    : buildThreadIdentityKey(thread.source, thread.id);
}

function applyKeyedDelta<T>(params: {
  current: T[];
  key: (value: T) => string;
  order?: string[];
  removedKeys: string[];
  upserted: T[];
}): T[] | undefined {
  const removed = new Set(params.removedKeys);
  const valuesByKey = new Map(
    params.current
      .filter((value) => !removed.has(params.key(value)))
      .map((value) => [params.key(value), value]),
  );
  for (const value of params.upserted) {
    valuesByKey.set(params.key(value), value);
  }
  if (params.order) {
    const ordered = params.order.map((key) => valuesByKey.get(key));
    return ordered.every((value): value is T => value !== undefined)
      ? ordered
      : undefined;
  }

  const existingKeys = new Set<string>();
  const next: T[] = [];
  for (const value of params.current) {
    const key = params.key(value);
    if (removed.has(key)) continue;
    const replacement = valuesByKey.get(key);
    if (!replacement) continue;
    existingKeys.add(key);
    next.push(replacement);
  }
  for (const value of params.upserted) {
    const key = params.key(value);
    if (!existingKeys.has(key)) {
      next.push(value);
    }
  }
  return next;
}

function applyDelta(
  previous: NavigationSnapshotTransportState,
  delta: NavigationSnapshotTransportDelta,
): NavigationSnapshotTransportState | undefined {
  if (delta.baseRevision !== previous.revision) {
    return undefined;
  }
  const threads = applyKeyedDelta<NavigationThreadSummary>({
    current: previous.snapshot.threads,
    key: threadKey,
    order: delta.threadKeys,
    removedKeys: delta.removedThreadKeys,
    upserted: delta.upsertedThreads,
  });
  const directories = applyKeyedDelta<NavigationDirectorySummary>({
    current: previous.snapshot.directories,
    key: (directory) => directory.key,
    order: delta.directoryKeys,
    removedKeys: delta.removedDirectoryKeys,
    upserted: delta.upsertedDirectories,
  });
  if (!threads || !directories) {
    return undefined;
  }
  const removedInboxThreadKeys = new Set(
    delta.removedInboxThreadKeys ?? [],
  );
  const inboxThreadKeys = delta.inboxThreadKeys ?? [
    ...previous.snapshot.inboxThreadKeys.filter(
      (key) => !removedInboxThreadKeys.has(key),
    ),
    ...(delta.addedInboxThreadKeys ?? []),
  ];
  return {
    revision: delta.revision,
    snapshot: {
      ...previous.snapshot,
      fetchedAt: delta.fetchedAt,
      unchanged: false,
      threads,
      directories,
      inboxThreadKeys,
      launchpadDefaults:
        delta.launchpadDefaults ?? previous.snapshot.launchpadDefaults,
    },
  };
}

export function applyNavigationSnapshotTransportResponse(
  previous: NavigationSnapshotTransportState | undefined,
  response: NavigationSnapshotTransportResponse,
): NavigationSnapshotTransportState | undefined {
  if (response.kind === "full") {
    return {
      revision: response.revision,
      snapshot: response.snapshot,
    };
  }
  if (response.kind === "unchanged") {
    return previous?.revision === response.revision
      ? {
          ...previous,
          snapshot: {
            ...previous.snapshot,
            unchanged: true,
          },
        }
      : undefined;
  }
  if (response.kind === "changes") {
    if (
      !previous
      || response.baseRevision !== previous.revision
      || response.changes.length === 0
    ) {
      return undefined;
    }
    let current: NavigationSnapshotTransportState | undefined = previous;
    for (const change of response.changes) {
      current = current ? applyDelta(current, change) : undefined;
      if (!current) return undefined;
    }
    return current.revision === response.revision ? current : undefined;
  }
  return previous ? applyDelta(previous, response) : undefined;
}
