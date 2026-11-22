/**
 * Resource checkout state for auditing the Resources screen.
 *
 * Every resource here enters through the product's own seams: the
 * `resource-checkout-authorities.json` an operator places at the PwrAgent root,
 * and the main process's `DesktopResourceCheckoutService` over the same
 * `resource-checkouts.db` and `federation-resource-checkouts.db` the launched
 * app opens. The test process runs its own service on those stores, exactly
 * as a second profile on the same root does (see resource-checkouts.spec.ts),
 * and writes only what agents and managed jobs write through it. Nothing is
 * mocked in the renderer, and the screen never sees preview fixtures.
 *
 * All names, keys and instance IDs are invented.
 */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ResourceCondition } from "@pwragent/shared/contracts/resource-checkouts";
import { readMachineCheckoutEvidence } from "../../src/main/resource-checkouts/checkout-machine-evidence";
import { readExternalCheckoutBindings } from "../../src/main/resource-checkouts/checkout-configuration";
import { DesktopResourceCheckoutService } from "../../src/main/resource-checkouts/resource-checkout-service";
import { StateDb } from "../../src/main/state/state-db";
import {
  openFederationCheckoutStorage,
  openMachineCheckoutStorage,
} from "../../src/main/storage/resource-checkout-storage";
import { stateDbPathForHomeRoot } from "./readme-state-seeding";

const AUDIT_INSTANCE_ID = "pwr_resources_audit_owner";
const AUDIT_PEER_INSTANCE_ID = "pwr_resources_audit_peer";

/** Counted, hosted by this instance, fully held by one agent with another waiting. */
export const RESOURCES_AUDIT_POOL = {
  resourceId: "external:fixture:audit:gpu-pool",
  displayName: "Render GPU pool",
};
/** Hosted by a Federation peer this instance cannot reach. */
export const RESOURCES_AUDIT_UNREACHABLE = {
  resourceId: "external:fixture:audit:retained-lab",
  displayName: "Retained lab machine",
};
/**
 * Bound to this instance on another machine, as a root copied from another
 * host would be, so the authority stays unresolved.
 */
export const RESOURCES_AUDIT_UNRESOLVED = {
  resourceId: "external:fixture:audit:bench-scope",
  displayName: "Bench oscilloscope",
};

export type ResourcesAuditSeed = {
  root: string;
  machineId: string;
  /** The launched app's machine resource, "This machine". */
  machineResourceId: string;
  /** Read once, so every seeding service opens the stores under one identity. */
  hostBinding: string;
  bootId: string | undefined;
};

function auditService(seed: ResourcesAuditSeed): DesktopResourceCheckoutService {
  // The identity the main process derives in `initializeResourceCheckouts`;
  // a mismatch would quarantine the store.
  const identity = JSON.stringify([seed.machineId, seed.hostBinding]);
  const opened: Array<{ close(): void }> = [];
  try {
    const machineStore = openMachineCheckoutStorage(seed.root, identity);
    opened.push(machineStore);
    const externalStore = openFederationCheckoutStorage(seed.root, identity);
    opened.push(externalStore);
    return new DesktopResourceCheckoutService({
      viewer: {
        instanceId: AUDIT_INSTANCE_ID, profile: "default", machineId: seed.machineId,
        instanceLabel: "Audit host",
      },
      machineStore,
      externalStore,
      bindings: readExternalCheckoutBindings(seed.root).bindings,
      bootId: seed.bootId,
      requestPeer: () => Promise.reject(new Error("The audit has no Federation peers.")),
      warn: (error) => {
        throw error;
      },
    });
  } catch (error) {
    // A leaked handle keeps the temp root busy on Windows.
    for (const store of opened) store.close();
    throw error;
  }
}

async function withAuditService(
  seed: ResourcesAuditSeed,
  apply: (service: DesktopResourceCheckoutService) => Promise<void>,
  expected: Record<string, ResourceCondition>,
): Promise<void> {
  const service = auditService(seed);
  try {
    await apply(service);
    // Check the seed through the same projection the renderer reads, so a
    // drifted seed fails here rather than auditing an emptier screen.
    const conditions = Object.fromEntries(
      service.read().resources.map((resource) => [resource.resourceId, resource.condition]),
    );
    for (const [resourceId, condition] of Object.entries(expected)) {
      if (conditions[resourceId] !== condition) {
        throw new Error(
          `Expected ${resourceId} to be ${condition}; the service reports ${conditions[resourceId] ?? "no such resource"}.`,
        );
      }
    }
  } finally {
    await service.close(0);
  }
}

/**
 * Before launch: the identities, the authorities file, and an agent holding
 * the pool with a second agent queued behind it.
 */
export async function seedResourcesAuditState(homeRoot: string): Promise<ResourcesAuditSeed> {
  const root = path.join(homeRoot, ".pwragent");
  await mkdir(root, { recursive: true });
  const machineId = `mach_${randomUUID()}`;
  const otherMachineId = `mach_${randomUUID()}`;
  await writeFile(path.join(root, "machine-id"), `${machineId}\n`);
  const stateDb = StateDb.open(stateDbPathForHomeRoot(homeRoot));
  try {
    stateDb.setMeta("federation_instance_id", AUDIT_INSTANCE_ID);
  } finally {
    stateDb.close();
  }
  const common = { epoch: 1, revision: 1, updatedAt: Date.now(), maxHoldMs: 2_700_000 };
  await writeFile(path.join(root, "resource-checkout-authorities.json"), JSON.stringify({
    version: 1,
    domains: [
      {
        ...common,
        canonicalKey: RESOURCES_AUDIT_POOL.resourceId, displayName: RESOURCES_AUDIT_POOL.displayName,
        kindLabel: "GPU slots", capacity: 4,
        authorityInstanceId: AUDIT_INSTANCE_ID, authorityMachineId: machineId, allowedInstances: [],
        instructions: "Render jobs only. Free slots before ending the turn.",
      },
      {
        ...common,
        canonicalKey: RESOURCES_AUDIT_UNREACHABLE.resourceId, displayName: RESOURCES_AUDIT_UNREACHABLE.displayName,
        kindLabel: "Test machine", capacity: 1,
        authorityInstanceId: AUDIT_PEER_INSTANCE_ID, authorityMachineId: otherMachineId,
        allowedInstances: [AUDIT_INSTANCE_ID],
      },
      {
        ...common,
        canonicalKey: RESOURCES_AUDIT_UNRESOLVED.resourceId, displayName: RESOURCES_AUDIT_UNRESOLVED.displayName,
        kindLabel: "Bench instrument", capacity: 1,
        authorityInstanceId: AUDIT_INSTANCE_ID, authorityMachineId: otherMachineId,
        allowedInstances: [AUDIT_INSTANCE_ID],
      },
    ],
  }));
  const evidence = await readMachineCheckoutEvidence();
  if (!evidence.hostBinding) {
    // Without it the app opens no Federation store and every hosted
    // resource would read as unresolved, which is not the state audited.
    throw new Error("This host reports no machine identity for checkout storage.");
  }
  const seed: ResourcesAuditSeed = {
    root, machineId, machineResourceId: `machine:${machineId}:cpu`,
    hostBinding: evidence.hostBinding, bootId: evidence.bootId,
  };
  await withAuditService(seed, async (service) => {
    const hold = await service.perform({
      kind: "request", idempotencyKey: "audit-pool-hold", resourceId: RESOURCES_AUDIT_POOL.resourceId,
      purpose: "Render the release walkthrough", expectedDurationMs: 1_800_000, units: 3,
    }, service.threadActor("codex", "thread-resources-audit-render"));
    const wait = await service.perform({
      kind: "request", idempotencyKey: "audit-pool-wait", resourceId: RESOURCES_AUDIT_POOL.resourceId,
      purpose: "Train the thumbnail model", expectedDurationMs: 2_400_000, units: 2,
    }, service.threadActor("codex", "thread-resources-audit-train"));
    if (hold.outcome !== "granted" || wait.outcome !== "queued") {
      throw new Error(`Expected one grant and one waiter on the pool: ${JSON.stringify([hold, wait])}`);
    }
  }, {
    [seed.machineResourceId]: "available",
    [RESOURCES_AUDIT_POOL.resourceId]: "busy",
    [RESOURCES_AUDIT_UNREACHABLE.resourceId]: "unreachable",
    [RESOURCES_AUDIT_UNRESOLVED.resourceId]: "ownership_unresolved",
  });
  return seed;
}

/**
 * After launch: a managed environment job on this machine whose cleanup was
 * never verified, as when an executor exits without proving its process group
 * ended. The machine must be free. The launched app sees it on its next poll.
 */
export async function seedResourcesAuditRecovery(seed: ResourcesAuditSeed): Promise<void> {
  await withAuditService(seed, async (service) => {
    const job = service.admitMachineJob(`audit-job-${randomUUID()}`, "Environment setup", {
      thread: { backend: "codex", threadId: "thread-smoke" },
    });
    // A recorded process group is what makes the operator's recovery
    // steps available. The audit never fences, so it is never signalled.
    job.active(424_242);
    job.finish(false);
  }, { [seed.machineResourceId]: "recovery_required" });
}
