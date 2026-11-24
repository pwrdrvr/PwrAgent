import { realpath } from "node:fs/promises";
import { cpus } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { readMachineCheckoutEvidence } from "./checkout-machine-evidence";
import type { ResourceAdvertisement, ResourceOwnershipConflict, ResourceThreadRef } from "@pwragent/shared/contracts/resource-checkouts";
import { getMainLogger } from "../log";
import { readOrCreateFederationMachineId } from "../federation/federation-host-info";
import { defaultInstanceLabel } from "../federation/federation-instance-label";
import type { DesktopFederationRuntime } from "../federation/federation-runtime";
import { buildDockProfileSnapshot, findLiveProfileRuntimeMarkers, resolveActiveProfileName, resolvePwragentRoot } from "../profile";
import {
  adoptMachineCheckoutStorage,
  CheckoutStoreIdentityError,
  openFederationCheckoutStorage,
  openMachineCheckoutStorage,
} from "../storage/resource-checkout-storage";
import { readExternalCheckoutBindings, type ExternalBinding } from "./checkout-configuration";
import { OWNERSHIP_CONFLICTS } from "./checkout-ownership";
import type { ApprovedLabCheckout } from "./pwrsuitelab-checkout-adapter";
import { DesktopResourceCheckoutService } from "./resource-checkout-service";

let runtime: DesktopResourceCheckoutService | undefined;
let unsubscribe: (() => void) | undefined;

async function openCheckoutStorage<T>(open: () => T): Promise<T> {
  // The first WAL transition can return SQLITE_BUSY without waiting for
  // SQLite's transaction busy handler. Both profiles retry this same file.
  for (const backoffMs of [10, 25, 50, 100, 200]) {
    try {
      return open();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!code || !/^SQLITE_(BUSY|LOCKED)(_|$)/.test(code)) throw error;
      await delay(backoffMs);
    }
  }
  return open();
}

export async function checkoutRootCanHostMachine(root: string, primaryRoot: string, isPackaged: boolean): Promise<boolean> {
  if (!isPackaged || root === primaryRoot) return true;
  const [actual, primary] = await Promise.all([root, primaryRoot].map((directory) => realpath(directory).catch(() => undefined)));
  return actual !== undefined && actual === primary;
}

export async function initializeResourceCheckouts(
  federation: DesktopFederationRuntime,
  approvedLabCheckouts?: ReadonlyMap<string, ApprovedLabCheckout>,
  isPackaged = true,
  localThreadTitle?: (thread: Pick<ResourceThreadRef, "backend" | "threadId">) => string | undefined,
): Promise<DesktopResourceCheckoutService> {
  const root = resolvePwragentRoot();
  const [machineId, evidence] = await Promise.all([
    readOrCreateFederationMachineId({ rootDir: root }), readMachineCheckoutEvidence(),
  ]);
  const profile = resolveActiveProfileName();
  const instanceId = federation.resourceCheckoutInstanceId();
  const warn = (error: unknown) => {
    getMainLogger("pwragent:resource-checkouts").warn("Checkout authority unavailable", { error: String(error) });
  };
  let bindings: ExternalBinding[] = [];
  let allowAgentDrafts = false;
  let machineStore;
  let machineUnresolved: ResourceOwnershipConflict = OWNERSHIP_CONFLICTS.machineIdMissing;
  let adoptMachineStore: (() => ReturnType<typeof adoptMachineCheckoutStorage>) | undefined;
  let externalStore;
  let externalUnresolved: ResourceOwnershipConflict | undefined;
  try {
    const config = readExternalCheckoutBindings(root);
    bindings = config.bindings;
    allowAgentDrafts = config.allowAgentDrafts;
  } catch (error) {
    warn(error);
  }
  if (machineId && /^mach_[0-9a-f-]{36}$/i.test(machineId)) {
    const identity = JSON.stringify([machineId, evidence.hostBinding ?? null]);
    machineUnresolved = OWNERSHIP_CONFLICTS.alternateRoot;
    if (await checkoutRootCanHostMachine(root, resolvePwragentRoot({ env: {} }), isPackaged)) {
      try { machineStore = await openCheckoutStorage(() => openMachineCheckoutStorage(root, identity)); }
      catch (error) {
        warn(error);
        if (error instanceof CheckoutStoreIdentityError) {
          machineUnresolved = OWNERSHIP_CONFLICTS.copiedRoot;
          adoptMachineStore = () => adoptMachineCheckoutStorage(root, identity);
        } else {
          machineUnresolved = OWNERSHIP_CONFLICTS.machineStoreUnavailable;
        }
      }
    }
    if (evidence.hostBinding && bindings.some((binding) => binding.authorityInstanceId === instanceId && binding.authorityMachineId === machineId)) {
      try { externalStore = await openCheckoutStorage(() => openFederationCheckoutStorage(root, identity)); }
      catch (error) {
        warn(error);
        if (error instanceof CheckoutStoreIdentityError) externalUnresolved = OWNERSHIP_CONFLICTS.federationCopiedRoot;
      }
    }
  }
  runtime = new DesktopResourceCheckoutService({
    viewer: { instanceId, profile, machineId, instanceLabel: defaultInstanceLabel() },
    machineStore, machineUnresolved, adoptMachineStore, machineCpuCount: cpus().length, externalStore, externalUnresolved,
    bindings, allowAgentDrafts, approvedLabCheckouts, warn,
    bootId: evidence.hostBinding ? evidence.bootId : undefined,
    readMachineAdvertisements: () => buildDockProfileSnapshot().profiles
      .filter((entry) => entry.name !== profile)
      .flatMap((entry) => findLiveProfileRuntimeMarkers(entry.name).map((marker): ResourceAdvertisement => ({
        instanceId: marker.instanceId, instanceLabel: entry.displayName ?? entry.name, profile: entry.name,
        isViewer: false, onViewerMachine: Boolean(machineId), observedAt: marker.heartbeatAt, freshness: "fresh",
        note: "Live profile on this PwrAgent root",
      }))),
    requestPeer: (id, request) => federation.requestResourceCheckout(id, request),
    threadTitle: (thread) => thread.instanceId === undefined || thread.instanceId === instanceId
      ? localThreadTitle?.(thread)
      : federation.remoteThreadSummaries().cachedThreadNameFromPeer({
        target: { scope: "remote", instanceId: thread.instanceId }, backend: thread.backend, threadId: thread.threadId,
      })?.title,
  });
  federation.setResourceCheckoutHandler((source, request) => runtime?.receivePeer(source, request));
  unsubscribe = federation.onPeerStatusChanged(() => { void runtime?.refreshPeers(); });
  void runtime.refreshPeers();
  return runtime;
}

export function getResourceCheckoutService(): DesktopResourceCheckoutService | undefined {
  return runtime;
}

export async function disposeResourceCheckouts(graceMs?: number): Promise<void> {
  unsubscribe?.();
  unsubscribe = undefined;
  // Keep the closing authority installed until the owner exits. Late launch
  // requests must still go through admission while other services drain.
  await runtime?.close(graceMs);
}
