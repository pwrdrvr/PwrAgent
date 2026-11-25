import fc from "fast-check";
import { expect, it } from "vitest";
import type { BackendAcpRuntimeCapabilities } from "@pwragent/shared/contracts/backend";
import type { AcpInstalledAgentRecord } from "../acp/acp-registry-types";
import { AcpBackendAdapter } from "../app-server/acp-backend-adapter";
import { issueProviderDiscoveryPermit } from "../settings/provider-discovery-permit";

const backendId = "acp:antigravity";

function managedInstall(version: string): AcpInstalledAgentRecord {
  return {
    backendId,
    registryId: "antigravity",
    name: "Antigravity",
    version,
    distributionKind: "local",
    distributionSource: "agy acp",
    installStatus: "installed",
    authStatus: "not-required",
    verificationStatus: "not-applicable",
    allowlistRuleId: "local-antigravity-cli",
    installedAt: 1,
    updatedAt: 2,
    launchDescriptor: {
      backendId,
      registryId: "antigravity",
      distributionKind: "local",
      command: `/fixture/versions/${version}/agy`,
      args: ["acp", "--process-per-session"],
      env: { AGY_CLI_DISABLE_AUTO_UPDATE: "true" },
      managedAntigravityFallback: true,
    },
  };
}

function capabilities(ids: number[]): BackendAcpRuntimeCapabilities {
  const names = ids.map((id) => `model-${id}`);
  return {
    schemaVersion: 1,
    status: "discovered",
    agentCapabilities: { loadSession: true },
    models: { currentModelId: names[0], availableModels: names.map((id) => ({ id, label: id })) },
  };
}

it("serves the last reported Antigravity catalog until the active replacement reports its own", async () => {
  const modelIds = fc.uniqueArray(fc.nat(), { minLength: 1, maxLength: 12 });
  const result = fc.record({ success: fc.boolean(), superseded: fc.boolean() });
  await fc.assert(fc.asyncProperty(modelIds, modelIds, result, async (previousIds, updatedIds, { success, superseded }) => {
    const previous = capabilities(previousIds);
    const updated = capabilities(updatedIds);
    let stored: AcpInstalledAgentRecord = {
      ...managedInstall("1.5.15"),
      runtimeCapabilities: previous,
      lastDiscoveredAt: 1,
    };
    const target = managedInstall(superseded ? "1.5.17" : "1.5.16");
    const finishProbe = Promise.withResolvers<void>();
    const published = Promise.withResolvers<void>();
    const supersededModels = capabilities([-1]);
    const adapter = new AcpBackendAdapter({
      acpAgentStore: {
        listInstalledAgents: () => [stored],
        getInstalledAgent: () => stored,
        upsertInstalledAgent: (record) => { stored = record; },
      },
      acpSessionStore: null,
      captureStores: [],
      discoverLocalAcpAgents: async () => [managedInstall("1.5.16")],
      probeAcpRuntimeCapabilities: async (record) => {
        await finishProbe.promise;
        if (record.version !== target.version) {
          return { ...record, runtimeCapabilities: supersededModels, lastDiscoveredAt: 3 };
        }
        return success
          ? { ...record, runtimeCapabilities: updated, lastDiscoveredAt: 3 }
          : { ...record, lastDiscoveryError: "transient failure" };
      },
      emit: async (event) => {
        if (event.notification.method === "backend/acpRuntimeCapabilities/updated") published.resolve();
      },
      handleServerRequest: async () => ({}),
    });
    try {
      await adapter.discoverAvailableAgents(issueProviderDiscoveryPermit("startup"));
      expect(adapter.getLaunchpadOptions(backendId)?.models?.map((model) => model.id))
        .toEqual(previous.models?.availableModels.map((model) => model.id));
      expect(stored.lastDiscoveredAt).toBeUndefined();
      expect(stored.runtimeCapabilities?.agentCapabilities).toBeUndefined();

      if (superseded) {
        stored = { ...target, runtimeCapabilities: stored.runtimeCapabilities };
        adapter.refreshManagedAntigravityCatalog(target.launchDescriptor!.command);
      }
      finishProbe.resolve();
      await published.promise;
      const availableModels = (success ? updated : previous).models?.availableModels;
      expect(stored.version).toBe(target.version);
      expect(adapter.getLaunchpadOptions(backendId)?.models?.map((model) => model.id))
        .toEqual(availableModels?.map((model) => model.id));
    } finally {
      finishProbe.resolve();
      await adapter.close();
    }
  }));
});
