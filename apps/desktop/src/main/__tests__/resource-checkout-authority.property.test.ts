import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ResourceCheckoutAuthority, type CheckoutToken } from "@pwragent/owner-core/resource-checkout-authority";
import { executeResourceCheckout, type CheckoutProviderAdapter } from "@pwragent/owner-core/resource-checkout-executor";
import type { CheckoutActor, CheckoutDefinition } from "@pwragent/owner-core/resource-checkout-storage";
import type { ResourceCheckoutActionRequest } from "@pwragent/shared/contracts/resource-checkouts";
import { openResourceCheckoutStore } from "@pwragent/sqlite-storage/resource-checkout-store";
import { DesktopResourceCheckoutService } from "../resource-checkouts/resource-checkout-service";
import type { ExternalBinding } from "../resource-checkouts/checkout-configuration";
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
  it("agrees with a FIFO capacity model across profile writers, replays, expiry and reopen", () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 4 }), fc.array(fc.record({
      command: fc.constantFrom("request", "release", "expire", "reopen", "cancel", "replay"),
      units: fc.integer({ min: -1, max: 4 }), writer: fc.boolean(),
    }), { minLength: 3, maxLength: 45 }), (capacity, commands) => {
      const harness = createHarness(capacity);
      try {
        let first = harness.open();
        const second = harness.open();
        type Item = { purpose: string; units: number; actor: CheckoutActor };
        let held: Item[] = [];
        const queue: Item[] = [];
        const requests: Array<{ key: string; who: CheckoutActor; units: number; receipt: unknown }> = [];
        let generation = 0;
        const wake = () => {
          let free = capacity - held.reduce((sum, item) => sum + item.units, 0);
          while (queue.length && queue[0].units <= free) {
            const next = queue.shift()!;
            free -= next.units;
            held.push(next);
            generation++;
          }
        };
        for (const [index, step] of commands.entries()) {
          const who = step.writer ? actor : other;
          const writer = (step.writer ? first : second).authority;
          const current = writer.records()[0];
          const key = String(index);
          if (step.command === "request") {
            const result = writer.perform(who, request(key, { units: step.units }));
            if (step.units > 0 && step.units <= capacity) {
              queue.push({ purpose: key, units: step.units, actor: who });
              wake();
              expect(result.outcome).toBe(held.some((item) => item.purpose === key) ? "granted" : "queued");
              requests.push({ key, who, units: step.units, receipt: result });
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
            harness.advance(1_001);
            held = [];
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
            expect(writer.perform(prior.who, request(prior.key, { units: prior.units }))).toEqual(prior.receipt);
          }
          const durable = first.authority.records()[0];
          expect(durable.grants.map(({ purpose, units }) => ({ purpose, units }))).toEqual(held.map(({ purpose, units }) => ({ purpose, units })));
          expect(durable.queue.map(({ purpose, units }) => ({ purpose, units }))).toEqual(queue.map(({ purpose, units }) => ({ purpose, units })));
          expect(durable.generation).toBe(generation);
          expect(second.authority.records()).toEqual([durable]);
        }
      } finally {
        harness.close();
      }
    }), { numRuns: 60 });
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
      const running = local.admitEnvironmentAction("job", "Managed action", "worker");
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
        expect(() => service.admitEnvironmentAction("automatic", "Launchpad action")).toThrow(/capacity is reserved/);
        await expect(service.perform(change("release", {
          resourceId, allocationId: hold.allocationId, generation: hold.generation, epoch: 1,
        }, randomUUID()))).resolves.toMatchObject({ outcome: "accepted" });
      }), { numRuns: 10 });
    } finally {
      service.close();
      harness.close();
    }
  });

  it("retains external ownership on partitions, replays a lost receipt, and blocks stale or foreign requests", async () => {
    const harness = createHarness();
    let authority: DesktopResourceCheckoutService | undefined;
    let client: DesktopResourceCheckoutService | undefined;
    try {
      const binding: ExternalBinding = {
        authorityInstanceId: "owner", authorityMachineId: "host", allowedInstances: ["viewer"],
        definition,
      };
      let offline = false;
      let loseResponse = false;
      authority = new DesktopResourceCheckoutService({
        viewer: { instanceId: "owner", instanceLabel: "Owner", profile: "default", machineId: "host" },
        bindings: [binding], warn: () => {},
        externalStore: openResourceCheckoutStore(path.join(harness.root, "external.db"), "host"),
        requestPeer: async () => { throw new Error("Unexpected outbound call"); },
      });
      client = new DesktopResourceCheckoutService({
        viewer: { instanceId: "viewer", instanceLabel: "Viewer", profile: "dev", machineId: "client" },
        bindings: [binding], warn: () => {},
        machineStore: openResourceCheckoutStore(path.join(harness.root, "client.db"), "client"),
        requestPeer: async <T>(_instanceId: string, input: unknown): Promise<T> => {
          if (offline) throw new Error("Partitioned");
          const response = authority!.receivePeer("viewer", input);
          if (loseResponse) throw new Error("Response lost");
          return response as T;
        },
      });
      await client.refreshPeers();
      const initialRevision = client.read().revision;
      const worker = client.threadActor("codex", "worker");
      const rival = client.threadActor("codex", "rival");
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
    } finally {
      harness.close();
      if (old === undefined) delete process.env[SQLITE_WRITE_METRICS_ENV];
      else process.env[SQLITE_WRITE_METRICS_ENV] = old;
    }
  });
});
