import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type {
  AcpAgentPreference,
  AcpAgentSettingsEntry,
  AcpManagedBuildStatus,
  AcknowledgeAcpAgentUpdateRequest,
  AcknowledgeAcpAgentUpdateResponse,
  CheckDesktopCodexAuthProfileStatusRequest,
  CheckDesktopCodexAuthProfileStatusResponse,
  ClearDesktopSettingsSecretRequest,
  CompleteOnboardingCodexBootstrapRequest,
  CompleteOnboardingCodexBootstrapResponse,
  CreateDesktopCodexAuthProfileRequest,
  CreateDesktopCodexAuthProfileResponse,
  DesktopMessagingContactLookupRequest,
  DesktopMessagingContactLookupResponse,
  DesktopMessagingSettingsProjection,
  DesktopSettingsConfigPatch,
  DesktopSettingsSecretName,
  DesktopSettingsSecretWriteResponse,
  DesktopSettingsWriteResponse,
  DesktopSettingsSnapshot,
  InspectDiscordThreadPermissionsRequest,
  InspectDiscordThreadPermissionsResponse,
  ListDiscordThreadPermissionChannelsRequest,
  ListDiscordThreadPermissionChannelsResponse,
  InstallAcpAgentRequest,
  InstallAcpAgentResponse,
  ListAcpAgentSettingsRequest,
  ListAcpAgentSettingsResponse,
  ReadDesktopSettingsRequest,
  ReadDesktopSettingsResponse,
  ReadDesktopConfigBootstrapResponse,
  ReadDesktopFullAccessPolicyResponse,
  ReadDesktopMessagingSettingsResponse,
  InspectCodeSignaturesRequest,
  InspectCodeSignaturesResponse,
  PickGhCommandResponse,
  PickGitCommandResponse,
  RefreshDesktopCodexDiscoveryRequest,
  ReplaceDesktopSettingsSecretRequest,
  SettingsCredentialTestKind,
  SettingsCredentialTestRequest,
  SettingsCredentialTestResult,
  OpenDiscordThreadPermissionRequest,
  OpenDiscordThreadPermissionResponse,
  SlackCreateAppRequest,
  SlackCreateAppResponse,
  StartDesktopCodexAuthProfileLoginRequest,
  StartDesktopCodexAuthProfileLoginResponse,
  WriteDesktopSettingsConfigRequest,
} from "@pwragent/shared";
import {
  isAcpBackendId,
  isMessagingRuntimeSecret,
  sanitizeMessagingContactHandle,
  sanitizeMessagingContactLabel,
} from "@pwragent/shared";
import {
  ONBOARDING_COMPLETE_CODEX_BOOTSTRAP_CHANNEL,
  ACP_AGENTS_LIST_CHANNEL,
  ACP_AGENT_INSTALL_CHANNEL,
  ACP_AGENT_UPDATE_ACKNOWLEDGE_CHANNEL,
  SETTINGS_CHECK_CODEX_AUTH_PROFILE_STATUS_CHANNEL,
  SETTINGS_CLEAR_SECRET_CHANNEL,
  SETTINGS_CREATE_CODEX_AUTH_PROFILE_CHANNEL,
  SETTINGS_LAST_CREDENTIAL_TEST_CHANNEL,
  SETTINGS_INSPECT_DISCORD_THREAD_PERMISSIONS_CHANNEL,
  SETTINGS_LIST_DISCORD_THREAD_PERMISSION_CHANNELS_CHANNEL,
  SETTINGS_OPEN_DISCORD_THREAD_PERMISSION_CHANNEL,
  SETTINGS_OPEN_SLACK_CREATE_APP_CHANNEL,
  SETTINGS_INSPECT_CODE_SIGNATURES_CHANNEL,
  SETTINGS_PICK_GH_COMMAND_CHANNEL,
  SETTINGS_PICK_GIT_COMMAND_CHANNEL,
  SETTINGS_REFRESH_GIT_DISCOVERY_CHANNEL,
  SETTINGS_READ_CHANNEL,
  SETTINGS_READ_BOOTSTRAP_CHANNEL,
  SETTINGS_READ_FULL_ACCESS_POLICY_CHANNEL,
  SETTINGS_READ_MESSAGING_CHANNEL,
  SETTINGS_REFRESH_CODEX_DISCOVERY_CHANNEL,
  SETTINGS_REPLACE_SECRET_CHANNEL,
  SETTINGS_RESOLVE_MESSAGING_CONTACT_CHANNEL,
  SETTINGS_START_CODEX_AUTH_PROFILE_LOGIN_CHANNEL,
  SETTINGS_TEST_CREDENTIALS_CHANNEL,
  SETTINGS_WRITE_CONFIG_CHANNEL,
} from "../../shared/ipc";
import type { DesktopSettingsService } from "../settings/desktop-settings-service";
import {
  getDesktopConfigStore,
  getDesktopSettingsService,
} from "../settings/desktop-settings-singleton";
import {
  acpProviderCommandOverrideFromSnapshot,
  acpProviderEnabledFromSnapshot,
  managedGrokBuildChannelFromSnapshot,
  managedGrokBuildsEnabledFromSnapshot,
  providerProjectionForRegistryId,
} from "../settings/config-store/provider-runtime-config";
import type { ConfigDomainMap } from "../settings/config-store/config-domains";
import {
  getDesktopBackendRegistry,
} from "../app-server/backend-registry";
import {
  assertProviderDiscoveryPermit,
  issueProviderDiscoveryPermit,
  type ProviderDiscoveryPermit,
} from "../settings/provider-discovery-permit";
import { CredentialTester } from "../credential-tester/credential-tester";
import { getDesktopMessagingRuntime } from "../messaging/messaging-runtime";
import { loadDesktopMessagingConfigFromSettings } from "../messaging/messaging-config";
import { resolveRuntimeMessagingOverride } from "../runtime-flags";
import { getRuntimeMessagingLeaseCoordinator } from "../runtime-messaging-lease";
import { validateGhCommand } from "../settings/gh-discovery";
import { validateGitCommand } from "../settings/git-discovery";
import { CodeSignatureInspector } from "../settings/code-signature";
import {
  CodexLoginManager,
  collectCodexStatus,
  createCodexAuthProfile,
  readCodexAuthInfo,
  resolveCodexHomeForProfile,
  resolveDefaultCodexHome,
} from "@pwrdrvr/codex-discovery";
import { isSafeExternalOpenUrl } from "../external-url-policy";
import { getMainLogger } from "../log";
import { timeStartupProfileOperation } from "../diagnostics/startup-profile-events";
import { BUILT_IN_ACP_STRATEGIES } from "@pwrdrvr/agent-acp";
import { AcpAgentStore } from "../acp/acp-agent-store";
import { isBannedAcpRegistryId } from "../acp/acp-agent-allowlist";
import { discoverLocalAcpAgentRecords } from "../acp/acp-instance-discovery";
import { discoverAcpRuntimeCapabilities } from "../acp/acp-runtime-discovery";
import {
  CLAUDE_ACP_BACKEND_ID,
  CLAUDE_ACP_NAME,
  CLAUDE_ACP_PACKAGE_NAME,
  CLAUDE_ACP_REGISTRY_ID,
  CLAUDE_ACP_REPOSITORY_URL,
  CLAUDE_ACP_VERSION,
  claudeAcpManagedRuntimeSummary,
  claudeAcpPlaceholderSettingsEntry,
  discoverManagedClaudeAcpRuntime,
  failedClaudeAcpInstallRecord,
  installManagedClaudeAcpRuntime,
  isClaudeAcpAuthenticationError,
  unavailableManagedClaudeAcpRuntime,
} from "../acp/claude-acp-runtime";
import { shouldReprobeAcpCapabilities } from "../acp/acp-capability-freshness";
import { describeDistributionSource } from "../acp/acp-install-provenance";
import { isPwrAgentOwnedGrokRuntime } from "../acp/grok-cli-update";
import {
  MANAGED_GROK_REPOSITORY,
  readManagedGrokInstallSummary,
} from "../acp/grok-managed-runtime";
import {
  isPwrAgentSuppliedGrokCommand,
  managedGrokTagForCommand,
} from "../acp/grok-build-channel";
import { selectAcpDistributionForCurrentPlatform } from "../acp/acp-platform-distribution";
import { AcpRegistryService } from "../acp/acp-registry-service";
import type {
  AcpInstalledAgentRecord,
  AcpRegistryAgent,
  AcpRegistryAgentWithPolicy,
  AcpRegistryDistribution,
  AcpRegistrySnapshot,
} from "../acp/acp-registry-types";
import { getAppStateDb, getAppStateMode } from "../state/app-state";
import { resolveWindowsCodexLaunchCommand } from "../codex-windows-launch";
import {
  normalizeProfileName,
  resolveActiveProfileDir,
  resolveBootstrapProfileDir,
} from "../profile";

const settingsIpcLog = getMainLogger("pwragent:settings");
const ACP_UPDATE_SNOOZE_MS = 24 * 60 * 60_000;
const SLACK_APP_MANAGEMENT_URL = "https://api.slack.com/apps";
const SUPPORTED_ACP_AGENT_CATALOG = [
  ...BUILT_IN_ACP_STRATEGIES,
  {
    id: CLAUDE_ACP_REGISTRY_ID,
    backendId: CLAUDE_ACP_BACKEND_ID,
    displayName: CLAUDE_ACP_NAME,
    authors: ["Agent Client Protocol contributors"],
    license: "Apache-2.0",
    repositoryUrl: CLAUDE_ACP_REPOSITORY_URL,
  },
] as const;
// Codex profile login now runs through @pwrdrvr/codex-discovery's
// CodexLoginManager (extracted from this file's inline flow). PwrAgnt owns the
// instance so the Electron seam — `shell.openExternal` — is injected and the
// in-flight login children are killed on dispose (mirrors the old
// `activeCodexLoginProcesses` map).
const codexLoginManager = new CodexLoginManager({
  openExternal: (url: string) => shell.openExternal(url),
  logger: getMainLogger("pwragent:codex-login"),
});

function getService(service?: DesktopSettingsService): DesktopSettingsService {
  return service ?? getDesktopSettingsService();
}

function invalidateAcpRefreshCacheAfterWrite(
  patch: WriteDesktopSettingsConfigRequest["patch"],
): void {
  if (
    patch.acpAgents !== undefined
    || patch.experimental?.claudeAcp !== undefined
  ) {
    recentAcpRefreshes.clear();
  }
  // A config write only invalidates normalized provider state. It is never
  // authority to launch discovery or rebuild a provider harness; the Settings
  // or setup action that initiated the write requests a permitted probe
  // explicitly when it needs verification.
}

// Coalesces concurrent ACP refreshes. A refresh runs cheap local discovery and
// may launch agents to probe capabilities; users can double-click an explicit
// refresh or trigger overlapping setup and Settings actions, so without this
// two passes would launch the same agents in parallel. Pure cache reads
// (refresh === false) never launch and are not coalesced.
//
// We track provider scope so narrower requests can ride an in-flight superset.
// Force bypasses old durable capability freshness; it never justifies launching
// a second copy of an agent that main is already probing. When a broader
// request arrives second, it waits for overlapping providers and refreshes only
// the remainder. A matching late arrival also reuses a result for five seconds.
type InFlightAcpRefresh = {
  probeCapabilities: boolean;
  registryIds: ReadonlySet<string>;
  promise: Promise<ListAcpAgentSettingsResponse>;
};

const LOCAL_ACP_REGISTRY_IDS = ["gemini", "grok", "kimi", "qwen"] as const;
const inFlightAcpRefreshes = new Set<InFlightAcpRefresh>();
const recentAcpRefreshes = new Set<
  InFlightAcpRefresh & {
    completedAt: number;
    response: ListAcpAgentSettingsResponse;
  }
>();
const ACP_REFRESH_REUSE_TTL_MS = 5_000;
const USER_INITIATED_ACP_PROBE_TIMEOUT_MS = 10 * 60_000;
let inFlightClaudeAcpInstall: Promise<InstallAcpAgentResponse> | undefined;

function acpRefreshRegistryIds(
  request: ListAcpAgentSettingsRequest,
): ReadonlySet<string> {
  const requested = request.registryIds
    ? new Set(request.registryIds)
    : undefined;
  return new Set(
    LOCAL_ACP_REGISTRY_IDS.filter(
      (registryId) => !requested || requested.has(registryId),
    ),
  );
}

function setContainsAll(
  candidate: ReadonlySet<string>,
  requested: ReadonlySet<string>,
): boolean {
  return [...requested].every((registryId) => candidate.has(registryId));
}

function setsOverlap(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): boolean {
  return [...left].some((registryId) => right.has(registryId));
}

function invalidateRecentAcpRefreshes(
  registryIds: ReadonlySet<string>,
): void {
  for (const recent of recentAcpRefreshes) {
    if (setsOverlap(recent.registryIds, registryIds)) {
      recentAcpRefreshes.delete(recent);
    }
  }
}

function permitAcpDiscoveryRequest(
  request: ListAcpAgentSettingsRequest,
): ProviderDiscoveryPermit | undefined {
  if (request.refresh !== true) {
    return undefined;
  }
  if (!request.discoveryIntent) {
    throw new Error(
      "ACP discovery requires a Settings or setup user-action intent.",
    );
  }
  return issueProviderDiscoveryPermit(request.discoveryIntent);
}

async function listAcpAgentSettings(
  request: ListAcpAgentSettingsRequest = {},
  service?: DesktopSettingsService,
): Promise<ListAcpAgentSettingsResponse> {
  const permit = permitAcpDiscoveryRequest(request);
  if (request.refresh === false) {
    return await listAcpAgentSettingsImpl(request, service, permit);
  }
  const probeCapabilities = request.probeCapabilities !== false;
  const registryIds = acpRefreshRegistryIds(request);
  const compatible = [...inFlightAcpRefreshes].filter(
    (active) => active.probeCapabilities === probeCapabilities,
  );
  const superset = compatible.find((active) =>
    setContainsAll(active.registryIds, registryIds),
  );
  if (superset) {
    return await superset.promise;
  }

  const overlapping = compatible.filter((active) =>
    setsOverlap(active.registryIds, registryIds),
  );
  if (overlapping.length === 0) {
    const now = Date.now();
    for (const recent of recentAcpRefreshes) {
      if (now - recent.completedAt >= ACP_REFRESH_REUSE_TTL_MS) {
        recentAcpRefreshes.delete(recent);
      }
    }
    const recentMatch = [...recentAcpRefreshes].find(
      (recent) =>
        recent.probeCapabilities === probeCapabilities
        && setContainsAll(recent.registryIds, registryIds)
        && setContainsAll(registryIds, recent.registryIds),
    );
    if (recentMatch) {
      return recentMatch.response;
    }
  }
  const coveredRegistryIds = new Set(
    overlapping.flatMap((active) => [...active.registryIds]),
  );
  const remainingRegistryIds = [...registryIds].filter(
    (registryId) => !coveredRegistryIds.has(registryId),
  );
  const run = (async () => {
    if (overlapping.length > 0) {
      await Promise.all(overlapping.map((entry) => entry.promise));
    }
    if (registryIds.size > 0 && remainingRegistryIds.length === 0) {
      return await listAcpAgentSettingsImpl(
        { ...request, refresh: false },
        service,
        permit,
      );
    }
    const nextRequest =
      request.registryIds || remainingRegistryIds.length !== registryIds.size
        ? { ...request, registryIds: remainingRegistryIds }
        : request;
    invalidateRecentAcpRefreshes(acpRefreshRegistryIds(nextRequest));
    return await listAcpAgentSettingsImpl(nextRequest, service, permit);
  })();
  const active: InFlightAcpRefresh = {
    probeCapabilities,
    registryIds,
    promise: run,
  };
  inFlightAcpRefreshes.add(active);
  try {
    const response = await run;
    recentAcpRefreshes.add({
      ...active,
      completedAt: Date.now(),
      response,
    });
    return response;
  } finally {
    inFlightAcpRefreshes.delete(active);
  }
}

async function listAcpAgentSettingsImpl(
  request: ListAcpAgentSettingsRequest = {},
  service?: DesktopSettingsService,
  permit?: ProviderDiscoveryPermit,
): Promise<ListAcpAgentSettingsResponse> {
  const claudeExperimental =
    getService(service).resolveClaudeAcpExperimentalEnabled();
  const store = new AcpAgentStore(getAppStateDb());
  const settingsService = getService(service);
  const registryService = new AcpRegistryService();
  let snapshot: AcpRegistrySnapshot | undefined;
  let error: string | undefined;

  if (request.refresh !== false) {
    try {
      snapshot = await registryService.fetchRegistry();
      store.saveRegistrySnapshot(snapshot);
    } catch (fetchError) {
      error = fetchError instanceof Error ? fetchError.message : String(fetchError);
    }
  }

  snapshot ??= store.readRegistrySnapshot();
  let discoveryEnv: NodeJS.ProcessEnv | undefined;
  if (request.refresh === true) {
    assertProviderDiscoveryPermit(permit, [
      "settings-user-action",
      "setup-user-action",
    ]);
    try {
      // Electron and package managers can prepend transient Node bin
      // directories to the app process PATH. Discover ACP CLIs from the same
      // hydrated login-shell environment used by the integrated terminal so
      // `qwen`, `kimi`, etc. resolve to the binaries the operator invokes.
      discoveryEnv = await settingsService.resolveTerminalSpawnEnvAsync();
    } catch (envError) {
      settingsIpcLog.debug("acp_discovery_shell_env_failed", {
        error: envError instanceof Error ? envError.message : String(envError),
      });
    }
  }
  const installed = await listInstalledAndLocalAcpAgents(store, {
    ...(permit ? { permit } : {}),
    providers: settingsService.readProvidersConfig(),
    refreshLocal: request.refresh === true,
    claudeExperimental,
    ...(request.force === true ? { force: true } : {}),
    ...(request.probeCapabilities === false
      ? { probeCapabilities: false }
      : {}),
    ...(request.registryIds ? { registryIds: request.registryIds } : {}),
    ...(discoveryEnv ? { env: discoveryEnv } : {}),
  });
  const entries = snapshot
    ? registryService
        .applyAllowlist(snapshot)
        .filter((agent) => agent.allowlist.allowed)
        .filter(
          (agent) =>
            agent.id !== CLAUDE_ACP_REGISTRY_ID || claudeExperimental,
        )
        .flatMap((agent) => {
          const entry = acpAgentSettingsEntry({
            agent,
            installed: installed.find((record) => record.backendId === agent.backendId),
            registryService,
          });
          return entry ? [entry] : [];
        })
    : [];
  const listedBackendIds = new Set(entries.map((entry) => entry.backendId));
  for (const record of installed) {
    if (!listedBackendIds.has(record.backendId)) {
      entries.push(installedAcpAgentSettingsEntry(record));
    }
  }

  // Always present every supported provider as its own
  // section, even when nothing was discovered for it — they are known providers
  // we support via ACP, so an undiscovered one shows a "Not installed" status
  // instead of vanishing. Fill a placeholder for any built-in strategy that
  // neither the registry nor local discovery produced an entry for. This makes
  // the screen independent of registry availability (offline / cold start).
  const presentBackendIds = new Set(entries.map((entry) => entry.backendId));
  for (const strategy of SUPPORTED_ACP_AGENT_CATALOG) {
    if (
      isBannedAcpRegistryId(strategy.id) ||
      (strategy.id === CLAUDE_ACP_REGISTRY_ID && !claudeExperimental) ||
      presentBackendIds.has(`acp:${strategy.id}`)
    ) {
      continue;
    }
    entries.push(
      strategy.id === CLAUDE_ACP_REGISTRY_ID
        ? claudeAcpPlaceholderSettingsEntry()
        : placeholderAcpAgentSettingsEntry(strategy),
    );
    presentBackendIds.add(`acp:${strategy.id}`);
  }

  // Stable, predictable order: the built-in catalog order first (Gemini, Grok,
  // Kimi, Qwen), any extra non-catalog entries after in their existing order.
  const catalogOrder = new Map(
    SUPPORTED_ACP_AGENT_CATALOG.map((strategy, index) => [
      strategy.backendId,
      index,
    ]),
  );
  const orderedEntries = entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const ao = catalogOrder.get(a.entry.backendId);
      const bo = catalogOrder.get(b.entry.backendId);
      if (ao !== undefined && bo !== undefined) {
        return ao - bo;
      }
      if (ao !== undefined) {
        return -1;
      }
      if (bo !== undefined) {
        return 1;
      }
      return a.index - b.index;
    })
    .map(({ entry }) => entry);

  await decorateManagedGrokBuild(
    orderedEntries,
    settingsService.readProvidersConfig(),
  );

  return {
    fetchedAt: snapshot?.fetchedAt ?? Date.now(),
    entries: orderedEntries,
    ...(error ? { error } : {}),
  };
}

async function installAcpAgent(
  request: InstallAcpAgentRequest,
  service?: DesktopSettingsService,
): Promise<InstallAcpAgentResponse> {
  if (
    !getService(service).resolveClaudeAcpExperimentalEnabled()
  ) {
    throw new Error(
      "Enable Experimental → Claude Agent through ACP before installing this runtime.",
    );
  }
  if (
    request?.registryId !== CLAUDE_ACP_REGISTRY_ID
    || request?.expectedVersion !== CLAUDE_ACP_VERSION
  ) {
    throw new Error(
      `PwrAgent only installs the allowlisted ${CLAUDE_ACP_PACKAGE_NAME}@${CLAUDE_ACP_VERSION} runtime.`,
    );
  }
  if (inFlightClaudeAcpInstall) {
    return await inFlightClaudeAcpInstall;
  }
  const run = installAcpAgentImpl(service).finally(() => {
    if (inFlightClaudeAcpInstall === run) {
      inFlightClaudeAcpInstall = undefined;
    }
  });
  inFlightClaudeAcpInstall = run;
  return await run;
}

async function installAcpAgentImpl(
  service?: DesktopSettingsService,
): Promise<InstallAcpAgentResponse> {
  const store = new AcpAgentStore(getAppStateDb());
  const now = Date.now();
  const previous = store.getInstalledAgent(CLAUDE_ACP_BACKEND_ID);
  let record: AcpInstalledAgentRecord;
  try {
    const env = await getService(service).resolveTerminalSpawnEnvAsync();
    record = await installManagedClaudeAcpRuntime({ env });
    if (
      previous?.installStatus === "installed"
      && previous.version === record.version
    ) {
      record = {
        ...record,
        authStatus: previous.authStatus,
        runtimeCapabilities: previous.runtimeCapabilities,
        lastDiscoveredAt: previous.lastDiscoveredAt,
        lastDiscoveryError: previous.lastDiscoveryError,
        installedAt: previous.installedAt,
      };
    }
  } catch (error) {
    record = failedClaudeAcpInstallRecord(error, now);
  }
  store.upsertInstalledAgent(record);
  await getDesktopBackendRegistry().invalidateProviderRuntimeSelections({
    acp: true,
    acpRegistryIds: [CLAUDE_ACP_REGISTRY_ID],
    codex: false,
  });
  return {
    fetchedAt: now,
    entry: installedAcpAgentSettingsEntry(record),
  };
}

/**
 * Label each Grok executable with the channel that publishes it, and attach
 * the managed channel's own state.
 *
 * Two products answer to the word "Grok" on this pane: xAI's CLI, which the
 * operator updates from x.ai/build, and the `-pwragent` builds PwrAgent
 * downloads, verifies and installs itself. They carry different version
 * strings and different release pages, so a surface that cannot tell them
 * apart ends up describing one in the other's terms.
 *
 * Everything reported here was already written to disk by the last release
 * check, so this adds no network call and starts no download — the pane can
 * name the installed tag and say when it was checked without one.
 */
async function decorateManagedGrokBuild(
  entries: AcpAgentSettingsEntry[],
  providers: ConfigDomainMap["providers"],
): Promise<void> {
  const index = entries.findIndex((entry) => entry.registryId === "grok");
  if (index === -1) {
    return;
  }
  const entry = entries[index];
  // Provenance is labeled whether or not the channel is enabled: the copy
  // inside the app bundle is a PwrAgent build even with managed downloads off,
  // and so is a managed version an operator pinned before turning them off.
  const instances = entry.instances?.map((instance) => {
    const tag = managedGrokTagForCommand(instance.command);
    if (tag === undefined && !isPwrAgentSuppliedGrokCommand(instance.command)) {
      return instance;
    }
    return {
      ...instance,
      pwrAgentBuild: true,
      ...(tag !== undefined ? { pwrAgentBuildTag: tag } : {}),
    };
  });

  if (
    !managedGrokBuildsEnabledFromSnapshot(
      providers,
      process.env,
      app?.isPackaged === true,
    )
  ) {
    if (instances) {
      entries[index] = { ...entry, instances };
    }
    return;
  }

  const summary = await readManagedGrokInstallSummary();
  const activeTag = managedGrokTagForCommand(entry.activeCommand);
  // `pinnedBehind` is what the pane and the durable notice cite as the *cause*
  // ("a manual path pins X"), so verify that cause rather than inferring it
  // from a tag mismatch. The managed root is machine-wide: a sibling instance
  // or profile can install a newer tag while this instance's durable record
  // still names the older one, and a mismatch alone would then accuse an
  // override that does not exist.
  const pinnedBy = acpProviderCommandOverrideFromSnapshot(providers, "grok");
  const managedBuild: AcpManagedBuildStatus = {
    repository: MANAGED_GROK_REPOSITORY,
    channel: managedGrokBuildChannelFromSnapshot(providers),
    ...(summary
      ? {
          installedTag: summary.tag,
          checkedAt: summary.checkedAt,
          installedAt: summary.installedAt,
          // Both tracks as the last check resolved them. A check that fell
          // back to the Atom feed knows one track only, so a missing tag here
          // means "not observed", never "no such release".
          ...(summary.latestTag ? { latestTag: summary.latestTag } : {}),
          ...(summary.prereleaseTag
            ? { prereleaseTag: summary.prereleaseTag }
            : {}),
        }
      : {}),
    ...(activeTag !== undefined ? { activeTag } : {}),
    // Only a managed build can be *behind* this channel. A vendor install is
    // on a different channel entirely, and calling it "behind" a `-pwragent`
    // tag is exactly the cross-channel comparison this work exists to remove.
    ...(summary
      && activeTag !== undefined
      && activeTag !== summary.tag
      && pinnedBy !== undefined
      && pinnedBy === entry.activeCommand
      ? { pinnedBehind: true }
      : {}),
  };
  entries[index] = {
    ...entry,
    ...(instances ? { instances } : {}),
    managedBuild,
  };
}

/**
 * A synthetic "not installed" entry for a supported ACP provider that neither
 * local discovery nor the registry produced a record for. Sourced from the
 * built-in strategy catalog so the provider still renders its own section
 * (with a not-installed status) instead of disappearing when undiscovered or
 * when the registry is unavailable.
 */
function placeholderAcpAgentSettingsEntry(
  strategy: {
    id: string;
    displayName: string;
    authors: readonly string[];
    license?: string;
    repositoryUrl?: string;
  },
): AcpAgentSettingsEntry {
  return {
    backendId: `acp:${strategy.id}`,
    registryId: strategy.id,
    name: strategy.displayName,
    authors: [...strategy.authors],
    ...(strategy.license ? { license: strategy.license } : {}),
    ...(strategy.repositoryUrl
      ? { repositoryUrl: strategy.repositoryUrl }
      : {}),
    distributionKind: "local",
    distributionSource: `${strategy.id} (not installed)`,
    installable: false,
    installed: false,
    installStatus: "not-installed",
    authStatus: "not-required",
    verificationStatus: "unverified-allowed",
    instances: [],
  };
}

async function listInstalledAndLocalAcpAgents(
  store: AcpAgentStore,
  options?: {
    permit?: ProviderDiscoveryPermit;
    providers?: ReturnType<DesktopSettingsService["readProvidersConfig"]>;
    refreshLocal?: boolean;
    force?: boolean;
    probeCapabilities?: boolean;
    registryIds?: readonly string[];
    env?: NodeJS.ProcessEnv;
    claudeExperimental?: boolean;
  },
): Promise<AcpInstalledAgentRecord[]> {
  const claudeExperimental =
    options?.claudeExperimental
    ?? getDesktopConfigStore().read("experimental").claudeAcp === true;
  const visible = (record: AcpInstalledAgentRecord): boolean =>
    record.registryId !== CLAUDE_ACP_REGISTRY_ID || claudeExperimental;
  const installed = store.listInstalledAgents().filter(visible);
  let discovered: AcpInstalledAgentRecord[] = [];
  if (options?.refreshLocal) {
    assertProviderDiscoveryPermit(options.permit, [
      "settings-user-action",
      "setup-user-action",
    ]);
    try {
      const providers = options.providers
        ?? getDesktopSettingsService().readProvidersConfig();
      const preferences: Record<string, AcpAgentPreference> = {};
      const requestedRegistryIds = LOCAL_ACP_REGISTRY_IDS.filter(
        (registryId) =>
          !options.registryIds || options.registryIds.includes(registryId),
      );
      const discoveryRegistryIds = options.probeCapabilities === false
        ? requestedRegistryIds
        : requestedRegistryIds.filter((registryId) =>
            acpProviderEnabledFromSnapshot(providers, registryId),
          );
      for (const registryId of discoveryRegistryIds) {
        const override = acpProviderCommandOverrideFromSnapshot(
          providers,
          registryId,
        );
        if (override) {
          preferences[registryId] = { overridePath: override };
        }
      }
      discovered = (await discoverLocalAcpAgentRecords({
        enabledRegistryIds: discoveryRegistryIds,
        managedGrok: {
          channel: managedGrokBuildChannelFromSnapshot(providers),
          enabled:
            managedGrokBuildsEnabledFromSnapshot(
              providers,
              options?.env ?? process.env,
              app?.isPackaged === true,
            ),
          checkMode: options.force
            ? "force"
            : app?.isPackaged === true
              ? "ttl"
              : "once-per-process",
          requirePlatformSignature: app?.isPackaged === true,
        },
        ...(Object.keys(preferences).length > 0 ? { preferences } : {}),
        ...(options?.env ? { env: options.env } : {}),
      })).map((record) => {
        const configDependencyFingerprint = providerProjectionForRegistryId(
          providers,
          record.registryId,
        )?.dependencyFingerprint;
        return {
          ...record,
          ...(configDependencyFingerprint
            ? { configDependencyFingerprint }
            : {}),
        };
      });
      if (claudeExperimental) {
        const managedClaude = await discoverManagedClaudeAcpRuntime({
          ...(options?.env ? { env: options.env } : {}),
        });
        if (managedClaude) {
          discovered.push(managedClaude);
        } else {
          const cachedClaude = store.getInstalledAgent(CLAUDE_ACP_BACKEND_ID);
          if (cachedClaude?.installStatus === "installed") {
            store.upsertInstalledAgent(
              unavailableManagedClaudeAcpRuntime(cachedClaude),
            );
          }
        }
      }
      const discoveryCwd = await ensureAcpRuntimeDiscoveryWorkspace();
      const now = Date.now();
      for (const record of discovered) {
        if (record.installStatus !== "installed") {
          // Compatibility diagnostics (for example a legacy Python kimi-cli)
          // are durable records but must never inherit the previous usable
          // runtime/model cache or launch an ACP capability probe.
          store.upsertInstalledAgent(record);
          continue;
        }
        const current = store.getInstalledAgent(record.backendId);
        const runtimeVersionChanged =
          current?.version !== undefined
          && record.version !== undefined
          && current.version !== record.version;
        const pwrAgentOwnedGrok = isPwrAgentOwnedGrokRuntime(record);
        const sameManagedClaudeRuntime =
          record.registryId === CLAUDE_ACP_REGISTRY_ID
          && current?.installStatus === "installed"
          && current.version === record.version;
        const preserveCachedRuntime =
          !runtimeVersionChanged
          && (
            record.registryId !== CLAUDE_ACP_REGISTRY_ID
            || sameManagedClaudeRuntime
          );
        const nextRecord = {
          ...record,
          authStatus:
            sameManagedClaudeRuntime
              ? current.authStatus
              : record.authStatus,
          runtimeCapabilities: preserveCachedRuntime
            ? current?.runtimeCapabilities
            : undefined,
          update: pwrAgentOwnedGrok ? undefined : current?.update,
          updateCommand: pwrAgentOwnedGrok
            ? undefined
            : current?.updateCommand,
          lastDiscoveredAt: preserveCachedRuntime
            ? current?.lastDiscoveredAt
            : undefined,
          lastDiscoveryError: preserveCachedRuntime
            ? current?.lastDiscoveryError
            : undefined,
          installedAt:
            record.registryId === CLAUDE_ACP_REGISTRY_ID
              ? preserveCachedRuntime
                ? current?.installedAt ?? record.installedAt
                : record.installedAt
              : current?.installedAt ?? record.installedAt,
          updatedAt: Math.max(current?.updatedAt ?? 0, record.updatedAt),
        } satisfies AcpInstalledAgentRecord;
        if (
          options.probeCapabilities === false
          || !acpProviderEnabledFromSnapshot(providers, record.registryId)
        ) {
          store.upsertInstalledAgent(nextRecord);
          continue;
        }
        // Cheap local discovery (above) always runs to find newly-installed
        // agents and refresh version metadata. The EXPENSIVE runtime-capability
        // probe launches the agent over ACP, so gate it: only re-probe agents
        // that are undiscovered, stale, or version-changed (or when forced).
        // Otherwise persist the merged record carrying the cached capabilities
        // without launching anything.
        const reprobeRequired = shouldReprobeAcpCapabilities(
          current,
          record.version,
          now,
          {
            ...(options?.force === true ? { force: true } : {}),
          },
        );
        if (
          acpProviderEnabledFromSnapshot(providers, record.registryId)
          && reprobeRequired
        ) {
          store.upsertInstalledAgent(
            await refreshAcpRuntimeCapabilities(
              nextRecord,
              discoveryCwd,
              // `force` is reserved for explicit UI refresh/login actions.
              // Gemini can wait on a human browser OAuth round trip, so keep
              // background discovery bounded while giving those actions room.
              options.force === true
                ? USER_INITIATED_ACP_PROBE_TIMEOUT_MS
                : undefined,
            ),
          );
        } else {
          store.upsertInstalledAgent(nextRecord);
        }
      }
    } catch (error) {
      settingsIpcLog.debug("local_acp_discovery_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const refreshedInstalled = options?.refreshLocal
    ? store.listInstalledAgents().filter(visible)
    : installed;
  const allowedInstalled = refreshedInstalled.filter(
    (record) => !isBannedAcpRegistryId(record.registryId),
  );
  const installedBackendIds = new Set(
    allowedInstalled.map((record) => record.backendId),
  );
  return [
    ...allowedInstalled,
    ...discovered.filter(
      (record) =>
        !installedBackendIds.has(record.backendId) &&
        visible(record) &&
        !isBannedAcpRegistryId(record.registryId),
    ),
  ];
}

async function refreshAcpRuntimeCapabilities(
  record: AcpInstalledAgentRecord,
  cwd: string,
  requestTimeoutMs?: number,
): Promise<AcpInstalledAgentRecord> {
  const now = Date.now();
  try {
    const result = await discoverAcpRuntimeCapabilities(record, {
      cwd,
      ...(requestTimeoutMs !== undefined ? { requestTimeoutMs } : {}),
    });
    return {
      ...record,
      ...(record.registryId === CLAUDE_ACP_REGISTRY_ID
        ? { authStatus: "authenticated" as const }
        : {}),
      ...(result.runtimeCapabilities
        ? {
            runtimeCapabilities: result.runtimeCapabilities,
            lastDiscoveredAt: result.runtimeCapabilities.discoveredAt ?? now,
            lastDiscoveryError: undefined,
          }
        : {
            lastDiscoveredAt: now,
          }),
      updatedAt: Math.max(record.updatedAt, now),
    };
  } catch (error) {
    return {
      ...record,
      ...(record.registryId === CLAUDE_ACP_REGISTRY_ID
        ? {
            authStatus: isClaudeAcpAuthenticationError(error)
              ? "required" as const
              : "failed" as const,
          }
        : {}),
      lastDiscoveryError: error instanceof Error ? error.message : String(error),
      updatedAt: Math.max(record.updatedAt, now),
    };
  }
}

async function ensureAcpRuntimeDiscoveryWorkspace(): Promise<string> {
  const directory = path.join(
    getAppStateMode() === "bootstrap"
      ? resolveBootstrapProfileDir()
      : resolveActiveProfileDir(),
    "state",
    "acp-discovery-workspace",
  );
  await mkdir(directory, { recursive: true });
  return directory;
}

function acpAgentSettingsEntry(params: {
  agent: AcpRegistryAgentWithPolicy;
  installed?: AcpInstalledAgentRecord;
  registryService: AcpRegistryService;
}): AcpAgentSettingsEntry | undefined {
  if (params.installed) {
    return installedAcpAgentSettingsEntry(params.installed, params.agent);
  }

  const distribution = selectAcpDistribution(params.agent);
  if (!distribution) {
    const displayDistribution = params.agent.distributions[0];
    if (!displayDistribution) {
      return undefined;
    }
    return {
      backendId: params.agent.backendId,
      registryId: params.agent.id,
      name: params.agent.name,
      description: params.agent.description,
      version: params.agent.version,
      license: params.agent.license,
      authors: params.agent.authors,
      repositoryUrl: params.agent.repositoryUrl,
      websiteUrl: params.agent.websiteUrl,
      distributionKind: displayDistribution.kind,
      distributionSource: describeDistributionSource(displayDistribution),
    installable: false,
      installed: false,
      installStatus: "unavailable",
      authStatus: params.agent.auth.required ? "required" : "not-required",
      verificationStatus: params.agent.verificationStatus,
      allowlistRuleId: params.agent.allowlist.allowed
        ? params.agent.allowlist.ruleId
        : undefined,
    unavailableReason: "Install is not supported. Install the agent separately and run Discover new.",
    };
  }
  const distributionPolicy = params.registryService.evaluateDistribution(
    params.agent,
    distribution,
  );
  return {
    backendId: params.agent.backendId,
    registryId: params.agent.id,
    name: params.agent.name,
    description: params.agent.description,
    version: params.agent.version,
    license: params.agent.license,
    authors: params.agent.authors,
    repositoryUrl: params.agent.repositoryUrl,
    websiteUrl: params.agent.websiteUrl,
    distributionKind: distribution.kind,
    distributionSource: describeDistributionSource(distribution),
    installable: false,
    installed: false,
    installStatus: "unavailable",
    authStatus: params.agent.auth.required ? "required" : "not-required",
    verificationStatus: distributionPolicy.verificationStatus,
    allowlistRuleId: distributionPolicy.allowlist.allowed
      ? distributionPolicy.allowlist.ruleId
      : undefined,
    unavailableReason:
      distributionPolicy.unavailableReason ??
      params.agent.unavailableReason ??
      "Install is not supported. Install the agent separately and run Discover new.",
  };
}

export function installedAcpAgentSettingsEntry(
  record: AcpInstalledAgentRecord,
  registryAgent?: AcpRegistryAgent,
): AcpAgentSettingsEntry {
  const agent = registryAgent ?? record.registryAgent;
  // Reads without a discovery pass (`refresh: false`) serve the durable record
  // as-is, so a vendor update status written while a vendor binary was active
  // would still reach the renderer after the PwrAgent build became the runtime.
  // Drop it at the boundary: the runtime in effect owns the update story.
  const pwrAgentOwnedGrok = isPwrAgentOwnedGrokRuntime(record);
  return {
    backendId: record.backendId,
    registryId: record.registryId,
    name: record.name,
    description: agent?.description,
    version: record.version,
    license: agent?.license,
    authors: agent?.authors ?? [],
    repositoryUrl: agent?.repositoryUrl,
    websiteUrl: agent?.websiteUrl,
    distributionKind: record.distributionKind,
    distributionSource: record.distributionSource,
    installable: record.registryId === CLAUDE_ACP_REGISTRY_ID,
    installed: record.installStatus === "installed",
    installStatus: record.installStatus,
    authStatus: record.authStatus,
    verificationStatus: record.verificationStatus,
    allowlistRuleId: record.allowlistRuleId,
    installedAt: record.installedAt,
    updatedAt: record.updatedAt,
    lastError: record.lastError,
    lastDiscoveredAt: record.lastDiscoveredAt,
    lastDiscoveryError: record.lastDiscoveryError,
    runtime: record.runtimeCapabilities,
    update: pwrAgentOwnedGrok ? undefined : record.update,
    ...(pwrAgentOwnedGrok ? { pwrAgentManagedRuntime: true } : {}),
    ...(record.instances !== undefined ? { instances: record.instances } : {}),
    ...(record.incompatibleInstances !== undefined
      ? { incompatibleInstances: record.incompatibleInstances }
      : {}),
    ...(record.rejectedInstances !== undefined
      ? { rejectedInstances: record.rejectedInstances }
      : {}),
    ...(record.activeCommand !== undefined
      ? { activeCommand: record.activeCommand }
      : {}),
    ...(record.registryId === CLAUDE_ACP_REGISTRY_ID
      ? { managedRuntime: claudeAcpManagedRuntimeSummary(record) }
      : {}),
  };
}

function selectAcpDistribution(
  agent: Pick<AcpRegistryAgent, "distributions">,
  preferredKind?: AcpRegistryDistribution["kind"],
): AcpRegistryDistribution | undefined {
  return selectAcpDistributionForCurrentPlatform(agent.distributions, preferredKind);
}

async function resolveCodexCommandForProfileWorkflow(
  service: DesktopSettingsService,
): Promise<string> {
  const command = (await service.resolveCodexCommand()).command;
  // Codex login and auth-status spawn this command the same way the transport
  // and the credential tester do, so they need the same Windows shim redirect.
  // Without it a `.ps1` reaching us from a stale cache launches threads fine
  // while onboarding login fails, which is the split this redirect exists to
  // prevent.
  return resolveWindowsCodexLaunchCommand({ command });
}

/**
 * Resolve the `CODEX_HOME` path for a profile name. Empty string is
 * treated as "the Codex system default" (`~/.codex/`) — used by the
 * Shared-mode auth status check on the onboarding wizard, where the
 * operator's chosen path is "reuse the existing Codex login" and the
 * wizard needs to verify that login exists before letting them Finish.
 * Any other invalid name still throws — the caller passes either a
 * valid profile name (`personal`, `work`, …) or the empty sentinel.
 */
function resolveRequiredCodexProfileHome(profile: string): string {
  if (profile === "") {
    return resolveDefaultCodexHome();
  }
  const codexHome = resolveCodexHomeForProfile(profile);
  if (!codexHome) {
    throw new Error("A named Codex profile is required.");
  }
  return codexHome;
}


async function checkCodexProfileAuthStatus(
  service: DesktopSettingsService,
  request: CheckDesktopCodexAuthProfileStatusRequest,
): Promise<CheckDesktopCodexAuthProfileStatusResponse> {
  const profile =
    request.profile.trim() === "" ? "" : normalizeProfileName(request.profile);
  if (request.profile.trim() !== "" && !profile) {
    throw new Error(
      `Codex profile name "${request.profile}" must contain at least one letter or number.`,
    );
  }
  const codexHome = resolveRequiredCodexProfileHome(profile);
  const command = await resolveCodexCommandForProfileWorkflow(service);
  const result = await collectCodexStatus(command, codexHome);
  const authenticated = result.code === 0;
  // When the CLI reports authenticated, surface the JWT-derived identity
  // fields too — the onboarding wizard's name+login step renders them
  // inline so the operator can confirm they signed in with the right
  // account (and at the expected plan tier) before moving on.
  const authInfo = authenticated ? readCodexAuthInfo(codexHome) : {};
  return {
    profile,
    codexHome,
    authenticated,
    status:
      result.code === null
        ? "failed"
        : authenticated
          ? "authenticated"
          : "unauthenticated",
    ...(result.detail ? { detail: result.detail } : {}),
    ...(authInfo.email ? { email: authInfo.email } : {}),
    ...(authInfo.planType ? { planType: authInfo.planType } : {}),
  };
}



function messagingPatchTouchesRuntime(
  patch: DesktopSettingsConfigPatch | undefined,
): boolean {
  return patch?.messaging !== undefined;
}

function messagingSecretTouchesRuntime(
  secret: DesktopSettingsSecretName,
): boolean {
  // Delegates to the shared predicate so the renderer's onboarding
  // wizard and the main-process IPC layer agree on which secret
  // names should re-evaluate the runtime when they change.
  return isMessagingRuntimeSecret(secret);
}

async function applyLatestMessagingRuntimeConfig(
  service: DesktopSettingsService,
): Promise<void> {
  const runtime = getDesktopMessagingRuntime();
  const runtimeOverride = resolveRuntimeMessagingOverride();
  await getRuntimeMessagingLeaseCoordinator().applyLatestConfig(
    runtime,
    (options) =>
      loadDesktopMessagingConfigFromSettings(service, process.env, options),
    {
      logStartupEligibility: true,
      allowStart: !runtimeOverride.disabled || runtime.isEnabled(),
    },
  );
}

function resolveRuntimeMessagingState(
  messaging: DesktopSettingsSnapshot["messaging"],
  runtime: DesktopSettingsSnapshot["runtime"]["messaging"],
): DesktopSettingsSnapshot["runtime"]["messaging"] {
  const leaseSnapshot = getRuntimeMessagingLeaseCoordinator().snapshot();
  const leaseOverrideActive = leaseSnapshot.disabledReasonKind === "lease_held";
  const overrideActive =
    runtime.overrideActive === true || leaseOverrideActive;
  const runtimeEnabled = overrideActive
    ? getDesktopMessagingRuntime().isEnabled()
    : messaging.enabled.value;
  const disabledReason =
    leaseSnapshot.disabledReason ?? runtime.disabledReason;
  const disabledReasonKind =
    leaseSnapshot.disabledReasonKind
    ?? runtime.disabledReasonKind;
  return {
    ...runtime,
    disabled: overrideActive
      ? !runtimeEnabled
      : messaging.enabled.value === false,
    overrideActive,
    ...(disabledReason ? { disabledReason } : {}),
    ...(disabledReasonKind ? { disabledReasonKind } : {}),
    ...(leaseSnapshot.leaseHolder
      ? { leaseHolder: leaseSnapshot.leaseHolder }
      : {}),
  };
}

/**
 * One inspector per main process, so its path cache survives a Settings
 * pane closing and reopening. Constructed lazily because the guard suites
 * import this module without ever calling a signature handler.
 */
let inspector: CodeSignatureInspector | undefined;

function codeSignatureInspector(): CodeSignatureInspector {
  inspector ??= new CodeSignatureInspector();
  return inspector;
}

function applyRuntimeMessagingSnapshot(
  snapshot: DesktopSettingsSnapshot,
): DesktopSettingsSnapshot {
  return {
    ...snapshot,
    runtime: {
      ...snapshot.runtime,
      messaging: resolveRuntimeMessagingState(
        snapshot.messaging,
        snapshot.runtime.messaging,
      ),
    },
  };
}

function applyRuntimeMessagingProjection(
  projection: DesktopMessagingSettingsProjection,
): DesktopMessagingSettingsProjection {
  return {
    ...projection,
    runtime: resolveRuntimeMessagingState(
      projection.messaging,
      projection.runtime,
    ),
  };
}

async function resolveMessagingContact(
  service: DesktopSettingsService,
  request: DesktopMessagingContactLookupRequest,
): Promise<DesktopMessagingContactLookupResponse> {
  const id = request.id.trim();
  if (!id) {
    return {
      status: "failed",
      id,
      errorMessage: "ID is required.",
    };
  }

  switch (request.platform) {
    case "telegram": {
      if (request.kind !== "user" && request.kind !== "supergroup") {
        return unsupportedLookup(request);
      }
      const botToken = service.resolveTelegramBotTokenSync();
      if (!botToken) return { status: "unset", id };
      const provider = await import("@pwragent/messaging-provider-telegram");
      return sanitizeMessagingContactLookupResponse(
        await provider.resolveContact(
          { botToken },
          { id, kind: request.kind },
        ),
      );
    }
    case "discord": {
      if (request.kind !== "user" && request.kind !== "guild") {
        return unsupportedLookup(request);
      }
      const botToken = service.resolveDiscordBotTokenSync();
      if (!botToken) return { status: "unset", id };
      const provider = await import("@pwragent/messaging-provider-discord");
      return sanitizeMessagingContactLookupResponse(
        await provider.resolveContact(
          { botToken },
          { id, kind: request.kind },
        ),
      );
    }
    case "mattermost": {
      if (request.kind !== "user") {
        return unsupportedLookup(request);
      }
      const botToken = service.resolveMattermostBotTokenSync();
      const serverUrl = service.resolveMattermostServerUrlSync();
      if (!botToken || !serverUrl) return { status: "unset", id };
      const provider = await import("@pwragent/messaging-provider-mattermost");
      return sanitizeMessagingContactLookupResponse(
        await provider.resolveContact(
          { botToken, serverUrl },
          { id, kind: request.kind },
        ),
      );
    }
    case "slack": {
      if (
        request.kind !== "user"
        && request.kind !== "workspace"
        && request.kind !== "channel"
      ) {
        return unsupportedLookup(request);
      }
      const botToken = service.resolveSlackBotTokenSync();
      if (!botToken) return { status: "unset", id };
      const provider = await import("@pwragent/messaging-provider-slack");
      return sanitizeMessagingContactLookupResponse(
        await provider.resolveContact(
          { botToken },
          { id, kind: request.kind },
        ),
      );
    }
    case "feishu": {
      if (
        request.kind !== "user"
        && request.kind !== "chat"
        && request.kind !== "tenant"
      ) {
        return unsupportedLookup(request);
      }
      const appId = service.resolveFeishuAppIdSync();
      const appSecret = service.resolveFeishuAppSecretSync();
      const tenantUrl = service.resolveFeishuTenantUrlSync();
      if (!appId || !appSecret || !tenantUrl) return { status: "unset", id };
      const provider = await import("@pwragent/messaging-provider-feishu");
      return sanitizeMessagingContactLookupResponse(
        await provider.resolveContact(
          { appId, appSecret, tenantUrl },
          { id, kind: request.kind },
        ),
      );
    }
    case "line": {
      return unsupportedLookup(request);
    }
  }
}

function sanitizeMessagingContactLookupResponse(
  response: DesktopMessagingContactLookupResponse,
): DesktopMessagingContactLookupResponse {
  const displayName = sanitizeMessagingContactLabel(response.displayName);
  const handle = sanitizeMessagingContactHandle(response.handle);
  return {
    ...response,
    displayName: displayName || undefined,
    handle: handle ? `@${handle}` : undefined,
  };
}

function unsupportedLookup(
  request: DesktopMessagingContactLookupRequest,
): DesktopMessagingContactLookupResponse {
  return {
    status: "unsupported",
    id: request.id.trim(),
    errorMessage: `${request.platform} cannot resolve ${request.kind} contacts.`,
  };
}

/**
 * Process-singleton credential tester. Reads its dependencies from
 * the active settings service so each probe uses the freshest token /
 * path even after a config rewrite. Cached `lastResult` survives
 * IPC handler re-registration (e.g. test-suite reloads), but resets
 * on full process restart — that's the right granularity for a
 * "manually run" diagnostic.
 *
 * All resolvers (settings + messaging-runtime) are GETTERS, not
 * captured references. The tester is constructed once per process
 * but the underlying singletons can be replaced (profile switch,
 * hot-reload during dev, test-suite re-init); resolving lazily on
 * each call ensures the tester always talks to the live instance.
 * Capturing `service` directly at construction would silently call
 * into a stale settings service after a swap.
 */
let credentialTesterInstance: CredentialTester | undefined;

function getCredentialTester(
  service?: DesktopSettingsService,
): CredentialTester {
  if (!credentialTesterInstance) {
    const resolveService = (): DesktopSettingsService =>
      service ?? getDesktopSettingsService();
    credentialTesterInstance = new CredentialTester({
      resolveTelegramBotToken: () =>
        resolveService().resolveTelegramBotTokenSync(),
      resolveDiscordBotToken: () =>
        resolveService().resolveDiscordBotTokenSync(),
      resolveMattermostBotToken: () =>
        resolveService().resolveMattermostBotTokenSync(),
      resolveMattermostServerUrl: () =>
        resolveService().resolveMattermostServerUrlSync(),
      resolveSlackBotToken: () =>
        resolveService().resolveSlackBotTokenSync(),
      resolveSlackAppToken: () =>
        resolveService().resolveSlackAppTokenSync(),
      resolveFeishuAppId: () =>
        resolveService().resolveFeishuAppIdSync(),
      resolveFeishuAppSecret: () =>
        resolveService().resolveFeishuAppSecretSync(),
      resolveFeishuTenantUrl: () =>
        resolveService().resolveFeishuTenantUrlSync(),
      resolveLineChannelAccessToken: () =>
        resolveService().resolveLineChannelAccessTokenSync(),
      resolveCodexCommand: async () => {
        try {
          return (await resolveService().resolveCodexCommand()).command;
        } catch {
          return undefined;
        }
      },
      validateMessagingCredentials: (request) =>
        getDesktopMessagingRuntime().requestCredentialValidation(request),
    });
  }
  return credentialTesterInstance;
}

function startupCredentialResult(
  kind: SettingsCredentialTestKind,
): SettingsCredentialTestResult | undefined {
  if (
    kind !== "telegram"
    && kind !== "discord"
    && kind !== "mattermost"
    && kind !== "slack"
    && kind !== "feishu"
  ) {
    return undefined;
  }
  const metadata = getDesktopMessagingRuntime().getPlatformCredentialMetadata(kind);
  if (!metadata) return undefined;
  return {
    kind,
    status: "ok",
    testedAt: metadata.observedAt,
    durationMs: 0,
    ...(metadata.account !== undefined ? { account: metadata.account } : {}),
    ...(metadata.detail !== undefined ? { detail: metadata.detail } : {}),
  };
}

/** For tests / shutdown — reset the singleton tester. */
function disposeCredentialTester(): void {
  credentialTesterInstance = undefined;
}

export function registerSettingsIpcHandlers(
  service?: DesktopSettingsService,
  options?: {
    onConfigPatchWritten?: (
      patch: DesktopSettingsConfigPatch,
    ) => void | Promise<void>;
  },
): void {
  recentAcpRefreshes.clear();
  ipcMain.removeHandler(ACP_AGENTS_LIST_CHANNEL);
  ipcMain.handle(
    ACP_AGENTS_LIST_CHANNEL,
    async (
      _event,
      request?: ListAcpAgentSettingsRequest,
    ): Promise<ListAcpAgentSettingsResponse> =>
      await listAcpAgentSettings(request, service),
  );

  ipcMain.removeHandler(ACP_AGENT_INSTALL_CHANNEL);
  ipcMain.handle(
    ACP_AGENT_INSTALL_CHANNEL,
    async (
      _event,
      request: InstallAcpAgentRequest,
    ): Promise<InstallAcpAgentResponse> =>
      await installAcpAgent(request, service),
  );

  ipcMain.removeHandler(ACP_AGENT_UPDATE_ACKNOWLEDGE_CHANNEL);
  ipcMain.handle(
    ACP_AGENT_UPDATE_ACKNOWLEDGE_CHANNEL,
    async (
      _event,
      request: AcknowledgeAcpAgentUpdateRequest,
    ): Promise<AcknowledgeAcpAgentUpdateResponse> => {
      const store = new AcpAgentStore(getAppStateDb());
      const record = isAcpBackendId(request.backendId)
        ? store.getInstalledAgent(request.backendId)
        : undefined;
      if (
        !record?.update
        || record.update.status !== "available"
        || record.update.latestVersion !== request.latestVersion
      ) {
        return { applied: false };
      }
      const now = Date.now();
      const update = request.action === "dismiss"
        ? {
            ...record.update,
            dismissedAt: now,
            snoozedUntil: undefined,
          }
        : {
            ...record.update,
            dismissedAt: undefined,
            snoozedUntil: now + ACP_UPDATE_SNOOZE_MS,
          };
      store.upsertInstalledAgent({ ...record, update });
      return { applied: true, update };
    },
  );

  ipcMain.removeHandler(SETTINGS_READ_CHANNEL);
  ipcMain.handle(
    SETTINGS_READ_CHANNEL,
    async (
      _event,
      _request?: ReadDesktopSettingsRequest,
    ): Promise<ReadDesktopSettingsResponse> =>
      await timeStartupProfileOperation({
        type: "ipc-main:readSettings",
        operation: async () => {
          const snapshot = applyRuntimeMessagingSnapshot(
            await getService(service).readSettingsProjection(),
          );
          return { snapshot };
        },
      }),
  );

  ipcMain.removeHandler(SETTINGS_READ_BOOTSTRAP_CHANNEL);
  ipcMain.handle(
    SETTINGS_READ_BOOTSTRAP_CHANNEL,
    async (): Promise<ReadDesktopConfigBootstrapResponse> => {
      const store = getDesktopConfigStore();
      const fileStatus = store.fileStatus();
      return {
        snapshot: {
          version: store.version(),
          configRevision: store.configRevision(),
          ...(fileStatus.kind === "invalid"
            ? { configError: fileStatus.error }
            : {}),
          appearance: store.read("general").appearance,
          onboarding: store.read("onboarding"),
        },
      };
    },
  );

  ipcMain.removeHandler(SETTINGS_READ_MESSAGING_CHANNEL);
  ipcMain.handle(
    SETTINGS_READ_MESSAGING_CHANNEL,
    async (): Promise<ReadDesktopMessagingSettingsResponse> => ({
      snapshot: applyRuntimeMessagingProjection(
        await getService(service).readMessagingProjection(),
      ),
    }),
  );

  ipcMain.removeHandler(SETTINGS_READ_FULL_ACCESS_POLICY_CHANNEL);
  ipcMain.handle(
    SETTINGS_READ_FULL_ACCESS_POLICY_CHANNEL,
    (): ReadDesktopFullAccessPolicyResponse => ({
      fullAccessRiskWarningDismissed:
        getService(service).readFullAccessRiskWarningDismissed(),
    }),
  );

  ipcMain.removeHandler(SETTINGS_WRITE_CONFIG_CHANNEL);
  ipcMain.handle(
    SETTINGS_WRITE_CONFIG_CHANNEL,
    async (
      _event,
      request: WriteDesktopSettingsConfigRequest,
    ): Promise<DesktopSettingsWriteResponse> => {
      const activeService = getService(service);
      const discoveryPermit = request.patch.experimental?.tokenMiserEnabled
        === true
        ? issueProviderDiscoveryPermit("settings-user-action")
        : undefined;
      const update = await activeService.writeConfigPatchTargeted(
        request.patch,
        discoveryPermit,
      );
      await options?.onConfigPatchWritten?.(request.patch);
      invalidateAcpRefreshCacheAfterWrite(request.patch);
      if (service && messagingPatchTouchesRuntime(request.patch)) {
        await applyLatestMessagingRuntimeConfig(activeService);
      }
      return {
        update,
        snapshot: applyRuntimeMessagingSnapshot(
          await activeService.readSettingsProjection(),
        ),
      };
    },
  );

  ipcMain.removeHandler(SETTINGS_REPLACE_SECRET_CHANNEL);
  ipcMain.handle(
    SETTINGS_REPLACE_SECRET_CHANNEL,
    async (
      _event,
      request: ReplaceDesktopSettingsSecretRequest,
    ): Promise<DesktopSettingsSecretWriteResponse> => {
      const activeService = getService(service);
      const state = await activeService.replaceSecret(
        request.secret,
        request.value,
      );
      if (messagingSecretTouchesRuntime(request.secret)) {
        await applyLatestMessagingRuntimeConfig(activeService);
      }
      return { secret: request.secret, state };
    },
  );

  ipcMain.removeHandler(SETTINGS_CLEAR_SECRET_CHANNEL);
  ipcMain.handle(
    SETTINGS_CLEAR_SECRET_CHANNEL,
    async (
      _event,
      request: ClearDesktopSettingsSecretRequest,
    ): Promise<DesktopSettingsSecretWriteResponse> => {
      const activeService = getService(service);
      const state = await activeService.clearSecret(request.secret);
      if (messagingSecretTouchesRuntime(request.secret)) {
        await applyLatestMessagingRuntimeConfig(activeService);
      }
      return { secret: request.secret, state };
    },
  );

  ipcMain.removeHandler(SETTINGS_REFRESH_CODEX_DISCOVERY_CHANNEL);
  ipcMain.handle(
    SETTINGS_REFRESH_CODEX_DISCOVERY_CHANNEL,
    async (
      _event,
      request: RefreshDesktopCodexDiscoveryRequest,
    ): Promise<ReadDesktopSettingsResponse> => {
      if (!request?.discoveryIntent) {
        throw new Error(
          "Codex discovery requires a Settings or setup user-action intent.",
        );
      }
      return {
        snapshot: applyRuntimeMessagingSnapshot(
          await getService(service).refreshCodexDiscovery(
            issueProviderDiscoveryPermit(request.discoveryIntent),
          ),
        ),
      };
    },
  );

  ipcMain.removeHandler(SETTINGS_CREATE_CODEX_AUTH_PROFILE_CHANNEL);
  ipcMain.handle(
    SETTINGS_CREATE_CODEX_AUTH_PROFILE_CHANNEL,
    async (
      _event,
      request: CreateDesktopCodexAuthProfileRequest,
    ): Promise<CreateDesktopCodexAuthProfileResponse> =>
      createCodexAuthProfile(request.profile),
  );

  ipcMain.removeHandler(SETTINGS_START_CODEX_AUTH_PROFILE_LOGIN_CHANNEL);
  ipcMain.handle(
    SETTINGS_START_CODEX_AUTH_PROFILE_LOGIN_CHANNEL,
    async (
      _event,
      request: StartDesktopCodexAuthProfileLoginRequest,
    ): Promise<StartDesktopCodexAuthProfileLoginResponse> => {
      const profile =
        request.profile.trim() === "" ? "" : normalizeProfileName(request.profile);
      if (request.profile.trim() !== "" && !profile) {
        throw new Error(
          `Codex profile name "${request.profile}" must contain at least one letter or number.`,
        );
      }
      const codexHome = resolveRequiredCodexProfileHome(profile);
      const command = await resolveCodexCommandForProfileWorkflow(
        getService(service),
      );
      try {
        return await codexLoginManager.startProfileLogin({
          codexHome,
          command,
          profile,
        });
      } catch (error) {
        // The codex-discovery CodexLoginManager rejects when `codex login`
        // exits without emitting a login link (e.g. it printed "Not logged
        // in"). The renderer catches this rejection to surface the failure
        // (CodexAuthProfileSelect), but without this catch it ALSO escapes to
        // Electron's default ipcMain handler logger instead of our structured
        // logging. Log it here with context, then rethrow so the renderer
        // still sees the rejection it relies on.
        settingsIpcLog.warn("codex profile login failed", {
          profile: profile === "" ? "(default)" : profile,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
  );

  ipcMain.removeHandler(SETTINGS_CHECK_CODEX_AUTH_PROFILE_STATUS_CHANNEL);
  ipcMain.handle(
    SETTINGS_CHECK_CODEX_AUTH_PROFILE_STATUS_CHANNEL,
    async (
      _event,
      request: CheckDesktopCodexAuthProfileStatusRequest,
    ): Promise<CheckDesktopCodexAuthProfileStatusResponse> =>
      await checkCodexProfileAuthStatus(getService(service), request),
  );

  ipcMain.removeHandler(SETTINGS_PICK_GH_COMMAND_CHANNEL);
  ipcMain.handle(
    SETTINGS_PICK_GH_COMMAND_CHANNEL,
    async (event): Promise<PickGhCommandResponse> => {
      const window = BrowserWindow.fromWebContents(event.sender)
        ?? BrowserWindow.getFocusedWindow()
        ?? undefined;
      const result = window
        ? await dialog.showOpenDialog(window, {
            properties: ["openFile"],
            title: "Choose gh",
          })
        : await dialog.showOpenDialog({
            properties: ["openFile"],
            title: "Choose gh",
          });
      if (result.canceled || !result.filePaths[0]) {
        return { canceled: true };
      }

      const selectedPath = result.filePaths[0];
      const candidate = await validateGhCommand({
        command: selectedPath,
        env: process.env,
      });
      if (!candidate.executable || !candidate.version) {
        return {
          canceled: false,
          path: selectedPath,
          candidate,
          error:
            candidate.failureReason
            ?? candidate.versionFailureReason
            ?? "Selected file did not respond to gh --version.",
        };
      }

      return {
        canceled: false,
        path: selectedPath,
        candidate,
      };
    },
  );

  ipcMain.removeHandler(SETTINGS_PICK_GIT_COMMAND_CHANNEL);
  ipcMain.handle(
    SETTINGS_PICK_GIT_COMMAND_CHANNEL,
    async (event): Promise<PickGitCommandResponse> => {
      const window = BrowserWindow.fromWebContents(event.sender)
        ?? BrowserWindow.getFocusedWindow()
        ?? undefined;
      const result = window
        ? await dialog.showOpenDialog(window, {
            properties: ["openFile"],
            title: "Choose git",
          })
        : await dialog.showOpenDialog({
            properties: ["openFile"],
            title: "Choose git",
          });
      if (result.canceled || !result.filePaths[0]) {
        return { canceled: true };
      }

      const selectedPath = result.filePaths[0];
      const candidate = await validateGitCommand({
        command: selectedPath,
        env: process.env,
      });
      if (!candidate.executable || !candidate.version) {
        return {
          canceled: false,
          path: selectedPath,
          candidate,
          error:
            candidate.failureReason
            ?? candidate.versionFailureReason
            ?? "Selected file did not respond to git --version.",
        };
      }

      return {
        canceled: false,
        path: selectedPath,
        candidate,
      };
    },
  );

  ipcMain.removeHandler(SETTINGS_REFRESH_GIT_DISCOVERY_CHANNEL);
  ipcMain.handle(
    SETTINGS_REFRESH_GIT_DISCOVERY_CHANNEL,
    async (): Promise<ReadDesktopSettingsResponse> => ({
      snapshot: applyRuntimeMessagingSnapshot(
        await getService(service).refreshGitDiscovery(),
      ),
    }),
  );

  ipcMain.removeHandler(SETTINGS_INSPECT_CODE_SIGNATURES_CHANNEL);
  ipcMain.handle(
    SETTINGS_INSPECT_CODE_SIGNATURES_CHANNEL,
    async (
      _event,
      request: InspectCodeSignaturesRequest,
    ): Promise<InspectCodeSignaturesResponse> => ({
      signatures: await codeSignatureInspector().inspectMany(
        Array.isArray(request?.paths) ? request.paths : [],
      ),
    }),
  );

  ipcMain.removeHandler(SETTINGS_TEST_CREDENTIALS_CHANNEL);
  ipcMain.handle(
    SETTINGS_TEST_CREDENTIALS_CHANNEL,
    async (
      _event,
      request: SettingsCredentialTestRequest,
    ): Promise<SettingsCredentialTestResult> => {
      const tester = getCredentialTester(service);
      return await tester.test(request.kind);
    },
  );

  ipcMain.removeHandler(SETTINGS_LAST_CREDENTIAL_TEST_CHANNEL);
  ipcMain.handle(
    SETTINGS_LAST_CREDENTIAL_TEST_CHANNEL,
    async (
      _event,
      request: { kind: SettingsCredentialTestKind },
    ): Promise<SettingsCredentialTestResult | undefined> => {
      const tester = getCredentialTester(service);
      return tester.lastResult(request.kind) ?? startupCredentialResult(request.kind);
    },
  );

  ipcMain.removeHandler(SETTINGS_OPEN_SLACK_CREATE_APP_CHANNEL);
  ipcMain.handle(
    SETTINGS_OPEN_SLACK_CREATE_APP_CHANNEL,
    async (
      _event,
      request: SlackCreateAppRequest = {},
    ): Promise<SlackCreateAppResponse> => {
      const slackProvider = await import("@pwragent/messaging-provider-slack");
      const prepared = slackProvider.buildSlackCreateAppUrl();
      const url = request.mode === "update"
        ? SLACK_APP_MANAGEMENT_URL
        : prepared.url;
      const shouldOpen = request.open !== false;
      let opened = false;
      if (shouldOpen) {
        if (!isSafeExternalOpenUrl(url)) {
          throw new Error("Refused to open an unsafe Slack app URL.");
        }
        await shell.openExternal(url);
        opened = true;
      }
      return {
        url,
        oversized: prepared.oversized,
        manifestJson: prepared.manifestJson,
        opened,
      };
    },
  );

  ipcMain.removeHandler(SETTINGS_LIST_DISCORD_THREAD_PERMISSION_CHANNELS_CHANNEL);
  ipcMain.handle(
    SETTINGS_LIST_DISCORD_THREAD_PERMISSION_CHANNELS_CHANNEL,
    async (
      _event,
      request: ListDiscordThreadPermissionChannelsRequest,
    ): Promise<ListDiscordThreadPermissionChannelsResponse> => {
      const config = await loadDesktopMessagingConfigFromSettings(
        getService(service),
        process.env,
      );
      const discordProvider = await import("@pwragent/messaging-provider-discord");
      return await discordProvider.listDiscordThreadPermissionChannels({
        botToken: config.discord?.botToken ?? "",
        guildId: request.guildId,
      });
    },
  );

  ipcMain.removeHandler(SETTINGS_INSPECT_DISCORD_THREAD_PERMISSIONS_CHANNEL);
  ipcMain.handle(
    SETTINGS_INSPECT_DISCORD_THREAD_PERMISSIONS_CHANNEL,
    async (
      _event,
      request: InspectDiscordThreadPermissionsRequest,
    ): Promise<InspectDiscordThreadPermissionsResponse> => {
      const config = await loadDesktopMessagingConfigFromSettings(
        getService(service),
        process.env,
      );
      const discordProvider = await import("@pwragent/messaging-provider-discord");
      return await discordProvider.inspectDiscordThreadPermissions({
        botToken: config.discord?.botToken ?? "",
        channelId: request.channelId,
        guildId: request.guildId,
      });
    },
  );

  ipcMain.removeHandler(SETTINGS_OPEN_DISCORD_THREAD_PERMISSION_CHANNEL);
  ipcMain.handle(
    SETTINGS_OPEN_DISCORD_THREAD_PERMISSION_CHANNEL,
    async (
      _event,
      request: OpenDiscordThreadPermissionRequest = {},
    ): Promise<OpenDiscordThreadPermissionResponse> => {
      const config = await loadDesktopMessagingConfigFromSettings(
        getService(service),
        process.env,
      );
      const discordProvider = await import("@pwragent/messaging-provider-discord");
      const applicationId = config.discord?.applicationId
        ?? await discordProvider.discoverDiscordApplicationId({
          botToken: config.discord?.botToken ?? "",
        });
      const url = discordProvider.buildDiscordThreadPermissionRequestUrl({
        applicationId,
        ...(request.guildId ? { guildId: request.guildId } : {}),
      });
      const shouldOpen = request.open !== false;
      let opened = false;
      if (shouldOpen) {
        if (!isSafeExternalOpenUrl(url)) {
          throw new Error("Refused to open an unsafe Discord permission URL.");
        }
        await shell.openExternal(url);
        opened = true;
      }
      return { opened, url };
    },
  );

  ipcMain.removeHandler(SETTINGS_RESOLVE_MESSAGING_CONTACT_CHANNEL);
  ipcMain.handle(
    SETTINGS_RESOLVE_MESSAGING_CONTACT_CHANNEL,
    async (
      _event,
      request: DesktopMessagingContactLookupRequest,
    ): Promise<DesktopMessagingContactLookupResponse> =>
      await resolveMessagingContact(getService(service), request),
  );

  ipcMain.removeHandler(ONBOARDING_COMPLETE_CODEX_BOOTSTRAP_CHANNEL);
  ipcMain.handle(
    ONBOARDING_COMPLETE_CODEX_BOOTSTRAP_CHANNEL,
    async (
      _event,
      request?: CompleteOnboardingCodexBootstrapRequest,
    ): Promise<CompleteOnboardingCodexBootstrapResponse> => {
      const activeService = getService(service);
      // Persist the wizard signal idempotently. The patch writer
      // skips the file write entirely when both values already match
      // what's on disk.
      await activeService.writeConfigPatchTargeted({
        onboarding: {
          completed: true,
          completedSource: "wizard",
        },
      });
      const snapshot = await activeService.readSettingsProjection();
      await options?.onConfigPatchWritten?.(
        {
          onboarding: { completed: true, completedSource: "wizard" },
        },
      );

      const shouldConnect = request?.connect !== false;
      if (shouldConnect) {
        // Same one-time discovery the startup path would have done. This is
        // an explicit setup action, so it may initialize Codex after the
        // bootstrap profile has graduated. Keep it off the wizard response.
        const registry = getDesktopBackendRegistry();
        const permit = issueProviderDiscoveryPermit("setup-user-action");
        void registry
          .listThreads({ callerReason: "onboarding-bootstrap" })
          .then(async () => {
            await registry.listBackends(
              { includeUnavailable: true, refreshModels: true },
              permit,
            );
          })
          .catch((error) => {
            settingsIpcLog.warn(
              "onboarding bootstrap thread-list prefetch failed",
              {
                error: error instanceof Error ? error.message : String(error),
              },
            );
          });
      }

      return {
        snapshot: applyRuntimeMessagingSnapshot(snapshot),
        connectInitiated: shouldConnect,
      };
    },
  );
}

export function disposeSettingsIpcHandlers(): void {
  codexLoginManager.dispose();
  recentAcpRefreshes.clear();
  ipcMain.removeHandler(ACP_AGENTS_LIST_CHANNEL);
  ipcMain.removeHandler(ACP_AGENT_INSTALL_CHANNEL);
  ipcMain.removeHandler(ACP_AGENT_UPDATE_ACKNOWLEDGE_CHANNEL);
  ipcMain.removeHandler(SETTINGS_READ_CHANNEL);
  ipcMain.removeHandler(SETTINGS_READ_BOOTSTRAP_CHANNEL);
  ipcMain.removeHandler(SETTINGS_READ_MESSAGING_CHANNEL);
  ipcMain.removeHandler(SETTINGS_READ_FULL_ACCESS_POLICY_CHANNEL);
  ipcMain.removeHandler(SETTINGS_WRITE_CONFIG_CHANNEL);
  ipcMain.removeHandler(SETTINGS_REPLACE_SECRET_CHANNEL);
  ipcMain.removeHandler(SETTINGS_CLEAR_SECRET_CHANNEL);
  ipcMain.removeHandler(SETTINGS_REFRESH_CODEX_DISCOVERY_CHANNEL);
  ipcMain.removeHandler(SETTINGS_CREATE_CODEX_AUTH_PROFILE_CHANNEL);
  ipcMain.removeHandler(SETTINGS_START_CODEX_AUTH_PROFILE_LOGIN_CHANNEL);
  ipcMain.removeHandler(SETTINGS_CHECK_CODEX_AUTH_PROFILE_STATUS_CHANNEL);
  ipcMain.removeHandler(SETTINGS_PICK_GH_COMMAND_CHANNEL);
  ipcMain.removeHandler(SETTINGS_PICK_GIT_COMMAND_CHANNEL);
  ipcMain.removeHandler(SETTINGS_REFRESH_GIT_DISCOVERY_CHANNEL);
  ipcMain.removeHandler(SETTINGS_INSPECT_CODE_SIGNATURES_CHANNEL);
  ipcMain.removeHandler(SETTINGS_TEST_CREDENTIALS_CHANNEL);
  ipcMain.removeHandler(SETTINGS_LAST_CREDENTIAL_TEST_CHANNEL);
  ipcMain.removeHandler(SETTINGS_OPEN_SLACK_CREATE_APP_CHANNEL);
  ipcMain.removeHandler(SETTINGS_LIST_DISCORD_THREAD_PERMISSION_CHANNELS_CHANNEL);
  ipcMain.removeHandler(SETTINGS_INSPECT_DISCORD_THREAD_PERMISSIONS_CHANNEL);
  ipcMain.removeHandler(SETTINGS_OPEN_DISCORD_THREAD_PERMISSION_CHANNEL);
  ipcMain.removeHandler(SETTINGS_RESOLVE_MESSAGING_CONTACT_CHANNEL);
  ipcMain.removeHandler(ONBOARDING_COMPLETE_CODEX_BOOTSTRAP_CHANNEL);
  disposeCredentialTester();
}
