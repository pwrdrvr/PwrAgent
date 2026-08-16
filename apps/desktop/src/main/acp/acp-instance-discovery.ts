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
  BUILT_IN_ACP_STRATEGIES,
  discoverLocalAcpAgentInstances,
  strategyById,
  type AcpAgentStrategy,
  type DiscoveredAcpAgentGroup,
  type LocalAcpDiscoveryOptions,
} from "@pwrdrvr/agent-acp";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import type {
  AcpAgentInstance,
  AcpAgentPreference,
  AcpBackendId,
} from "@pwragent/shared";
import { resolveActiveAcpInstance } from "./acp-instance-resolver.js";
import { acpAgentCapabilitiesForRegistryId } from "./acp-agent-capabilities.js";
import { resolveBundledGrokCommand } from "./acp-bundled-agent.js";
import {
  ensureManagedGrokRuntime,
  type ManagedGrokCheckMode,
} from "./grok-managed-runtime.js";
import { normalizeAcpLaunchDescriptor } from "./acp-launch-descriptor.js";
import { buildPwrAgentChildProcessEnv } from "../child-process-env.js";
import type {
  AcpInstalledAgentRecord,
  AcpRegistryAgent,
} from "./acp-registry-types.js";

const execFile = promisify(execFileCallback);
const ACP_IDENTITY_PROBE_TIMEOUT_MS = 2_000;

// Qwen Code 0.21 still supports `--acp`, but no longer advertises that hidden
// flag in `qwen --help`. The upstream strategy's `--acp` text match therefore
// rejects the current CLI and can make discovery fall through to an older
// installation. Match the stable product identity instead; the version probe
// and successful help invocation still guard against unrelated `qwen`
// executables.
const ACP_DISCOVERY_STRATEGIES = BUILT_IN_ACP_STRATEGIES.map((strategy) =>
  strategy.id === "qwen"
    ? {
        ...strategy,
        discoveryProbe: {
          ...strategy.discoveryProbe,
          helpMatches: /Qwen Code/i,
        },
      }
    : strategy,
);

export type AcpInstanceDiscovery = {
  /** Every installed instance, in candidate order (override → PATH → fallback). */
  instances: AcpAgentInstance[];
  /** Detected command collisions that are intentionally excluded. */
  incompatibleInstances?: AcpAgentInstance[];
  /** The instance command currently in effect (override → picked → first). */
  activeCommand?: string;
};

export type DiscoverAcpAgentInstancesOptions = {
  /** Per-agent (registryId) path preferences (override + picked). */
  preferences?: Record<string, AcpAgentPreference>;
  /** Registry ids to discover. Undefined means all built-in strategies. */
  enabledRegistryIds?: readonly string[];
  /** Env used for PATH enumeration + (default probe) spawns. */
  env?: NodeJS.ProcessEnv;
  /** Injectable clock (tests). */
  now?: () => number;
  /** Injectable discovery fn (tests). Defaults to the kit's. */
  discover?: (
    options?: LocalAcpDiscoveryOptions,
  ) => Promise<DiscoveredAcpAgentGroup[]>;
  /** Injectable raw version-output probe used for synthesized bundled instances
   *  and to distinguish products that share one command name (currently legacy
   *  Python kimi-cli vs Kimi Code). */
  readVersionOutput?: (
    command: string,
    env: NodeJS.ProcessEnv,
  ) => Promise<string | undefined>;
  /**
   * Packaged PwrAgent Grok executable. `undefined` auto-detects it under
   * Electron resources; `null` disables it (primarily for tests).
   */
  bundledGrokCommand?: string | null;
  /**
   * Downloaded, checksummed PwrAgent Grok runtime. Callers opt in only when
   * Grok itself and the managed-build preference are both enabled.
   */
  managedGrok?: {
    checkMode?: ManagedGrokCheckMode;
    enabled: boolean;
    requirePlatformSignature?: boolean;
  };
  /** Injectable managed-runtime resolver (tests). */
  resolveManagedGrokCommand?: (
    checkMode: ManagedGrokCheckMode,
    requirePlatformSignature: boolean,
  ) => Promise<string | undefined>;
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
  const strategies = strategiesForEnabledRegistryIds(options?.enabledRegistryIds);

  const overrides: Record<string, string> = {};
  for (const [registryId, pref] of Object.entries(preferences)) {
    const override = pref.overridePath?.trim();
    if (override) {
      overrides[registryId] = override;
    }
  }

  const discover = options?.discover ?? discoverLocalAcpAgentInstances;
  const [discoveredGroups, managedGrokCommand] = await Promise.all([
    discover({
      ...(strategies !== undefined ? { strategies } : {}),
      ...(Object.keys(overrides).length > 0 ? { overrides } : {}),
      ...(options?.env ? { env: options.env } : {}),
      ...(options?.now ? { now: options.now } : {}),
    }),
    resolveManagedGrokCommand(options, strategies),
  ]);
  const groups = await withPwrAgentGrok(
    discoveredGroups,
    strategies,
    managedGrokCommand,
    options?.bundledGrokCommand === undefined
      ? resolveBundledGrokCommand()
      : options.bundledGrokCommand,
    options?.now?.() ?? Date.now(),
    options,
  );

  const byRegistryId = new Map<string, AcpInstanceDiscovery>();
  for (const group of groups) {
    const classified = await classifyGroupInstances(group, options);
    if (
      classified.instances.length === 0
      && classified.incompatibleInstances.length === 0
    ) {
      continue;
    }
    const active = resolveActiveAcpInstance(
      classified.instances,
      preferences[group.strategyId],
    );
    byRegistryId.set(group.strategyId, {
      instances: classified.instances,
      ...(classified.incompatibleInstances.length > 0
        ? { incompatibleInstances: classified.incompatibleInstances }
        : {}),
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
  const strategies = strategiesForEnabledRegistryIds(options?.enabledRegistryIds);

  const overrides: Record<string, string> = {};
  for (const [registryId, pref] of Object.entries(preferences)) {
    const override = pref.overridePath?.trim();
    if (override) {
      overrides[registryId] = override;
    }
  }

  const discover = options?.discover ?? discoverLocalAcpAgentInstances;
  const [discoveredGroups, managedGrokCommand] = await Promise.all([
    discover({
      ...(strategies !== undefined ? { strategies } : {}),
      ...(Object.keys(overrides).length > 0 ? { overrides } : {}),
      ...(options?.env ? { env: options.env } : {}),
      ...(options?.now ? { now: options.now } : {}),
    }),
    resolveManagedGrokCommand(options, strategies),
  ]);
  const now = options?.now?.() ?? Date.now();
  const bundledGrokCommand =
    options?.bundledGrokCommand === undefined
      ? resolveBundledGrokCommand()
      : options.bundledGrokCommand;
  const groups = await withPwrAgentGrok(
    discoveredGroups,
    strategies,
    managedGrokCommand,
    bundledGrokCommand,
    now,
    options,
  );

  const records: AcpInstalledAgentRecord[] = [];
  for (const group of groups) {
    const classified = await classifyGroupInstances(group, options);
    if (
      classified.instances.length === 0
      && classified.incompatibleInstances.length === 0
    ) {
      continue;
    }
    const active = resolveActiveAcpInstance(
      classified.instances,
      preferences[group.strategyId],
    );
    if (active === undefined) {
      if (
        group.strategyId === "kimi"
        && classified.incompatibleInstances.length > 0
      ) {
        records.push(
          legacyKimiUnavailableRecord({
            group,
            incompatibleInstances: classified.incompatibleInstances,
            now,
          }),
        );
      }
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
      env: {
        ...group.env,
        ...(group.strategyId === "grok"
          && (
            active.command === managedGrokCommand
            || active.command === bundledGrokCommand
          )
          ? { GROK_INSTALLER: "pwragent" }
          : {}),
      },
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
      instances: classified.instances,
      ...(classified.incompatibleInstances.length > 0
        ? { incompatibleInstances: classified.incompatibleInstances }
        : {}),
      activeCommand: active.command,
    });
  }
  return records;
}

async function classifyGroupInstances(
  group: DiscoveredAcpAgentGroup,
  options: DiscoverAcpAgentInstancesOptions | undefined,
): Promise<{
  instances: AcpAgentInstance[];
  incompatibleInstances: AcpAgentInstance[];
}> {
  const mapped = group.instances.map((instance) => ({
    command: instance.command,
    ...(instance.version !== undefined ? { version: instance.version } : {}),
    source: instance.source,
  }));
  if (group.strategyId !== "kimi") {
    return { instances: mapped, incompatibleInstances: [] };
  }

  const env = buildPwrAgentChildProcessEnv(options?.env ?? process.env);
  const readVersionOutput = options?.readVersionOutput ?? defaultReadVersionOutput;
  const classifications = await Promise.all(
    mapped.map(async (instance) => {
      let output: string | undefined;
      try {
        output = await readVersionOutput(instance.command, env);
      } catch {
        // The discovery kit already proved the command runnable. If this
        // identity-only second probe races an install change, retain the parsed
        // version fallback below instead of dropping a possibly valid agent.
      }
      return {
        instance,
        legacy: isLegacyPythonKimiCli({ output, version: instance.version }),
      };
    }),
  );
  return {
    instances: classifications
      .filter((entry) => !entry.legacy)
      .map((entry) => entry.instance),
    incompatibleInstances: classifications
      .filter((entry) => entry.legacy)
      .map((entry) => entry.instance),
  };
}

export function isLegacyPythonKimiCli(params: {
  output?: string;
  version?: string;
}): boolean {
  const output = params.output?.trim() ?? "";
  if (/^kimi-code(?:\.exe)?\s+v?\d/i.test(output)) {
    return false;
  }
  if (
    /python version\s*:/i.test(output)
    || /^kimi(?:-cli)?(?:\s+version\s*:|,\s*version)\s*v?\d/i.test(output)
  ) {
    return true;
  }

  // The current TypeScript Kimi Code line is 0.x; the deprecated Python
  // kimi-cli line is 1.x. This fallback covers wrappers that suppress the
  // product prefix while preserving the parsed discovery version.
  const major = Number.parseInt(params.version?.split(".")[0] ?? "", 10);
  return Number.isFinite(major) && major >= 1;
}

async function defaultReadVersionOutput(
  command: string,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const result = await execFile(command, ["--version"], {
    env,
    timeout: ACP_IDENTITY_PROBE_TIMEOUT_MS,
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
  return output || undefined;
}

function legacyKimiUnavailableRecord(params: {
  group: DiscoveredAcpAgentGroup;
  incompatibleInstances: AcpAgentInstance[];
  now: number;
}): AcpInstalledAgentRecord {
  const active = params.incompatibleInstances[0];
  const strategy = strategyById(params.group.strategyId);
  const versionLabel = active?.version ? ` v${active.version}` : "";
  const commandLabel = active?.command ? ` at ${active.command}` : "";
  const registryAgent: AcpRegistryAgent = {
    id: params.group.strategyId,
    backendId: params.group.backendId as AcpBackendId,
    name: params.group.name,
    ...(active?.version !== undefined ? { version: active.version } : {}),
    authors: strategy?.authors ?? [],
    ...(strategy?.license !== undefined ? { license: strategy.license } : {}),
    ...(strategy?.repositoryUrl !== undefined
      ? { repositoryUrl: strategy.repositoryUrl }
      : {}),
    distributions: [],
    distributionKinds: ["local"],
    auth: { required: false, methods: ["agent-managed"] },
    raw: { source: "legacy-local-cli" },
  };
  return {
    backendId: params.group.backendId as AcpBackendId,
    registryId: params.group.strategyId,
    name: params.group.name,
    ...(active?.version !== undefined ? { version: active.version } : {}),
    distributionKind: "local",
    distributionSource: `${active?.command ?? "kimi"} (legacy kimi-cli ignored)`,
    installStatus: "unavailable",
    authStatus: "not-required",
    verificationStatus: "not-applicable",
    allowlistRuleId: "local-kimi-cli",
    installedAt: params.now,
    updatedAt: params.now,
    lastError: `Legacy Python kimi-cli${versionLabel} was found${commandLabel} and was ignored. PwrAgent requires the current Kimi Code CLI. Install Kimi Code, then refresh discovery.`,
    capabilities: acpAgentCapabilitiesForRegistryId(params.group.strategyId),
    registryAgent,
    instances: [],
    incompatibleInstances: params.incompatibleInstances,
  };
}

function strategiesForEnabledRegistryIds(
  enabledRegistryIds: readonly string[] | undefined,
): readonly AcpAgentStrategy[] | undefined {
  if (enabledRegistryIds === undefined) {
    return ACP_DISCOVERY_STRATEGIES;
  }
  const enabled = new Set(enabledRegistryIds);
  return ACP_DISCOVERY_STRATEGIES.filter((strategy) => enabled.has(strategy.id));
}

async function resolveManagedGrokCommand(
  options: DiscoverAcpAgentInstancesOptions | undefined,
  enabledStrategies: readonly AcpAgentStrategy[] | undefined,
): Promise<string | undefined> {
  if (
    options?.managedGrok?.enabled !== true
    || !(enabledStrategies ?? ACP_DISCOVERY_STRATEGIES).some(
      (strategy) => strategy.id === "grok",
    )
  ) {
    return undefined;
  }
  const checkMode = options.managedGrok.checkMode ?? "ttl";
  if (options.resolveManagedGrokCommand) {
    return await options.resolveManagedGrokCommand(
      checkMode,
      options.managedGrok.requirePlatformSignature === true,
    );
  }
  return (await ensureManagedGrokRuntime({
    checkMode,
    requirePlatformSignature:
      options.managedGrok.requirePlatformSignature === true,
  }))?.command;
}

async function withPwrAgentGrok(
  discoveredGroups: readonly DiscoveredAcpAgentGroup[],
  enabledStrategies: readonly AcpAgentStrategy[] | undefined,
  managedGrokCommand: string | undefined,
  bundledGrokCommand: string | null | undefined,
  discoveredAt: number,
  options: DiscoverAcpAgentInstancesOptions | undefined,
): Promise<DiscoveredAcpAgentGroup[]> {
  const groups = discoveredGroups.map((group) => ({
    ...group,
    instances: [...group.instances],
  }));
  if (!managedGrokCommand && !bundledGrokCommand) {
    return groups;
  }

  const grokStrategy = (enabledStrategies ?? BUILT_IN_ACP_STRATEGIES).find(
    (strategy) => strategy.id === "grok",
  );
  if (!grokStrategy) {
    return groups;
  }

  const grokGroup = groups.find((group) => group.strategyId === "grok");
  const managedInstance = managedGrokCommand
    && !grokGroup?.instances.some(
      (instance) => instance.command === managedGrokCommand,
    )
      ? await probePwrAgentGrokInstance(managedGrokCommand, options)
      : undefined;
  const bundledInstance = bundledGrokCommand
    && bundledGrokCommand !== managedGrokCommand
    && !grokGroup?.instances.some(
      (instance) => instance.command === bundledGrokCommand,
    )
      ? await probePwrAgentGrokInstance(bundledGrokCommand, options)
      : undefined;
  if (grokGroup) {
    if (managedInstance) {
      const firstNonOverride = grokGroup.instances.findIndex(
        (instance) => instance.source !== "override",
      );
      grokGroup.instances.splice(
        firstNonOverride === -1 ? grokGroup.instances.length : firstNonOverride,
        0,
        managedInstance,
      );
    }
    if (bundledInstance) {
      grokGroup.instances.push(bundledInstance);
    }
    return groups;
  }

  groups.push({
    strategyId: grokStrategy.id,
    backendId: grokStrategy.backendId,
    name: grokStrategy.displayName,
    args: [...grokStrategy.spawn.args],
    env: { ...grokStrategy.spawn.env },
    instances: [managedInstance, bundledInstance].filter(
      (instance): instance is AcpAgentInstance => instance !== undefined,
    ),
    discoveredAt,
  });
  return groups;
}

async function probePwrAgentGrokInstance(
  command: string,
  options: DiscoverAcpAgentInstancesOptions | undefined,
): Promise<AcpAgentInstance> {
  const env = buildPwrAgentChildProcessEnv(options?.env ?? process.env);
  const readVersionOutput = options?.readVersionOutput ?? defaultReadVersionOutput;
  let version: string | undefined;
  try {
    version = parseCliVersion(await readVersionOutput(command, env));
  } catch {
    // The bundle path is a trusted packaged fallback. If an install/update race
    // makes the version probe fail, retain the instance so launch can surface
    // the concrete error instead of silently hiding Grok from discovery.
  }
  return {
    command,
    source: "fallback",
    ...(version !== undefined ? { version } : {}),
  };
}

function parseCliVersion(output: string | undefined): string | undefined {
  const trimmed = output?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.match(/\d+\.\d+\.\d+(?:[-+][\w.-]+)?/)?.[0] ?? trimmed;
}
