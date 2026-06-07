import { BrowserWindow, dialog, ipcMain, shell } from "electron";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type {
  AcpAgentPreference,
  AcpAgentSettingsEntry,
  CheckDesktopCodexAuthProfileStatusRequest,
  CheckDesktopCodexAuthProfileStatusResponse,
  ClearDesktopSettingsSecretRequest,
  CompleteOnboardingCodexBootstrapRequest,
  CompleteOnboardingCodexBootstrapResponse,
  CreateDesktopCodexAuthProfileRequest,
  CreateDesktopCodexAuthProfileResponse,
  DesktopMessagingContactLookupRequest,
  DesktopMessagingContactLookupResponse,
  DesktopSettingsConfigPatch,
  DesktopSettingsSecretName,
  DesktopSettingsWriteResponse,
  DesktopSettingsSnapshot,
  ListAcpAgentSettingsRequest,
  ListAcpAgentSettingsResponse,
  ReadDesktopSettingsRequest,
  ReadDesktopSettingsResponse,
  PickGhCommandResponse,
  RefreshDesktopCodexDiscoveryRequest,
  ReplaceDesktopSettingsSecretRequest,
  SettingsCredentialTestKind,
  SettingsCredentialTestRequest,
  SettingsCredentialTestResult,
  StartDesktopCodexAuthProfileLoginRequest,
  StartDesktopCodexAuthProfileLoginResponse,
  WriteDesktopSettingsConfigRequest,
} from "@pwragent/shared";
import {
  isMessagingRuntimeSecret,
  sanitizeMessagingContactHandle,
  sanitizeMessagingContactLabel,
} from "@pwragent/shared";
import {
  ONBOARDING_COMPLETE_CODEX_BOOTSTRAP_CHANNEL,
  ACP_AGENTS_LIST_CHANNEL,
  SETTINGS_CHECK_CODEX_AUTH_PROFILE_STATUS_CHANNEL,
  SETTINGS_CLEAR_SECRET_CHANNEL,
  SETTINGS_CREATE_CODEX_AUTH_PROFILE_CHANNEL,
  SETTINGS_LAST_CREDENTIAL_TEST_CHANNEL,
  SETTINGS_PICK_GH_COMMAND_CHANNEL,
  SETTINGS_READ_CHANNEL,
  SETTINGS_REFRESH_CODEX_DISCOVERY_CHANNEL,
  SETTINGS_REPLACE_SECRET_CHANNEL,
  SETTINGS_RESOLVE_MESSAGING_CONTACT_CHANNEL,
  SETTINGS_START_CODEX_AUTH_PROFILE_LOGIN_CHANNEL,
  SETTINGS_TEST_CREDENTIALS_CHANNEL,
  SETTINGS_WRITE_CONFIG_CHANNEL,
} from "../../shared/ipc";
import type { DesktopSettingsService } from "../settings/desktop-settings-service";
import { getDesktopSettingsService } from "../settings/desktop-settings-singleton";
import {
  resolveGrokCliPathOverride,
  resolveQwenCliPathOverride,
} from "../settings/desktop-config";
import {
  disposeDesktopBackendRegistry,
  getDesktopBackendRegistry,
} from "../app-server/backend-registry";
import { CredentialTester } from "../credential-tester/credential-tester";
import { getDesktopMessagingRuntime } from "../messaging/messaging-runtime";
import { loadDesktopMessagingConfigFromSettings } from "../messaging/messaging-config";
import { resolveRuntimeMessagingOverride } from "../runtime-flags";
import { getRuntimeMessagingLeaseCoordinator } from "../runtime-messaging-lease";
import { validateGhCommand } from "../settings/gh-discovery";
import {
  CodexLoginManager,
  collectCodexStatus,
  createCodexAuthProfile,
  readCodexAuthInfo,
  resolveCodexHomeForProfile,
  resolveDefaultCodexHome,
} from "@pwrdrvr/codex-discovery";
import { getMainLogger } from "../log";
import { AcpAgentStore } from "../acp/acp-agent-store";
import { isBannedAcpRegistryId } from "../acp/acp-agent-allowlist";
import { discoverLocalAcpAgentRecords } from "../acp/acp-instance-discovery";
import { discoverAcpRuntimeCapabilities } from "../acp/acp-runtime-discovery";
import { shouldReprobeAcpCapabilities } from "../acp/acp-capability-freshness";
import { describeDistributionSource } from "../acp/acp-install-provenance";
import { selectAcpDistributionForCurrentPlatform } from "../acp/acp-platform-distribution";
import { AcpRegistryService } from "../acp/acp-registry-service";
import type {
  AcpInstalledAgentRecord,
  AcpRegistryAgent,
  AcpRegistryAgentWithPolicy,
  AcpRegistryDistribution,
  AcpRegistrySnapshot,
} from "../acp/acp-registry-types";
import { getAppStateDb } from "../state/app-state";
import { normalizeProfileName, resolveActiveProfileDir } from "../profile";

const settingsIpcLog = getMainLogger("pwragent:settings");
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

async function refreshModelBackendsIfNeeded(params: {
  patch?: WriteDesktopSettingsConfigRequest["patch"];
  secret?: ReplaceDesktopSettingsSecretRequest["secret"];
}): Promise<void> {
  if (
    params.patch?.models?.codex?.path !== undefined
    || params.secret === "grokApiKey"
  ) {
    await disposeDesktopBackendRegistry();
  }
}

// Coalesces concurrent ACP refreshes. A refresh runs cheap local discovery and
// may launch agents to probe capabilities; React StrictMode double-fires the
// settings-pane mount effect (dev) and users can double-click "Discover new",
// so without this two passes would launch the same agents in parallel. Pure
// cache reads (refresh === false) never launch and are not coalesced.
//
// We track whether the in-flight pass was forced so a caller only rides a pass
// that satisfies it: a non-forced caller can ride any in-flight pass, but a
// forced caller ("Discover new") only rides an in-flight *forced* pass —
// otherwise it would silently inherit a freshness-gated pass that skipped the
// re-probe it asked for. This is what stops two rapid "Discover new" clicks
// from launching every agent twice in parallel. A forced caller that arrives
// while only a non-forced pass is in flight still starts its own pass, so
// "Discover new" is never a no-op.
let inFlightAcpRefresh: Promise<ListAcpAgentSettingsResponse> | undefined;
let inFlightAcpRefreshForced = false;

async function listAcpAgentSettings(
  request: ListAcpAgentSettingsRequest = {},
): Promise<ListAcpAgentSettingsResponse> {
  if (request.refresh === false) {
    return await listAcpAgentSettingsImpl(request);
  }
  const wantsForce = request.force === true;
  if (inFlightAcpRefresh && (!wantsForce || inFlightAcpRefreshForced)) {
    return await inFlightAcpRefresh;
  }
  const run = listAcpAgentSettingsImpl(request).finally(() => {
    if (inFlightAcpRefresh === run) {
      inFlightAcpRefresh = undefined;
      inFlightAcpRefreshForced = false;
    }
  });
  inFlightAcpRefresh = run;
  inFlightAcpRefreshForced = wantsForce;
  return await run;
}

async function listAcpAgentSettingsImpl(
  request: ListAcpAgentSettingsRequest = {},
): Promise<ListAcpAgentSettingsResponse> {
  const store = new AcpAgentStore(getAppStateDb());
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
  const installed = await listInstalledAndLocalAcpAgents(store, {
    refreshLocal: request.refresh === true,
    ...(request.force === true ? { force: true } : {}),
  });
  const entries = snapshot
    ? registryService
        .applyAllowlist(snapshot)
        .filter((agent) => agent.allowlist.allowed)
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

  return {
    fetchedAt: snapshot?.fetchedAt ?? Date.now(),
    entries,
    ...(error ? { error } : {}),
  };
}

async function listInstalledAndLocalAcpAgents(
  store: AcpAgentStore,
  options?: { refreshLocal?: boolean; force?: boolean },
): Promise<AcpInstalledAgentRecord[]> {
  const installed = store.listInstalledAgents();
  let discovered: AcpInstalledAgentRecord[] = [];
  if (options?.refreshLocal) {
    try {
      const grokOverride = resolveGrokCliPathOverride();
      const qwenOverride = resolveQwenCliPathOverride();
      const preferences: Record<string, AcpAgentPreference> = {
        ...(grokOverride ? { grok: { overridePath: grokOverride } } : {}),
        ...(qwenOverride ? { qwen: { overridePath: qwenOverride } } : {}),
      };
      discovered = await discoverLocalAcpAgentRecords({
        ...(Object.keys(preferences).length > 0 ? { preferences } : {}),
      });
      const discoveryCwd = await ensureAcpRuntimeDiscoveryWorkspace();
      const now = Date.now();
      for (const record of discovered) {
        const current = store.getInstalledAgent(record.backendId);
        const nextRecord = {
          ...record,
          runtimeCapabilities: current?.runtimeCapabilities,
          lastDiscoveredAt: current?.lastDiscoveredAt,
          lastDiscoveryError: current?.lastDiscoveryError,
          installedAt: current?.installedAt ?? record.installedAt,
          updatedAt: Math.max(current?.updatedAt ?? 0, record.updatedAt),
        } satisfies AcpInstalledAgentRecord;
        // Cheap local discovery (above) always runs to find newly-installed
        // agents and refresh version metadata. The EXPENSIVE runtime-capability
        // probe launches the agent over ACP, so gate it: only re-probe agents
        // that are undiscovered, stale, or version-changed (or when forced).
        // Otherwise persist the merged record carrying the cached capabilities
        // without launching anything.
        if (
          shouldReprobeAcpCapabilities(current, record.version, now, {
            ...(options?.force === true ? { force: true } : {}),
          })
        ) {
          store.upsertInstalledAgent(
            await refreshAcpRuntimeCapabilities(nextRecord, discoveryCwd),
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
    ? store.listInstalledAgents()
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
        !isBannedAcpRegistryId(record.registryId),
    ),
  ];
}

async function refreshAcpRuntimeCapabilities(
  record: AcpInstalledAgentRecord,
  cwd: string,
): Promise<AcpInstalledAgentRecord> {
  const now = Date.now();
  try {
    const result = await discoverAcpRuntimeCapabilities(record, { cwd });
    return {
      ...record,
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
      lastDiscoveryError: error instanceof Error ? error.message : String(error),
      updatedAt: Math.max(record.updatedAt, now),
    };
  }
}

async function ensureAcpRuntimeDiscoveryWorkspace(): Promise<string> {
  const directory = path.join(
    resolveActiveProfileDir(),
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

function installedAcpAgentSettingsEntry(
  record: AcpInstalledAgentRecord,
  registryAgent?: AcpRegistryAgent,
): AcpAgentSettingsEntry {
  const agent = registryAgent ?? record.registryAgent;
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
    installable: false,
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
    ...(record.instances !== undefined ? { instances: record.instances } : {}),
    ...(record.activeCommand !== undefined
      ? { activeCommand: record.activeCommand }
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
  const snapshot = await service.readSettings();
  const command = snapshot.models.codex.discovery.selectedCommand;
  if (!command) {
    throw new Error("No Codex command is configured or discoverable.");
  }
  return command;
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

function applyRuntimeMessagingSnapshot(
  snapshot: DesktopSettingsSnapshot,
): DesktopSettingsSnapshot {
  const leaseSnapshot = getRuntimeMessagingLeaseCoordinator().snapshot();
  const leaseOverrideActive = leaseSnapshot.disabledReasonKind === "lease_held";
  const overrideActive =
    snapshot.runtime.messaging.overrideActive === true || leaseOverrideActive;
  const runtimeEnabled = overrideActive
    ? getDesktopMessagingRuntime().isEnabled()
    : snapshot.messaging.enabled.value;
  const disabledReason =
    leaseSnapshot.disabledReason ?? snapshot.runtime.messaging.disabledReason;
  const disabledReasonKind =
    leaseSnapshot.disabledReasonKind
    ?? snapshot.runtime.messaging.disabledReasonKind;
  return {
    ...snapshot,
    runtime: {
      ...snapshot.runtime,
      messaging: {
        ...snapshot.runtime.messaging,
        disabled: overrideActive
          ? !runtimeEnabled
          : snapshot.messaging.enabled.value === false,
        overrideActive,
        ...(disabledReason ? { disabledReason } : {}),
        ...(disabledReasonKind ? { disabledReasonKind } : {}),
        ...(leaseSnapshot.leaseHolder
          ? { leaseHolder: leaseSnapshot.leaseHolder }
          : {}),
      },
    },
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
      if (request.kind !== "user" && request.kind !== "workspace") {
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
      resolveFeishuAppId: () =>
        resolveService().resolveFeishuAppIdSync(),
      resolveFeishuAppSecret: () =>
        resolveService().resolveFeishuAppSecretSync(),
      resolveFeishuTenantUrl: () =>
        resolveService().resolveFeishuTenantUrlSync(),
      resolveLineChannelAccessToken: () =>
        resolveService().resolveLineChannelAccessTokenSync(),
      resolveGrokApiKey: () => resolveService().resolveGrokApiKey(),
      resolveCodexCommand: async () => {
        const snapshot = await resolveService().readSettings();
        return snapshot.models.codex.discovery.selectedCommand ?? undefined;
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
      snapshot: DesktopSettingsSnapshot,
    ) => void | Promise<void>;
  },
): void {
  ipcMain.removeHandler(ACP_AGENTS_LIST_CHANNEL);
  ipcMain.handle(
    ACP_AGENTS_LIST_CHANNEL,
    async (
      _event,
      request?: ListAcpAgentSettingsRequest,
    ): Promise<ListAcpAgentSettingsResponse> => await listAcpAgentSettings(request),
  );

  ipcMain.removeHandler(SETTINGS_READ_CHANNEL);
  ipcMain.handle(
    SETTINGS_READ_CHANNEL,
    async (
      _event,
      _request?: ReadDesktopSettingsRequest,
    ): Promise<ReadDesktopSettingsResponse> => ({
      snapshot: applyRuntimeMessagingSnapshot(
        await getService(service).readSettings(),
      ),
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
      const snapshot = await activeService.writeConfigPatch(request.patch);
      await options?.onConfigPatchWritten?.(request.patch, snapshot);
      await refreshModelBackendsIfNeeded({ patch: request.patch });
      if (messagingPatchTouchesRuntime(request.patch)) {
        await applyLatestMessagingRuntimeConfig(activeService);
      }
      return { snapshot: applyRuntimeMessagingSnapshot(snapshot) };
    },
  );

  ipcMain.removeHandler(SETTINGS_REPLACE_SECRET_CHANNEL);
  ipcMain.handle(
    SETTINGS_REPLACE_SECRET_CHANNEL,
    async (
      _event,
      request: ReplaceDesktopSettingsSecretRequest,
    ): Promise<DesktopSettingsWriteResponse> => {
      const activeService = getService(service);
      const snapshot = await activeService.replaceSecret(
        request.secret,
        request.value,
      );
      await refreshModelBackendsIfNeeded({ secret: request.secret });
      if (messagingSecretTouchesRuntime(request.secret)) {
        await applyLatestMessagingRuntimeConfig(activeService);
      }
      return { snapshot: applyRuntimeMessagingSnapshot(snapshot) };
    },
  );

  ipcMain.removeHandler(SETTINGS_CLEAR_SECRET_CHANNEL);
  ipcMain.handle(
    SETTINGS_CLEAR_SECRET_CHANNEL,
    async (
      _event,
      request: ClearDesktopSettingsSecretRequest,
    ): Promise<DesktopSettingsWriteResponse> => {
      const activeService = getService(service);
      const snapshot = await activeService.clearSecret(request.secret);
      await refreshModelBackendsIfNeeded({ secret: request.secret });
      if (messagingSecretTouchesRuntime(request.secret)) {
        await applyLatestMessagingRuntimeConfig(activeService);
      }
      return { snapshot: applyRuntimeMessagingSnapshot(snapshot) };
    },
  );

  ipcMain.removeHandler(SETTINGS_REFRESH_CODEX_DISCOVERY_CHANNEL);
  ipcMain.handle(
    SETTINGS_REFRESH_CODEX_DISCOVERY_CHANNEL,
    async (
      _event,
      _request?: RefreshDesktopCodexDiscoveryRequest,
    ): Promise<ReadDesktopSettingsResponse> => ({
      snapshot: applyRuntimeMessagingSnapshot(
        await getService(service).readSettings(),
      ),
    }),
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
      const snapshot = await activeService.writeConfigPatch({
        onboarding: {
          completed: true,
          completedSource: "wizard",
        },
      });
      await options?.onConfigPatchWritten?.(
        {
          onboarding: { completed: true, completedSource: "wizard" },
        },
        snapshot,
      );

      const shouldConnect = request?.connect !== false;
      if (shouldConnect) {
        // Same prefetch the startup path would have done. Fire-and-forget;
        // errors are logged by the registry's own diagnostic plumbing.
        void getDesktopBackendRegistry()
          .listThreads({ callerReason: "onboarding-bootstrap" })
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
  ipcMain.removeHandler(ACP_AGENTS_LIST_CHANNEL);
  ipcMain.removeHandler(SETTINGS_READ_CHANNEL);
  ipcMain.removeHandler(SETTINGS_WRITE_CONFIG_CHANNEL);
  ipcMain.removeHandler(SETTINGS_REPLACE_SECRET_CHANNEL);
  ipcMain.removeHandler(SETTINGS_CLEAR_SECRET_CHANNEL);
  ipcMain.removeHandler(SETTINGS_REFRESH_CODEX_DISCOVERY_CHANNEL);
  ipcMain.removeHandler(SETTINGS_CREATE_CODEX_AUTH_PROFILE_CHANNEL);
  ipcMain.removeHandler(SETTINGS_START_CODEX_AUTH_PROFILE_LOGIN_CHANNEL);
  ipcMain.removeHandler(SETTINGS_CHECK_CODEX_AUTH_PROFILE_STATUS_CHANNEL);
  ipcMain.removeHandler(SETTINGS_PICK_GH_COMMAND_CHANNEL);
  ipcMain.removeHandler(SETTINGS_TEST_CREDENTIALS_CHANNEL);
  ipcMain.removeHandler(SETTINGS_LAST_CREDENTIAL_TEST_CHANNEL);
  ipcMain.removeHandler(SETTINGS_RESOLVE_MESSAGING_CONTACT_CHANNEL);
  ipcMain.removeHandler(ONBOARDING_COMPLETE_CODEX_BOOTSTRAP_CHANNEL);
  disposeCredentialTester();
}
