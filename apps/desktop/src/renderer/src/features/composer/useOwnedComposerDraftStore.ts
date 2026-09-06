import { buildOwnedComposerScopeKey, parseOwnedComposerScopeKey } from "@pwragent/shared";
import { useEffect } from "react";
import type { ComposerThreadOwner } from "@pwragent/shared";
import type { ComposerDraftStore } from "./useComposerDraftStore";

export type ComposerScopeOwnerResolution =
  | { state: "known"; owner: ComposerThreadOwner }
  | { state: "unresolved" | "ambiguous" };

/** Enumerated scopes remain opaque until their stored metadata proves an owner. */
export function resolveComposerScopeOwner(
  store: ComposerDraftStore,
  scopeKey: string,
): ComposerScopeOwnerResolution {
  const owners = new Map<string, ComposerThreadOwner>();
  const encodedOwner = parseOwnedComposerScopeKey(scopeKey);
  if (encodedOwner) owners.set(buildOwnedComposerScopeKey(encodedOwner), encodedOwner);
  const registered = store.getScopeOwner?.(scopeKey);
  if (registered) owners.set(buildOwnedComposerScopeKey(registered), registered);
  for (const snapshot of [store.get(scopeKey), ...store.getQueuedTurns(scopeKey)]) {
    const owner = snapshot?.threadOwner;
    if (!owner) continue;
    try {
      owners.set(buildOwnedComposerScopeKey(owner), owner);
    } catch {
      return { state: "unresolved" };
    }
  }
  if (owners.size > 1) return { state: "ambiguous" };
  const owner = owners.values().next().value;
  return owner ? { state: "known", owner } : { state: "unresolved" };
}

/** Attach metadata to existing writes, without a separate persistence operation. */
export function useOwnedComposerDraftStore(
  store: ComposerDraftStore,
  scopeKey: string,
  owner?: ComposerThreadOwner,
): ComposerDraftStore;
export function useOwnedComposerDraftStore(
  store: ComposerDraftStore | undefined,
  scopeKey: string,
  owner?: ComposerThreadOwner,
): ComposerDraftStore | undefined;
export function useOwnedComposerDraftStore(
  store: ComposerDraftStore | undefined,
  scopeKey: string,
  owner?: ComposerThreadOwner,
): ComposerDraftStore | undefined {
  const ownerKey = owner ? JSON.stringify(owner) : undefined;
  useEffect(() => {
    if (!ownerKey) return;
    return store?.retainScopeOwner?.(scopeKey, JSON.parse(ownerKey) as ComposerThreadOwner);
  }, [ownerKey, scopeKey, store]);
  // Store identity is part of launchpad handoff and asynchronous attachment
  // ownership. Registration must never introduce a wrapper store.
  return store;
}
