import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type {
  ResourceActionGate,
  ResourceActionGates,
  ResourceActionKind,
  ResourceAllocation,
  ResourceAuthority,
  ResourceCheckoutsSnapshot,
  ResourceCondition,
  ResourceDomain,
  ResourceQueueEntry,
} from "@pwragent/shared/contracts/resource-checkouts";
import {
  effectiveCondition,
  effectiveGate,
  resourceActions,
  resourceGroup,
} from "../resource-view-model";
import { acceptSnapshot } from "../useResourceCheckouts";

/**
 * The rules in resource-view-model.ts's header and the PRD's operator
 * section, as properties:
 *
 * - The UI may make an authority's answer more conservative, never less.
 * - Cached state from an unreachable (or missing) authority never reads as
 *   usable capacity and never offers an action.
 * - Ownership unresolved offers only the resolution the authority describes:
 *   every other action shows blocked, and resolving is offered nowhere else.
 * - A draft offers nothing.
 * - Administrative release needs verified fencing.
 * - "Available" never shows while the capacity is fully held.
 */

const ACTION_KINDS: ResourceActionKind[] = [
  "request",
  "cancel_request",
  "release",
  "extend",
  "fence",
  "verify_cleanup",
  "administrative_release",
  "resolve_ownership",
];

const CONDITIONS: ResourceCondition[] = [
  "available",
  "busy",
  "draining",
  "waiting_interactive",
  "unreachable",
  "ownership_unresolved",
  "recovery_required",
  "pending_registration",
];

const gateArb: fc.Arbitrary<ResourceActionGate> = fc.oneof(
  fc.constant({ allowed: true } as const),
  fc.record({
    allowed: fc.constant(false as const),
    reason: fc.constantFrom("not_authorized", "policy", "renewal_limit", "not_applicable") as fc.Arbitrary<"not_authorized" | "policy" | "renewal_limit" | "not_applicable">,
    detail: fc.string({ maxLength: 12 }),
  }),
);

const gatesArb: fc.Arbitrary<ResourceActionGates> = fc.dictionary(
  fc.constantFrom(...ACTION_KINDS),
  gateArb,
  { maxKeys: ACTION_KINDS.length },
) as fc.Arbitrary<ResourceActionGates>;

const allocationArb: fc.Arbitrary<ResourceAllocation> = fc.record({
  allocationId: fc.uuid(),
  state: fc.constantFrom("granted", "preparing", "active", "draining", "recovery_required"),
  holder: fc.constant({ kind: "operator", label: "You" } as const),
  taskLabel: fc.constant("task"),
  executorLabel: fc.constant("host · default"),
  grantedAt: fc.integer({ min: 0, max: 1_000 }),
  deadlineAt: fc.integer({ min: -10_000, max: 10_000 }),
  renewalsUsed: fc.integer({ min: 0, max: 3 }),
  renewalsAllowed: fc.integer({ min: 0, max: 3 }),
  generation: fc.integer({ min: 1, max: 1_000 }),
  authorityEpoch: fc.integer({ min: 1, max: 20 }),
  lastKnown: fc.boolean(),
  viewerOwns: fc.boolean(),
});

const queueEntryArb: fc.Arbitrary<ResourceQueueEntry> = fc.record({
  queueEntryId: fc.uuid(),
  position: fc.integer({ min: 1, max: 9 }),
  requester: fc.constant({ kind: "operator", label: "You" } as const),
  purpose: fc.constant("purpose"),
  requestedAt: fc.integer({ min: 0, max: 1_000 }),
  eligibility: fc.constant({ eligible: true } as const),
  viewerOwns: fc.boolean(),
});

const AUTHORITY_ID = "auth-1";

const authorityArb: fc.Arbitrary<ResourceAuthority | undefined> = fc.option(
  fc.record({
    authorityId: fc.constant(AUTHORITY_ID),
    kind: fc.constantFrom("machine_broker", "federation_coordinator", "cloud_coordinator"),
    label: fc.constant("Authority"),
    endpointLabel: fc.constant("endpoint"),
    epoch: fc.integer({ min: 1, max: 20 }),
    status: fc.constantFrom("reachable", "unreachable", "unresolved"),
  }),
  { nil: undefined },
);

const sharingArb = fc.oneof(
  fc.constant({ mode: "exclusive" } as const),
  fc.integer({ min: 1, max: 6 }).chain((capacity) =>
    fc.integer({ min: 0, max: capacity }).map((inUse) => ({
      mode: "counted" as const,
      capacity,
      inUse,
      unitLabel: "slots",
    }))),
);

const resourceArb: fc.Arbitrary<ResourceDomain> = fc.record({
  condition: fc.constantFrom(...CONDITIONS),
  boundAuthority: fc.boolean(),
  conflict: fc.constantFrom("none", "remedy", "resolvable"),
  sharing: sharingArb,
  allocations: fc.array(allocationArb, { maxLength: 3 }),
  queue: fc.array(queueEntryArb, { maxLength: 3 }),
  fencing: fc.option(fc.constantFrom("verified", "unverified", "unknown"), { nil: undefined }),
  actions: gatesArb,
}).map(({ condition, boundAuthority, conflict, sharing, allocations, queue, fencing, actions }) => ({
  resourceId: "res-1",
  canonicalKey: "machine:abc:cpu",
  displayName: "Resource",
  kindLabel: "Machine compute",
  aliases: [],
  conflictDomainIds: ["cd-1"],
  relatedResourceIds: [],
  placement: "machine",
  visibility: "machine",
  allocationScope: "machine",
  authorityId: boundAuthority ? AUTHORITY_ID : null,
  condition,
  sharing,
  enforcement: { coverage: "enforced", summary: "Enforced", gaps: [] },
  allocations,
  queue,
  readiness: [],
  advertisements: [],
  routes: [],
  instructions: null,
  policy: { useScope: "All", manageScope: "Operator", renewalRule: "None", finalEffect: "None" },
  cleanup: { state: "verified", detail: "ok" },
  recovery: fencing
    ? { allocationId: "a", generation: 1, reason: "r", since: 0, fencing, evidence: [] }
    : null,
  ownershipConflict: conflict === "none"
    ? null
    : {
      reason: "two ids",
      remedy: "Run it on the machine that created the root.",
      ...(conflict === "resolvable"
        ? { resolution: { kind: "adopt_store" as const, label: "Adopt for this machine", consequence: "Copied checkouts are dropped." } }
        : {}),
    },
  definition: { revision: 1, publication: "published", updatedAt: 0 },
  actions,
}));

const scenarioArb = fc.tuple(resourceArb, authorityArb);

function allowedKinds(resource: ResourceDomain, authority: ResourceAuthority | undefined): ResourceActionKind[] {
  return ACTION_KINDS.filter((kind) => effectiveGate(resource, authority, kind)?.allowed === true);
}

describe("resource view model", () => {
  it("never loosens the authority's gate", () => {
    fc.assert(fc.property(scenarioArb, ([resource, authority]) => {
      for (const kind of ACTION_KINDS) {
        const server = resource.actions[kind];
        const shown = effectiveGate(resource, authority, kind);
        if (!server) {
          expect(shown).toBeUndefined();
          continue;
        }
        if (!server.allowed) expect(shown).toEqual(server);
        if (shown?.allowed) expect(server.allowed).toBe(true);
      }
    }));
  });

  it("shows a missing or unreachable authority's resources as unreachable and offers nothing", () => {
    fc.assert(fc.property(scenarioArb, ([resource, authority]) => {
      fc.pre(resource.condition !== "pending_registration");
      fc.pre(resource.authorityId !== null && resource.ownershipConflict === null);
      fc.pre(authority === undefined || authority.status === "unreachable");
      expect(effectiveCondition(resource, authority)).toBe("unreachable");
      expect(allowedKinds(resource, authority)).toEqual([]);
    }));
  });

  it("offers only the described resolution while ownership is unresolved, whatever the server sends", () => {
    fc.assert(fc.property(scenarioArb, ([resource, authority]) => {
      fc.pre(effectiveCondition(resource, authority) === "ownership_unresolved");
      const resolution = resource.ownershipConflict?.resolution;
      const expected = resolution && resource.actions.resolve_ownership?.allowed ? ["resolve_ownership"] : [];
      expect(allowedKinds(resource, authority)).toEqual(expected);
      for (const action of resourceActions(resource, authority)) {
        expect(action.gate.allowed).toBe(action.kind === "resolve_ownership" && expected.length === 1);
        if (action.kind === "resolve_ownership") expect(action.label).toBe(resolution?.label);
      }
    }));
  });

  it("never offers resolving ownership outside the unresolved condition", () => {
    fc.assert(fc.property(scenarioArb, ([resource, authority]) => {
      fc.pre(effectiveCondition(resource, authority) !== "ownership_unresolved");
      expect(effectiveGate(resource, authority, "resolve_ownership")?.allowed ?? false).toBe(false);
      expect(resourceActions(resource, authority).map((action) => action.kind)).not.toContain("resolve_ownership");
    }));
  });

  it("reads a conflict, an unbound record or an unresolved authority as ownership unresolved", () => {
    fc.assert(fc.property(scenarioArb, ([resource, authority]) => {
      fc.pre(resource.condition !== "pending_registration");
      fc.pre(
        resource.authorityId === null
        || resource.ownershipConflict !== null
        || authority?.status === "unresolved",
      );
      expect(effectiveCondition(resource, authority)).toBe("ownership_unresolved");
    }));
  });

  it("offers nothing on a definition the registry has not confirmed", () => {
    fc.assert(fc.property(scenarioArb, ([resource, authority]) => {
      const draft = { ...resource, condition: "pending_registration" as const };
      expect(effectiveCondition(draft, authority)).toBe("pending_registration");
      expect(allowedKinds(draft, authority)).toEqual([]);
    }));
  });

  it("never allows administrative release without verified fencing", () => {
    fc.assert(fc.property(scenarioArb, ([resource, authority]) => {
      fc.pre(resource.recovery?.fencing !== "verified");
      expect(effectiveGate(resource, authority, "administrative_release")?.allowed ?? false).toBe(false);
    }));
  });

  it("never shows Available while the capacity is fully held", () => {
    fc.assert(fc.property(scenarioArb, ([resource, authority]) => {
      const full = resource.sharing.mode === "exclusive"
        ? resource.allocations.length > 0
        : resource.sharing.inUse >= resource.sharing.capacity;
      fc.pre(full);
      expect(effectiveCondition(resource, authority)).not.toBe("available");
    }));
  });

  it("offers Request checkout whenever the snapshot leaves room for an immediate grant", () => {
    const requestableArb = fc.tuple(resourceArb, fc.constantFrom("available", "busy") as fc.Arbitrary<ResourceCondition>, fc.boolean())
      .map(([resource, condition, emptyQueue]): [ResourceDomain, ResourceAuthority] => [
        {
          ...resource,
          condition,
          authorityId: AUTHORITY_ID,
          ownershipConflict: null,
          queue: emptyQueue ? [] : resource.queue,
          allocations: resource.allocations.map((allocation) => ({ ...allocation, viewerOwns: false })),
          actions: { ...resource.actions, request: { allowed: true } },
        },
        { authorityId: AUTHORITY_ID, kind: "machine_broker", label: "Broker", endpointLabel: "socket", epoch: 1, status: "reachable" },
      ]);
    let possibleWithQueue = 0;
    fc.assert(fc.property(requestableArb, ([resource, authority]) => {
      const request = resourceActions(resource, authority).find((action) => action.kind === "request");
      if (!request) return;
      const possible = resource.sharing.mode === "counted"
        ? resource.sharing.inUse < resource.sharing.capacity
        : resource.queue.length === 0 && resource.allocations.length === 0;
      if (possible && resource.queue.length) possibleWithQueue += 1;
      expect(request.label).toBe(possible ? "Request checkout" : "Join queue");
    }));
    // The generator must reach the case the property is about.
    expect(possibleWithQueue).toBeGreaterThan(0);
  });

  it("offers exactly one of request, cancel and release", () => {
    fc.assert(fc.property(scenarioArb, ([resource, authority]) => {
      const kinds = resourceActions(resource, authority).map((action) => action.kind);
      const primary = kinds.filter((kind) => kind === "request" || kind === "cancel_request" || kind === "release");
      expect(primary.length).toBeLessThanOrEqual(1);
    }));
  });
});

describe("resource grouping", () => {
  const brokerArb: fc.Arbitrary<ResourceAuthority> = fc.constantFrom("reachable", "unreachable", "unresolved")
    .map((status) => ({ authorityId: AUTHORITY_ID, kind: "machine_broker", label: "Broker", endpointLabel: "socket", epoch: 1, status }));
  const adArb = fc.record({ isViewer: fc.boolean(), onViewerMachine: fc.boolean() }).map(({ isViewer, onViewerMachine }) => ({
    instanceId: "inst",
    instanceLabel: "host",
    profile: "default",
    isViewer,
    onViewerMachine,
    observedAt: 0,
    freshness: "fresh" as const,
  }));

  it("puts a broker under This machine only when this machine advertises it", () => {
    fc.assert(fc.property(resourceArb, brokerArb, fc.array(adArb, { maxLength: 3 }), (base, broker, advertisements) => {
      const resource = { ...base, advertisements };
      const local = advertisements.some((ad) => ad.isViewer || ad.onViewerMachine);
      expect(resourceGroup(resource, broker)).toBe(local ? "machine" : "federation");
    }));
  });

  it("never puts federation-scoped or coordinator-allocated capacity under This machine", () => {
    fc.assert(fc.property(resourceArb, authorityArb, fc.array(adArb, { maxLength: 3 }), (base, authority, advertisements) => {
      const resource = { ...base, advertisements, allocationScope: "federation" as const };
      expect(resourceGroup(resource, authority)).toBe("federation");
      if (authority?.kind !== "machine_broker") {
        expect(resourceGroup({ ...resource, allocationScope: "machine" }, authority)).toBe("federation");
      }
    }));
  });
});

describe("snapshot ordering", () => {
  const snapshotAt = (revision: number): ResourceCheckoutsSnapshot => ({
    contractVersion: 1,
    revision,
    observedAt: revision,
    viewer: { instanceId: "i", instanceLabel: "host", profile: "default" },
    authorities: [],
    resources: [],
    registerGate: { allowed: true },
  });

  it("shows the newest revision whatever order reads land in, and never moves back", () => {
    // Reads resolve in any order and may repeat a revision (a change event
    // and the mount read both returning the same snapshot).
    fc.assert(fc.property(
      fc.array(fc.integer({ min: 1, max: 50 }), { minLength: 1, maxLength: 30 }),
      (arrivals) => {
        let shown: ResourceCheckoutsSnapshot | undefined;
        let previous = 0;
        for (const revision of arrivals) {
          const incoming = snapshotAt(revision);
          if (acceptSnapshot(shown, incoming)) shown = incoming;
          expect(shown!.revision).toBeGreaterThanOrEqual(previous);
          previous = shown!.revision;
        }
        expect(shown!.revision).toBe(Math.max(...arrivals));
      },
    ));
  });
});
