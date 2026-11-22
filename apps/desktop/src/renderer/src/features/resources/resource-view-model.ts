import type {
  ResourceActionBlockReason,
  ResourceActionGate,
  ResourceActionKind,
  ResourceAllocation,
  ResourceAuthority,
  ResourceCheckoutsSnapshot,
  ResourceCondition,
  ResourceDomain,
  ResourceQueueEntry,
} from "@pwragent/shared/contracts/resource-checkouts";

/**
 * Presentation rules for resource checkouts.
 *
 * The serving authority decides conditions and action gates. This module may
 * only make them more conservative: a resource whose authority is missing or
 * unreachable never reads as free and never offers an action that would need
 * that authority, and a blocked server gate is never shown as allowed.
 * `__tests__/resource-view-model.property.test.ts` holds those rules.
 */

export type ResourceConditionTone =
  | "available"
  | "busy"
  | "draining"
  | "interactive"
  | "unreachable"
  | "unresolved"
  | "recovery"
  | "draft";

export type ResourceConditionPresentation = {
  label: string;
  tone: ResourceConditionTone;
  /** One sentence on what the state means, for tooltips and the legend. */
  meaning: string;
  needsAttention: boolean;
};

const CONDITION_PRESENTATION: Record<ResourceCondition, ResourceConditionPresentation> = {
  available: {
    label: "Available",
    tone: "available",
    meaning: "The authority shows free capacity. A request is granted right away.",
    needsAttention: false,
  },
  busy: {
    label: "Busy",
    tone: "busy",
    meaning: "Held by managed work. New requests wait in order.",
    needsAttention: false,
  },
  draining: {
    label: "Draining",
    tone: "draining",
    meaning: "Owned work is stopping and cleanup is being verified.",
    needsAttention: false,
  },
  waiting_interactive: {
    label: "Needs interactive session",
    tone: "interactive",
    meaning: "Granted, but waiting on a step only a person can do, such as signing in.",
    needsAttention: true,
  },
  unreachable: {
    label: "Authority unreachable",
    tone: "unreachable",
    meaning: "The allocating authority can't be reached. Cached state can't grant work.",
    needsAttention: true,
  },
  ownership_unresolved: {
    label: "Ownership unresolved",
    tone: "unresolved",
    meaning: "Identity or authority conflicts. Nothing is granted until it's reconciled.",
    needsAttention: true,
  },
  recovery_required: {
    label: "Recovery required",
    tone: "recovery",
    meaning: "A lease ended with work or cleanup unverified. Capacity stays reserved.",
    needsAttention: true,
  },
  pending_registration: {
    label: "Pending registration",
    tone: "draft",
    meaning: "A local definition the registry hasn't confirmed. Other instances can't see it.",
    needsAttention: false,
  },
};

export const RESOURCE_CONDITION_ORDER: readonly ResourceCondition[] = [
  "available",
  "busy",
  "draining",
  "waiting_interactive",
  "unreachable",
  "ownership_unresolved",
  "recovery_required",
  "pending_registration",
];

export function presentCondition(condition: ResourceCondition): ResourceConditionPresentation {
  return CONDITION_PRESENTATION[condition];
}

export function findAuthority(
  snapshot: Pick<ResourceCheckoutsSnapshot, "authorities">,
  resource: Pick<ResourceDomain, "authorityId">,
): ResourceAuthority | undefined {
  if (resource.authorityId === null) return undefined;
  return snapshot.authorities.find((authority) => authority.authorityId === resource.authorityId);
}

function capacityExhausted(resource: ResourceDomain): boolean {
  if (resource.sharing.mode === "exclusive") return resource.allocations.length > 0;
  return resource.sharing.inUse >= resource.sharing.capacity;
}

/**
 * The condition the row shows. Conservative clamps, in order:
 *
 * 1. A draft stays a draft: it has no authority to ask yet.
 * 2. No bound authority, an ownership conflict, or an `unresolved` authority
 *    reads as Ownership unresolved.
 * 3. An authority missing from the snapshot, or unreachable, reads as
 *    Authority unreachable, whatever the cached condition said.
 * 4. "Available" with its capacity fully held reads as Busy.
 */
export function effectiveCondition(
  resource: ResourceDomain,
  authority: ResourceAuthority | undefined,
): ResourceCondition {
  if (resource.condition === "pending_registration") return "pending_registration";
  if (
    resource.authorityId === null
    || resource.ownershipConflict !== null
    || authority?.status === "unresolved"
  ) {
    return "ownership_unresolved";
  }
  if (!authority || authority.status !== "reachable") return "unreachable";
  if (resource.condition === "available" && capacityExhausted(resource)) return "busy";
  return resource.condition;
}

function blocked(reason: ResourceActionBlockReason, detail: string): ResourceActionGate {
  return { allowed: false, reason, detail };
}

/**
 * The gate a control shows. `undefined` means the action is not offered.
 * A server gate that is already blocked passes through unchanged.
 */
export function effectiveGate(
  resource: ResourceDomain,
  authority: ResourceAuthority | undefined,
  kind: ResourceActionKind,
): ResourceActionGate | undefined {
  const server = resource.actions[kind];
  if (!server) return undefined;
  if (!server.allowed) return server;
  const condition = effectiveCondition(resource, authority);
  if (condition === "pending_registration") {
    return blocked("pending_registration", "Available after the registry confirms this definition.");
  }
  if (condition === "ownership_unresolved" && kind !== "resolve_ownership") {
    return blocked("ownership_unresolved", "Resolve ownership before anyone can use this resource.");
  }
  if (condition === "unreachable") {
    return blocked(
      "authority_unreachable",
      "The authority can't be reached. Cached state can't change a checkout.",
    );
  }
  if (kind === "resolve_ownership" && condition !== "ownership_unresolved") {
    return blocked("not_applicable", "Ownership is already resolved.");
  }
  if (kind === "administrative_release" && resource.recovery?.fencing !== "verified") {
    return blocked(
      "fencing_required",
      "Administrative release needs verified fencing. It never erases an active owner.",
    );
  }
  if (kind === "verify_cleanup" && resource.recovery && resource.recovery.fencing !== "verified") {
    return blocked("fencing_required", "Fence the old workload first.");
  }
  if (kind === "extend") {
    const held = viewerAllocation(resource);
    if (held && held.renewalsUsed >= held.renewalsAllowed) {
      return blocked(
        "renewal_limit",
        `Renewal limit reached (${held.renewalsUsed} of ${held.renewalsAllowed}).`,
      );
    }
  }
  return server;
}

export function viewerAllocation(resource: ResourceDomain): ResourceAllocation | undefined {
  return resource.allocations.find((allocation) => allocation.viewerOwns);
}

export function viewerQueueEntry(resource: ResourceDomain): ResourceQueueEntry | undefined {
  return resource.queue.find((entry) => entry.viewerOwns);
}

export type ResourceActionDescriptor = {
  kind: ResourceActionKind;
  label: string;
  emphasis: "primary" | "secondary" | "danger";
  gate: ResourceActionGate;
  /** For `request`: whether it would wait in the queue instead of granting now. */
  waits?: boolean;
};

/**
 * The header actions for one resource, in display order. Request and Join
 * queue are one control: the label follows whether the request would wait.
 */
export function resourceActions(
  resource: ResourceDomain,
  authority: ResourceAuthority | undefined,
): ResourceActionDescriptor[] {
  const out: ResourceActionDescriptor[] = [];
  const add = (
    kind: ResourceActionKind,
    label: string,
    emphasis: ResourceActionDescriptor["emphasis"],
    extra: Pick<ResourceActionDescriptor, "waits"> = {},
  ) => {
    const gate = effectiveGate(resource, authority, kind);
    if (gate) out.push({ kind, label, emphasis, gate, ...extra });
  };
  const condition = effectiveCondition(resource, authority);
  const held = viewerAllocation(resource);
  const queued = viewerQueueEntry(resource);
  if (queued) {
    add("cancel_request", "Cancel request", "secondary");
  } else if (held) {
    add("release", "Release", "secondary");
    add("extend", "Extend", "secondary");
  } else {
    const waits = requestWouldWait(resource, condition);
    add("request", waits ? "Join queue" : "Request checkout", "primary", { waits });
  }
  if (resource.recovery) {
    add("fence", "Fence old workload", "secondary");
    add("verify_cleanup", "Verify cleanup", "secondary");
    add("administrative_release", "Administrative release", "danger");
  }
  if (condition === "ownership_unresolved") {
    add("resolve_ownership", "Resolve ownership", "danger");
  }
  return out;
}

/** Whether a request would queue rather than be granted now. */
export function requestWouldWait(resource: ResourceDomain, condition: ResourceCondition): boolean {
  if (condition !== "available" && condition !== "busy") return true;
  if (resource.queue.length > 0) return true;
  if (resource.sharing.mode === "counted") {
    return resource.sharing.inUse >= resource.sharing.capacity;
  }
  return resource.allocations.length > 0;
}

export function freeUnits(resource: ResourceDomain): number | undefined {
  if (resource.sharing.mode !== "counted") return undefined;
  return Math.max(0, resource.sharing.capacity - resource.sharing.inUse);
}

/** "2 of 4 free" for counted capacity, otherwise undefined. */
export function capacitySummary(resource: ResourceDomain): string | undefined {
  if (resource.sharing.mode !== "counted") return undefined;
  return `${freeUnits(resource)} of ${resource.sharing.capacity} free`;
}

/**
 * The chip label for a row or inspector: a busy counted resource with units
 * still free reads as its free count; anything else reads as its condition.
 */
export function conditionChipLabel(
  resource: ResourceDomain,
  condition: ResourceCondition,
): string | undefined {
  if (condition !== "busy" || resource.sharing.mode !== "counted") return undefined;
  if (resource.sharing.inUse >= resource.sharing.capacity) return undefined;
  return capacitySummary(resource);
}

export type ResourceFilter = "all" | "held" | "queued" | "attention";
export type ResourceScopeFilter = "all" | "machine" | "federation";

export type PresentedResource = {
  resource: ResourceDomain;
  authority: ResourceAuthority | undefined;
  condition: ResourceCondition;
  presentation: ResourceConditionPresentation;
};

export function presentResources(snapshot: ResourceCheckoutsSnapshot): PresentedResource[] {
  return snapshot.resources.map((resource) => {
    const authority = findAuthority(snapshot, resource);
    const condition = effectiveCondition(resource, authority);
    return { resource, authority, condition, presentation: presentCondition(condition) };
  });
}

/** Machine-scoped capacity on the viewer's own machine sorts under "This machine". */
export function resourceGroup(
  resource: ResourceDomain,
  authority: ResourceAuthority | undefined,
): "machine" | "federation" {
  if (resource.allocationScope === "federation") return "federation";
  if (authority?.kind !== "machine_broker") return "federation";
  // Only positive evidence places a broker on this machine. An unresolved
  // machine-id leaves a peer's broker under Federation, never under here.
  return resource.advertisements.some((ad) => ad.isViewer || ad.onViewerMachine)
    ? "machine"
    : "federation";
}

export function matchesFilter(item: PresentedResource, filter: ResourceFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "held":
      return item.resource.allocations.length > 0;
    case "queued":
      return item.resource.queue.length > 0;
    case "attention":
      return item.presentation.needsAttention;
  }
}

export function matchesSearch(resource: ResourceDomain, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [resource.displayName, resource.kindLabel, resource.canonicalKey, ...resource.aliases]
    .some((text) => text.toLowerCase().includes(needle));
}

export function countAttention(snapshot: ResourceCheckoutsSnapshot): number {
  return presentResources(snapshot).filter((item) => item.presentation.needsAttention).length;
}

export function holderLabel(holder: ResourceAllocation["holder"]): string {
  switch (holder.kind) {
    case "thread":
      return holder.thread.title;
    case "operator":
      return holder.label;
    case "automation":
      return holder.label;
  }
}

/** "34m left", "1h 05m left", "12m over". */
export function formatDeadline(deadlineAt: number, now: number): string {
  const minutes = Math.round((deadlineAt - now) / 60_000);
  if (minutes < 0) return `${-minutes}m over`;
  if (minutes < 60) return `${minutes}m left`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m left`;
}

/** "now", "4m", "2h", "3d". */
export function formatAge(at: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

/** Deadlines inside this window read in the warning tone. */
export const DEADLINE_SOON_MS = 15 * 60_000;
