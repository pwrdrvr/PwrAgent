import { z } from "zod";
import { isAppServerBackendKind } from "@pwragent/shared/contracts/navigation";
import type { ResourceAuthority, ResourceDomain, ResourceThreadRef } from "@pwragent/shared/contracts/resource-checkouts";

const string = z.string();
const strings = z.array(string);
const optionalText = string.optional();
const number = z.number();
const integer = z.int();
const positive = integer.positive();
const boolean = z.boolean();
const thread = z.object({
  backend: z.custom<ResourceThreadRef["backend"]>(value => typeof value === "string" && isAppServerBackendKind(value)),
  threadId: string.min(1), title: string, instanceId: optionalText, instanceLabel: optionalText,
});
const holder = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("thread"), thread }),
  z.object({ kind: z.literal(["operator", "automation"]), label: string }),
]);
const gate = z.discriminatedUnion("allowed", [
  z.object({ allowed: z.literal(true) }),
  z.object({ allowed: z.literal(false), detail: string, reason: z.enum([
    "not_authorized", "authority_unreachable", "ownership_unresolved", "pending_registration",
    "renewal_limit", "fencing_required", "policy", "not_applicable",
  ]) }),
]);
const recoveryActions = z.object({ fence: gate, verify_cleanup: gate, administrative_release: gate }).partial();
const recovery = z.object({
  allocationId: string, generation: positive, reason: string, since: number,
  fencing: z.enum(["verified", "unverified", "unknown"]), evidence: strings, actions: recoveryActions.optional(),
});

// Only validated owner fields enter the cache. Usage history is always computed by the viewer.
export const checkoutCatalogView = z.object({
  authority: z.object({
    authorityId: string, epoch: positive, kind: z.literal("federation_coordinator"), label: string, endpointLabel: string,
    status: z.enum(["reachable", "unreachable", "unresolved"]), lastSnapshotAt: number.optional(), lastSnapshotRevision: integer.optional(),
  }),
  resource: z.object({
    resourceId: string, canonicalKey: string, authorityId: string, displayName: string, kindLabel: string,
    placement: z.literal("external"), visibility: z.literal("federation"), allocationScope: z.literal("federation"),
    aliases: strings, relatedResourceIds: strings, conflictDomainIds: strings,
    condition: z.enum(["available", "busy", "draining", "waiting_interactive", "unreachable", "ownership_unresolved", "recovery_required", "pending_registration"]),
    conditionDetail: optionalText,
    sharing: z.discriminatedUnion("mode", [
      z.object({ mode: z.literal("exclusive") }),
      z.object({ mode: z.literal("counted"), capacity: positive, inUse: integer.nonnegative(), unitLabel: string }),
    ]),
    enforcement: z.object({ coverage: z.enum(["enforced", "mixed", "advisory", "none"]), summary: string, gaps: strings }),
    allocations: z.array(z.object({
      allocationId: string, state: z.enum(["granted", "preparing", "active", "draining", "recovery_required"]),
      holder, delegatedExecutor: thread.optional(), taskLabel: string, executorLabel: string, grantedAt: number, deadlineAt: number,
      renewalsUsed: integer, renewalsAllowed: integer, generation: positive, authorityEpoch: positive,
      units: positive.optional(), lastKnown: boolean, viewerOwns: boolean,
    })),
    queue: z.array(z.object({
      queueEntryId: string, position: positive, requester: holder, purpose: string, requestedAt: number,
      expectedDurationMs: positive.optional(), units: positive.optional(), viewerOwns: boolean,
      eligibility: z.discriminatedUnion("eligible", [z.object({ eligible: z.literal(true) }), z.object({ eligible: z.literal(false), reason: string })]),
    })),
    admission: z.object({ state: z.enum(["open", "paused"]), detail: string }).optional(),
    readiness: z.array(z.object({ checkId: string, label: string, state: z.enum(["ok", "warning", "failing", "needs_operator", "unknown"]),
      detail: string, observedAt: number.optional(), advisory: boolean })),
    advertisements: z.array(z.object({ instanceId: string, instanceLabel: string, profile: string, isViewer: boolean,
      onViewerMachine: boolean, observedAt: number, freshness: z.enum(["fresh", "stale", "expired"]), note: optionalText })),
    routes: z.array(z.object({ routeId: string, kind: z.enum(["local_process", "ssh", "provider_adapter", "thread_handoff"]),
      label: string, status: z.enum(["available", "unconfigured", "unreachable", "withheld"]),
      enforcement: z.enum(["enforced", "advisory"]), detail: optionalText })),
    instructions: z.object({ revision: positive, title: string, source: z.enum(["pwragent", "skill", "mcp_resource"]),
      sourceLabel: string, excerpt: string, updatedAt: number }).nullable(),
    policy: z.object({ useScope: string, manageScope: string, maxHoldMs: positive.optional(), renewalRule: string,
      queueOrder: z.enum(["fifo", "backfill"]).optional(), costCeilingLabel: optionalText, finalEffect: string }),
    cleanup: z.object({ state: z.enum(["verified", "in_progress", "failed", "unknown", "not_applicable"]), detail: string, verifiedAt: number.optional() }),
    recovery: recovery.nullable(), recoveries: z.array(recovery).optional(),
    ownershipConflict: z.object({ reason: string, remedy: string, resolution: z.object({
      kind: z.enum(["adopt_store", "accept_definition"]), label: string, consequence: string,
    }).optional() }).nullable(),
    definition: z.object({ revision: positive, updatedAt: number, publication: z.enum(["published", "pending_registration", "quarantined"]) }),
    actions: recoveryActions.extend({ request: gate, cancel_request: gate, release: gate, extend: gate, resolve_ownership: gate }).partial(),
  }),
}) satisfies z.ZodType<{ authority: ResourceAuthority; resource: ResourceDomain }>;
