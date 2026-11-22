import type { FederationInstanceId } from "./federation";
import type { AppServerBackendKind } from "./normalized-app-server";

/**
 * Resource checkouts: the operator's view of scarce capacity that agents
 * check out, wait for, and release, on this machine and across the
 * Federation.
 *
 * This file is the boundary between the desktop renderer and whatever
 * serves checkout state (a machine broker, a Federation coordinator, or a
 * Cloud coordinator behind the main process). The renderer only reads
 * snapshots and sends typed action requests; it never decides a grant.
 *
 * Shape rules:
 *
 * - One `ResourceDomain` per canonical capacity domain. Aliases,
 *   advertisements and execution routes hang off it; they never become rows
 *   of their own.
 * - The server derives `condition` and the per-action gates. The renderer
 *   may only make them *more* conservative (see the renderer's
 *   `resource-view-model.ts`), never less.
 * - Times are epoch milliseconds. Durations are milliseconds.
 * - Snapshots carry a monotonic `revision` for the viewing window. A
 *   renderer drops any snapshot older than the one it shows.
 */

export const RESOURCE_CHECKOUTS_CONTRACT_VERSION = 1;

/** One complete, revisioned view of every resource this instance can see. */
export type ResourceCheckoutsSnapshot = {
  contractVersion: typeof RESOURCE_CHECKOUTS_CONTRACT_VERSION;
  /** Monotonic for this viewer. Older snapshots are discarded. */
  revision: number;
  /** When the serving process assembled the snapshot. */
  observedAt: number;
  viewer: ResourceViewer;
  authorities: ResourceAuthority[];
  resources: ResourceDomain[];
  /** Gate for the Register resource affordance. */
  registerGate: ResourceActionGate;
};

export type ResourceViewer = {
  instanceId: FederationInstanceId;
  instanceLabel: string;
  profile: string;
  /** The shared `<PwrAgent root>/machine-id`, when resolved. */
  machineId?: string;
};

export type ResourceAuthorityKind =
  | "machine_broker"
  | "federation_coordinator"
  | "cloud_coordinator";

/**
 * `unreachable`: the authority exists but no current snapshot arrived; the
 * cached state it last sent can be shown but never authorizes work.
 * `unresolved`: no single authority could be established (missing or
 * conflicting identity). Nothing it covers can be granted.
 */
export type ResourceAuthorityStatus = "reachable" | "unreachable" | "unresolved";

export type ResourceAuthority = {
  authorityId: string;
  kind: ResourceAuthorityKind;
  label: string;
  /** Where the authority is served from, for display only. */
  endpointLabel: string;
  epoch: number;
  status: ResourceAuthorityStatus;
  /** Last authoritative snapshot from this authority. */
  lastSnapshotAt?: number;
  lastSnapshotRevision?: number;
};

export type ResourcePlacement = "machine" | "external";

/** Used for both visibility and allocation scope. */
export type ResourceScope = "instance" | "machine" | "federation";

export type ResourceSharing =
  | { mode: "exclusive" }
  | {
    mode: "counted";
    capacity: number;
    inUse: number;
    /** Operator-facing unit, e.g. "heavy-job slots". */
    unitLabel: string;
  };

/**
 * How much of the resource's use PwrAgent can actually enforce. `advisory`
 * routes (an arbitrary SSH shell, an independently held credential) are
 * coordination only, and the UI says so.
 */
export type ResourceEnforcement = {
  coverage: "enforced" | "mixed" | "advisory" | "none";
  summary: string;
  /** Known paths that bypass enforcement, in operator language. */
  gaps: string[];
};

/**
 * The single state a resource row reports. Ordered roughly by how much the
 * operator needs to do.
 *
 * - `available`: a current authority snapshot shows free capacity.
 * - `busy`: held by managed work; new requests queue (FIFO).
 * - `draining`: a holder released or expired; owned work is stopping and
 *   cleanup is being verified. Still consumes capacity.
 * - `waiting_interactive`: granted, but a prerequisite only a person can
 *   satisfy is missing (for example a signed-in desktop session).
 * - `unreachable`: the authority can't be reached. Cached state only.
 * - `ownership_unresolved`: identity or authority conflict. Records are
 *   quarantined; nothing is granted until reconciled.
 * - `recovery_required`: a lease ended with the workload or cleanup
 *   unverified. Capacity stays reserved.
 * - `pending_registration`: a local definition the registry has not
 *   confirmed. Not visible to other instances; not requestable.
 */
export type ResourceCondition =
  | "available"
  | "busy"
  | "draining"
  | "waiting_interactive"
  | "unreachable"
  | "ownership_unresolved"
  | "recovery_required"
  | "pending_registration";

export type ResourceDomain = {
  resourceId: string;
  /** Canonical identity key, e.g. `machine:<machine-id>:cpu`. Display only. */
  canonicalKey: string;
  displayName: string;
  /** Operator-facing kind, e.g. "Machine compute", "Retained Windows VM". */
  kindLabel: string;
  aliases: string[];
  conflictDomainIds: string[];
  /** Other resources sharing a conflict domain with this one. */
  relatedResourceIds: string[];
  placement: ResourcePlacement;
  visibility: ResourceScope;
  allocationScope: ResourceScope;
  /** `null` only while ownership is unresolved. */
  authorityId: string | null;
  condition: ResourceCondition;
  /** Server-written sentence explaining `condition`, when not `available`. */
  conditionDetail?: string;
  sharing: ResourceSharing;
  enforcement: ResourceEnforcement;
  /** Live allocations: granted, preparing, active, draining or in recovery. */
  allocations: ResourceAllocation[];
  /** FIFO order; `position` is 1-based. */
  queue: ResourceQueueEntry[];
  /** Admission control for conflicting managed work (exclusive windows). */
  admission?: { state: "open" | "paused"; detail: string };
  readiness: ResourceReadinessCheck[];
  advertisements: ResourceAdvertisement[];
  routes: ResourceExecutionRoute[];
  instructions: ResourceInstructionsRef | null;
  policy: ResourcePolicySummary;
  cleanup: ResourceCleanupStatus;
  /** First failed allocation, retained for clients that display one recovery. */
  recovery: ResourceRecoveryStatus | null;
  recoveries?: ResourceRecoveryStatus[];
  ownershipConflict: ResourceOwnershipConflict | null;
  definition: ResourceDefinitionStatus;
  /** Per-action gates from the authority for this viewer. */
  actions: ResourceActionGates;
};

export type ResourceThreadRef = {
  backend: AppServerBackendKind;
  threadId: string;
  title: string;
  /** Owning instance when the thread is not local to the viewer. */
  instanceId?: FederationInstanceId;
  instanceLabel?: string;
};

export type ResourceHolder =
  | { kind: "thread"; thread: ResourceThreadRef }
  /** A manual hold the operator took from this UI. */
  | { kind: "operator"; label: string }
  | { kind: "automation"; label: string };

export type ResourceAllocationState =
  | "granted"
  | "preparing"
  | "active"
  | "draining"
  | "recovery_required";

export type ResourceAllocation = {
  allocationId: string;
  state: ResourceAllocationState;
  holder: ResourceHolder;
  /** The bound task or job, e.g. "vitest shard 3/4". */
  taskLabel: string;
  /** Where the work actually runs, e.g. "studio-m4 · dev". */
  executorLabel: string;
  delegatedExecutor?: Extract<ResourceHolder, { kind: "thread" }>["thread"];
  grantedAt: number;
  deadlineAt: number;
  renewalsUsed: number;
  renewalsAllowed: number;
  generation: number;
  authorityEpoch: number;
  /** Counted capacity only. */
  units?: number;
  /** Served from an unreachable authority's last snapshot. */
  lastKnown: boolean;
  /** The viewer (this operator) owns this allocation. */
  viewerOwns: boolean;
};

export type ResourceQueueEntry = {
  queueEntryId: string;
  position: number;
  requester: ResourceHolder;
  purpose: string;
  requestedAt: number;
  expectedDurationMs?: number;
  units?: number;
  eligibility: { eligible: true } | { eligible: false; reason: string };
  viewerOwns: boolean;
};

export type ResourceReadinessState =
  | "ok"
  | "warning"
  | "failing"
  | "needs_operator"
  | "unknown";

export type ResourceReadinessCheck = {
  checkId: string;
  label: string;
  state: ResourceReadinessState;
  detail: string;
  observedAt?: number;
  /** Informational only (host load): never blocks a grant by itself. */
  advisory: boolean;
};

export type ResourceAdvertisement = {
  instanceId: FederationInstanceId;
  instanceLabel: string;
  profile: string;
  /** Advertised by the viewing instance and profile. */
  isViewer: boolean;
  /**
   * Advertised by any profile whose `<PwrAgent root>/machine-id` matches the
   * viewer's. False while the viewer's machine-id is unresolved: the producer
   * must not guess that a broker is local.
   */
  onViewerMachine: boolean;
  observedAt: number;
  freshness: "fresh" | "stale" | "expired";
  note?: string;
};

export type ResourceRouteKind =
  | "local_process"
  | "ssh"
  | "provider_adapter"
  | "thread_handoff";

export type ResourceExecutionRoute = {
  routeId: string;
  kind: ResourceRouteKind;
  label: string;
  status: "available" | "unconfigured" | "unreachable" | "withheld";
  enforcement: "enforced" | "advisory";
  detail?: string;
};

/**
 * Operating instructions are untrusted shared content. They are shown and
 * linked, never interpreted as permissions.
 */
export type ResourceInstructionsRef = {
  revision: number;
  title: string;
  source: "pwragent" | "skill" | "mcp_resource";
  sourceLabel: string;
  /** Bounded plain-text excerpt (the server truncates). */
  excerpt: string;
  updatedAt: number;
};

export type ResourcePolicySummary = {
  useScope: string;
  manageScope: string;
  maxHoldMs?: number;
  renewalRule: string;
  costCeilingLabel?: string;
  /** Required final state, e.g. "Stop compute, keep disks". */
  finalEffect: string;
};

export type ResourceCleanupStatus = {
  state: "verified" | "in_progress" | "failed" | "unknown" | "not_applicable";
  detail: string;
  verifiedAt?: number;
};

export type ResourceRecoveryStatus = {
  allocationId: string;
  generation: number;
  reason: string;
  since: number;
  /** Whether an old grant has been proven unable to act. */
  fencing: "verified" | "unverified" | "unknown";
  evidence: string[];
  /** Gates scoped to this exact allocation. Absent on older snapshots. */
  actions?: ResourceRecoveryActionGates;
};

export type ResourceOwnershipConflict = {
  reason: string;
  candidates: Array<{
    candidateId: string;
    label: string;
    detail: string;
    observedAt: number;
  }>;
};

export type ResourceDefinitionStatus = {
  revision: number;
  publication: "published" | "pending_registration" | "quarantined";
  updatedAt: number;
};

export type ResourceActionKind =
  | "request"
  | "cancel_request"
  | "release"
  | "extend"
  | "fence"
  | "verify_cleanup"
  | "administrative_release"
  | "resolve_ownership";

export type ResourceActionBlockReason =
  | "not_authorized"
  | "authority_unreachable"
  | "ownership_unresolved"
  | "pending_registration"
  | "renewal_limit"
  | "fencing_required"
  | "policy"
  | "not_applicable";

export type ResourceActionGate =
  | { allowed: true }
  | { allowed: false; reason: ResourceActionBlockReason; detail: string };

export type ResourceRecoveryActionGates = Partial<Record<"fence" | "verify_cleanup" | "administrative_release", ResourceActionGate>>;

/** Absent means the action is not offered for this resource at all. */
export type ResourceActionGates = Partial<Record<ResourceActionKind, ResourceActionGate>>;

export type ResourceDefinitionDraft = {
  displayName: string;
  canonicalKey: string;
  kindLabel: string;
  allocationScope: ResourceScope;
  sharing: ResourceSharing;
  instructionsSource?: string;
};

/**
 * Every request carries an idempotency key the renderer generates once per
 * operator intent, so a retried send after an unknown outcome cannot
 * create a second grant or release a newer one. Grant-scoped actions carry
 * the generation the operator saw; the authority rejects a stale one.
 */
export type ResourceCheckoutActionRequest =
  | {
    kind: "request";
    idempotencyKey: string;
    resourceId: string;
    purpose: string;
    expectedDurationMs: number;
    units?: number;
  }
  | {
    kind: "cancel_request";
    idempotencyKey: string;
    resourceId: string;
    queueEntryId: string;
  }
  | {
    kind: "release" | "extend" | "fence" | "verify_cleanup";
    idempotencyKey: string;
    resourceId: string;
    allocationId: string;
    generation: number;
  }
  | {
    kind: "delegate_execution";
    idempotencyKey: string;
    resourceId: string;
    allocationId: string;
    generation: number;
    authorityEpoch: number;
    executor: { instanceId: string; backend: AppServerBackendKind; threadId: string };
  }
  | {
    kind: "administrative_release";
    idempotencyKey: string;
    resourceId: string;
    allocationId: string;
    generation: number;
    auditNote: string;
  }
  | {
    kind: "resolve_ownership";
    idempotencyKey: string;
    resourceId: string;
    canonicalCandidateId: string;
  }
  | {
    kind: "register_definition";
    idempotencyKey: string;
    draft: ResourceDefinitionDraft;
  };

/**
 * `accepted`, `queued` and `granted` report what the authority recorded.
 * The renderer still waits for a snapshot at or after `revision` before it
 * shows the change; it never applies a result optimistically.
 *
 * `unknown`: the request may or may not have applied (timeout, dropped
 * connection). The renderer re-reads the snapshot and may resend with the
 * same idempotency key.
 */
export type ResourceCheckoutActionResult =
  | { outcome: "accepted"; revision?: number; message?: string }
  | { outcome: "queued"; queueEntryId: string; position: number; revision?: number }
  | { outcome: "granted"; allocationId: string; generation: number; revision?: number }
  | {
    outcome: "rejected";
    reason: ResourceActionBlockReason | "stale_generation" | "conflict";
    message: string;
  }
  | { outcome: "unknown"; message: string };

/** Marker event; listeners re-read the snapshot. */
export type ResourceCheckoutsChangedEvent = {
  revision: number;
};
