import {
  buildThreadIdentityKey,
  federatedThreadIdentityKey,
  isRemoteFederationTarget,
  type AppServerBackendKind,
  type FederatedThreadRef,
  type FederationRemoteTarget,
  type FederationTarget,
  type ThreadSearchResult,
} from "@pwragent/shared";

/**
 * Where an opened search result goes.
 *
 * - `this-window`: select the thread here. `federationTarget` names a peer's
 *   thread, which the window adds to its sidebar first when it is not there
 *   yet. `threadKey` is the key the thread is selected under, for the find
 *   bar's deep link.
 * - `owner-window`: open or focus the owner's remote viewer window on it.
 */
export type SearchResultOpenPlan =
  | {
      kind: "this-window";
      backend: AppServerBackendKind;
      federationTarget?: FederationRemoteTarget;
      threadId: string;
      threadKey: string;
    }
  | {
      kind: "owner-window";
      target: FederationRemoteTarget;
      initialThread: FederatedThreadRef;
    };

/**
 * A click on a search result. The main window (no `windowTarget`) shows
 * every result in place, a peer's included, the way thread links and Cmd+K
 * do: the owner's remote viewer window opens only from the result's own
 * Remote viewer button. A remote viewer belongs to one owner and never adds
 * another machine's threads to its sidebar, so it hands a peer's result to
 * that owner's window.
 */
export function planSearchResultOpen(
  result: {
    backend: AppServerBackendKind;
    federation?: ThreadSearchResult["federation"];
    threadId: string;
  },
  windowTarget: FederationTarget | undefined,
): SearchResultOpenPlan {
  const ref = result.federation?.ref;
  if (!ref || !isRemoteFederationTarget(ref.target)) {
    return {
      kind: "this-window",
      backend: result.backend,
      threadId: result.threadId,
      threadKey: buildThreadIdentityKey(result.backend, result.threadId),
    };
  }
  if (windowTarget) {
    return { kind: "owner-window", target: ref.target, initialThread: ref };
  }
  return {
    kind: "this-window",
    backend: ref.backend,
    federationTarget: ref.target,
    threadId: ref.threadId,
    threadKey: federatedThreadIdentityKey(ref),
  };
}
