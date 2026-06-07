// Multi-install ACP discovery adapter (Wave 2 / agent-acp).
//
// Wraps the kit's `discoverLocalAcpAgentInstances` (which finds EVERY installed
// executable of each agent — all PATH matches + well-known fallback bin dirs +
// a passing override — generalizing the per-agent path/probe hacks the in-tree
// `acp-local-discovery.ts` used to special-case, including the kimi
// `~/.kimi-code/bin` + exit-code fixes). Produces a per-registryId view of the
// instances plus the one currently in effect, honoring the user's preference
// via the shared instance resolver.

import {
  discoverLocalAcpAgentInstances,
  strategyById,
  type DiscoveredAcpAgentGroup,
  type LocalAcpDiscoveryOptions,
} from "@pwrdrvr/agent-acp";
import type {
  AcpAgentInstance,
  AcpAgentPreference,
  AcpBackendId,
} from "@pwragent/shared";
import { resolveActiveAcpInstance } from "./acp-instance-resolver.js";
import { acpAgentCapabilitiesForRegistryId } from "./acp-agent-capabilities.js";
import { normalizeAcpLaunchDescriptor } from "./acp-launch-descriptor.js";
import type {
  AcpInstalledAgentRecord,
  AcpRegistryAgent,
} from "./acp-registry-types.js";

export type AcpInstanceDiscovery = {
  /** Every installed instance, in candidate order (override → PATH → fallback). */
  instances: AcpAgentInstance[];
  /** The instance command currently in effect (override → picked → first). */
  activeCommand?: string;
};

export type DiscoverAcpAgentInstancesOptions = {
  /** Per-agent (registryId) path preferences (override + picked). */
  preferences?: Record<string, AcpAgentPreference>;
  /** Env used for PATH enumeration + (default probe) spawns. */
  env?: NodeJS.ProcessEnv;
  /** Injectable clock (tests). */
  now?: () => number;
  /** Injectable discovery fn (tests). Defaults to the kit's. */
  discover?: (
    options?: LocalAcpDiscoveryOptions,
  ) => Promise<DiscoveredAcpAgentGroup[]>;
};

/**
 * Discover every installed instance of each ACP agent, keyed by registryId
 * (`gemini` / `grok` / `kimi` / `qwen`). Groups with no passing instance are
 * omitted (the agent isn't installed). The user's `overridePath` is passed to
 * the kit as a per-strategy override so a manual path is probed first and
 * tagged `source: "override"`.
 */
export async function discoverAcpAgentInstances(
  options?: DiscoverAcpAgentInstancesOptions,
): Promise<Map<string, AcpInstanceDiscovery>> {
  const preferences = options?.preferences ?? {};

  const overrides: Record<string, string> = {};
  for (const [registryId, pref] of Object.entries(preferences)) {
    const override = pref.overridePath?.trim();
    if (override) {
      overrides[registryId] = override;
    }
  }

  const discover = options?.discover ?? discoverLocalAcpAgentInstances;
  const groups = await discover({
    ...(Object.keys(overrides).length > 0 ? { overrides } : {}),
    ...(options?.env ? { env: options.env } : {}),
    ...(options?.now ? { now: options.now } : {}),
  });

  const byRegistryId = new Map<string, AcpInstanceDiscovery>();
  for (const group of groups) {
    const instances: AcpAgentInstance[] = group.instances.map((instance) => ({
      command: instance.command,
      ...(instance.version !== undefined ? { version: instance.version } : {}),
      source: instance.source,
    }));
    if (instances.length === 0) {
      continue;
    }
    const active = resolveActiveAcpInstance(
      instances,
      preferences[group.strategyId],
    );
    byRegistryId.set(group.strategyId, {
      instances,
      ...(active !== undefined ? { activeCommand: active.command } : {}),
    });
  }
  return byRegistryId;
}

/**
 * Drop-in replacement for the in-tree `discoverLocalAcpAgents`: produces the
 * same `AcpInstalledAgentRecord[]` the settings/store/registry/capability-probe
 * pipeline already consumes, but sourced from the kit's multi-install discovery
 * and carrying the new `instances`/`activeCommand`. `launchDescriptor.command`
 * is the resolved active instance (override → picked → first), so the existing
 * chat-launch path spawns the binary the user sees as "Using".
 */
export async function discoverLocalAcpAgentRecords(
  options?: DiscoverAcpAgentInstancesOptions,
): Promise<AcpInstalledAgentRecord[]> {
  const preferences = options?.preferences ?? {};

  const overrides: Record<string, string> = {};
  for (const [registryId, pref] of Object.entries(preferences)) {
    const override = pref.overridePath?.trim();
    if (override) {
      overrides[registryId] = override;
    }
  }

  const discover = options?.discover ?? discoverLocalAcpAgentInstances;
  const groups = await discover({
    ...(Object.keys(overrides).length > 0 ? { overrides } : {}),
    ...(options?.env ? { env: options.env } : {}),
    ...(options?.now ? { now: options.now } : {}),
  });
  const now = options?.now?.() ?? Date.now();

  const records: AcpInstalledAgentRecord[] = [];
  for (const group of groups) {
    const instances: AcpAgentInstance[] = group.instances.map((instance) => ({
      command: instance.command,
      ...(instance.version !== undefined ? { version: instance.version } : {}),
      source: instance.source,
    }));
    if (instances.length === 0) {
      continue;
    }
    const active = resolveActiveAcpInstance(
      instances,
      preferences[group.strategyId],
    );
    if (active === undefined) {
      continue;
    }
    const backendId = group.backendId as AcpBackendId;
    const strategy = strategyById(group.strategyId);
    const launchDescriptor = normalizeAcpLaunchDescriptor({
      backendId,
      registryId: group.strategyId,
      distributionKind: "local",
      command: active.command,
      args: group.args,
      env: group.env,
    });
    const registryAgent: AcpRegistryAgent = {
      id: group.strategyId,
      backendId,
      name: group.name,
      ...(active.version !== undefined ? { version: active.version } : {}),
      authors: strategy?.authors ?? [],
      ...(strategy?.license !== undefined ? { license: strategy.license } : {}),
      ...(strategy?.repositoryUrl !== undefined
        ? { repositoryUrl: strategy.repositoryUrl }
        : {}),
      distributions: [],
      distributionKinds: ["local"],
      auth: { required: false, methods: ["agent-managed"] },
      raw: { source: "local-cli" },
    };
    records.push({
      backendId,
      registryId: group.strategyId,
      name: group.name,
      ...(active.version !== undefined ? { version: active.version } : {}),
      distributionKind: "local",
      distributionSource: `${active.command} ${group.args.join(" ")}`.trim(),
      installStatus: "installed",
      authStatus: "not-required",
      verificationStatus: "not-applicable",
      allowlistRuleId: `local-${group.strategyId}-cli`,
      installedAt: now,
      updatedAt: now,
      capabilities: acpAgentCapabilitiesForRegistryId(group.strategyId),
      launchDescriptor,
      registryAgent,
      instances,
      activeCommand: active.command,
    });
  }
  return records;
}
