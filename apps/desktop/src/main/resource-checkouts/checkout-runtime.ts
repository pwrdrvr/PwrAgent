import { readMachineCheckoutEvidence } from "./checkout-machine-evidence";
import type { ResourceAdvertisement } from "@pwragent/shared/contracts/resource-checkouts";
import { getMainLogger } from "../log";
import { readOrCreateFederationMachineId } from "../federation/federation-host-info";
import { defaultInstanceLabel } from "../federation/federation-instance-label";
import type { DesktopFederationRuntime } from "../federation/federation-runtime";
import { buildDockProfileSnapshot, findLiveProfileRuntimeMarkers, resolveActiveProfileName, resolvePwragentRoot } from "../profile";
import { openFederationCheckoutStorage, openMachineCheckoutStorage } from "../storage/resource-checkout-storage";
import { readExternalCheckoutBindings, type ExternalBinding } from "./checkout-configuration";
import { DesktopResourceCheckoutService } from "./resource-checkout-service";

let runtime: DesktopResourceCheckoutService | undefined;
let unsubscribe: (() => void) | undefined;

export async function initializeResourceCheckouts(federation: DesktopFederationRuntime): Promise<DesktopResourceCheckoutService> {
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
  let externalStore;
  try {
    const config = readExternalCheckoutBindings(root);
    bindings = config.bindings;
    allowAgentDrafts = config.allowAgentDrafts;
  } catch (error) {
    warn(error);
  }
  if (machineId && /^mach_[0-9a-f-]{36}$/i.test(machineId)) {
    const identity = JSON.stringify([machineId, evidence.hostBinding ?? null]);
    try { machineStore = openMachineCheckoutStorage(root, identity); }
    catch (error) { warn(error); }
    if (machineStore && evidence.hostBinding && bindings.some((binding) => binding.authorityInstanceId === instanceId && binding.authorityMachineId === machineId)) {
      try { externalStore = openFederationCheckoutStorage(root, identity); }
      catch (error) { warn(error); }
    }
  }
  runtime = new DesktopResourceCheckoutService({
    viewer: { instanceId, profile, machineId, instanceLabel: defaultInstanceLabel() },
    machineStore, externalStore, bindings, allowAgentDrafts, warn, bootId: evidence.hostBinding ? evidence.bootId : undefined,
    readMachineAdvertisements: () => buildDockProfileSnapshot().profiles
      .filter((entry) => entry.name !== profile)
      .flatMap((entry) => findLiveProfileRuntimeMarkers(entry.name).map((marker): ResourceAdvertisement => ({
        instanceId: marker.instanceId, instanceLabel: entry.displayName ?? entry.name, profile: entry.name,
        isViewer: false, observedAt: marker.heartbeatAt, freshness: "fresh",
        note: "Live profile on this PwrAgent root",
      }))),
    requestPeer: (id, request) => federation.requestResourceCheckout(id, request),
  });
  federation.setResourceCheckoutHandler((source, request) => runtime?.receivePeer(source, request));
  unsubscribe = federation.onPeerStatusChanged(() => { void runtime?.refreshPeers(); });
  void runtime.refreshPeers();
  return runtime;
}

export function getResourceCheckoutService(): DesktopResourceCheckoutService | undefined {
  return runtime;
}

export function disposeResourceCheckouts(): void {
  unsubscribe?.();
  unsubscribe = undefined;
  runtime?.close();
  runtime = undefined;
}
