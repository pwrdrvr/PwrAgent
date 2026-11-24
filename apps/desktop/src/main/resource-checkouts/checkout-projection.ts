import { MAX_CHECKOUT_RENEWALS } from "@pwragent/owner-core/resource-checkout-authority";
import type { CheckoutActor, CheckoutDomainRecord, CheckoutGrant } from "@pwragent/owner-core/resource-checkout-storage";
import { isAppServerBackendKind } from "@pwragent/shared/contracts/navigation";
import type { WindowShowThreadRequest } from "../../shared/window-show-thread";
import type {
  ResourceActionGates, ResourceAuthority, ResourceDomain, ResourceHolder, ResourceOwnershipConflict, ResourceRecoveryStatus,
  ResourceThreadRef,
} from "@pwragent/shared/contracts/resource-checkouts";

/**
 * The holder an actor names, with the owning instance its key records. Grants
 * stored before holders carried `instanceId` still name their owner in the
 * key, `[instanceId, backend, threadId]`, so a click can reach the right
 * PwrAgent instead of guessing this one.
 */
export function actorHolder(actor: CheckoutActor): ResourceHolder {
  const { holder } = actor;
  if (holder.kind !== "thread" || holder.thread.instanceId) return holder;
  let key: unknown;
  try { key = JSON.parse(actor.key); } catch { return holder; }
  const owner: unknown = Array.isArray(key) ? key[0] : undefined;
  return typeof owner === "string" && owner ? { kind: "thread", thread: { ...holder.thread, instanceId: owner } } : holder;
}

/**
 * Where clicking a holder in Resources shows its thread: a thread owned by
 * another instance opens through Federation, this instance's own in place.
 * A malformed reference from the renderer shows nothing.
 */
export function resourceThreadShowRequest(thread: unknown, localInstanceId: string): WindowShowThreadRequest | undefined {
  if (!thread || typeof thread !== "object") return undefined;
  const { backend, threadId, instanceId } = thread as Partial<Record<keyof ResourceThreadRef, unknown>>;
  if (typeof backend !== "string" || !isAppServerBackendKind(backend) || typeof threadId !== "string" || !threadId.trim()
    || (instanceId !== undefined && typeof instanceId !== "string")) return undefined;
  return {
    backend, threadId,
    ...(instanceId && instanceId !== localInstanceId ? { federationTarget: { scope: "remote", instanceId } } : {}),
  };
}

function delegatedExecutor(grant: CheckoutGrant): { delegatedExecutor?: ResourceThreadRef } {
  const executor = grant.executor && actorHolder(grant.executor);
  return executor?.kind === "thread" ? { delegatedExecutor: executor.thread } : {};
}

/**
 * Applies `label` to every thread a resource names: holders, delegated
 * executors and queued requesters. A delegated executor's label follows its
 * thread's title.
 */
export function labelResourceThreads(
  resource: ResourceDomain,
  label: (thread: ResourceThreadRef) => ResourceThreadRef,
): ResourceDomain {
  const holder = (value: ResourceHolder): ResourceHolder => value.kind === "thread" ? { kind: "thread", thread: label(value.thread) } : value;
  return {
    ...resource,
    allocations: resource.allocations.map((allocation) => {
      if (!allocation.delegatedExecutor) return { ...allocation, holder: holder(allocation.holder) };
      const delegatedExecutor = label(allocation.delegatedExecutor);
      const delegatedLabel = `Delegated to ${allocation.delegatedExecutor.title}`;
      return {
        ...allocation, holder: holder(allocation.holder), delegatedExecutor,
        executorLabel: allocation.executorLabel === delegatedLabel ? `Delegated to ${delegatedExecutor.title}` : allocation.executorLabel,
      };
    }),
    queue: resource.queue.map((entry) => ({ ...entry, requester: holder(entry.requester) })),
  };
}

function projectRecovery(grant: CheckoutGrant, machine: boolean, canRecover: boolean): ResourceRecoveryStatus {
  const hasProcessGroup = grant.job?.processGroupId !== undefined;
  const verified = grant.fencingVerifiedAt !== undefined;
  const verifiedGate = verified ? { allowed: true as const }
    : { allowed: false as const, reason: "fencing_required" as const, detail: "Fence the owned process group first." };
  return {
    allocationId: grant.id, generation: grant.generation, since: grant.recoverySince ?? grant.deadlineAt,
    reason: machine && !hasProcessGroup
      ? "No local process group was recorded for this job."
      : "An owned job has unverified cleanup.",
    fencing: verified ? "verified" : "unverified",
    evidence: verified ? ["The local process group is gone."] : [],
    actions: canRecover && hasProcessGroup ? {
      fence: { allowed: true }, verify_cleanup: verifiedGate, administrative_release: verifiedGate,
    } : {},
  };
}

/** For an unresolved authority whose caller could not say more. */
export const UNEXPLAINED_OWNERSHIP_CONFLICT: ResourceOwnershipConflict = {
  reason: "The checkout authority could not be bound to this root.",
  remedy: "Check the main-process log for pwragent:resource-checkouts, correct the cause, and restart PwrAgent.",
};

/**
 * `conflict` explains an `unresolved` authority and is ignored otherwise. An
 * unresolved resource offers only `resolve_ownership`, and only to the local
 * operator when the conflict carries a resolution.
 */
export function projectCheckoutDomain(
  record: CheckoutDomainRecord,
  actor: CheckoutActor,
  authority: ResourceAuthority,
  approvedProvider = false,
  conflict: ResourceOwnershipConflict = UNEXPLAINED_OWNERSHIP_CONFLICT,
): ResourceDomain {
  const { definition, grants, queue, cleanupVerifiedAt } = record;
  const machine = definition.scope === "machine" && definition.canonicalKey.startsWith("machine:");
  const pending = definition.publication === "pending_registration";
  const held = record.grants.reduce((sum, grant) => sum + grant.units, 0);
  const draining = grants.some((grant) => grant.state === "draining");
  const owned = grants.find((grant) => grant.actor.key === actor.key);
  const unavailable = authority.status !== "reachable";
  const canRecover = machine && !unavailable && !pending && actor.manage && actor.holder.kind === "operator";
  const recoveries = grants.filter((grant) => grant.state === "recovery_required")
    .map((grant) => projectRecovery(grant, machine, canRecover));
  const recovery = recoveries[0] ?? null;
  const resolvable = authority.status === "unresolved" && conflict.resolution !== undefined
    && actor.manage && actor.holder.kind === "operator";
  const actions: ResourceActionGates = resolvable ? { resolve_ownership: { allowed: true } } : unavailable || pending ? {} : {
    request: recovery ? { allowed: false, reason: "fencing_required", detail: "The previous job needs verified cleanup." } : { allowed: true },
    ...recovery?.actions,
    ...(queue.some((entry) => entry.actor.key === actor.key) ? { cancel_request: { allowed: true } } : {}),
    ...(owned && owned.state !== "recovery_required" && owned.state !== "draining" ? { release: { allowed: true } } : {}),
    ...(owned && !owned.job?.provider && (owned.state === "granted" || owned.state === "active") ? {
      extend: owned.renewals < MAX_CHECKOUT_RENEWALS && !queue.length && owned.deadlineAt < owned.grantedAt + definition.maxHoldMs
        ? { allowed: true } : { allowed: false, reason: "renewal_limit", detail: "The lease limit was reached or another requester is waiting." },
    } : {}),
  };
  return {
    resourceId: definition.resourceId, canonicalKey: definition.canonicalKey, displayName: definition.displayName,
    kindLabel: definition.kindLabel, aliases: [], conflictDomainIds: [definition.canonicalKey], relatedResourceIds: [],
    placement: machine ? "machine" : "external", visibility: pending ? "instance" : definition.scope,
    allocationScope: definition.scope, authorityId: authority.authorityId,
    condition: authority.status === "unresolved" ? "ownership_unresolved" : unavailable ? "unreachable"
      : pending ? "pending_registration" : recovery ? "recovery_required" : draining ? "draining"
        : held >= definition.capacity || queue.length > 0 ? "busy" : "available",
    ...(recovery ? { conditionDetail: "The executor has not verified that its owned work ended." } : {}),
    sharing: definition.counted ? {
      mode: "counted", capacity: definition.capacity, inUse: held, unitLabel: machine ? "CPU slots" : "slots",
    } : { mode: "exclusive" },
    enforcement: machine ? {
      coverage: "advisory", summary: "This authority coordinates cooperative CPU reservations across local profiles.",
      gaps: ["Environment setup, environment actions, automation gates, agent shell commands, terminals, CI, and other applications are outside checkout enforcement."],
    } : approvedProvider ? {
      coverage: "mixed", summary: "PwrSuiteLab enforces the approved workload and cleanup policy.",
      gaps: ["Provider credentials and independently launched work are outside checkout enforcement."],
    } : {
      coverage: "advisory", summary: "This authority coordinates reservations for this resource.",
      gaps: ["Provider credentials and independently launched work are outside checkout enforcement."],
    },
    allocations: grants.map((grant) => ({
      allocationId: grant.id, state: grant.state, holder: actorHolder(grant.actor), taskLabel: grant.purpose,
      executorLabel: grant.job?.executor ?? (grant.executor?.holder.kind === "thread"
        ? `Delegated to ${grant.executor.holder.thread.title}` : "No managed job"),
      ...delegatedExecutor(grant),
      grantedAt: grant.grantedAt, deadlineAt: grant.deadlineAt,
      renewalsUsed: grant.renewals, renewalsAllowed: MAX_CHECKOUT_RENEWALS, authorityEpoch: definition.epoch,
      generation: grant.generation, ...(definition.counted ? { units: grant.units } : {}),
      lastKnown: unavailable, viewerOwns: grant.actor.key === actor.key,
    })),
    queue: queue.map((entry, index) => ({
      queueEntryId: entry.id, position: index + 1, requester: actorHolder(entry.actor), purpose: entry.purpose,
      requestedAt: entry.requestedAt, expectedDurationMs: entry.durationMs,
      ...(definition.counted ? { units: entry.units } : {}),
      eligibility: { eligible: true }, viewerOwns: entry.actor.key === actor.key,
    })),
    readiness: [], advertisements: [],
    routes: machine ? [{
      routeId: "local-process", kind: "local_process", label: "Local processes",
      status: "available", enforcement: "advisory",
      detail: "Agents and operators coordinate machine CPU checkouts cooperatively through the checkout tools.",
    }] : approvedProvider ? [{
      routeId: "provider", kind: "provider_adapter", label: "Approved PwrSuiteLab workload",
      status: "available", enforcement: "enforced",
    }] : [{
      routeId: "provider", kind: "provider_adapter", label: "Provider adapter", status: "unconfigured",
      enforcement: "advisory", detail: "No provider executor is configured for this definition.",
    }],
    instructions: definition.instructions ?? null,
    policy: {
      useScope: machine ? "Local profiles" : "Operator-configured instances",
      manageScope: "Operator", maxHoldMs: definition.maxHoldMs,
      renewalRule: "One renewal while no requester is waiting, within the maximum hold.",
      costCeilingLabel: approvedProvider ? "Operator-approved workload only" : "No spending permission",
      finalEffect: machine ? "Release reserved CPU slots" : approvedProvider ? "Stop compute and verify retained assets" : "No provider lifecycle operations",
    },
    cleanup: recovery ? { state: "unknown", detail: "Owned workload cleanup is unverified." }
      : draining ? { state: "in_progress", detail: "Capacity stays reserved during cleanup." }
        : cleanupVerifiedAt === undefined ? { state: "not_applicable", detail: "No managed cleanup has been recorded." }
          : { state: "verified", detail: "The executor verified an owned job ended.", verifiedAt: cleanupVerifiedAt },
    recovery, recoveries,
    // A copy, so a caller can't change the shared explanations.
    ownershipConflict: authority.status === "unresolved" ? structuredClone(conflict) : null,
    definition: { revision: definition.revision, updatedAt: definition.updatedAt, publication: definition.publication },
    actions,
  };
}
