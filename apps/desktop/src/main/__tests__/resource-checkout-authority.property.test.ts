import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ResourceCheckoutAuthority, type CheckoutToken } from "@pwragent/owner-core/resource-checkout-authority";
import { executeResourceCheckout, type CheckoutProviderAdapter } from "@pwragent/owner-core/resource-checkout-executor";
import type { CheckoutActor, CheckoutDefinition, CheckoutGrant } from "@pwragent/owner-core/resource-checkout-storage";
import type { ResourceCheckoutActionRequest } from "@pwragent/shared/contracts/resource-checkouts";
import { openResourceCheckoutStore } from "@pwragent/sqlite-storage/resource-checkout-store";
import { createResourceCheckoutToolHandler } from "../agent-tools/pwragent-resource-checkout-agent-tools";
import { checkoutRootCanHostMachine } from "../resource-checkouts/checkout-runtime";
import { projectCheckoutDomain } from "../resource-checkouts/checkout-projection";
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
    }), { numRuns: 16 });
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
    }), { numRuns: 20 });
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
    }), { numRuns: 30 });
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
    }), { numRuns: 20 });
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
      const worker = client.threadActor("acp:registry.worker", "worker");
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
    }), { numRuns: 25 });
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
