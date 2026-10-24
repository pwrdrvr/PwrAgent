import type {
  FederationRemoteTarget,
  NavigationThreadSummary,
} from "@pwragent/shared";
import {
  buildThreadIdentityKey,
  isRemoteFederationTarget,
} from "@pwragent/shared";

export function readRendererFederationTarget(): FederationRemoteTarget | undefined {
  const target = (window as typeof window & {
    __pwragentFederationTarget?: Partial<FederationRemoteTarget>;
  }).__pwragentFederationTarget;
  return target?.scope === "remote" && typeof target.instanceId === "string"
    ? { scope: "remote", instanceId: target.instanceId }
    : undefined;
}

/**
 * Whether this renderer is a viewer fronting a peer instance rather than the
 * main window of this instance.
 *
 * A viewer reads its whole navigation snapshot through the peer, and the main
 * process stamps every row it returns as remote (`stampRemoteNavigationSnapshot`)
 * — so anything that tells "this instance's" work apart from "a peer's" has
 * no content in a viewer: every row is the peer's, and closing the window
 * interrupts none of it. Surfaces that split by machine (the Attention tab's
 * counts, the thread rows' scanners, the transcript's pending line) gate on
 * this so they all make, or all skip, the distinction together.
 */
export function isFederationViewerWindow(): boolean {
  return readRendererFederationTarget() !== undefined;
}

/**
 * The instance that owns a thread's checkout: the thread's own remote ref,
 * else the peer this window fronts. Undefined means this instance.
 */
export function resolveThreadOwnerFederationTarget(
  thread: NavigationThreadSummary,
  federationWindowInstanceId?: string,
): FederationRemoteTarget | undefined {
  const threadTarget = thread.federation?.ref.target;
  if (threadTarget && isRemoteFederationTarget(threadTarget)) {
    return threadTarget;
  }
  return federationWindowInstanceId
    ? { scope: "remote", instanceId: federationWindowInstanceId }
    : undefined;
}

/** A thread key that keeps one owner's thread apart from another's. */
export function buildThreadOwnerKey(
  thread: NavigationThreadSummary,
  federationWindowInstanceId?: string,
): string {
  const federationTarget = resolveThreadOwnerFederationTarget(
    thread,
    federationWindowInstanceId,
  );
  return `${federationTarget?.instanceId ?? "local"}:${buildThreadIdentityKey(
    thread.source,
    thread.id,
  )}`;
}

export function readRendererFederationLabel(): string | undefined {
  const label = (window as typeof window & {
    __pwragentFederationLabel?: unknown;
  }).__pwragentFederationLabel;
  return typeof label === "string" && label.trim()
    ? label.trim()
    : undefined;
}
