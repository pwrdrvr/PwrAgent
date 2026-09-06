import type { NavigationSnapshot, NavigationThreadSummary } from "@pwragent/shared";
import {
  buildThreadIdentityKey,
  federatedThreadIdentityKey,
  normalizeThreadIdentityKey,
  resolveThreadParentKey,
} from "@pwragent/shared";
import { FEDERATION_COLLECTION_PAGE_BYTES, FEDERATION_COLLECTION_PAGE_ROWS } from "./federation-collection-reads";

export type FederationNavigationSelectionRequest = {
  threadKeys: string[];
  afterKey?: string;
  revision?: string;
};

export type FederationNavigationSelectionPage = {
  revision: string;
  snapshot: NavigationSnapshot;
  nextAfterKey?: string;
};

function key(thread: NavigationThreadSummary): string {
  return thread.federation?.ref
    ? federatedThreadIdentityKey(thread.federation.ref)
    : buildThreadIdentityKey(thread.source, thread.id);
}

/** Select on the owner: a viewer cannot discover foreign descendants from IDs alone. */
export function projectNavigationDescendantPage(
  snapshot: NavigationSnapshot,
  revision: string,
  request: FederationNavigationSelectionRequest,
): FederationNavigationSelectionPage {
  if (!request || !Array.isArray(request.threadKeys)
    || request.threadKeys.length > FEDERATION_COLLECTION_PAGE_ROWS
    || request.threadKeys.some((value) => typeof value !== "string" || !value || value.length > 2048)
    || (request.afterKey !== undefined && (typeof request.afterKey !== "string" || request.afterKey.length > 4096))) {
    throw new Error("Navigation selection requires at most 100 bounded thread identities.");
  }
  if (request.revision !== undefined && request.revision !== revision) {
    throw new Error("Navigation changed during descendant pagination; retry the selection.");
  }
  const index = new Map(snapshot.threads.map((thread) => [key(thread), thread]));
  const children = new Map<string, string[]>();
  for (const [threadKey, thread] of index) {
    const parent = resolveThreadParentKey(thread, index);
    if (!parent) continue;
    const group = children.get(parent) ?? [];
    group.push(threadKey);
    children.set(parent, group);
  }
  const selected = new Set(request.threadKeys.map((value) => normalizeThreadIdentityKey(value) ?? value));
  const pending = [...selected];
  for (let offset = 0; offset < pending.length; offset += 1) {
    for (const child of children.get(pending[offset]!) ?? []) {
      if (selected.has(child)) continue;
      selected.add(child);
      pending.push(child);
    }
  }
  const keys = [...selected].filter((value) => index.has(value)
    && (request.afterKey === undefined || value > request.afterKey)).sort();
  const result: FederationNavigationSelectionPage = {
    revision,
    snapshot: { ...snapshot, threads: [], directories: [], inboxThreadKeys: [] },
  };
  const inbox = new Set(snapshot.inboxThreadKeys.map((value) => normalizeThreadIdentityKey(value) ?? value));
  for (const threadKey of keys) {
    const candidate: FederationNavigationSelectionPage = {
      ...result,
      nextAfterKey: threadKey,
      snapshot: {
        ...result.snapshot,
        threads: [...result.snapshot.threads, index.get(threadKey)!],
        inboxThreadKeys: inbox.has(threadKey)
          ? [...result.snapshot.inboxThreadKeys, threadKey] : result.snapshot.inboxThreadKeys,
      },
    };
    if (result.snapshot.threads.length >= FEDERATION_COLLECTION_PAGE_ROWS
      || Buffer.byteLength(JSON.stringify(candidate)) > FEDERATION_COLLECTION_PAGE_BYTES) {
      if (!result.snapshot.threads.length) throw new Error("One descendant exceeds its navigation-page byte budget.");
      return result;
    }
    result.snapshot = candidate.snapshot;
    result.nextAfterKey = threadKey;
  }
  delete result.nextAfterKey;
  if (Buffer.byteLength(JSON.stringify(result)) > FEDERATION_COLLECTION_PAGE_BYTES) {
    throw new Error("Navigation selection metadata exceeds its page byte budget.");
  }
  return result;
}
