import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ResourceCheckoutAuthority, type CheckoutToken } from "@pwragent/owner-core/resource-checkout-authority";
import { executeResourceCheckout, recoverResourceCheckout, type CheckoutExecution } from "@pwragent/owner-core/resource-checkout-executor";
import type { CheckoutActor } from "@pwragent/owner-core/resource-checkout-storage";
import { openResourceCheckoutStore } from "@pwragent/sqlite-storage/resource-checkout-store";
import {
  createPwrSuiteLabCheckoutAdapter, PWR_SUITE_LAB_CHECKOUT_ADAPTER_ID, RETAINED_LAB_FINAL_STATE,
  type ApprovedLabCheckout, type PwrSuiteLabCheckoutControl,
} from "../resource-checkouts/pwrsuitelab-checkout-adapter";
import { DesktopResourceCheckoutService } from "../resource-checkouts/resource-checkout-service";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";

const resourceId = "external:fixture:lab:retained";
const requester: CheckoutActor = {
  key: "requester", holder: { kind: "thread", thread: { backend: "codex", threadId: "requester", title: "Requester" } }, manage: false,
};
const waiter: CheckoutActor = { key: "waiter", holder: { kind: "operator", label: "Waiter" }, manage: true };
const policy = {
  adapterId: PWR_SUITE_LAB_CHECKOUT_ADAPTER_ID, allowedActors: [requester.key],
  maxCostMinorUnits: 200, finalState: RETAINED_LAB_FINAL_STATE,
};

function evidence(execution: CheckoutExecution) {
  return {
    execution, commandsSealed: true, inFlightCommands: 0, ownedProcesses: 0, stopGuardsRetired: true,
    artifactsCollected: true, compute: "stopped" as const, retainedAssets: "verified" as const, receipt: "controller-proof",
  };
}

function checkouts() {
  const root = mkdtempSync(path.join(os.tmpdir(), "pwragent-lab-adapter-"));
  const file = path.join(root, "authority.db");
  const store = openResourceCheckoutStore(file, "fixture-authority");
  let now = 100;
  const authority = new ResourceCheckoutAuthority(store, () => now, () => crypto.randomUUID());
  authority.ensure({
    resourceId, canonicalKey: resourceId, displayName: "Fixture", kindLabel: "Invented retained lab",
    scope: "federation", counted: false, capacity: 1, authorityId: "fixture-authority", epoch: 7,
    maxHoldMs: 100_000, revision: 1, updatedAt: now, publication: "published",
  });
  const request = (actor: CheckoutActor, idempotencyKey: string) =>
    authority.perform(actor, { kind: "request", resourceId, idempotencyKey, purpose: idempotencyKey, expectedDurationMs: 2_000 });
  const initial = request(requester, "first");
  if (initial.outcome !== "granted") throw new Error("Missing fixture grant.");
  const token: CheckoutToken = { resourceId, epoch: 7, generation: initial.generation, allocationId: initial.allocationId };
  const config = (control: PwrSuiteLabCheckoutControl): ApprovedLabCheckout => ({
    resourceId, control, policy, approval: "fixture-approval", target: "fixture-target", workload: "fixture-workload",
    expiresAt: 3_000, maxDurationMs: 2_500,
  });
  return {
    authority, request, token, config, now: () => now, advance: (ms: number) => { now += ms; },
    close() { store.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

describe("PwrSuiteLab checkout adapter", () => {
  it("blocks FIFO reuse for expired in-flight work and requires exact proof of all cleanup effects", async () => {
    type Fault = (execution: CheckoutExecution) => Partial<Awaited<ReturnType<PwrSuiteLabCheckoutControl["drain"]>>>;
    const faults: Fault[] = [
      () => ({ commandsSealed: false }), () => ({ inFlightCommands: 1 }), () => ({ ownedProcesses: 1 }),
      () => ({ stopGuardsRetired: false }), () => ({ artifactsCollected: false }), () => ({ compute: "running" }),
      () => ({ retainedAssets: "changed" }), () => ({ receipt: "" }),
      (execution) => ({ execution: { ...execution, generation: execution.generation - 1 } }),
      (execution) => ({ execution: { ...execution, epoch: execution.epoch - 1 } }),
    ];
    await fc.assert(fc.asyncProperty(fc.shuffledSubarray(faults, { minLength: 1 }), async (brokenEvidence) => {
      const system = checkouts();
      let fault: Fault | undefined = brokenEvidence[0];
      const stopped = new AbortController();
      const running = Promise.withResolvers<void>();
      const remoteCompletion = Promise.withResolvers<void>();
      const effects: string[] = [];
      const control: PwrSuiteLabCheckoutControl = {
        async prepare({ execution }) {
          effects.push("prepare");
          return { execution, ready: true, independentGuardId: "guard", guardDeadlineAt: execution.deadlineAt };
        },
        async run() { effects.push("run"); running.resolve(); await remoteCompletion.promise; },
        async drain({ execution }) {
          effects.push("drain");
          return { ...evidence(execution), ...fault?.(execution) };
        },
      };
      const adapter = createPwrSuiteLabCheckoutAdapter(system.config(control), system.now);
      try {
        const options = {
          authority: system.authority, actor: requester, token: system.token, adapter, policy, jobId: "job",
          signal: stopped.signal,
        };
        await expect(executeResourceCheckout({ ...options, costMinorUnits: 201 })).resolves.toBe("rejected");
        expect(effects).toEqual([]);
        const run = executeResourceCheckout({ ...options, costMinorUnits: 200 });
        await running.promise;
        expect(system.request(waiter, "next")).toMatchObject({ outcome: "queued" });
        system.advance(2_001);
        stopped.abort();
        await expect(run).resolves.toBe("recovery_required");
        for (const nextFault of brokenEvidence) {
          fault = nextFault;
          await expect(recoverResourceCheckout(options)).resolves.toBe("recovery_required");
          expect(system.authority.records()[0]).toMatchObject({
            grants: [{ id: system.token.allocationId, state: "recovery_required" }], queue: [{ purpose: "next" }],
          });
        }

        remoteCompletion.resolve();
        fault = undefined;
        await expect(recoverResourceCheckout({
          ...options, adapter: createPwrSuiteLabCheckoutAdapter({ ...system.config(control), target: "different" }, system.now),
        })).resolves.toBe("rejected");
        await expect(recoverResourceCheckout(options)).resolves.toBe("released");
        expect(system.authority.records()[0]).toMatchObject({
          cleanupReceipt: "controller-proof", grants: [{ purpose: "next", generation: system.token.generation + 1 }], queue: [],
        });
        await expect(recoverResourceCheckout(options)).resolves.toBe("rejected");
        expect(effects.filter((effect) => effect === "run")).toEqual(["run"]);
      } finally {
        stopped.abort();
        remoteCompletion.resolve();
        system.close();
      }
    }), { numRuns: 25 });
  });

  it("uses the configured controller for the approved executor and keeps other reservations advisory", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "pwragent-lab-owner-"));
    const workerKey = JSON.stringify(["owner", "codex", "worker"]);
    const workload = Promise.withResolvers<void>();
    const effects: string[] = [];
    const config: ApprovedLabCheckout = {
      resourceId, target: "fictional-target", workload: "approved-fixture", approval: "approval",
      expiresAt: 5_000, maxDurationMs: 4_000,
      policy: { ...policy, allowedActors: [workerKey] },
      control: {
        async prepare({ execution }) {
          effects.push("prepare");
          return { execution, ready: true, independentGuardId: "guard", guardDeadlineAt: execution.deadlineAt };
        },
        async run() { effects.push("run"); await workload.promise; },
        async drain({ execution }) { effects.push("drain"); return evidence(execution); },
      },
    };
    const binding = {
      authorityInstanceId: "owner", authorityMachineId: "host", allowedInstances: ["enrolled"],
      definition: {
        resourceId, canonicalKey: resourceId, displayName: "Approved fixture", kindLabel: "Retained lab",
        scope: "federation" as const, counted: false, capacity: 1, authorityId: "owner", epoch: 7,
        maxHoldMs: 10_000, revision: 1, updatedAt: 1, publication: "published" as const,
      },
    };
    const service = new DesktopResourceCheckoutService({
      viewer: { instanceId: "owner", instanceLabel: "Owner", profile: "default", machineId: "host" },
      bindings: [binding], externalStore: openResourceCheckoutStore(path.join(root, "checkout.db"), "host"),
      approvedLabCheckouts: new Map([[resourceId, config]]), now: () => 100,
      requestPeer: async () => { throw new Error("No outbound effects"); }, warn: () => {},
    });
    const worker = service.threadActor("codex", "worker");
    try {
      const grant = await service.perform({
        kind: "request", resourceId, idempotencyKey: "request", purpose: "Verified fixture", expectedDurationMs: 2_000,
      }, worker);
      if (grant.outcome !== "granted") throw new Error("Expected fixture grant");
      const token = { resourceId, allocationId: grant.allocationId, generation: grant.generation, epoch: 7 };
      await expect(service.executeLabCheckout(service.threadActor("codex", "intruder"), token, 1)).resolves.toBe("rejected");
      await expect(service.executeLabCheckout(worker, token, 201)).resolves.toBe("rejected");
      await expect(service.executeLabCheckout(worker, { ...token, resourceId: "unapproved" }, 1)).resolves.toBe("rejected");
      expect(effects).toEqual([]);
      expect(service.read().resources.find((resource) => resource.resourceId === resourceId)).toMatchObject({
        enforcement: { coverage: "mixed" }, routes: [{ enforcement: "enforced" }],
      });
      await expect(service.executeLabCheckout(worker, token, 100)).resolves.toMatchObject({ outcome: "started" });
      await expect(service.executeLabCheckout(worker, token, 100)).resolves.toBe("rejected");
      workload.resolve();
      await expect.poll(() => service.status(worker, resourceId, "request")).toMatchObject({ state: "ended" });
      expect(effects).toEqual(["prepare", "run", "drain"]);
    } finally {
      workload.resolve();
      await service.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("records no writes while a recovery retry still lacks evidence", async () => {
    const saved = process.env[SQLITE_WRITE_METRICS_ENV];
    process.env[SQLITE_WRITE_METRICS_ENV] = "1";
    const system = checkouts();
    let verified = false;
    const adapter = createPwrSuiteLabCheckoutAdapter(system.config({
      async prepare({ execution }) {
        return { execution, ready: true, independentGuardId: "guard", guardDeadlineAt: execution.deadlineAt };
      },
      async run() {},
      async drain({ execution }) { return verified ? evidence(execution) : undefined; },
    }), system.now);
    const savedExecution = { authority: system.authority, actor: requester, token: system.token, adapter };
    try {
      expect(system.request(waiter, "after-recovery")).toMatchObject({ outcome: "queued" });
      await expect(executeResourceCheckout({
        ...savedExecution, policy, jobId: "job", costMinorUnits: 200, signal: new AbortController().signal,
      })).resolves.toBe("recovery_required");
      const retry = await measureSqliteWrites(async () => {
        for (let i = 0; i < 10; i++) await expect(recoverResourceCheckout(savedExecution)).resolves.toBe("recovery_required");
      });
      expectSqliteWriteBudget({
        scenario: "resource-checkout-provider-unchanged-recovery",
        note: "Ten explicit recovery retries with unverified provider effects produce zero commits.",
        writes: retry.writes,
      });
      verified = true;
      const cleanup = await measureSqliteWrites(() => recoverResourceCheckout(savedExecution));
      expect(cleanup.result).toBe("released");
      expect(system.authority.records()[0].grants[0]?.purpose).toBe("after-recovery");
      expectSqliteWriteBudget({
        scenario: "resource-checkout-provider-recovery-cleanup",
        note: "Verified provider recovery writes one boundary commit for proof, release, and FIFO promotion.",
        writes: cleanup.writes,
      });
    } finally {
      system.close();
      if (saved === undefined) delete process.env[SQLITE_WRITE_METRICS_ENV];
      else process.env[SQLITE_WRITE_METRICS_ENV] = saved;
    }
  });

  it("uses only four boundary commits for a successful approved execution", async () => {
    const saved = process.env[SQLITE_WRITE_METRICS_ENV];
    process.env[SQLITE_WRITE_METRICS_ENV] = "1";
    const system = checkouts();
    const adapter = createPwrSuiteLabCheckoutAdapter(system.config({
      async prepare({ execution }) {
        return { execution, ready: true, independentGuardId: "guard", guardDeadlineAt: execution.deadlineAt };
      },
      async run() {},
      async drain({ execution }) { return evidence(execution); },
    }), system.now);
    try {
      const { writes, result } = await measureSqliteWrites(() => executeResourceCheckout({
        authority: system.authority, actor: requester, token: system.token, adapter, policy, jobId: "job",
        costMinorUnits: 200, signal: new AbortController().signal,
      }));
      expect(result).toBe("released");
      expectSqliteWriteBudget({
        scenario: "resource-checkout-provider-lifecycle",
        note: "Approved provider job binding, activation, drain, and verified final state use four commits. 100 approved jobs a day cost about 1.65 MB of WAL.",
        writes,
      });
    } finally {
      system.close();
      if (saved === undefined) delete process.env[SQLITE_WRITE_METRICS_ENV];
      else process.env[SQLITE_WRITE_METRICS_ENV] = saved;
    }
  });
});
