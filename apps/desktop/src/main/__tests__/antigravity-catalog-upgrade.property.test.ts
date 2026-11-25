import fc from "fast-check";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import type { BackendAcpRuntimeCapabilities } from "@pwragent/shared/contracts/backend";
import { recordWithSessionRuntimeCapabilities } from "../acp/acp-capability-freshness";
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
  const result = fc.record({ success: fc.boolean(), superseded: fc.boolean(), initializedFirst: fc.boolean() });
  await fc.assert(fc.asyncProperty(modelIds, modelIds, result, async (previousIds, updatedIds, { success, superseded, initializedFirst }) => {
    const previous = capabilities(previousIds);
    const updated = capabilities(updatedIds);
    let stored: AcpInstalledAgentRecord = {
      ...managedInstall("1.5.15"),
      runtimeCapabilities: previous,
      lastDiscoveredAt: 1,
    };
    const target = managedInstall(superseded ? "1.5.17" : "1.5.16");
    const finishProbe = Promise.withResolvers<void>();
    const emit = vi.fn(async () => {});
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
      emit,
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
        await adapter.refreshManagedAntigravityCatalog(target.launchDescriptor!.command);
      }
      if (initializedFirst) {
        stored = recordWithSessionRuntimeCapabilities(stored, {
          ...previous, source: "initialize", protocolVersion: 1,
        }, 3);
      }
      finishProbe.resolve();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(emit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        notification: expect.objectContaining({ method: "backend/acpRuntimeCapabilities/updated" }),
      }));
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

it.skipIf(process.platform !== "darwin")("probes through a managed PATH alias and leaves an explicit pin alone", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-aliased-catalog-"));
  try {
    const binary = path.join(root, "managed-agy");
    const alias = path.join(root, "path-agy");
    await writeFile(binary, "", { mode: 0o700 });
    await symlink(binary, alias);
    await fc.assert(fc.asyncProperty(fc.boolean(), async (automatic) => {
      const install = managedInstall("1.5.16");
      let stored: AcpInstalledAgentRecord = {
        ...install,
        launchDescriptor: { ...install.launchDescriptor!, command: alias, managedAntigravityFallback: automatic },
      };
      const probe = vi.fn(async (record: AcpInstalledAgentRecord) => ({ ...record, lastDiscoveredAt: 3 }));
      const adapter = new AcpBackendAdapter({
        acpAgentStore: {
          listInstalledAgents: () => [stored],
          getInstalledAgent: () => stored,
          upsertInstalledAgent: (record) => { stored = record; },
        },
        acpSessionStore: null,
        captureStores: [],
        discoverLocalAcpAgents: async () => [],
        probeAcpRuntimeCapabilities: probe,
        emit: async () => {},
        handleServerRequest: async () => ({}),
      });
      try {
        await adapter.refreshManagedAntigravityCatalog(binary);
        expect(probe).toHaveBeenCalledTimes(automatic ? 1 : 0);
      } finally {
        await adapter.close();
      }
    }), { numRuns: 12 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("discards an invalidated runtime selection before launch or publication", async () => {
  await fc.assert(fc.asyncProperty(fc.boolean(), async (changeBeforeLaunch) => {
    let selectedFingerprint = "selected-on-install";
    let stored: AcpInstalledAgentRecord = {
      ...managedInstall("1.5.16"), configDependencyFingerprint: selectedFingerprint,
    };
    const finishProbe = Promise.withResolvers<void>();
    const probe = vi.fn(async (record: AcpInstalledAgentRecord) => {
      await finishProbe.promise;
      return { ...record, runtimeCapabilities: capabilities([1]), lastDiscoveredAt: 3 };
    });
    const adapter = new AcpBackendAdapter({
      acpAgentStore: {
        listInstalledAgents: () => [stored],
        getInstalledAgent: () => stored,
        upsertInstalledAgent: (record) => { stored = record; },
      },
      acpSessionStore: null,
      captureStores: [],
      discoverLocalAcpAgents: async () => [],
      resolveProviderDependencyFingerprint: () => selectedFingerprint,
      probeAcpRuntimeCapabilities: probe,
      emit: async () => {},
      handleServerRequest: async () => ({}),
    });
    const changeSelection = () => {
      selectedFingerprint = "other-executable";
      adapter.invalidateRuntimeSelections(["antigravity"]);
    };
    try {
      if (changeBeforeLaunch) changeSelection();
      await adapter.refreshManagedAntigravityCatalog(stored.launchDescriptor!.command);
      if (!changeBeforeLaunch) changeSelection();
      finishProbe.resolve();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(probe).toHaveBeenCalledTimes(changeBeforeLaunch ? 0 : 1);
      expect(stored.lastDiscoveredAt).toBeUndefined();
    } finally {
      finishProbe.resolve();
      await adapter.close();
    }
  }));
});
