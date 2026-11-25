import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { ResourceQueueOrder } from "@pwragent/shared/contracts/resource-checkouts";
import { promoteQueue, ResourceCheckoutAuthority } from "../resource-checkout-authority";
import type {
  CheckoutActor, CheckoutDefinition, CheckoutDomainRecord, CheckoutGrant, CheckoutReceipt, CheckoutStore, CheckoutWaiter,
} from "../resource-checkout-storage";

/**
 * Rules the checkout queue keeps, whatever its queue order:
 *
 * - No requester holds part of a resource while it waits for more of it.
 *   Holding while waiting can stall every request behind it until the
 *   holder's deadline (observed on the machine CPU pool, 2026-11-24).
 * - So the queue always makes progress: once every holder that is not
 *   waiting releases, the head starts, with no deadline needed.
 *
 * And for `backfill`, against `fifo` from the same state:
 *
 * - The head never starts later. In the worst case, where nobody releases
 *   early and nothing new arrives, it starts at the same time.
 * - A later request that fits now and ends before the head could start is
 *   started, rather than waiting behind the head.
 */

const RESOURCE = "machine:test:cpu";
const DURATION = 60_000;

function definition(capacity: number, queueOrder?: ResourceQueueOrder): CheckoutDefinition {
  return {
    resourceId: RESOURCE, canonicalKey: RESOURCE, displayName: "Test pool", kindLabel: "Machine compute",
    scope: "machine", capacity, counted: true, authorityId: RESOURCE, epoch: 1, maxHoldMs: 4 * 60 * 60_000,
    publication: "published", revision: 2, updatedAt: 1, ...(queueOrder ? { queueOrder } : {}),
  };
}

/** An in-memory store with the SQLite store's copy-on-read behavior. */
function memoryStore(): CheckoutStore {
  const records = new Map<string, string>();
  const receipts = new Map<string, string>();
  const tx = {
    read: (id: string) => {
      const value = records.get(id);
      return value === undefined ? undefined : JSON.parse(value) as CheckoutDomainRecord;
    },
    list: () => [...records.values()].map((value) => JSON.parse(value) as CheckoutDomainRecord),
    save: (record: CheckoutDomainRecord) => { records.set(record.definition.resourceId, JSON.stringify(record)); },
    receipt: (actor: string, key: string) => {
      const value = receipts.get(`${actor}\0${key}`);
      return value === undefined ? undefined : JSON.parse(value) as CheckoutReceipt;
    },
    recordReceipt: (actor: string, key: string, receipt: CheckoutReceipt) => { receipts.set(`${actor}\0${key}`, JSON.stringify(receipt)); },
  };
  return { change: (apply) => apply(tx), readAll: () => tx.list(), receipt: tx.receipt };
}

const ACTORS: CheckoutActor[] = ["a", "b", "c"].map((key) => ({
  key: `thread:claude:${key}`,
  holder: { kind: "thread", thread: { backend: "claude", threadId: key, title: key } },
  manage: false,
}));

type Step =
  | { kind: "request"; actor: number; units: number; minutes: number }
  | { kind: "release"; actor: number }
  | { kind: "cancel"; actor: number }
  | { kind: "advance"; minutes: number };

const stepArb = (capacity: number): fc.Arbitrary<Step> => fc.oneof(
  { weight: 4, arbitrary: fc.record({
    kind: fc.constant("request" as const), actor: fc.nat({ max: 2 }),
    units: fc.integer({ min: 1, max: capacity }), minutes: fc.integer({ min: 1, max: 30 }),
  }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("release" as const), actor: fc.nat({ max: 2 }) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("cancel" as const), actor: fc.nat({ max: 2 }) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("advance" as const), minutes: fc.integer({ min: 1, max: 20 }) }) },
);

const runArb = fc.integer({ min: 2, max: 18 }).chain((capacity) => fc.record({
  capacity: fc.constant(capacity),
  queueOrder: fc.constantFrom<ResourceQueueOrder>("fifo", "backfill"),
  steps: fc.array(stepArb(capacity), { minLength: 10, maxLength: 60 }),
}));

/** Replays the steps through the real authority and yields the record after each. */
function* replay(capacity: number, queueOrder: ResourceQueueOrder, steps: Step[]): Generator<CheckoutDomainRecord & { now: number }> {
  let now = 1;
  let ids = 0;
  const authority = new ResourceCheckoutAuthority(memoryStore(), () => now, () => `id-${++ids}`);
  authority.ensure(definition(capacity, queueOrder));
  const record = () => authority.records(RESOURCE)[0]!;
  for (const [index, step] of steps.entries()) {
    const key = `step-${index}`;
    if (step.kind === "request") {
      authority.perform(ACTORS[step.actor]!, {
        kind: "request", resourceId: RESOURCE, idempotencyKey: key, purpose: key,
        units: step.units, expectedDurationMs: step.minutes * 60_000,
      });
    } else if (step.kind === "release") {
      const actor = ACTORS[step.actor]!;
      const grant = record().grants.find((entry) => entry.actor.key === actor.key);
      if (grant) {
        authority.perform(actor, {
          kind: "release", resourceId: RESOURCE, idempotencyKey: key, allocationId: grant.id, generation: grant.generation,
        });
      }
    } else if (step.kind === "cancel") {
      const actor = ACTORS[step.actor]!;
      const entry = record().queue.find((waiter) => waiter.actor.key === actor.key);
      if (entry) authority.perform(actor, { kind: "cancel_request", resourceId: RESOURCE, idempotencyKey: key, queueEntryId: entry.id });
    } else {
      now += step.minutes * 60_000;
    }
    yield { ...record(), now };
  }
}

describe("checkout queue progress", () => {
  it("never lets a requester hold part of a resource while it waits for more", () => {
    fc.assert(fc.property(runArb, ({ capacity, queueOrder, steps }) => {
      for (const state of replay(capacity, queueOrder, steps)) {
        const waiting = new Set(state.queue.map((entry) => entry.actor.key));
        expect(state.grants.filter((grant) => waiting.has(grant.actor.key))).toEqual([]);
        expect(waiting.size).toBe(state.queue.length);
      }
    }));
  });

  it("starts the head once every holder that is not waiting releases, without a deadline", () => {
    fc.assert(fc.property(runArb, ({ capacity, queueOrder, steps }) => {
      for (const state of replay(capacity, queueOrder, steps)) {
        const head = state.queue[0];
        if (!head) continue;
        const waiting = new Set(state.queue.map((entry) => entry.actor.key));
        const after: CheckoutDomainRecord = structuredClone({
          definition: state.definition, generation: state.generation,
          grants: state.grants.filter((grant) => waiting.has(grant.actor.key)), queue: state.queue,
        });
        promoteQueue(after, state.now);
        expect(after.grants.map((grant) => grant.id)).toContain(head.id);
      }
    }));
  });

  it("refuses more for a holder that can't start at once, and says to release first", () => {
    let now = 1;
    const authority = new ResourceCheckoutAuthority(memoryStore(), () => now, () => `id-${now++}`);
    authority.ensure(definition(18, "fifo"));
    const [a, b] = ACTORS;
    const ask = (actor: CheckoutActor, key: string, units: number) => authority.perform(actor!, {
      kind: "request", resourceId: RESOURCE, idempotencyKey: key, purpose: key, units, expectedDurationMs: 15 * 60_000,
    });
    // The live case: a thread holds 4 slots, another wants 16, and the first asks for 16 more.
    expect(ask(a!, "lint", 4)).toMatchObject({ outcome: "granted" });
    // More that starts at once is fine: the holder isn't left waiting.
    expect(ask(a!, "typecheck", 2)).toMatchObject({ outcome: "granted" });
    expect(ask(b!, "suite", 16)).toMatchObject({ outcome: "queued" });
    expect(ask(a!, "more", 12)).toMatchObject({ outcome: "rejected", reason: "policy", message: expect.stringMatching(/Release what it holds/) });
    expect(ask(b!, "again", 1)).toMatchObject({ outcome: "rejected", message: expect.stringMatching(/already has a request queued/) });
  });

  it("doesn't count a released job's draining grant as held: it ends without the requester", () => {
    let now = 1;
    const authority = new ResourceCheckoutAuthority(memoryStore(), () => now, () => `id-${now++}`);
    authority.ensure(definition(18, "fifo"));
    const [a, b] = ACTORS;
    const granted = authority.perform(a!, {
      kind: "request", resourceId: RESOURCE, idempotencyKey: "setup", purpose: "setup", units: 4, expectedDurationMs: 15 * 60_000,
    });
    if (granted.outcome !== "granted") throw new Error("Expected a grant.");
    const token = { resourceId: RESOURCE, allocationId: granted.allocationId, generation: granted.generation, epoch: 1 };
    expect(authority.bindJob(a!, token, { id: "job-1", executor: "local" })).toBe(true);
    expect(authority.perform(a!, { kind: "release", resourceId: RESOURCE, idempotencyKey: "done", allocationId: token.allocationId, generation: token.generation }))
      .toMatchObject({ outcome: "accepted" });
    expect(authority.records(RESOURCE)[0]!.grants[0]).toMatchObject({ state: "draining", units: 4 });
    expect(authority.perform(b!, {
      kind: "request", resourceId: RESOURCE, idempotencyKey: "suite", purpose: "suite", units: 16, expectedDurationMs: 30 * 60_000,
    })).toMatchObject({ outcome: "queued" });
    // Still draining, it can't start: queued, not refused as hold-and-wait.
    expect(authority.perform(a!, {
      kind: "request", resourceId: RESOURCE, idempotencyKey: "next", purpose: "next", units: 8, expectedDurationMs: 10 * 60_000,
    })).toMatchObject({ outcome: "queued" });
  });
});

/** A counted pool after promotion under `fifo`: holders fit, and the head (if any) does not. */
const blockedArb = fc.integer({ min: 2, max: 24 }).chain((capacity) => fc.record({
  capacity: fc.constant(capacity),
  held: fc.array(fc.record({ units: fc.integer({ min: 1, max: capacity }), minutes: fc.integer({ min: 1, max: 60 }) }), { minLength: 1, maxLength: 5 }),
  queued: fc.array(fc.record({ units: fc.integer({ min: 1, max: capacity }), minutes: fc.integer({ min: 1, max: 60 }) }), { minLength: 1, maxLength: 8 }),
})).map(({ capacity, held, queued }): CheckoutDomainRecord => {
  const now = 0;
  const grants: CheckoutGrant[] = [];
  let used = 0;
  for (const [index, entry] of held.entries()) {
    if (used + entry.units > capacity) continue;
    used += entry.units;
    grants.push({
      id: `g${index}`, actor: ACTORS[index % 3]!, purpose: "held", units: entry.units, durationMs: entry.minutes * 60_000,
      requestedAt: now, generation: index + 1, grantedAt: now, renewals: 0, deadlineAt: now + entry.minutes * 60_000, state: "granted",
    });
  }
  const queue: CheckoutWaiter[] = queued.map((entry, index) => ({
    id: `q${index}`, actor: ACTORS[index % 3]!, purpose: "queued", units: entry.units,
    durationMs: entry.minutes * 60_000, requestedAt: now,
  }));
  const record: CheckoutDomainRecord = { definition: definition(capacity, "fifo"), generation: grants.length, grants, queue };
  promoteQueue(record, now);
  return record;
});

/** When `headId` starts if no grant ends before its deadline and nothing new arrives. */
function worstCaseStart(record: CheckoutDomainRecord, headId: string, now: number): number {
  const state = structuredClone(record);
  let at = now;
  for (let step = 0; step < 1_000; step++) {
    promoteQueue(state, at);
    if (state.grants.some((grant) => grant.id === headId)) return at;
    at = Math.min(...state.grants.map((grant) => grant.deadlineAt));
    state.grants = state.grants.filter((grant) => grant.deadlineAt > at);
  }
  throw new Error("The head never started.");
}

describe("backfill", () => {
  it("never starts the head later than first in, first out would", () => {
    fc.assert(fc.property(blockedArb, (fifo) => {
      const head = fifo.queue[0];
      fc.pre(head !== undefined);
      const backfill = structuredClone(fifo);
      backfill.definition.queueOrder = "backfill";
      promoteQueue(backfill, 0);
      expect(backfill.queue[0]?.id).toBe(head!.id);
      expect(worstCaseStart(backfill, head!.id, 0)).toBeLessThanOrEqual(worstCaseStart(fifo, head!.id, 0));
    }));
  });

  it("starts every later request that fits now and ends before the head could start", () => {
    fc.assert(fc.property(blockedArb, (fifo) => {
      const head = fifo.queue[0];
      fc.pre(head !== undefined);
      const headStart = worstCaseStart(fifo, head!.id, 0);
      const backfill = structuredClone(fifo);
      backfill.definition.queueOrder = "backfill";
      promoteQueue(backfill, 0);
      const free = backfill.definition.capacity - backfill.grants.reduce((sum, grant) => sum + grant.units, 0);
      for (const entry of backfill.queue.slice(1)) {
        expect(entry.units <= free && entry.durationMs <= headStart).toBe(false);
      }
    }));
  });

  it("starts a small request beside a blocked whole-pool head on the live pool's numbers", () => {
    const record = structuredClone({
      definition: definition(18, "backfill"), generation: 1, queue: [] as CheckoutWaiter[],
      grants: [{
        id: "lint", actor: ACTORS[0]!, purpose: "lint", units: 4, durationMs: 15 * 60_000, requestedAt: 0,
        generation: 1, grantedAt: 0, renewals: 0, deadlineAt: 15 * 60_000, state: "granted",
      }] as CheckoutGrant[],
    });
    record.queue.push(
      { id: "suite", actor: ACTORS[1]!, purpose: "suite", units: 16, durationMs: DURATION * 30, requestedAt: 0 },
      { id: "focused", actor: ACTORS[2]!, purpose: "focused", units: 2, durationMs: DURATION * 10, requestedAt: 0 },
    );
    promoteQueue(record, 0);
    // 14 free: the suite needs 16 and waits for the lint's 4 at 15m; the
    // focused run needs 2 for 10m, ends first, and starts now.
    expect(record.queue.map((entry) => entry.id)).toEqual(["suite"]);
    expect(record.grants.map((grant) => grant.id)).toEqual(["lint", "focused"]);
  });
});

describe("a queue order change", () => {
  it("starts what a new backfill order allows as soon as the definition changes", () => {
    let now = 1;
    const authority = new ResourceCheckoutAuthority(memoryStore(), () => now, () => `id-${now++}`);
    const external = (revision: number, queueOrder?: ResourceQueueOrder): CheckoutDefinition => ({
      ...definition(18, queueOrder), scope: "federation", revision,
    });
    authority.ensure(external(1, "fifo"));
    const ask = (actor: CheckoutActor, key: string, units: number, minutes: number) => authority.perform(actor, {
      kind: "request", resourceId: RESOURCE, idempotencyKey: key, purpose: key, units, expectedDurationMs: minutes * 60_000,
    });
    expect(ask(ACTORS[0]!, "lint", 4, 15)).toMatchObject({ outcome: "granted" });
    expect(ask(ACTORS[1]!, "suite", 16, 30)).toMatchObject({ outcome: "queued" });
    expect(ask(ACTORS[2]!, "focused", 2, 10)).toMatchObject({ outcome: "queued" });
    authority.ensure(external(2, "backfill"));
    expect(authority.records(RESOURCE)[0]!.queue.map((entry) => entry.purpose)).toEqual(["suite"]);
  });
});
