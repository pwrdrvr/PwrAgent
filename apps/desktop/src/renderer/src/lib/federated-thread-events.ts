import type {
  AgentEvent,
  FederationTarget,
  NavigationThreadSummary,
  ThreadIdentifier,
} from "@pwragent/shared";
import {
  buildThreadIdentityKey,
  federatedThreadIdentityKey,
} from "@pwragent/shared";

export function federationTargetsEqual(
  left: FederationTarget | undefined,
  right: FederationTarget | undefined,
): boolean {
  if (!left || left.scope === "local") {
    return !right || right.scope === "local";
  }
  return right?.scope === "remote" && right.instanceId === left.instanceId;
}

export function threadSummaryIdentityKey(thread: NavigationThreadSummary): string {
  return thread.federation?.ref
    ? federatedThreadIdentityKey(thread.federation.ref)
    : buildThreadIdentityKey(thread.source, thread.id);
}

export function agentEventThreadIdentityKey(
  event: AgentEvent,
  threadId: ThreadIdentifier,
): string {
  return event.federationTarget
    ? federatedThreadIdentityKey({
        backend: event.backend,
        target: event.federationTarget,
        threadId,
      })
    : buildThreadIdentityKey(event.backend, threadId);
}

export function agentEventMatchesThread(
  event: AgentEvent,
  thread: NavigationThreadSummary,
  threadId: ThreadIdentifier | undefined,
): boolean {
  return (
    event.backend === thread.source &&
    threadId === thread.id &&
    federationTargetsEqual(event.federationTarget, thread.federation?.ref.target)
  );
}
