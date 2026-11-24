import type {
  ResourceAllocation,
  ResourceCheckoutsSnapshot,
  ResourceDomain,
  ResourceEnforcement,
  ResourceHolder,
  ResourceQueueEntry,
  ResourceScope,
} from "@pwragent/shared/contracts/resource-checkouts";
import { capacitySummary, effectiveCondition, findAuthority, freeUnits, holderLabel, presentCondition } from "./resource-view-model";

/** The thread a resource wait belongs to, as checkout holders name threads. */
export type ResourceWaiter = { backend: string; threadId: string };

/**
 * Where the waiting thread stands. Its own queue entry comes first: a wait is
 * for a queued request, so a thread that holds some of the resource and also
 * queues for more is still waiting, and `holds` is what it keeps reserved
 * meanwhile.
 */
export type ResourceWaitPlace =
  | { kind: "holding" }
  | { kind: "queued"; position: number; ahead: number; queueLength: number; hold: QueueEntryHold; holds?: number }
  | { kind: "not_queued"; queueLength: number };

export type ResourceWaitHolder = { label: string; grantedAt: number; deadlineAt: number; units?: number };

/** What the Waiting for tab says about one resource wait. */
export type ResourceWaitSummary = {
  resourceId: string;
  name: string;
  kindLabel: string;
  conditionLabel: string;
  conditionDetail?: string;
  /** "2 of 14 free", for counted capacity. */
  capacity?: string;
  /** "CPU slot" or "unit", singular. */
  unit: string;
  place: ResourceWaitPlace;
  /** Everyone else holding it now. */
  holders: ResourceWaitHolder[];
  enforcement: { coverage: ResourceEnforcement["coverage"]; label: string; summary: string; gaps: string[] };
  scopeLabel: string;
};

/**
 * Why a queued request has not started. Promotion is strictly first in,
 * first out: only the head is granted, and only once it fits.
 *
 * - `capacity`: the head needs more than is free.
 * - `order`: an earlier request goes first. `fitsNow` marks a request that
 *   would fit in the free capacity, the case where FIFO alone holds it.
 * - `pending`: the head fits; the authority has not granted it yet, or a
 *   recovery holds the whole resource.
 */
export type QueueEntryHold = {
  reason: "capacity" | "order" | "pending";
  needs: number;
  free: number;
  fitsNow: boolean;
};

/** Units still free, counting an exclusive resource as one unit. */
export function freeCapacity(resource: Pick<ResourceDomain, "sharing" | "allocations">): number {
  return freeUnits(resource as ResourceDomain) ?? (resource.allocations.length === 0 ? 1 : 0);
}

export function queueEntryHold(
  resource: Pick<ResourceDomain, "sharing" | "allocations">,
  entry: Pick<ResourceQueueEntry, "position" | "units">,
): QueueEntryHold {
  const needs = resource.sharing.mode === "counted" ? entry.units ?? 1 : 1;
  const free = freeCapacity(resource);
  const fitsNow = needs <= free;
  const reason = entry.position > 1 ? "order" : fitsNow ? "pending" : "capacity";
  return { reason, needs, free, fitsNow };
}

/** One sentence on a queued request's hold, in the resource's unit. */
export function describeQueueEntryHold(hold: QueueEntryHold, position: number, unit: string): string {
  const units = (count: number) => `${count} ${unit}${count === 1 ? "" : "s"}`;
  switch (hold.reason) {
    case "capacity":
      return `Needs ${units(hold.needs)}, ${hold.free} free. Starts when ${hold.needs - hold.free} more ${hold.needs - hold.free === 1 ? "frees" : "free"} up.`;
    case "pending":
      return `Fits in the ${hold.free} free. Waiting for the authority to grant it.`;
    case "order":
      return hold.fitsNow
        ? `Would fit now (${hold.needs} of ${hold.free} free), but waits for ${position === 2 ? "#1" : `#1 to #${position - 1}`}: first in, first out.`
        : `Needs ${units(hold.needs)}. Waits for ${position - 1} earlier request${position === 2 ? "" : "s"}.`;
  }
}

/**
 * How long a grant has been held against what its requester expected. The
 * expected span is the grant's own deadline window, so a renewal widens it.
 */
export function allocationHoldTime(
  allocation: Pick<ResourceAllocation, "grantedAt" | "deadlineAt">,
  now: number,
): { heldMs: number; expectedMs: number } {
  return {
    heldMs: Math.max(0, now - allocation.grantedAt),
    expectedMs: Math.max(0, allocation.deadlineAt - allocation.grantedAt),
  };
}

/** The holder's own queued request on the same resource, when it has one. */
export function holderAlsoQueued(
  resource: Pick<ResourceDomain, "queue">,
  holder: ResourceHolder,
): ResourceQueueEntry | undefined {
  if (holder.kind !== "thread") return undefined;
  return resource.queue.find((entry) => entry.requester.kind === "thread"
    && entry.requester.thread.backend === holder.thread.backend
    && entry.requester.thread.threadId === holder.thread.threadId);
}

function isWaiter(holder: ResourceHolder, waiter: ResourceWaiter): boolean {
  return holder.kind === "thread"
    && holder.thread.backend === waiter.backend
    && holder.thread.threadId === waiter.threadId;
}

/** Plain words for how much of the resource's use PwrAgent enforces. */
export function enforcementLabel(coverage: ResourceEnforcement["coverage"]): string {
  switch (coverage) {
    case "enforced":
      return "Enforced";
    case "mixed":
      return "Partly enforced";
    case "advisory":
      return "Agreement only, not enforced";
    case "none":
      return "Not enforced";
  }
}

/** Who shares the resource's capacity. */
export function allocationScopeLabel(scope: ResourceScope): string {
  switch (scope) {
    case "instance":
      return "This PwrAgent only";
    case "machine":
      return "Every profile on this machine";
    case "federation":
      return "Every instance in the federation";
  }
}

/**
 * The waiting thread's view of one resource, or `undefined` when this
 * snapshot does not list the resource (a peer's authority, or a definition
 * removed since the wait was registered).
 */
export function summarizeResourceWait(
  snapshot: ResourceCheckoutsSnapshot,
  resourceId: string,
  waiter: ResourceWaiter,
): ResourceWaitSummary | undefined {
  const resource = snapshot.resources.find((candidate) => candidate.resourceId === resourceId);
  if (!resource) return undefined;
  const condition = effectiveCondition(resource, findAuthority(snapshot, resource));
  const queueLength = resource.queue.length;
  const own = resource.allocations.filter((allocation) => isWaiter(allocation.holder, waiter));
  const holds = own.reduce((sum, allocation) => sum + (allocation.units ?? 1), 0);
  const entry = resource.queue.find((candidate) => isWaiter(candidate.requester, waiter));
  const place: ResourceWaitPlace = entry ? {
    kind: "queued",
    position: entry.position,
    ahead: entry.position - 1,
    queueLength,
    hold: queueEntryHold(resource, entry),
    ...(holds > 0 ? { holds } : {}),
  }
    : own.length > 0 ? { kind: "holding" }
    : { kind: "not_queued", queueLength };
  const capacity = capacitySummary(resource);
  return {
    resourceId,
    name: resource.displayName,
    kindLabel: resource.kindLabel,
    conditionLabel: presentCondition(condition).label,
    ...(resource.conditionDetail ? { conditionDetail: resource.conditionDetail } : {}),
    ...(capacity ? { capacity } : {}),
    unit: resource.placement === "machine" ? "CPU slot" : "unit",
    place,
    holders: resource.allocations
      .filter((allocation) => !isWaiter(allocation.holder, waiter))
      .map((allocation) => ({
        label: holderLabel(allocation.holder),
        grantedAt: allocation.grantedAt,
        deadlineAt: allocation.deadlineAt,
        ...(allocation.units !== undefined ? { units: allocation.units } : {}),
      })),
    enforcement: {
      coverage: resource.enforcement.coverage,
      label: enforcementLabel(resource.enforcement.coverage),
      summary: resource.enforcement.summary,
      gaps: resource.enforcement.gaps,
    },
    scopeLabel: allocationScopeLabel(resource.allocationScope),
  };
}

/** "#2 in line, 1 ahead", "Holding it now", "Not in the queue". */
export function describeResourceWaitPlace(place: ResourceWaitPlace): string {
  switch (place.kind) {
    case "holding":
      return "Granted. This thread holds it now.";
    case "queued":
      return place.ahead === 0
        ? `Next in line (#${place.position} of ${place.queueLength})`
        : `#${place.position} of ${place.queueLength} in line, ${place.ahead} ahead`;
    case "not_queued":
      return place.queueLength === 0 ? "Not in the queue" : `Not in the queue of ${place.queueLength}`;
  }
}
