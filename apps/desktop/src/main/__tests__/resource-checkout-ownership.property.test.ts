import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { CheckoutDefinition, CheckoutStore } from "@pwragent/owner-core/resource-checkout-storage";
import type {
  ResourceOwnershipConflict,
  ResourceOwnershipResolution,
} from "@pwragent/shared/contracts/resource-checkouts";
import { openResourceCheckoutStore } from "@pwragent/sqlite-storage/resource-checkout-store";
import type { ExternalBinding } from "../resource-checkouts/checkout-configuration";
import { misboundAuthorityConflict, OWNERSHIP_CONFLICTS } from "../resource-checkouts/checkout-ownership";
import { DesktopResourceCheckoutService } from "../resource-checkouts/resource-checkout-service";
import { adoptMachineCheckoutStorage, openMachineCheckoutStorage } from "../storage/resource-checkout-storage";

/**
 * Rule: every route to `ownership_unresolved` carries its own reason and
 * remedy, and blocks every action except the one resolution the operator can
 * settle from Resources. Checkouts are cooperative, so:
 *
 * - a store copied from another machine is adopted, dropping the holds and
 *   waiters that came with it, because they never held this machine;
 * - a changed definition is accepted, keeping current holds and waiters;
 * - every other cause offers nothing to press and names the fix outside.
 *
 * Resolving makes the resource usable, and a retry with the same idempotency
 * key returns the same answer instead of applying twice.
 *
 * The model below is the oracle: from the configuration alone it names which
 * resources are unresolved, the explanation each carries, and what resolving
 * it leaves behind.
 */

const SELF = "pwr_ownership_self";
const PEER = "pwr_ownership_peer";
const MACHINE = "mach_00000000-0000-4000-8000-00000000000a";
const OTHER_MACHINE = "mach_00000000-0000-4000-8000-00000000000b";
const MACHINE_RESOURCE = `machine:${MACHINE}:cpu`;
const IDENTITY = "identity";
const VIEWER = { instanceId: SELF, instanceLabel: "Ownership host", profile: "default", machineId: MACHINE };
const NO_PEERS = async (): Promise<never> => {
  throw new Error("No peers.");
};

type BindingScenario = {
  owner: "self" | "peer";
  ownerMachine: "self" | "other";
  /** The saved record has another epoch than the configuration. */
  changed: boolean;
};

type MachineScenario =
  /** This machine's store, as it created it. */
  | "store"
  /** No store: the packaged app runs on an alternate root. */
  | "alternate_root"
  /** The saved pool has another epoch than this release's machine definition. */
  | "changed"
  /** The store was created by another machine and copied here. */
  | "copied";

type Scenario = {
  machine: MachineScenario;
  /** The pre-existing machine record holds a checkout. */
  machineHeld: boolean;
  externalStore: boolean;
  bindings: BindingScenario[];
};

const scenarioArb: fc.Arbitrary<Scenario> = fc.record({
  machine: fc.constantFrom("store", "alternate_root", "changed", "copied"),
  machineHeld: fc.boolean(),
  externalStore: fc.boolean(),
  bindings: fc.array(fc.record({
    owner: fc.constantFrom("self", "peer"),
    ownerMachine: fc.constantFrom("self", "other"),
    changed: fc.boolean(),
  }), { maxLength: 4 }),
});

function bindingFor(index: number, scenario: BindingScenario): ExternalBinding {
  const canonicalKey = `external:fixture:ownership:r${index}`;
  const owner = scenario.owner === "self" ? SELF : PEER;
  return {
    authorityInstanceId: owner,
    authorityMachineId: scenario.ownerMachine === "self" ? MACHINE : OTHER_MACHINE,
    definition: {
      resourceId: canonicalKey, canonicalKey, displayName: `Resource ${index}`, kindLabel: "Fixture",
      scope: "federation", counted: false, capacity: 1, authorityId: `checkout:${owner}:${canonicalKey}`,
      epoch: 1, maxHoldMs: 60_000, publication: "published", revision: 1, updatedAt: 1,
    },
  };
}

/** The oracle: `undefined` when the resource is not listed at all, `null` when it is bound. */
function expectedConflict(scenario: BindingScenario, externalStore: boolean): ResourceOwnershipConflict | null | undefined {
  const local = scenario.owner === "self" && scenario.ownerMachine === "self";
  if (scenario.owner === "peer") return undefined;
  if (!local) return misboundAuthorityConflict(OTHER_MACHINE);
  if (!externalStore) return OWNERSHIP_CONFLICTS.federationStoreUnavailable;
  return scenario.changed ? OWNERSHIP_CONFLICTS.definitionChanged : null;
}

function expectedMachineConflict(machine: MachineScenario): ResourceOwnershipConflict | null {
  switch (machine) {
    case "alternate_root":
      return OWNERSHIP_CONFLICTS.alternateRoot;
    case "changed":
      return OWNERSHIP_CONFLICTS.machineDefinitionChanged;
    case "copied":
      return OWNERSHIP_CONFLICTS.copiedRoot;
    default:
      return null;
  }
}

/** How many holds survive resolving: adopting drops copied ones, accepting keeps them. */
function expectedHoldsAfter(resolution: ResourceOwnershipResolution, heldBefore: number): number {
  return resolution === "adopt_store" ? 0 : heldBefore;
}

/** Save a record the configuration will conflict with, as a changed epoch does. */
function saveConflicting(store: CheckoutStore, definition: CheckoutDefinition): void {
  store.change((tx) => tx.save({ definition: { ...definition, epoch: 9 }, generation: 0, grants: [], queue: [] }));
}

/** Use the machine store as a profile would, optionally leaving a checkout held. */
async function seedMachineStore(root: string, identity: string, cpuCount: number, held: boolean): Promise<void> {
  const service = new DesktopResourceCheckoutService({
    viewer: VIEWER, machineCpuCount: cpuCount, machineStore: openMachineCheckoutStorage(root, identity),
    bindings: [], requestPeer: NO_PEERS, warn: () => {},
  });
  try {
    if (held) {
      await expect(service.perform({
        kind: "request", idempotencyKey: "seed", resourceId: MACHINE_RESOURCE, purpose: "Seeded hold", expectedDurationMs: 60_000,
      })).resolves.toMatchObject({ outcome: "granted" });
    }
  } finally {
    await service.close(0);
  }
}

async function run(scenario: Scenario): Promise<void> {
  const root = mkdtempSync(path.join(os.tmpdir(), "pwragent-checkout-ownership-"));
  const bindings = scenario.bindings.map((binding, index) => bindingFor(index, binding));
  const seeded = scenario.machine === "changed" || scenario.machine === "copied";
  if (seeded) {
    const identity = scenario.machine === "copied" ? "another-host" : IDENTITY;
    await seedMachineStore(root, identity, 2, scenario.machineHeld);
    if (scenario.machine === "changed") {
      const store = openMachineCheckoutStorage(root, identity);
      store.change((tx) => {
        const record = tx.read(MACHINE_RESOURCE)!;
        tx.save({ ...record, definition: { ...record.definition, epoch: 9 } });
      });
      store.close();
    }
  }
  const machineStore = scenario.machine === "alternate_root" || scenario.machine === "copied"
    ? undefined
    : openMachineCheckoutStorage(root, IDENTITY);
  const externalStore = scenario.externalStore
    ? openResourceCheckoutStore(path.join(root, "federation.db"), IDENTITY)
    : undefined;
  if (externalStore) {
    bindings.forEach((binding, index) => {
      if (scenario.bindings[index].changed) saveConflicting(externalStore, binding.definition);
    });
  }
  const service = new DesktopResourceCheckoutService({
    viewer: VIEWER,
    machineCpuCount: 4,
    machineStore,
    machineUnresolved: scenario.machine === "copied" ? OWNERSHIP_CONFLICTS.copiedRoot : OWNERSHIP_CONFLICTS.alternateRoot,
    adoptMachineStore: scenario.machine === "copied"
      ? () => adoptMachineCheckoutStorage(root, IDENTITY)
      : undefined,
    externalStore,
    bindings,
    requestPeer: NO_PEERS,
    warn: () => {},
  });
  try {
    const expected = new Map<string, ResourceOwnershipConflict | null>([
      [MACHINE_RESOURCE, expectedMachineConflict(scenario.machine)],
    ]);
    scenario.bindings.forEach((binding, index) => {
      const conflict = expectedConflict(binding, scenario.externalStore);
      if (conflict !== undefined) expected.set(bindings[index].definition.resourceId, conflict);
    });
    const { resources } = service.read();
    expect(new Set(resources.map((resource) => resource.resourceId))).toEqual(new Set(expected.keys()));
    for (const resource of resources) {
      const conflict = expected.get(resource.resourceId) ?? null;
      expect(resource.ownershipConflict).toEqual(conflict);
      expect(resource.condition === "ownership_unresolved").toBe(conflict !== null);
      if (conflict === null) continue;
      expect(resource.ownershipConflict?.reason.trim()).not.toBe("");
      expect(resource.ownershipConflict?.remedy.trim()).not.toBe("");
      const resolution = conflict.resolution?.kind;
      // The one thing to press, or nothing at all.
      expect(resource.actions).toEqual(resolution ? { resolve_ownership: { allowed: true } } : {});
      // The authority refuses what the screen does not offer.
      await expect(service.perform({
        kind: "request", idempotencyKey: `request-${resource.resourceId}`, resourceId: resource.resourceId,
        purpose: "Ownership probe", expectedDurationMs: 1_000,
      })).resolves.toMatchObject({ outcome: "rejected" });
      const other: ResourceOwnershipResolution = resolution === "adopt_store" ? "accept_definition" : "adopt_store";
      await expect(service.perform({
        kind: "resolve_ownership", idempotencyKey: `wrong-${resource.resourceId}`, resourceId: resource.resourceId, resolution: other,
      })).resolves.toMatchObject({ outcome: "rejected" });
      if (!resolution) {
        await expect(service.perform({
          kind: "resolve_ownership", idempotencyKey: `none-${resource.resourceId}`, resourceId: resource.resourceId, resolution: "accept_definition",
        })).resolves.toMatchObject({ outcome: "rejected" });
        continue;
      }
      const resolve = {
        kind: "resolve_ownership", idempotencyKey: `resolve-${resource.resourceId}`, resourceId: resource.resourceId, resolution,
      } as const;
      const first = await service.perform(resolve);
      expect(first).toMatchObject({ outcome: "accepted" });
      await expect(service.perform(resolve)).resolves.toEqual(first);

      const after = service.read().resources.find((candidate) => candidate.resourceId === resource.resourceId);
      expect(after?.ownershipConflict).toBeNull();
      expect(after?.condition).not.toBe("ownership_unresolved");
      const heldBefore = resource.resourceId === MACHINE_RESOURCE && scenario.machineHeld ? 1 : 0;
      expect(after?.allocations).toHaveLength(expectedHoldsAfter(resolution, heldBefore));
      if (resource.resourceId === MACHINE_RESOURCE && resolution === "accept_definition") {
        // The pool keeps the capacity its first profile set (2), not this
        // profile's CPU sample (4), so the kept holds still fit.
        expect(after?.sharing).toMatchObject({ mode: "counted", capacity: 2 });
      }
      expect(after?.actions.resolve_ownership).toBeUndefined();
      expect(after?.actions.request).toBeDefined();
      // Resolving twice under a new key finds nothing left to resolve.
      await expect(service.perform({ ...resolve, idempotencyKey: `again-${resource.resourceId}` }))
        .resolves.toMatchObject({ outcome: "rejected" });
    }
  } finally {
    await service.close(0);
    rmSync(root, { recursive: true, force: true });
  }
}

describe("unresolved checkout ownership", () => {
  it("explains each route to ownership unresolved and resolves only what Resources offers", async () => {
    await fc.assert(fc.asyncProperty(scenarioArb, run), { numRuns: 60 });
  });

  it("keeps checkouts made after another profile on the root adopted the store", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "pwragent-checkout-ownership-"));
    await seedMachineStore(root, "another-host", 2, true);
    const profile = () => new DesktopResourceCheckoutService({
      viewer: VIEWER, machineCpuCount: 2, machineUnresolved: OWNERSHIP_CONFLICTS.copiedRoot,
      adoptMachineStore: () => adoptMachineCheckoutStorage(root, IDENTITY),
      bindings: [], requestPeer: NO_PEERS, warn: () => {},
    });
    // Both profiles started before either adopted the copied store.
    const first = profile();
    const second = profile();
    const adopt = { kind: "resolve_ownership", resourceId: MACHINE_RESOURCE, resolution: "adopt_store" } as const;
    try {
      await expect(first.perform({ ...adopt, idempotencyKey: "first" })).resolves.toMatchObject({ outcome: "accepted" });
      expect(first.read().resources[0]?.allocations).toHaveLength(0);
      await expect(first.perform({
        kind: "request", idempotencyKey: "after", resourceId: MACHINE_RESOURCE, purpose: "Real work", expectedDurationMs: 60_000,
      })).resolves.toMatchObject({ outcome: "granted" });
      expect(second.read().resources[0]?.condition).toBe("ownership_unresolved");
      await expect(second.perform({ ...adopt, idempotencyKey: "second" })).resolves.toMatchObject({ outcome: "accepted" });
      expect(second.read().resources[0]?.allocations).toHaveLength(1);
      expect(first.read().resources[0]?.allocations).toHaveLength(1);
    } finally {
      await first.close(0);
      await second.close(0);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("lets only this instance's operator resolve ownership, never a peer", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "pwragent-checkout-ownership-"));
    const externalStore = openResourceCheckoutStore(path.join(root, "federation.db"), IDENTITY);
    const binding = bindingFor(0, { owner: "self", ownerMachine: "self", changed: true });
    saveConflicting(externalStore, binding.definition);
    const service = new DesktopResourceCheckoutService({
      viewer: VIEWER, externalStore, bindings: [binding], checkoutPeers: () => new Map([[PEER, "connected"]]), requestPeer: NO_PEERS, warn: () => {},
    });
    const id = binding.definition.resourceId;
    try {
      // A peer never reaches a resource this instance does not host.
      expect(() => service.receivePeer(PEER, {
        operation: "perform", resourceId: id, epoch: binding.definition.epoch,
        action: { kind: "resolve_ownership", idempotencyKey: "peer", resourceId: id, resolution: "accept_definition" },
      })).toThrow();
      expect(service.read().resources.find((resource) => resource.resourceId === id)?.condition).toBe("ownership_unresolved");
      await expect(service.perform({
        kind: "resolve_ownership", idempotencyKey: "operator", resourceId: id, resolution: "accept_definition",
      })).resolves.toMatchObject({ outcome: "accepted" });
      // Once hosted, the authority still refuses a peer's resolve.
      expect(service.receivePeer(PEER, {
        operation: "perform", resourceId: id, epoch: binding.definition.epoch,
        action: { kind: "resolve_ownership", idempotencyKey: "peer", resourceId: id, resolution: "accept_definition" },
      })).toMatchObject({ outcome: "rejected" });
    } finally {
      await service.close(0);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
