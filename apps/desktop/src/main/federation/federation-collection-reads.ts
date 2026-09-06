import type {
  AppServerBackendKind,
  AppServerThreadSummary,
  NavigationSnapshot,
} from "@pwragent/shared";
import { isAppServerBackendKind } from "@pwragent/shared";

/** Collection reads have a payload budget, independent of the socket ceiling. */
export const FEDERATION_COLLECTION_PAGE_BYTES = 256 * 1024;
export const FEDERATION_COLLECTION_PAGE_ROWS = 100;

/** For merge-based notifications only. Never split replacement snapshots this way. */
export function partitionFederationCollection<T>(items: readonly T[]): T[][] {
  const pages: T[][] = [];
  let page: T[] = [];
  let bytes = 2;
  for (const item of items) {
    const itemBytes = collectionBytes(item);
    // Reserve space for the envelope and its params wrapper.
    if (itemBytes + 2 > FEDERATION_COLLECTION_PAGE_BYTES - 4096) {
      throw new Error("One Federation collection item exceeds its notification budget.");
    }
    if (page.length >= FEDERATION_COLLECTION_PAGE_ROWS
      || bytes + itemBytes + 1 > FEDERATION_COLLECTION_PAGE_BYTES - 4096) {
      pages.push(page);
      page = [];
      bytes = 2;
    }
    bytes += itemBytes + (page.length ? 1 : 0);
    page.push(item);
  }
  if (page.length) pages.push(page);
  return pages;
}

export type FederationProjectPageRequest = {
  projectKey?: string;
  afterKey?: string;
};

export type FederationProjectPage = Pick<
  NavigationSnapshot,
  "backend" | "fetchedAt" | "directories" | "launchpadDefaults"
> & { nextAfterKey?: string };

export type FederationArchivedThreadLookupRequest = {
  backend: AppServerBackendKind;
  threadIds: string[];
};

export function projectFederationProjectPage(
  snapshot: NavigationSnapshot,
  request: FederationProjectPageRequest,
): FederationProjectPage {
  const page: FederationProjectPage = {
    backend: snapshot.backend,
    fetchedAt: snapshot.fetchedAt,
    launchpadDefaults: snapshot.launchpadDefaults,
    directories: [],
  };
  assertCollectionBytes(page);
  const directories = snapshot.directories
    .filter((directory) => directory.kind !== "unlinked"
      && (request.projectKey === undefined || directory.key === request.projectKey)
      && (request.afterKey === undefined || directory.key > request.afterKey))
    .sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
  for (const directory of directories) {
    // A project picker never consumes directory membership. In particular,
    // do not send every thread key merely to display a project label.
    const candidate = { ...directory, threadKeys: [] };
    const next = {
      ...page,
      directories: [...page.directories, candidate],
      nextAfterKey: directory.key,
    };
    if (page.directories.length >= FEDERATION_COLLECTION_PAGE_ROWS
      || collectionBytes(next) > FEDERATION_COLLECTION_PAGE_BYTES) {
      if (page.directories.length === 0) {
        throw new Error("One project exceeds the Federation project-page budget.");
      }
      page.nextAfterKey = page.directories[page.directories.length - 1]!.key;
      return page;
    }
    page.directories.push(candidate);
  }
  return page;
}

export function validateArchivedThreadLookup(
  request: FederationArchivedThreadLookupRequest,
): Set<string> {
  if (!request || !isAppServerBackendKind(request.backend)
    || !Array.isArray(request.threadIds)
    || request.threadIds.length > FEDERATION_COLLECTION_PAGE_ROWS
    || request.threadIds.some((id) => typeof id !== "string" || !id || id.length > 1024)) {
    throw new Error("Archived lookup requires at most 100 non-empty thread IDs.");
  }
  return new Set(request.threadIds);
}

/** Exact-ID proof, not a fuzzy search or a viewer-side archive scan. */
export function projectFederationArchivedThreads(
  threads: readonly AppServerThreadSummary[],
  request: FederationArchivedThreadLookupRequest,
): { threads: AppServerThreadSummary[] } {
  const ids = validateArchivedThreadLookup(request);
  const result = {
    threads: threads.filter((thread) => {
      if (thread.source !== request.backend || !ids.has(thread.id)) return false;
      ids.delete(thread.id);
      return true;
    })
      .map((thread): AppServerThreadSummary => ({
        id: thread.id,
        source: thread.source,
        title: thread.title,
        titleSource: thread.titleSource,
        archivedAt: thread.archivedAt,
        projectKey: thread.projectKey,
        updatedAt: thread.updatedAt,
        createdAt: thread.createdAt,
        linkedDirectories: thread.linkedDirectories,
      })),
  };
  assertCollectionBytes(result);
  return result;
}

function collectionBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function assertCollectionBytes(value: unknown): void {
  if (collectionBytes(value) > FEDERATION_COLLECTION_PAGE_BYTES) {
    throw new Error("Federation collection response exceeds its byte budget.");
  }
}
