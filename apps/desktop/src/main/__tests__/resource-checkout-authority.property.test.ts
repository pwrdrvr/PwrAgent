import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { ResourceCheckoutAuthority, type CheckoutToken } from "@pwragent/owner-core/resource-checkout-authority";
import { executeResourceCheckout, type CheckoutProviderAdapter } from "@pwragent/owner-core/resource-checkout-executor";
import type { CheckoutActor, CheckoutDefinition, CheckoutGrant } from "@pwragent/owner-core/resource-checkout-storage";
import type { ResourceCheckoutActionRequest } from "@pwragent/shared/contracts/resource-checkouts";
import { openResourceCheckoutStore } from "@pwragent/sqlite-storage/resource-checkout-store";
import { createResourceCheckoutToolHandler } from "../agent-tools/pwragent-resource-checkout-agent-tools";
import { checkoutRootCanHostMachine } from "../resource-checkouts/checkout-runtime";
import { projectCheckoutDomain } from "../resource-checkouts/checkout-projection";
import { DesktopResourceCheckoutService } from "../resource-checkouts/resource-checkout-service";
import { readExternalCheckoutBindings, type ExternalBinding } from "../resource-checkouts/checkout-configuration";
import { readOrCreateFederationMachineId } from "../federation/federation-host-info";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";

const resourceId = "external:fake:test:worker";
const definition: CheckoutDefinition = {
  resourceId, canonicalKey: resourceId, displayName: "Test resource", kindLabel: "Fake",
  scope: "federation", counted: false, capacity: 1, authorityId: "authority", epoch: 3,
  maxHoldMs: 10_000, publication: "published", revision: 1, updatedAt: 1,
};
const actor: CheckoutActor = { key: "alice", holder: { kind: "operator", label: "Alice" }, manage: true };
const other: CheckoutActor = { key: "bob", holder: { kind: "operator", label: "Bob" }, manage: true };
/** A requester of its own: one requester never holds part of a resource while it waits for more. */
const requester = (key: string): CheckoutActor => ({ key, holder: { kind: "operator", label: key }, manage: true });
const request = (key: string, overrides?: { resourceId?: string; units?: number; expectedDurationMs?: number }) => ({
  kind: "request" as const, idempotencyKey: key, resourceId, purpose: key, expectedDurationMs: 1_000, ...overrides,
});
const change = (kind: "release" | "extend", token: CheckoutToken, key: string): ResourceCheckoutActionRequest =>
  ({ kind, resourceId: token.resourceId, allocationId: token.allocationId, generation: token.generation, idempotencyKey: key });

function createHarness(capacity = 1) {
  const root = mkdtempSync(path.join(os.tmpdir(), "pwragent-checkouts-"));
  const file = path.join(root, "authority.db");
  let now = 1;
  const stores = new Set<ReturnType<typeof openResourceCheckoutStore>>();
  function open() {
    const store = openResourceCheckoutStore(file, "machine");
    stores.add(store);
    const authority = new ResourceCheckoutAuthority(store, () => now, randomUUID);
    authority.ensure({ ...definition, capacity, counted: capacity > 1 });
    return { authority, close: () => { store.close(); stores.delete(store); } };
  }
  return {
    root, open, advance: (duration: number) => { now += duration; },
    close: () => { for (const store of stores) store.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

function granted(authority: ResourceCheckoutAuthority, key: string): CheckoutToken {
  const result = authority.perform(actor, request(key));
  if (result.outcome !== "granted") throw new Error("Expected a grant.");
  return { resourceId, allocationId: result.allocationId, generation: result.generation, epoch: definition.epoch };
}

describe("the persisted resource checkout authority", () => {
  it("never lets managed work consume a backfilled lease", () => {
    fc.assert(fc.property(fc.integer({ min: 3, max: 12 }), fc.boolean(), (capacity, local) => {
      const harness = createHarness(capacity);
      try {
        const { authority } = harness.open();
        authority.perform(actor, request("holder", { units: 1, expectedDurationMs: 100 }));
        expect(authority.perform(requester("carol"), request("head", { units: capacity }))).toMatchObject({ outcome: "queued" });
        const backfill = authority.perform(other, request("backfill", { units: 1, expectedDurationMs: 50 }));
        if (backfill.outcome !== "granted") throw new Error("Expected a backfill.");
        const job = { id: "managed", executor: "fixture" };
        if (local) {
          expect(authority.admitLocalJob(resourceId, other, "Managed job", job)).toBeUndefined();
        } else {
          expect(authority.bindJob(other, { resourceId, epoch: definition.epoch, ...backfill }, job)).toBe(false);
        }
        harness.advance(100);
        expect(authority.status(requester("carol"), "head", resourceId)).toMatchObject({ state: "granted" });
      } finally {
        harness.close();
      }
    }), { numRuns: 8, examples: [[4, false], [4, true]] });
  });

  it("uses the durable machine capacity even when another profile detects a different CPU count", async () => {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 2, max: 64 }), fc.integer({ min: 0, max: 64 }), async (capacity, detected) => {
      fc.pre(capacity !== detected);
      const root = mkdtempSync(path.join(os.tmpdir(), "pwragent-cpu-detection-"));
      const open = (profile: string, machineCpuCount: number) => new DesktopResourceCheckoutService({
        viewer: { instanceId: profile, instanceLabel: profile, profile, machineId: "host" },
        machineStore: openResourceCheckoutStore(path.join(root, "machine.db"), "host"), machineCpuCount,
        bindings: [], now: () => 1, requestPeer: async () => { throw new Error("Offline"); }, warn: () => {},
      });
      const first = open("first", capacity);
      const [machine] = first.read().resources;
      const second = open("second", detected);
      try {
        await expect(first.perform(request("light", { resourceId: machine.resourceId, units: 1 }))).resolves.toMatchObject({ outcome: "granted" });
        expect(second.read().resources[0]).toMatchObject({
          condition: "available",
          sharing: { mode: "counted", capacity, inUse: 1 },
        });
        await expect(second.perform(request("whole machine", { resourceId: machine.resourceId }))).resolves.toMatchObject({ outcome: "queued" });
        expect(first.read().resources[0].queue).toMatchObject([{ units: capacity }]);
      } finally {
        await Promise.all([first.close(), second.close()]);
        rmSync(root, { recursive: true, force: true });
      }
    }), { numRuns: 8 });
  });

  it("never binds a managed job when more than one idle reservation belongs to its executor", () => {
    fc.assert(fc.property(fc.integer({ min: 2, max: 32 }), (largeReservation) => {
      const harness = createHarness(largeReservation + 1);
      try {
        const { authority } = harness.open();
        const small = authority.perform(actor, request("small", { units: 1, expectedDurationMs: 50 }));
        const large = authority.perform(actor, request("large", { units: largeReservation, expectedDurationMs: 5_000 }));
        if (small.outcome !== "granted" || large.outcome !== "granted") throw new Error("Invalid counted fixture.");
        const before = authority.records(resourceId);
        const job = { id: "managed", executor: "host" };
        expect(() => authority.admitLocalJob(resourceId, actor, "Managed action", job)).toThrow(/multiple idle/i);
        expect(authority.records(resourceId)).toEqual(before);
        authority.perform(actor, change("release", { resourceId, epoch: definition.epoch, ...small }, "release small"));
        expect(authority.admitLocalJob(resourceId, actor, "Managed action", job)).toMatchObject({
          allocationId: large.allocationId, generation: large.generation,
        });
      } finally { harness.close(); }
    }), { numRuns: 8 });
  });

  it("projects fencing and cleanup gates for each allocation independently of earlier failures", () => {
    fc.assert(fc.property(fc.array(fc.constantFrom("missing", "unverified", "verified"), { minLength: 2, maxLength: 12 }), (states) => {
      const machine = { ...definition, resourceId: "machine:host:cpu", canonicalKey: "machine:host:cpu", scope: "machine" as const };
      const grants: CheckoutGrant[] = states.map((state, index) => ({
        actor, id: `failed-${index}`, generation: index + 1, requestedAt: 1, purpose: `Job ${index}`,
        units: 1, durationMs: 10, grantedAt: 1, deadlineAt: 11, renewals: 0, state: "recovery_required",
        job: { id: `job-${index}`, executor: "host", ...(state === "missing" ? {} : { processGroupId: index + 1 }) },
        ...(state === "verified" ? { fencingVerifiedAt: 12 } : {}),
      }));
      const view = projectCheckoutDomain({ definition: machine, generation: grants.length, grants, queue: [] }, actor, {
        authorityId: machine.authorityId, kind: "machine_broker", status: "reachable", label: "Host",
        endpointLabel: "Local", epoch: machine.epoch,
      });
      expect(view.recoveries?.map((entry) => [
        entry.allocationId, entry.generation, entry.actions?.fence?.allowed, entry.actions?.verify_cleanup?.allowed,
      ])).toEqual(states.map((state, index) => [
        `failed-${index}`, index + 1, state === "missing" ? undefined : true, state === "missing" ? undefined : state === "verified",
      ]));
      expect(view.actions.request).toMatchObject({ allowed: false });
    }), { numRuns: 8 });
  });

  it("offers Join queue exactly when the authority would take another request from the viewer", () => {
    fc.assert(fc.property(fc.array(fc.boolean(), { maxLength: 6 }), (viewerEntries) => {
      const queue = viewerEntries.map((mine, index) => ({
        actor: mine ? actor : other, id: `q-${index}`, purpose: "work", units: 1, durationMs: 1_000, requestedAt: 1,
      }));
      const view = projectCheckoutDomain({ definition, generation: 0, grants: [], queue }, actor, {
        authorityId: definition.authorityId, kind: "machine_broker", status: "reachable", label: "Host",
        endpointLabel: "Local", epoch: definition.epoch,
      });
      // The authority refuses a second queued request from one requester.
      const waiting = queue.some((entry) => entry.actor === actor);
      expect(view.actions.request?.allowed).toBe(!waiting);
      expect(view.actions.cancel_request?.allowed).toBe(waiting ? true : undefined);
    }), { numRuns: 8 });
  });

  it("preserves exclusive holders and FIFO waiters while upgrading dev's machine pool", async () => {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 2, max: 128 }), async (machineCpuCount) => {
      const root = mkdtempSync(path.join(os.tmpdir(), "pwragent-machine-capacity-"));
      const file = path.join(root, "machine.db");
      const resourceId = "machine:host:cpu";
      const legacy = openResourceCheckoutStore(file, "host");
      const authority = new ResourceCheckoutAuthority(legacy, () => 1, randomUUID);
      authority.ensure({
        resourceId, canonicalKey: resourceId, authorityId: resourceId,
        displayName: "This machine", kindLabel: "Machine compute", scope: "machine",
        counted: false, capacity: 1, epoch: 1, publication: "published", revision: 1,
        maxHoldMs: 10_000, updatedAt: 1,
      });
      const first = authority.perform(actor, request("old holder", { resourceId }));
      const second = authority.perform(other, request("old waiter", { resourceId, units: 1 }));
      legacy.close();
      if (first.outcome !== "granted" || second.outcome !== "queued") throw new Error("Invalid legacy fixture.");
      const services = ["dev", "default"].map((profile) => new DesktopResourceCheckoutService({
        viewer: { instanceId: profile, instanceLabel: profile, profile, machineId: "host" },
        machineStore: openResourceCheckoutStore(file, "host"), machineCpuCount,
        bindings: [], now: () => 2, requestPeer: async () => { throw new Error("Offline"); }, warn: () => {},
      }));
      const [dev, releaseProfile] = services;
      try {
        await expect(dev.perform(request("light", { resourceId, units: 1 }))).resolves.toMatchObject({ outcome: "queued", position: 2 });
        expect(releaseProfile.read().resources[0]).toMatchObject({
          sharing: { mode: "counted", capacity: machineCpuCount, inUse: machineCpuCount },
          allocations: [{ allocationId: first.allocationId, generation: first.generation, units: machineCpuCount }],
          queue: [{ queueEntryId: second.queueEntryId, units: machineCpuCount }, { units: 1 }],
        });
        const oldToken = { resourceId, allocationId: first.allocationId, generation: first.generation, epoch: 1 };
        await expect(releaseProfile.perform(change("release", oldToken, "old release"), actor)).resolves.toMatchObject({ outcome: "accepted" });
        expect(dev.read().resources[0]).toMatchObject({
          sharing: { inUse: machineCpuCount }, allocations: [{ allocationId: second.queueEntryId, units: machineCpuCount }],
          queue: [{ units: 1 }],
        });
        await expect(dev.status(actor, resourceId, "old holder")).resolves.toMatchObject({ receipt: first, state: "ended" });
      } finally {
        await Promise.all(services.map((service) => service.close()));
        rmSync(root, { recursive: true, force: true });
      }
    }), { numRuns: 8 });
  });

  it("keeps an unenrolled root unresolved and out of managed admission", async () => {
    const service = new DesktopResourceCheckoutService({
      viewer: { instanceId: "alternate", instanceLabel: "Alternate root", profile: "default", machineId: "host" },
      bindings: [], requestPeer: async () => { throw new Error("No peers"); }, warn: () => {},
    });
    try {
      const [machine] = service.read().resources;
      expect(machine).toMatchObject({
        condition: "ownership_unresolved", definition: { publication: "pending_registration" }, actions: {}, advertisements: [],
      });
      expect(() => service.admitMachineJob("setup", "Environment setup")).toThrow(/unavailable/);
    } finally {
      await service.close();
    }
  });

  it("allows production roots only when they open the primary store", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "pwragent-root-enrollment-"));
    try {
      const primary = path.join(root, "primary");
      const alternate = path.join(root, "alternate");
      const alias = path.join(root, "same-store");
      mkdirSync(primary);
      mkdirSync(alternate);
      symlinkSync(primary, alias, process.platform === "win32" ? "junction" : "dir");
      await expect(checkoutRootCanHostMachine(primary, primary, true)).resolves.toBe(true);
      await expect(checkoutRootCanHostMachine(alias, primary, true)).resolves.toBe(true);
      await expect(checkoutRootCanHostMachine(alternate, primary, true)).resolves.toBe(false);
      await expect(checkoutRootCanHostMachine(alternate, primary, false)).resolves.toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(["default", "dev"])("keeps unpublished drafts private to the %s instance", async (owner) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "pwragent-draft-"));
    const services = ["default", "dev"].map((instanceId) => new DesktopResourceCheckoutService({
      viewer: { instanceId, instanceLabel: instanceId, profile: instanceId, machineId: "host" },
      machineStore: openResourceCheckoutStore(path.join(root, "machine.db"), "host"),
      bindings: [], now: () => 1, requestPeer: async () => { throw new Error("Offline"); }, warn: () => {},
    }));
    const [local, peer] = owner === "default" ? services : services.toReversed();
    try {
      const registration = {
        kind: "register_definition", idempotencyKey: "draft",
        draft: { displayName: "Private draft", canonicalKey: resourceId, kindLabel: "Fixture", allocationScope: "federation",
          sharing: { mode: "exclusive" }, instructionsSource: "Private instructions" },
      };
      await expect(local.perform(registration)).resolves.toMatchObject({ outcome: "accepted" });
      expect(local.read().resources.some(({ displayName }) => displayName === "Private draft")).toBe(true);
      expect(JSON.stringify(peer.read())).not.toContain("Private");
      expect(JSON.stringify(await peer.discover(peer.threadActor("codex", "thread")))).not.toContain("Private");
      await expect(peer.perform({ ...registration, draft: { ...registration.draft, displayName: "Other draft" } })).resolves.toMatchObject({ outcome: "accepted" });
    } finally {
      for (const service of services) await service.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([true, false])("persists shutdown evidence after stopping an admitted job (verified %s)", async (verified) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "pwragent-cleanup-"));
    const database = path.join(root, "machine.db");
    const old = process.env[SQLITE_WRITE_METRICS_ENV];
    process.env[SQLITE_WRITE_METRICS_ENV] = "1";
    const service = new DesktopResourceCheckoutService({
      viewer: { instanceId: "default", instanceLabel: "default", profile: "default", machineId: "host" },
      machineStore: openResourceCheckoutStore(database, "host"),
      bindings: [], now: () => 1, requestPeer: async () => { throw new Error("Offline"); }, warn: () => {},
    });
    const observer = openResourceCheckoutStore(database, "host");
    try {
      const checkout = service.admitMachineJob("job", "Job");
      checkout.active();
      checkout.watch(() => { if (verified) setImmediate(() => checkout.finish(true)); });
      const { writes } = await measureSqliteWrites(() => service.close(verified ? 2_000 : 0));
      expectSqliteWriteBudget({
        scenario: verified ? "resource-checkout-shutdown-verified" : "resource-checkout-shutdown-unverified",
        note: verified ? "One commit to persist late verified drain and release" : "One commit to retain the slot in recovery when shutdown runs out of time",
        writes,
      });
      const grants = observer.readAll()[0].grants;
      if (verified) expect(grants).toEqual([]);
      else expect(grants).toMatchObject([{ state: "recovery_required" }]);
    } finally {
      await service.close();
      observer.close();
      rmSync(root, { recursive: true, force: true });
      if (old === undefined) delete process.env[SQLITE_WRITE_METRICS_ENV];
      else process.env[SQLITE_WRITE_METRICS_ENV] = old;
    }
  });
  it("agrees with an EASY-backfill FIFO capacity model across profile writers, replays, expiry and reopen", () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 6 }), fc.array(fc.record({
      command: fc.constantFrom("request", "release", "expire", "reopen", "cancel", "replay"),
      units: fc.integer({ min: -1, max: 6 }),
      durationMs: fc.constantFrom(200, 500, 1_000, 1_500),
      writer: fc.boolean(),
    }), { minLength: 3, maxLength: 45 }), (capacity, commands) => {
      const harness = createHarness(capacity);
      try {
        let first = harness.open();
        const second = harness.open();
        let modelNow = 1;
        type Item = { purpose: string; units: number; durationMs: number; deadlineAt?: number; actor: CheckoutActor };
        let held: Item[] = [];
        const queue: Item[] = [];
        const requests: Array<{ key: string; who: CheckoutActor; units: number; durationMs: number; receipt: unknown }> = [];
        let generation = 0;
        const wake = () => {
          let free = capacity - held.reduce((sum, item) => sum + item.units, 0);
          while (queue.length && queue[0].units <= free) {
            const next = queue.shift()!;
            free -= next.units;
            held.push({ ...next, deadlineAt: modelNow + next.durationMs });
            generation++;
          }
          if (capacity <= 1 || queue.length <= 1 || free <= 0) return;
          const ordered = [...held].sort((a, b) => (a.deadlineAt ?? 0) - (b.deadlineAt ?? 0));
          let projected = free;
          let shadowTime: number | undefined;
          for (const grant of ordered) {
            projected += grant.units;
            if (projected >= queue[0].units) {
              shadowTime = grant.deadlineAt;
              break;
            }
          }
          if (shadowTime === undefined) return;
          let extraAtShadow = free
            + ordered.filter((grant) => (grant.deadlineAt ?? 0) <= shadowTime).reduce((sum, grant) => sum + grant.units, 0)
            - queue[0].units;
          let i = 1;
          while (i < queue.length && free > 0) {
            const candidate = queue[i]!;
            const finishesBeforeHead = modelNow + candidate.durationMs <= shadowTime;
            const fitsInSpare = candidate.units <= extraAtShadow;
            if (candidate.units <= free && (finishesBeforeHead || fitsInSpare)) {
              queue.splice(i, 1);
              free -= candidate.units;
              if (!finishesBeforeHead) extraAtShadow -= candidate.units;
              held.push({ ...candidate, deadlineAt: modelNow + candidate.durationMs });
              generation++;
            } else {
              i++;
            }
          }
        };
        for (const [index, step] of commands.entries()) {
          const who = step.writer ? actor : other;
          const writer = (step.writer ? first : second).authority;
          const current = writer.records()[0];
          const key = String(index);
          if (step.command === "request") {
            const result = writer.perform(who, request(key, { units: step.units, expectedDurationMs: step.durationMs }));
            // A requester never holds while it waits: one already waiting is
            // refused, and one holding is refused unless it starts at once.
            const holds = held.some((item) => item.actor === who);
            if (step.units > 0 && step.units <= capacity && !queue.some((item) => item.actor === who)) {
              const before = { held: [...held], queue: [...queue], generation };
              queue.push({ purpose: key, units: step.units, durationMs: step.durationMs, actor: who });
              wake();
              const startedAtOnce = held.some((item) => item.purpose === key);
              if (holds && !startedAtOnce) {
                held = before.held;
                queue.splice(0, queue.length, ...before.queue);
                generation = before.generation;
                expect(result).toMatchObject({ outcome: "rejected", reason: "policy" });
              } else {
                expect(result.outcome).toBe(startedAtOnce ? "granted" : "queued");
                requests.push({ key, who, units: step.units, durationMs: step.durationMs, receipt: result });
              }
            } else {
              expect(result.outcome).toBe("rejected");
            }
          } else if (step.command === "release" && current.grants[0]) {
            const grant = current.grants[0];
            const stale = { resourceId, epoch: definition.epoch, generation: grant.generation + 1, allocationId: grant.id };
            expect(writer.perform(grant.actor, change("release", stale, key + "-stale"))).toMatchObject({ outcome: "rejected", reason: "stale_generation" });
            expect(writer.perform(grant.actor, change("release", { ...stale, generation: grant.generation }, key))).toMatchObject({ outcome: "accepted" });
            held.shift();
            wake();
          } else if (step.command === "expire") {
            harness.advance(1_501);
            modelNow += 1_501;
            held = held.filter((item) => (item.deadlineAt ?? 0) > modelNow);
            wake();
          } else if (step.command === "cancel" && current.queue[0]) {
            const entry = current.queue[0];
            expect(writer.perform(entry.actor, { kind: "cancel_request", resourceId, idempotencyKey: key, queueEntryId: entry.id }).outcome).toBe("accepted");
            queue.shift();
            wake();
          } else if (step.command === "reopen") {
            first.close();
            first = harness.open();
          } else if (step.command === "replay" && requests[0]) {
            const prior = requests[0];
            expect(writer.perform(prior.who, request(prior.key, { units: prior.units, expectedDurationMs: prior.durationMs }))).toEqual(prior.receipt);
          }
          const durable = first.authority.records()[0];
          expect(durable.grants.reduce((sum, grant) => sum + grant.units, 0)).toBeLessThanOrEqual(capacity);
          expect(durable.grants.map(({ purpose, units }) => ({ purpose, units }))).toEqual(held.map(({ purpose, units }) => ({ purpose, units })));
          expect(durable.queue.map(({ purpose, units }) => ({ purpose, units }))).toEqual(queue.map(({ purpose, units }) => ({ purpose, units })));
          expect(durable.generation).toBe(generation);
          expect(second.authority.records()).toEqual([durable]);
        }
      } finally {
        harness.close();
      }
    }), { numRuns: 8 });
  });

  it("backfills non-delaying waiters behind a large head without ever delaying the head's shadow start time", () => {
    fc.assert(fc.property(
      fc.integer({ min: 6, max: 24 }),
      fc.integer({ min: 1, max: 5 }),
      fc.integer({ min: 1_000, max: 8_000 }),
      fc.array(fc.record({
        units: fc.integer({ min: 1, max: 12 }),
        durationMs: fc.integer({ min: 200, max: 9_000 }),
      }), { minLength: 1, maxLength: 8 }),
      (capacity, activeUnits, activeDurationMs, trailing) => {
        const harness = createHarness(capacity);
        try {
          const { authority } = harness.open();
          const holder = authority.perform(actor, request("holder", { units: activeUnits, expectedDurationMs: activeDurationMs }));
          expect(holder.outcome).toBe("granted");
          const headUnits = capacity - activeUnits + 1;
          if (headUnits > capacity) return;
          const head = authority.perform(other, request("head", { units: headUnits, expectedDurationMs: 2_000 }));
          expect(head.outcome).toBe("queued");
          const shadowTime = 1 + activeDurationMs;

          for (const [index, entry] of trailing.entries()) {
            const units = Math.min(entry.units, capacity);
            authority.perform(requester(`trail-${index}`), request(`trail-${index}`, { units, expectedDurationMs: entry.durationMs }));
            const state = authority.records()[0];
            expect(state.grants.reduce((sum, grant) => sum + grant.units, 0)).toBeLessThanOrEqual(capacity);
          }

          // Advance directly to the head's original shadow time: every backfilled
          // job either finished by then or left enough spare capacity for #1.
          harness.advance(shadowTime - 1);
          const afterShadow = authority.records()[0];
          expect(afterShadow.grants.some((grant) => grant.purpose === "head")).toBe(true);
          expect(afterShadow.grants.reduce((sum, grant) => sum + grant.units, 0)).toBeLessThanOrEqual(capacity);
        } finally {
          harness.close();
        }
      },
    ), { numRuns: 8 });

    // Concrete scenario from an 18-CPU host: 4 held (12m), 16 queued #1,
    // 4-slot 10m request backfills immediately while 4-slot 15m request waits.
    const harness = createHarness(18);
    try {
      const { authority } = harness.open();
      expect(authority.perform(actor, request("g193", { units: 4, expectedDurationMs: 7_200 })).outcome).toBe("granted");
      expect(authority.perform(other, request("head-16", { units: 16, expectedDurationMs: 6_000 })).outcome).toBe("queued");
      expect(authority.perform(requester("carol"), request("short-4", { units: 4, expectedDurationMs: 6_000 })).outcome).toBe("granted");
      expect(authority.perform(requester("dave"), request("long-4", { units: 4, expectedDurationMs: 9_000 })).outcome).toBe("queued");
      expect(authority.perform(actor, request("spare-2", { units: 2, expectedDurationMs: 9_000 })).outcome).toBe("granted");
      harness.advance(7_200);
      expect(authority.records()[0].grants.map((grant) => grant.purpose)).toEqual(["spare-2", "head-16"]);
    } finally {
      harness.close();
    }
  });

  it("resolves live thread titles for new and already-persisted thread checkouts", async () => {
    const harness = createHarness();
    try {
      const dbPath = path.join(harness.root, "titles.db");
      const titles = new Map<string, string>([
        ["codex:t-1", "Fix Duplicate Access Mode Dialogs"],
      ]);
      // Persist an older grant with the generic fallback title first.
      const legacyService = new DesktopResourceCheckoutService({
        viewer: { instanceId: "default", instanceLabel: "default", profile: "default", machineId: "host" },
        machineStore: openResourceCheckoutStore(dbPath, "host"),
        machineCpuCount: 18,
        bindings: [],
        now: () => 1,
        requestPeer: async () => { throw new Error("Offline"); },
        warn: () => {},
      });
      const machineId = legacyService.localMachineResourceId();
      const legacyGrant = await legacyService.perform(
        request("legacy", { resourceId: machineId, units: 4, expectedDurationMs: 60_000 }),
        legacyService.threadActor("codex", "t-1"),
      );
      expect(legacyGrant.outcome).toBe("granted");
      expect(legacyService.read().resources[0].allocations[0].holder).toMatchObject({
        kind: "thread",
        thread: { title: "Agent thread" },
      });
      await legacyService.close();

      // Reopen with a live title resolver: both persisted and newly queued entries show real titles.
      const titledService = new DesktopResourceCheckoutService({
        viewer: { instanceId: "default", instanceLabel: "default", profile: "default", machineId: "host" },
        machineStore: openResourceCheckoutStore(dbPath, "host"),
        machineCpuCount: 18,
        bindings: [],
        now: () => 2,
        threadTitle: ({ backend, threadId }) => titles.get(`${backend}:${threadId}`),
        requestPeer: async () => { throw new Error("Offline"); },
        warn: () => {},
      });
      try {
        titles.set("acp:antigravity:t-2", "AntiGravity Review PR");
        await titledService.perform(
          request("queued-16", { resourceId: machineId, units: 16, expectedDurationMs: 60_000 }),
          titledService.threadActor("acp:antigravity", "t-2"),
        );
        const snapshot = titledService.read().resources[0];
        expect(snapshot.allocations[0].holder).toMatchObject({
          kind: "thread",
          thread: { threadId: "t-1", title: "Fix Duplicate Access Mode Dialogs" },
        });
        expect(snapshot.queue[0].requester).toMatchObject({
          kind: "thread",
          thread: { threadId: "t-2", title: "AntiGravity Review PR" },
        });
        // Renaming a thread updates subsequent snapshots immediately.
        titles.set("codex:t-1", "Renamed Thread Title");
        expect(titledService.read().resources[0].allocations[0].holder).toMatchObject({
          kind: "thread",
          thread: { title: "Renamed Thread Title" },
        });
      } finally {
        await titledService.close();
      }
    } finally {
      harness.close();
    }
  });

  it("keeps preparing and active work reserved across same-boot restarts and wakes after a verified reboot", async () => {
    const harness = createHarness();
    try {
      const machineId = await readOrCreateFederationMachineId({ rootDir: harness.root });
      function service(profile: string, bootId: string) {
        return new DesktopResourceCheckoutService({
          viewer: { instanceId: profile, instanceLabel: profile, profile, machineId }, bootId,
          machineStore: openResourceCheckoutStore(path.join(harness.root, "machine.db"), machineId!),
          bindings: [], requestPeer: async () => { throw new Error("Offline"); }, warn: () => {},
        });
      }
      const local = service("default", "boot-a");
      const dev = service("dev", "boot-a");
      const resource = local.read().resources[0];
      expect(dev.read().resources[0].resourceId).toBe(resource.resourceId);
      const running = local.admitMachineJob("job", "Managed action", { thread: { backend: "codex", threadId: "worker" } });
      running.active();
      expect(dev.read().resources[0].allocations[0].state).toBe("active");
      await expect(dev.perform(request("waiter", { resourceId: resource.resourceId }))).resolves.toMatchObject({ outcome: "queued" });
      local.close();
      dev.close();

      const restarted = service("default", "boot-a");
      expect(restarted.read().resources[0]).toMatchObject({ condition: "busy", queue: [{ purpose: "waiter" }] });
      restarted.close();
      const rebooted = service("dev", "boot-b");
      expect(rebooted.read().resources[0]).toMatchObject({
        cleanup: { state: "verified" }, allocations: [{ taskLabel: "waiter", generation: 2, viewerOwns: true }], queue: [],
      });
      rebooted.close();
    } finally {
      harness.close();
    }
  });

  it("keeps an operator's manual hold separate from actions without a thread owner", async () => {
    const harness = createHarness();
    const service = new DesktopResourceCheckoutService({
      viewer: { instanceId: "default", instanceLabel: "Local", profile: "default", machineId: "host" },
      machineStore: openResourceCheckoutStore(path.join(harness.root, "machine.db"), "host"),
      bindings: [], now: () => 1, requestPeer: async () => { throw new Error("Offline"); }, warn: () => {},
    });
    try {
      await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 20_000 }), async (expectedDurationMs) => {
        const { resourceId } = service.read().resources[0];
        const hold = await service.perform(request(randomUUID(), { resourceId, expectedDurationMs }));
        if (hold.outcome !== "granted") throw new Error("Expected a manual hold.");
        expect(() => service.admitMachineJob("automatic", "Launchpad action")).toThrow(/capacity is reserved/);
        await expect(service.perform(change("release", {
          resourceId, allocationId: hold.allocationId, generation: hold.generation, epoch: 1,
        }, randomUUID()))).resolves.toMatchObject({ outcome: "accepted" });
      }), { numRuns: 8 });
    } finally {
      service.close();
      harness.close();
    }
  });

  it("reads a legacy peer list and an owner-only file as the same definition without rewriting either", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "checkout-manifest-"));
    try {
      const file = path.join(root, "resource-checkout-authorities.json");
      const domain = { canonicalKey: resourceId, displayName: "Lab", kindLabel: "Fixture", authorityInstanceId: "owner",
        authorityMachineId: "host", epoch: 3, capacity: 1, maxHoldMs: 10_000, revision: 1, updatedAt: 1 };
      const read = (extra: Record<string, unknown>) => {
        const raw = JSON.stringify({ version: 1, domains: [{ ...domain, ...extra }] });
        writeFileSync(file, raw);
        const result = readExternalCheckoutBindings(root);
        expect(readFileSync(file, "utf8")).toBe(raw);
        return result;
      };
      expect(read({ allowedInstances: ["previous-member"] })).toEqual(read({}));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each(["subject discovery", "action receipt"])("routes from a confirmed owner without unrelated catalog reads for %s", async (scenario) => {
    const harness = createHarness();
    const authority = new DesktopResourceCheckoutService({
      viewer: { instanceId: "owner", instanceLabel: "Owner", profile: "default", machineId: "host" },
      bindings: [{ authorityInstanceId: "owner", authorityMachineId: "host",
        definition: { ...definition, authorityId: `checkout:owner:${resourceId}` } }],
      checkoutPeers: () => new Map([["viewer", "connected"]]), now: () => 1, warn: () => {},
      externalStore: openResourceCheckoutStore(path.join(harness.root, "external.db"), "host"),
      requestPeer: async () => { throw new Error("Unexpected outbound call"); },
    });
    const catalogReads: string[] = [];
    const client = new DesktopResourceCheckoutService({
      viewer: { instanceId: "viewer", instanceLabel: "Viewer", profile: "dev", machineId: "client" },
      bindings: [], checkoutPeers: () => new Map([["owner", "connected"]]), now: () => 1, warn: () => {},
      requestPeer: async <T>(_instance: string, input: unknown) => {
        const op = input as { operation: string; subject?: unknown };
        if (op.operation === "catalog") {
          catalogReads.push(op.subject ? "subject" : "operator");
          if (scenario === "subject discovery" && !op.subject) throw new Error("Operator read timed out");
        }
        return authority.receivePeer("viewer", input) as T;
      },
    });
    try {
      const worker = client.threadActor("codex", "worker");
      if (scenario === "subject discovery") {
        expect((await client.discover(worker)).find(row => row.resource.resourceId === resourceId)?.resource.condition).toBe("available");
      } else await client.refreshPeers();
      const receipt = await client.perform(request("hold"), worker);
      expect(receipt.outcome).toBe("granted");
      await expect(client.status(worker, resourceId, "hold")).resolves.toMatchObject({ state: "granted" });
      expect(catalogReads).toEqual([scenario === "subject discovery" ? "subject" : "operator"]);
      if (scenario === "subject discovery") {
        const row = (await client.discover(worker)).find(item => item.resource.resourceId === resourceId);
        expect(row?.resource.actions.release?.allowed).toBe(true);
        expect(client.read().resources.find(item => item.resourceId === resourceId)?.actions.release?.allowed).toBeFalsy();
      }
    } finally { client.close(); authority.close(); harness.close(); }
  });

  it("retains external ownership on partitions, replays a lost receipt, and blocks stale or foreign requests", async () => {
    const harness = createHarness();
    let authority: DesktopResourceCheckoutService | undefined;
    let client: DesktopResourceCheckoutService | undefined;
    try {
      const binding: ExternalBinding = {
        authorityInstanceId: "owner", authorityMachineId: "host",
        definition: { ...definition, authorityId: `checkout:owner:${resourceId}` },
      };
      let permitted = true;
      let offline = false;
      let loseResponse = false;
      authority = new DesktopResourceCheckoutService({
        viewer: { instanceId: "owner", instanceLabel: "Owner", profile: "default", machineId: "host" },
        bindings: [binding], checkoutPeers: () => new Map(permitted ? [["viewer", "connected"]] : []), now: () => 1, warn: () => {},
        externalStore: openResourceCheckoutStore(path.join(harness.root, "external.db"), "host"),
        requestPeer: async () => { throw new Error("Unexpected outbound call"); },
      });
      client = new DesktopResourceCheckoutService({
        viewer: { instanceId: "viewer", instanceLabel: "Viewer", profile: "dev", machineId: "client" },
        bindings: [], checkoutPeers: () => new Map(permitted ? [["owner", "connected"]] : []), agentToolsEnabled: () => true, now: () => 1, warn: () => {},
        machineStore: openResourceCheckoutStore(path.join(harness.root, "client.db"), "client"),
        requestPeer: async <T>(_instanceId: string, input: unknown): Promise<T> => {
          if (offline) throw new Error("Partitioned");
          const response = authority!.receivePeer("viewer", input);
          if (loseResponse) throw new Error("Response lost");
          return response as T;
        },
      });
      await client.refreshPeers();
      expect(client.read().resources.map((item) => item.resourceId)).toContain(resourceId);
      const initialRevision = client.read().revision;
      const worker = client.threadActor("acp:registry.worker", "worker");
      const rival = client.threadActor("codex", "rival");
      const tool = createResourceCheckoutToolHandler(client);
      const ctx = { backend: "codex" as const, threadId: "rival", turnId: "turn", callId: "call", transport: "mcp" as const };
      expect(client.read().agentTools).toBe("enabled");
      await expect(tool("resource_checkout_discover", {}, ctx)).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ resource: expect.objectContaining({ resourceId, condition: "available" }) }),
      ]));
      loseResponse = true;
      await expect(client.perform(request("acquire"), worker)).resolves.toMatchObject({ outcome: "unknown" });
      await client.refreshPeers();
      loseResponse = false;
      await client.refreshPeers();
      const replay = await client.perform(request("acquire"), worker);
      if (replay.outcome !== "granted") throw new Error("Expected replayed grant");
      await expect(client.perform(change("release", { ...replay, resourceId, epoch: 3 }, "foreign"), rival))
        .resolves.toMatchObject({ outcome: "rejected", reason: "not_authorized" });
      expect(() => authority!.receivePeer("intruder", { operation: "read", resourceId, epoch: 3 })).toThrow();
      expect(() => authority!.receivePeer("viewer", { operation: "perform", resourceId, epoch: 2, action: request("stale") })).toThrow();
      expect(client.read().revision).toBeGreaterThan(initialRevision);
      const handedOff: string[] = [];
      const route = createResourceCheckoutToolHandler(client, undefined, async (_context, target, _prompt, bind) => {
        expect(target).toEqual({ instanceId: "owner", backend: "codex", threadId: "executor" });
        await bind();
        expect(authority!.read().resources.find((item) => item.resourceId === resourceId)?.allocations[0]).toMatchObject({
          allocationId: replay.allocationId, generation: replay.generation, delegatedExecutor: { threadId: "executor", instanceId: "owner" },
        });
        handedOff.push(target.threadId);
        return { ok: true };
      });
      const handoff = () => route("resource_checkout_handoff", {
        resourceId, idempotencyKey: "route-handoff", allocationId: replay.allocationId,
        generation: replay.generation, authorityEpoch: definition.epoch, instanceId: "owner",
        backend: "codex", threadId: "executor", prompt: "Run the fixture.",
      }, { backend: "acp:registry.worker", threadId: "worker", turnId: "turn", callId: "call", transport: "mcp" });
      await expect(handoff()).resolves.toEqual({ ok: true });
      expect(handedOff).toEqual(["executor"]);
      await expect(client.perform(request("second"), rival)).resolves.toMatchObject({ outcome: "queued" });
      await expect(client.status(rival, resourceId, "second")).resolves.toMatchObject({ state: "queued", position: 1 });
      permitted = false;
      expect(client.read().resources.some((item) => item.resourceId === resourceId)).toBe(false);
      await expect(client.discover(worker)).resolves.toHaveLength(1);
      await expect(client.status(worker, resourceId, "acquire")).resolves.toBeUndefined();
      for (const operation of ["catalog", "read", "status", "perform", "lab_execution"]) {
        expect(() => authority!.receivePeer("viewer", { operation, resourceId, offset: 0, epoch: 3 }))
          .toThrow("authenticated full Federation member");
      }
      permitted = true;
      await client.refreshPeers();
      const authoritative = authority.read().resources.find((item) => item.resourceId === resourceId);

      for (let i = 0; i < 3; i++) {
        offline = true;
        await client.refreshPeers();
        const snapshot = client.read();
        expect(snapshot.resources.find((item) => item.resourceId === resourceId)).toMatchObject({
          condition: "unreachable", allocations: [{ generation: 1, lastKnown: true }], actions: {},
        });
        expect(snapshot.resources.find((item) => item.placement === "machine")?.condition).toBe("available");
        await expect(client.perform(request("partition"), worker)).resolves.toMatchObject({ outcome: "rejected", reason: "authority_unreachable" });
        offline = false;
        await client.refreshPeers();
        expect(authority.read().resources.find((item) => item.resourceId === resourceId)).toEqual(authoritative);
      }
      await expect(client.status(worker, resourceId, "acquire")).resolves.toMatchObject({ state: "granted", generation: 1 });
      await expect(client.perform(change("release", { ...replay, resourceId, epoch: 3 }, "release"), worker))
        .resolves.toMatchObject({ outcome: "accepted" });
      await expect(client.status(rival, resourceId, "second")).resolves.toMatchObject({ state: "granted" });
      await expect(handoff()).rejects.toThrow(/no longer has an idle grant/);
      expect(handedOff).toEqual(["executor"]);
    } finally {
      client?.close();
      authority?.close();
      harness.close();
    }
  });

  it("blocks stale executor effects and retains ownership until fencing and the required final state are proven", async () => {
    const harness = createHarness();
    try {
      const { authority } = harness.open();
      const grant = granted(authority, "first");
      const effects: string[] = [];
      const policy = { allowedActors: [actor.key], adapterId: "fake", maxCostMinorUnits: 200, finalState: "stopped-retained" };
      const adapter: CheckoutProviderAdapter = {
        id: "fake",
        async prepare() { effects.push("prepare"); },
        async run() { effects.push("run"); },
        async drain() { effects.push("drain"); return { effectsFenced: true, finalState: "wrong-state" }; },
      };
      const options = { authority, actor, token: grant, adapter, policy, jobId: "job", costMinorUnits: 200, signal: new AbortController().signal };
      await expect(executeResourceCheckout({ ...options, costMinorUnits: 201 })).resolves.toBe("rejected");
      await expect(executeResourceCheckout({ ...options, actor: other })).resolves.toBe("rejected");
      expect(effects).toEqual([]);
      const result = executeResourceCheckout(options);
      expect(authority.perform(other, request("waiter"))).toMatchObject({ outcome: "queued" });
      harness.advance(1_001);
      await expect(result).resolves.toBe("recovery_required");
      expect(effects).toEqual(["prepare", "drain"]);
      expect(authority.records()[0]).toMatchObject({ grants: [{ state: "recovery_required" }], queue: [{ purpose: "waiter" }] });
      expect(authority.finishJob(grant, "wrong-job")).toBe(false);
      expect(authority.finishJob({ ...grant, epoch: 2 }, "job")).toBe(false);
      expect(authority.finishJob(grant, "job")).toBe(true);
      expect(authority.records()[0].grants[0]).toMatchObject({ purpose: "waiter", generation: 2 });
      expect(authority.beginJobDrain(grant, "job")).toBe(false);
      await expect(executeResourceCheckout(options)).resolves.toBe("rejected");
      expect(effects).toEqual(["prepare", "drain"]);
    } finally {
      harness.close();
    }
  });

  it("waits for cancelled preparation and its stop guard to drain before granting the next checkout", async () => {
    const harness = createHarness();
    try {
      const { authority } = harness.open();
      const token = granted(authority, "preparing");
      const controller = new AbortController();
      const finishPreparation = Promise.withResolvers<void>();
      const finishCleanup = Promise.withResolvers<void>();
      const cleanupStarted = Promise.withResolvers<void>();
      let runAttempted = false;
      const run = executeResourceCheckout({
        authority, actor, token, jobId: "job", costMinorUnits: 0, signal: controller.signal,
        policy: { allowedActors: [actor.key], adapterId: "fake", maxCostMinorUnits: 0, finalState: "stopped" },
        adapter: {
          id: "fake",
          async prepare() { await finishPreparation.promise; },
          async run() { runAttempted = true; },
          async drain() {
            cleanupStarted.resolve();
            await finishCleanup.promise;
            return { effectsFenced: true, finalState: "stopped" };
          },
        },
      });
      controller.abort();
      expect(authority.perform(other, request("waiting"))).toMatchObject({ outcome: "queued" });
      expect(authority.records()[0].grants[0].state).toBe("preparing");
      finishPreparation.resolve();
      await cleanupStarted.promise;
      expect(authority.records()[0]).toMatchObject({
        grants: [{ id: token.allocationId, state: "draining" }], queue: [{ purpose: "waiting" }],
      });
      finishCleanup.resolve();
      await expect(run).resolves.toBe("released");
      expect(runAttempted).toBe(false);
      expect(authority.records()[0]).toMatchObject({
        grants: [{ purpose: "waiting", generation: token.generation + 1 }], queue: [],
      });
      expect(authority.beginJobDrain(token, "job")).toBe(false);
    } finally {
      harness.close();
    }
  });

  it("fails closed on an identity collision and rejects administrative release without current proof", () => {
    const harness = createHarness();
    try {
      const { authority } = harness.open();
      expect(() => openResourceCheckoutStore(path.join(harness.root, "authority.db"), "copied-to-another-host")).toThrow();
      const grant = granted(authority, "owned");
      const fencing = { ...grant, kind: "fence" as const, idempotencyKey: "fence" };
      const administrativeRelease = { ...grant, kind: "administrative_release" as const, idempotencyKey: "release", auditNote: "Verified owned cleanup" };
      expect(authority.bindJob(actor, grant, { id: "job", executor: "managed" })).toBe(true);
      expect(authority.perform(other, administrativeRelease, { proveFenced: () => true }).outcome).toBe("rejected");
      expect(authority.markJobRecovery(grant, "job")).toBe(true);
      expect(authority.perform(other, { ...administrativeRelease, idempotencyKey: "early" }, { proveFenced: () => true })).toMatchObject({ reason: "fencing_required" });
      expect(authority.perform(other, fencing, { proveFenced: () => true }).outcome).toBe("accepted");
      expect(authority.perform(other, { ...administrativeRelease, idempotencyKey: "proof-missing" }, { proveFenced: () => false })).toMatchObject({ reason: "fencing_required" });
      expect(authority.records()[0].grants).toHaveLength(1);
      expect(authority.perform(other, { ...administrativeRelease, idempotencyKey: "verified" }, { proveFenced: () => true }).outcome).toBe("accepted");
      expect(authority.records()[0].grants).toHaveLength(0);
    } finally {
      harness.close();
    }
  });

  it("keeps idle and replay writes at zero and budgets each authority transition", async () => {
    const old = process.env[SQLITE_WRITE_METRICS_ENV];
    process.env[SQLITE_WRITE_METRICS_ENV] = "1";
    const harness = createHarness();
    try {
      const { authority } = harness.open();
      const scenario = async (name: string, note: string, operation: () => unknown) => {
        const { result, writes } = await measureSqliteWrites(operation);
        expectSqliteWriteBudget({ scenario: "resource-checkout-" + name, note, writes });
        return result;
      };
      await scenario("idle", "100 empty reconciliation passes and reads, zero idle commits", () => {
        for (let index = 0; index < 100; index++) authority.records();
      });
      const token = await scenario("acquire", "One acquire and its replay receipt in one commit", () => granted(authority, "acquire")) as CheckoutToken;
      await scenario("replay", "Duplicate delivery returns the durable original receipt without writes", () => authority.perform(actor, request("acquire")));
      await scenario("renew", "One renewal and its receipt in one commit per hold", () => authority.perform(actor, change("extend", token, "extend")));
      await scenario("queue", "One enqueue and its receipt in one commit", () => authority.perform(other, request("queued")));
      await scenario("release-wake", "Release and FIFO promotion with the action receipt in one commit", () => authority.perform(actor, change("release", token, "release")));
      const second = authority.records()[0].grants[0];
      const active = { resourceId, epoch: 3, allocationId: second.id, generation: second.generation };
      await scenario("job-start", "Two commits to bind and activate an actual job", () => {
        authority.bindJob(other, active, { id: "job", executor: "fake" });
        authority.activateJob(active, "job");
      });
      harness.advance(1_001);
      await scenario("expiry", "One reconciliation commit for an expired job, including a repeated read", () => {
        authority.records();
        authority.records();
      });
      await scenario("drain", "One commit for verified job completion", () => authority.finishJob(active, "job"));
      const local = await scenario("local-admission", "One commit for atomic local acquisition and binding", () =>
        authority.admitLocalJob(resourceId, actor, "Managed job", { id: "local", executor: "local" })) as CheckoutToken;
      await scenario("begin-drain", "One commit to begin draining an owned job before adapter effects", () => authority.beginJobDrain(local, "local"));
      authority.markJobRecovery(local, "local");
      await scenario("fence", "One commit for fencing evidence and its receipt", () => authority.perform(actor, {
        ...local, kind: "fence", idempotencyKey: "fence",
      }, { proveFenced: () => true }));
      await scenario("administrative-release", "One commit for validated recovery, a wake, and the operator audit note", () => authority.perform(actor, {
        ...local, kind: "administrative_release", idempotencyKey: "recover", auditNote: "Fixture proof",
      }, { proveFenced: () => true }));
      const resolve = { kind: "resolve_ownership", idempotencyKey: "resolve", resourceId, resolution: "accept_definition" } as const;
      await scenario("resolve-ownership", "One commit for an operator's ownership resolution and its receipt; a retry commits nothing", () => {
        authority.resolveOwnership(actor, resolve, (record) => { record.definition = { ...record.definition }; });
        authority.resolveOwnership(actor, resolve);
      });
    } finally {
      harness.close();
      if (old === undefined) delete process.env[SQLITE_WRITE_METRICS_ENV];
      else process.env[SQLITE_WRITE_METRICS_ENV] = old;
    }
  });
});

describe("delegated checkout execution", () => {
  const thread = (id: string): CheckoutActor => ({
    key: id, holder: { kind: "thread", thread: { backend: "codex", threadId: id, title: id } }, manage: false,
  });
  const requester = thread("requester");
  const executor = thread("executor");
  const stranger = thread("stranger");

  it("preserves allocation, generation, deadline and FIFO across retry, reopen and delegated setup", async () => {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 200, max: 9_000 }), fc.array(fc.constantFrom("replay", "stale", "foreign", "reopen"), {
      minLength: 1, maxLength: 12,
    }), async (expectedDurationMs, operations) => {
      const harness = createHarness();
      try {
        let owner = harness.open();
        const initial = owner.authority.perform(requester, request("requester", { expectedDurationMs }));
        if (initial.outcome !== "granted") throw new Error("Expected initial grant.");
        const next = owner.authority.perform(stranger, request("next"));
        if (next.outcome !== "queued") throw new Error("Expected FIFO waiter.");
        const authorityEpoch = definition.epoch;
        const action = {
          kind: "delegate_execution" as const, idempotencyKey: "handoff", resourceId,
          generation: initial.generation, allocationId: initial.allocationId, authorityEpoch,
          executor: { instanceId: "execution-host", backend: "codex" as const, threadId: "executor" },
        };
        const token = { resourceId, allocationId: initial.allocationId, generation: initial.generation, epoch: authorityEpoch };
        expect(owner.authority.perform(requester, action, { executor })).toMatchObject({ outcome: "accepted" });
        for (const op of operations) {
          if (op === "reopen") { owner.close(); owner = harness.open(); }
          if (op === "replay") expect(owner.authority.perform(requester, action, { executor })).toMatchObject({ outcome: "accepted" });
          if (op === "stale") expect(owner.authority.perform(requester, {
            ...action, idempotencyKey: "stale", authorityEpoch: authorityEpoch - 1,
          }, { executor })).toMatchObject({ outcome: "rejected" });
          if (op === "foreign") expect(owner.authority.perform(stranger, action, { executor })).toMatchObject({ outcome: "rejected" });
          expect(owner.authority.records()[0]).toMatchObject({
            grants: [{ id: token.allocationId, generation: token.generation, deadlineAt: 1 + expectedDurationMs, actor: requester, executor }],
            queue: [{ id: next.queueEntryId }],
          });
        }
        const job = { id: "setup", executor: "local" };
        expect(owner.authority.admitLocalJob(resourceId, requester, "setup", job, true)).toBeUndefined();
        expect(owner.authority.admitLocalJob(resourceId, stranger, "setup", job, true)).toBeUndefined();
        expect(owner.authority.admitLocalJob(resourceId, executor, "setup", job, true)).toEqual(token);
        expect(owner.authority.finishJob(token, job.id)).toBe(true);
        expect(owner.authority.records()[0]).toMatchObject({
          grants: [{ id: token.allocationId, state: "granted", deadlineAt: 1 + expectedDurationMs }],
          queue: [{ id: next.queueEntryId }],
        });
        expect(owner.authority.bindJob(executor, token, { id: "work", executor: "local" })).toBe(true);
        expect(owner.authority.finishJob(token, "work")).toBe(true);
        expect(owner.authority.records()[0].grants[0]).toMatchObject({ id: next.queueEntryId, generation: token.generation + 1 });
      } finally {
        harness.close();
      }
    }), { numRuns: 8 });
  });

  it("persists delegation and its retry receipt in one boundary commit", async () => {
    const previous = process.env[SQLITE_WRITE_METRICS_ENV];
    process.env[SQLITE_WRITE_METRICS_ENV] = "1";
    const harness = createHarness();
    try {
      const { authority } = harness.open();
      const initial = authority.perform(requester, request("requester"));
      if (initial.outcome !== "granted") throw new Error("Expected initial grant.");
      const action = {
        kind: "delegate_execution" as const, idempotencyKey: "handoff", resourceId,
        generation: initial.generation, allocationId: initial.allocationId, authorityEpoch: definition.epoch,
        executor: { instanceId: "execution-host", backend: "codex" as const, threadId: "executor" },
      };
      const { writes } = await measureSqliteWrites(() => {
        expect(authority.perform(requester, action, { executor })).toMatchObject({ outcome: "accepted" });
        expect(authority.perform(requester, action, { executor })).toMatchObject({ outcome: "accepted" });
      });
      expectSqliteWriteBudget({
        scenario: "resource-checkout-handoff",
        note: "Delegation and its receipt commit once; retry costs zero. At 100 handoffs a day this is about 0.82 MB of WAL.",
        writes,
      });
    } finally {
      harness.close();
      if (previous === undefined) delete process.env[SQLITE_WRITE_METRICS_ENV];
      else process.env[SQLITE_WRITE_METRICS_ENV] = previous;
    }
  });
});

describe("resource_checkout_acquire (blocking Code Mode checkout)", () => {
  const caller = { backend: "claude" as const, threadId: "t1", turnId: "turn-1", callId: "call-1", transport: "mcp" as const };
  const holder = { backend: "codex" as const, threadId: "t-holder", turnId: "turn-2", callId: "call-2", transport: "mcp" as const };

  function openRealService(capacity = 8, now?: () => number) {
    const root = mkdtempSync(path.join(os.tmpdir(), "pwragent-acquire-tool-"));
    const service = new DesktopResourceCheckoutService({
      viewer: { instanceId: "default", instanceLabel: "default", profile: "default", machineId: "host" },
      machineStore: openResourceCheckoutStore(path.join(root, "machine.db"), "host"),
      machineCpuCount: capacity,
      now,
      bindings: [],
      requestPeer: async () => { throw new Error("Offline"); },
      warn: () => {},
    });
    return {
      service,
      close: async () => {
        await service.close();
        rmSync(root, { recursive: true, force: true });
      },
    };
  }

  const acquireArgs = { purpose: "Fixture work", expectedDurationMs: 1_000, units: 1 };

  it("replays a grant only while its lease is usable", async () => {
    await fc.assert(fc.asyncProperty(fc.uuid(), fc.boolean(), async (key, expires) => {
      let now = 1;
      const { service, close } = openRealService(4, () => now);
      try {
        const handle = createResourceCheckoutToolHandler(service);
        const args = { ...acquireArgs, idempotencyKey: key };
        const first = await handle("resource_checkout_acquire", args, caller) as { releaseAction: unknown };
        expect(await handle("resource_checkout_acquire", args, caller)).toEqual(first);
        if (expires) now += acquireArgs.expectedDurationMs;
        else await handle("resource_checkout_action", { action: first.releaseAction }, caller);
        expect(await handle("resource_checkout_acquire", args, caller)).toMatchObject({ outcome: "ended" });
      } finally {
        await close();
      }
    }), { numRuns: 8 });
  });

  it("preserves the generated identity after an uncertain request", async () => {
    const { service, close } = openRealService();
    try {
      await fc.assert(fc.asyncProperty(fc.boolean(), async (explicit) => {
        const uncertain = { outcome: "unknown", message: "The network lost the response." } as const;
        const perform = vi.spyOn(service, "perform").mockResolvedValueOnce(uncertain);
        try {
          const result = await createResourceCheckoutToolHandler(service)("resource_checkout_acquire", {
            ...acquireArgs, ...(explicit ? { idempotencyKey: "explicit" } : {}),
          }, caller);
          expect(result).toMatchObject({ ...uncertain,
            resourceId: service.localMachineResourceId(),
            idempotencyKey: explicit ? "explicit" : expect.stringMatching(/^rco-/),
          });
          expect(perform.mock.calls[0][0]).toMatchObject({ idempotencyKey: (result as { idempotencyKey: string }).idempotencyKey });
        } finally {
          perform.mockRestore();
        }
      }), { numRuns: 8, examples: [[false]] });
    } finally {
      await close();
    }
  });

  it("derives usable release actions for acquire keys that differ near the length limit", async () => {
    const { service, close } = openRealService();
    const handle = createResourceCheckoutToolHandler(service);
    try {
      await fc.assert(fc.asyncProperty(fc.uuid(), async (token) => {
        const keys = [`${token.padEnd(159, "x")}a`, `${token.padEnd(159, "x")}b`];
        const results = await Promise.all(keys.map(async (idempotencyKey) =>
          await handle("resource_checkout_acquire", { ...acquireArgs, idempotencyKey }, caller) as { releaseAction: unknown }));
        for (const { releaseAction } of results) {
          expect(await handle("resource_checkout_action", { action: releaseAction }, caller)).toMatchObject({ outcome: "accepted" });
        }
        expect(service.read().resources[0].allocations).toHaveLength(0);
      }), { numRuns: 8 });
    } finally {
      await close();
    }
  });

  async function abortQueuedAcquire(promoteOnCancel: boolean, key: string) {
    let now = 1;
    const { service, close } = openRealService(4, () => now);
    const controller = new AbortController();
    const handle = createResourceCheckoutToolHandler(service);
    try {
      await handle("resource_checkout_acquire", { ...acquireArgs, units: 4 }, holder);
      const perform = service.perform.bind(service);
      const admitted = Promise.withResolvers<void>();
      vi.spyOn(service, "perform").mockImplementation(async (value, ...rest) => {
        if (promoteOnCancel && (value as ResourceCheckoutActionRequest).kind === "cancel_request") now += 1_000;
        const result = await perform(value, ...rest);
        if (result.outcome === "queued") admitted.resolve();
        return result;
      });
      const pending = handle("resource_checkout_acquire", { ...acquireArgs, idempotencyKey: key },
        { ...caller, signal: controller.signal });
      await admitted.promise;
      const { writes } = await measureSqliteWrites(async () => {
        controller.abort(new Error("Caller stopped"));
        await expect(pending).rejects.toThrow("Caller stopped");
      });
      expect(await service.status(service.threadActor(caller.backend, caller.threadId), service.localMachineResourceId(), key))
        .toMatchObject({ state: "ended" });
      return writes;
    } finally {
      await close();
    }
  }

  it("clears an interrupted checkout across both cancellation/promotion orderings", async () => {
    await fc.assert(fc.asyncProperty(fc.boolean(), fc.uuid(), async (promoteOnCancel, key) => {
      await abortQueuedAcquire(promoteOnCancel, key);
    }), { numRuns: 8, examples: [[true, "race"], [false, "cancel"]] });
  });

  it("budgets cleanup when abort races promotion", async () => {
    const previousMetrics = process.env[SQLITE_WRITE_METRICS_ENV];
    process.env[SQLITE_WRITE_METRICS_ENV] = "1";
    try {
      expectSqliteWriteBudget({
        scenario: "resource-checkout-blocking-abort-race",
        note: "Interrupted acquire cleanup after enqueue. The cancel reconciles expiry and promotes the waiter, then cleanup releases the grant.",
        writes: await abortQueuedAcquire(true, "write budget"),
      });
    } finally {
      if (previousMetrics === undefined) delete process.env[SQLITE_WRITE_METRICS_ENV];
      else process.env[SQLITE_WRITE_METRICS_ENV] = previousMetrics;
    }
  });

  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ] as const)("cleans up a grant returned by status after abort or timeout [%#]", async (abort, queued) => {
    const { service, close } = openRealService();
    const handle = createResourceCheckoutToolHandler(service);
    const controller = new AbortController();
    const waiting = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const subscribed = Promise.withResolvers<void>();
    const subscribe = service.subscribe.bind(service);
    vi.spyOn(service, "subscribe").mockImplementation((listener) => {
      const unsubscribe = subscribe(listener);
      subscribed.resolve();
      return unsubscribe;
    });
    const first = queued
      ? await handle("resource_checkout_acquire", { ...acquireArgs, units: 8 }, holder) as { releaseAction: unknown }
      : undefined;
    const status = service.status.bind(service);
    vi.spyOn(service, "status").mockImplementation(async (...args) => {
      const result = await status(...args);
      if (result?.state === "granted") {
        waiting.resolve();
        await resume.promise;
      }
      return result;
    });
    vi.useFakeTimers({ toFake: ["performance"] });
    try {
      const pending = handle("resource_checkout_acquire", {
        ...acquireArgs, idempotencyKey: "late status", waitTimeoutMs: 100,
      }, { ...caller, signal: controller.signal });
      if (first) {
        await subscribed.promise;
        await handle("resource_checkout_action", { action: first.releaseAction }, holder);
      }
      await waiting.promise;
      if (abort) controller.abort(new Error("Caller stopped"));
      else vi.advanceTimersByTime(100);
      resume.resolve();
      if (abort) await expect(pending).rejects.toThrow("Caller stopped");
      else expect(await pending).toMatchObject({ outcome: "timed_out", cancelled: true });
      expect(service.read().resources[0].allocations).toHaveLength(0);
    } finally {
      vi.useRealTimers();
      await close();
    }
  });

  it("requires explicit units on counted resources and returns releaseAction for immediate try/finally release", async () => {
    const { service, close } = openRealService(8);
    try {
      const handler = createResourceCheckoutToolHandler(service);
      await expect(handler("resource_checkout_acquire", {
        purpose: "Focused tests",
        expectedDurationMs: 60_000,
      }, caller)).rejects.toThrow(/Specify units/i);

      const lease = await handler("resource_checkout_acquire", {
        purpose: "Focused tests",
        expectedDurationMs: 60_000,
        units: 4,
      }, caller) as { outcome: string; resourceId: string; idempotencyKey: string; releaseAction: Record<string, unknown> };
      expect(lease.outcome).toBe("granted");
      expect(lease.resourceId).toBe(service.localMachineResourceId());
      expect(service.read().resources[0].allocations).toHaveLength(1);

      const released = await handler("resource_checkout_action", { action: lease.releaseAction }, caller);
      expect(released).toMatchObject({ outcome: "accepted" });
      expect(service.read().resources[0].allocations).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it("blocks event-driven until a holder releases and wakes without sleeping 2s", async () => {
    const { service, close } = openRealService(8);
    try {
      const handler = createResourceCheckoutToolHandler(service);
      const first = await handler("resource_checkout_acquire", {
        purpose: "First hold",
        expectedDurationMs: 60_000,
        units: 6,
      }, holder) as { releaseAction: Record<string, unknown> };

      const startedAt = performance.now();
      const pending = handler("resource_checkout_acquire", {
        purpose: "Waiting script",
        expectedDurationMs: 60_000,
        units: 4,
        waitTimeoutMs: 5_000,
      }, caller);

      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(service.read().resources[0].queue).toHaveLength(1);
      await handler("resource_checkout_action", { action: first.releaseAction }, holder);

      const granted = await pending as { outcome: string; releaseAction: Record<string, unknown> };
      expect(granted.outcome).toBe("granted");
      expect(performance.now() - startedAt).toBeLessThan(1_000);
      await handler("resource_checkout_action", { action: granted.releaseAction }, caller);
      expect(service.read().resources[0].allocations).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it("automatically cancels its queued entry on timeout or abort so no phantom waiters remain", async () => {
    const previousMetrics = process.env[SQLITE_WRITE_METRICS_ENV];
    process.env[SQLITE_WRITE_METRICS_ENV] = "1";
    const { service, close } = openRealService(8);
    try {
      const handler = createResourceCheckoutToolHandler(service);
      const first = await handler("resource_checkout_acquire", {
        purpose: "Blocking hold",
        expectedDurationMs: 60_000,
        units: 8,
      }, holder) as { releaseAction: Record<string, unknown> };

      const { result: timedOut, writes } = await measureSqliteWrites(() => handler("resource_checkout_acquire", {
        purpose: "Short wait",
        expectedDurationMs: 60_000,
        units: 4,
        waitTimeoutMs: 40,
      }, caller));
      expect(timedOut).toMatchObject({ outcome: "timed_out", cancelled: true });
      expect(service.read().resources[0].queue).toHaveLength(0);
      expectSqliteWriteBudget({
        scenario: "resource-checkout-blocking-timeout",
        note: "One queued blocking acquire and automatic cancellation, excluding the existing holder.",
        writes,
      });

      const controller = new AbortController();
      const aborting = handler("resource_checkout_acquire", {
        purpose: "Aborting wait",
        expectedDurationMs: 60_000,
        units: 4,
        waitTimeoutMs: 5_000,
      }, { ...caller, signal: controller.signal });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(service.read().resources[0].queue).toHaveLength(1);
      controller.abort(new Error("User cancelled"));
      await expect(aborting).rejects.toThrow(/User cancelled/);
      expect(service.read().resources[0].queue).toHaveLength(0);

      await handler("resource_checkout_action", { action: first.releaseAction }, holder);
    } finally {
      await close();
      if (previousMetrics === undefined) delete process.env[SQLITE_WRITE_METRICS_ENV];
      else process.env[SQLITE_WRITE_METRICS_ENV] = previousMetrics;
    }
  });
});
