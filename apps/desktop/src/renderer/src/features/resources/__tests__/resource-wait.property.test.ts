import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type {
  ResourceAllocation,
  ResourceCheckoutsSnapshot,
  ResourceDomain,
  ResourceHolder,
  ResourceQueueEntry,
} from "@pwragent/shared/contracts/resource-checkouts";
import { buildPreviewAuthorities, buildPreviewResources } from "../preview/resource-checkouts-preview";
import {
  allocationHoldTime,
  describeQueueEntryHold,
  holderAlsoQueued,
  queueEntryHold,
  summarizeResourceWait,
} from "../resource-wait";

/**
 * The rules a waiting thread's view of a checkout queue must keep:
 *
 * - "Why hasn't it started" agrees with the authority's own promotion on a
 *   `fifo` resource: only the head is granted, and only once it fits
 *   (owner-core `resource-checkout-authority.ts`, `promoteQueue`). The
 *   oracle below is that loop, re-stated.
 * - A request marked "fits now" is exactly one the free capacity could run
 *   if the queue were not FIFO: the case an operator reads as a stall.
 * - The waiter's place is its own entry's position, never another thread's.
 *   A thread with a queued request reads as queued even while it holds some
 *   of the resource (its wait is for that request), and says how much it
 *   holds. Only a thread with no queued request reads as holding.
 * - "Held by" never lists the waiter itself.
 */

const NOW = 1_800_000_000_000;
const base = buildPreviewResources(NOW)[0]!;
const WAITER = { backend: "claude", threadId: "waiter" } as const;

const threadHolder = (threadId: string, backend = "codex"): ResourceHolder => ({
  kind: "thread",
  thread: { backend: backend as "codex", threadId, title: `Thread ${threadId}` },
});

const holderArb: fc.Arbitrary<ResourceHolder> = fc.oneof(
  fc.constantFrom("a", "b", "c").map((id) => threadHolder(id)),
  fc.constant(threadHolder(WAITER.threadId, WAITER.backend)),
  // Same id on another backend is a different thread.
  fc.constant(threadHolder(WAITER.threadId, "codex")),
  fc.constant({ kind: "operator", label: "You" } as const),
);

function allocationFor(holder: ResourceHolder, units: number, index: number, grantedAt: number, span: number): ResourceAllocation {
  return {
    allocationId: `alloc-${index}`,
    state: "granted",
    holder,
    taskLabel: "task",
    executorLabel: "No managed job",
    grantedAt,
    deadlineAt: grantedAt + span,
    renewalsUsed: 0,
    renewalsAllowed: 1,
    generation: index + 1,
    authorityEpoch: 1,
    units,
    lastKnown: false,
    viewerOwns: false,
  };
}

/**
 * A counted resource as the authority leaves it after `wake`: holders fit in
 * the capacity, and the queue's head (if any) does not fit what is free.
 */
const settledArb = fc.record({
  capacity: fc.integer({ min: 1, max: 24 }),
  held: fc.array(fc.record({ holder: holderArb, units: fc.integer({ min: 1, max: 8 }) }), { maxLength: 4 }),
  queued: fc.array(fc.record({ holder: holderArb, units: fc.integer({ min: 1, max: 24 }) }), { maxLength: 6 }),
}).map(({ capacity, held, queued }): ResourceDomain => {
  const allocations: ResourceAllocation[] = [];
  let inUse = 0;
  for (const [index, entry] of held.entries()) {
    if (inUse + entry.units > capacity) continue;
    inUse += entry.units;
    allocations.push(allocationFor(entry.holder, entry.units, index, NOW - (index + 1) * 60_000, 15 * 60_000));
  }
  const free = capacity - inUse;
  // Drop leading requests that would already have been promoted.
  const firstBlocked = queued.findIndex((entry) => Math.min(entry.units, capacity) > free);
  const queue: ResourceQueueEntry[] = (firstBlocked < 0 ? [] : queued.slice(firstBlocked)).map((entry, index) => ({
    queueEntryId: `q-${index}`,
    position: index + 1,
    requester: entry.holder,
    purpose: "work",
    requestedAt: NOW - 60_000,
    units: Math.min(entry.units, capacity),
    eligibility: { eligible: true },
    viewerOwns: false,
  }));
  return {
    ...base,
    resourceId: "res",
    // Settled by `fifoOracle`, so it is a first-in, first-out resource.
    policy: { ...base.policy, queueOrder: "fifo" },
    sharing: { mode: "counted", capacity, inUse, unitLabel: "CPU slots" },
    allocations,
    queue,
  };
});

function snapshotOf(resource: ResourceDomain): ResourceCheckoutsSnapshot {
  return {
    contractVersion: 1,
    revision: 1,
    observedAt: NOW,
    viewer: { instanceId: "inst", instanceLabel: "host", profile: "default" },
    authorities: buildPreviewAuthorities(NOW),
    resources: [{ ...resource, authorityId: base.authorityId }],
    registerGate: { allowed: true },
    agentTools: "enabled",
  };
}

/** The authority's promotion pass: grant from the head while it fits. */
function fifoOracle(resource: ResourceDomain): Set<string> {
  const capacity = resource.sharing.mode === "counted" ? resource.sharing.capacity : 1;
  let available = capacity - resource.allocations.reduce((sum, allocation) => sum + (allocation.units ?? 1), 0);
  const granted = new Set<string>();
  for (const entry of resource.queue) {
    const units = entry.units ?? 1;
    if (units > available) break;
    available -= units;
    granted.add(entry.queueEntryId);
  }
  return granted;
}

function sameThread(holder: ResourceHolder, waiter: typeof WAITER): boolean {
  return holder.kind === "thread" && holder.thread.backend === waiter.backend && holder.thread.threadId === waiter.threadId;
}

describe("resource wait view", () => {
  it("explains a hold only where FIFO promotion would not grant the request", () => {
    fc.assert(fc.property(settledArb, (resource) => {
      const granted = fifoOracle(resource);
      for (const entry of resource.queue) {
        const hold = queueEntryHold(resource, entry);
        // A settled queue holds every request; none reads as about to start.
        expect(granted.has(entry.queueEntryId)).toBe(false);
        expect(hold.reason).toBe(entry.position === 1 ? "capacity" : "order");
        const free = resource.sharing.mode === "counted" ? resource.sharing.capacity - resource.sharing.inUse : 0;
        expect(hold.free).toBe(free);
        expect(hold.fitsNow).toBe((entry.units ?? 1) <= free);
        const sentence = describeQueueEntryHold(hold, entry.position, "CPU slot");
        expect(sentence.includes("Would fit now")).toBe(hold.reason === "order" && hold.fitsNow);
      }
    }));
  });

  it("blames first in, first out only on a fifo resource; on a backfill one, protecting the head", () => {
    fc.assert(fc.property(settledArb, fc.constantFrom("fifo", "backfill", undefined), (settled, queueOrder) => {
      const resource: ResourceDomain = { ...settled, policy: { ...settled.policy, queueOrder } };
      // Unset, a counted resource backfills and an exclusive one is fifo.
      const effective = queueOrder ?? (resource.sharing.mode === "counted" ? "backfill" : "fifo");
      for (const entry of resource.queue) {
        const hold = queueEntryHold(resource, entry);
        expect(hold.queueOrder).toBe(effective);
        const sentence = describeQueueEntryHold(hold, entry.position, "CPU slot");
        const waitsWhileFitting = hold.reason === "order" && hold.fitsNow;
        expect(sentence.includes("first in, first out")).toBe(waitsWhileFitting && effective === "fifo");
        expect(sentence.includes("can't delay #1")).toBe(waitsWhileFitting && effective === "backfill");
      }
    }));
  });

  it("reads a head that fits as pending, matching the oracle's grant", () => {
    fc.assert(fc.property(settledArb, fc.integer({ min: 1, max: 24 }), (resource, units) => {
      const free = resource.sharing.mode === "counted" ? resource.sharing.capacity - resource.sharing.inUse : 0;
      const head: ResourceQueueEntry = { ...base.queue[0]!, queueEntryId: "head", position: 1, units };
      const withHead = { ...resource, queue: [head] };
      const hold = queueEntryHold(withHead, head);
      expect(hold.reason === "pending").toBe(fifoOracle(withHead).has("head"));
      expect(hold.reason === "pending").toBe(units <= free);
    }));
  });

  it("places the waiter by its own entry and never lists it as another holder", () => {
    fc.assert(fc.property(settledArb, (resource) => {
      const summary = summarizeResourceWait(snapshotOf(resource), "res", WAITER)!;
      const held = resource.allocations
        .filter((allocation) => sameThread(allocation.holder, WAITER))
        .reduce((sum, allocation) => sum + (allocation.units ?? 1), 0);
      const own = resource.queue.find((entry) => sameThread(entry.requester, WAITER));
      if (own) {
        expect(summary.place).toMatchObject({ kind: "queued", position: own.position, ahead: own.position - 1, queueLength: resource.queue.length });
        expect(summary.place.kind === "queued" ? summary.place.holds : undefined).toBe(held > 0 ? held : undefined);
      } else if (held > 0) {
        expect(summary.place.kind).toBe("holding");
      } else {
        expect(summary.place).toEqual({ kind: "not_queued", queueLength: resource.queue.length });
      }
      expect(summary.holders).toHaveLength(resource.allocations.filter((allocation) => !sameThread(allocation.holder, WAITER)).length);
    }));
  });

  it("finds a holder's own queued request and nobody else's", () => {
    fc.assert(fc.property(settledArb, (resource) => {
      for (const allocation of resource.allocations) {
        const found = holderAlsoQueued(resource, allocation.holder);
        const expected = allocation.holder.kind === "thread"
          ? resource.queue.find((entry) => entry.requester.kind === "thread"
            && allocation.holder.kind === "thread"
            && entry.requester.thread.backend === allocation.holder.thread.backend
            && entry.requester.thread.threadId === allocation.holder.thread.threadId)
          : undefined;
        expect(found).toBe(expected);
      }
    }));
  });

  it("never reports negative hold time", () => {
    fc.assert(fc.property(fc.integer(), fc.integer(), fc.integer(), (grantedAt, deadlineAt, now) => {
      const { heldMs, expectedMs } = allocationHoldTime({ grantedAt, deadlineAt }, now);
      expect(heldMs).toBeGreaterThanOrEqual(0);
      expect(expectedMs).toBeGreaterThanOrEqual(0);
    }));
  });

  it("returns nothing for a resource this snapshot does not list", () => {
    fc.assert(fc.property(settledArb, (resource) => {
      expect(summarizeResourceWait(snapshotOf(resource), "res-elsewhere", WAITER)).toBeUndefined();
    }));
  });
});
