import { ThreadMaintenanceToolScans } from "../agent-tools/thread-maintenance-tool-scans";
import type { RegistryContext } from "./registry-context";
import { getMainLogger } from "../log";
import { applicationHost as app, getOwnerHostServices } from "../owner-host";
import { buildPwrAgentToolGuideDefinition } from "../agent-tools/pwragent-tool-guide";
import { buildPwrAgentTaskMonitorToolDefinitions } from "../agent-tools/pwragent-task-monitor-agent-tools";
import { ClaudeBackend } from "../claude/claude-backend";
import { inspectClaudeInstallation } from "../claude/claude-executable";
import { openClaudeSessionReader } from "../claude/claude-session-reader";
import { PlanLimitStore } from "./plan-limit-store";
import { DEFAULT_CHECKOUT_HIBERNATION_POLICY, DEFAULT_THREAD_ARCHIVE_POLICY } from "@pwragent/shared";
import { restartGateHolds } from "./restart-continuation-gate";
import { wrapCodexProviderUsageAttribution } from "./codex-provider-usage-attribution";
import { CodexModelProviderCatalog } from "./codex-model-provider-catalog";
import { createProviderRuntimeClient } from "../codex-app-server/provider-runtime-client";
import { bonsaiNativeMcpOverrides, prepareBonsaiRuntime } from "../codex-app-server/bonsai-runtime";
import { codexModelProviderApiKeyEnv, PWRAGENT_TOOL_NAMESPACE, type CodexModelProviderSettings } from "@pwragent/shared";
import { ThreadCorrespondenceStore } from "./thread-correspondence-store";
import { PendingEnvironmentLaunchStore } from "./pending-environment-launch-store";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import {
  findLiveProfileRuntimeMarkers,
  getProcessRuntimeIdentity,
  resolveActiveProfileName,
  resolveActiveProfilePath,
} from "../profile";
import {
  createAcpAvailableCommandsStorage,
  createArchiveCleanupCheckpointStorage,
  createProjectHeldWakeupStorage,
  createProviderThreadSnapshotStorage,
  createRetainedOwnerThreadStorage,
  createRestartContinuationStorage,
  createTokenMiserStorage,
} from "../storage/desktop-runtime-storage";
import { getAppStateMode, isAppStateInitialized } from "../storage/desktop-runtime-storage";
import { getMcpConnectionGatewayService } from "../mcp-connections/mcp-connection-gateway-service";
import {
  buildThreadIdentityKey,
  isAcpBackendId,
  DEFAULT_PR_AUTO_DISPATCH_ENABLED_FOR_NEW_THREADS,
  DESKTOP_SPEND_ALERT_POLICY_DEFAULT,
  DESKTOP_TOOL_OUTPUT_ALERT_POLICY_DEFAULT,
} from "@pwragent/shared";
import { AcpBackendAdapter, createLocalAcpAgentDiscovery, noLocalAcpAgentDiscovery } from "./acp-backend-adapter";
import { CodexAppServerClient } from "../codex-app-server/desktop-client";
import { DEFAULT_CODEX_APP_SERVER_RECYCLE_SETTINGS } from "../codex-app-server/app-server-recycle-policy";
import { buildPwrAgentMessagingPdfToolRouter } from "../agent-tools/pwragent-messaging-agent-tools";
import { resolveAutomationInspectionMcpCommand } from "../automations/automation-inspection-cli";
import { resolveAgentToolCatalogs } from "../agent-tools/agent-tool-catalog-registry";
import { AgentToolRouter } from "../agent-tools/agent-tool-router";
import { buildMcpGatewayToolDefinitions } from "../agent-tools/pwragent-mcp-gateway-tools";
import { McpGatewayToolService } from "../mcp-connections/mcp-gateway-tool-service";
import { getTokenMiserBridgeDescriptorPath, TokenMiserHookBridge } from "../token-miser/token-miser-hook-bridge";
import { TokenMiserPluginManager } from "../token-miser/token-miser-plugin-manager";
import { TOKEN_MISER_DIAGNOSTICS_DIRNAME } from "../token-miser/token-miser-types";
import { TokenMiserDiagnostics } from "../token-miser/token-miser-diagnostics";
import { TokenMiserService } from "../token-miser/token-miser-service";
import { AgentToolMcpServer } from "../agent-tools/agent-tool-mcp-server";
import { createScratchProjectDirectory as defaultCreateScratchProjectDirectory } from "./scratch-projects";
import { CodexProtocolCaptureSession } from "../diagnostics/codex-protocol-capture";
import { getDesktopOverlayStore } from "../storage/desktop-overlay-store";
import { createProtocolCaptureFromEnv } from "../testing/protocol-capture";
import type { ProtocolCaptureStore } from "../testing/capture-store";
import { GitDirectoryService } from "./git-directory-service";
import { GitWorkingStateService } from "./git-working-state-service";
import { resolveWorktreeRepositoryDirectory } from "./thread-directory-enricher";
import { GitWorkspaceHandoffService } from "./git-workspace-handoff-service";
import { WorktreeArchiveService } from "./worktree-archive-service";
import { WorktreeRecoveryService } from "./worktree-recovery-service";
import { userHomeWorktreesRoot } from "../settings/desktop-config";
import { WorktreeContainerService } from "./worktree-container-service";
import { createCompositeJsonRpcObserver, createProtocolLogObserverFromEnv } from "./protocol-log-observer";
import { ThreadTitleGenerationService } from "@pwragent/owner-core/thread-title-generation-service";
import { AcpThreadTitleGenerator } from "./acp-thread-title-generator";
import { ensureAcpHelperWorkspace } from "../acp/acp-capability-probe";
import { getDesktopConfigStore, getDesktopSettingsService } from "../settings/desktop-settings-singleton";
import { resolveSpendAlertPolicy, resolveToolOutputAlertPolicy } from "../settings/config-store/config-domains";
import {
  acpProviderEnabledFromSnapshot,
  providerProjectionForRegistryId,
} from "../settings/config-store/provider-runtime-config";
import { ONBOARDING_CODEX_GATE_ENABLED } from "../settings/desktop-settings-service";
import { BackendModelCatalog } from "./backend-model-catalog";
import { ThreadTurnQueue } from "@pwragent/owner-core/thread-turn-queue";
import { QueuedMessageTitler } from "./queued-message-title";
import {
  ACP_AVAILABLE_COMMAND_PROBE_BUDGET_MS,
  ACP_SESSION_IDLE_CLOSE_MS,
  CODEX_THREAD_IDLE_UNSUBSCRIBE_MS,
  RUNNING_TURN_SHUTDOWN_STOP_TIMEOUT_MS,
  createReplayClientsFromEnv,
  readProviderRuntimeFingerprints,
} from "./backend-registry-runtime-helpers";
import { buildPendingRequestKey } from "./thread-turn-keys";
import { GROK_TITLE_HELPER_SESSION_POLICY, createReplayThreadTitleService } from "./thread-transcript-helpers";
import { buildCodexClientArgs, withTokenMiserBridgeDescriptorEnv } from "./codex-thread-config";
import { createDefaultCodexEnvironmentHydrationStore } from "./thread-launchpad-helpers";
import { DesktopBackendRegistry } from "./backend-registry";
import { ForgeToolBridge } from "./forge-tool-bridge";
import { ThreadInspectionTools } from "./thread-inspection-tools";
import type { DesktopBackendRegistryOptions, RegistryDependencies } from "./backend-registry-construction";
import { bundledSkillRoot, materializeBundledSkills } from "../agent-tools/bundled-skill-root";
import { isAgentToolCallAllowed } from "../headless/outpost-agent-tools";
import { localAgentToolAllowlist } from "../member-containment";

// A contained member's MCP clients see only its allowed PwrAgent tools.
function isMcpToolAdvertised(name: string): boolean {
  const allowlist = localAgentToolAllowlist();
  return !allowlist || isAgentToolCallAllowed(allowlist, { namespace: PWRAGENT_TOOL_NAMESPACE, tool: name });
}

const backendRegistryLog = getMainLogger("pwragent:backend-registry");

/** The domain modules the composition root built for one registry. */
export interface RegistryModules {
  readonly forgeToolBridge: ForgeToolBridge;
  readonly threadInspectionTools: ThreadInspectionTools;
}

const registryModulesByRegistry = new WeakMap<DesktopBackendRegistry, RegistryModules>();

/**
 * Tests reach an extracted module's public interface here instead of casting
 * into the registry. Production code calls the registry's facade members;
 * backend-registry-wiring.property.test.ts holds that rule.
 */
export function registryModules(registry: DesktopBackendRegistry): RegistryModules {
  const modules = registryModulesByRegistry.get(registry);
  if (!modules) throw new Error("This registry was not built by createDesktopBackendRegistry.");
  return modules;
}

/** Owner-only composition. Provider callbacks bind after all collaborators exist. */
export function createDesktopBackendRegistry(options?: DesktopBackendRegistryOptions): DesktopBackendRegistry {
  let ports: ReturnType<DesktopBackendRegistry["constructionPorts"]>;
  const initialize: Array<() => void> = [];
  const planLimits = new PlanLimitStore();
  const captureStores: ProtocolCaptureStore[] = [];
  let ownerAdmission: RegistryDependencies["ownerAdmission"];
  let configStore: RegistryDependencies["configStore"];
  let archiveCleanupCheckpointStore: RegistryDependencies["archiveCleanupCheckpointStore"];
  let projectHeldWakeupStore: RegistryDependencies["projectHeldWakeupStore"];
  let restartContinuationStore: RegistryDependencies["restartContinuationStore"];
  let mcpConnectionService: RegistryDependencies["mcpConnectionService"];
  let providerThreadSnapshotStore: RegistryDependencies["providerThreadSnapshotStore"];
  let retainedOwnerThreadStorage: RegistryDependencies["retainedOwnerThreadStorage"];
  let codexProtocolCaptureSession: RegistryDependencies["codexProtocolCaptureSession"];
  let resolveCodexRuntimeCommandFn: RegistryDependencies["resolveCodexRuntimeCommandFn"];
  let resolveTokenMiserCodexRuntimeFn: RegistryDependencies["resolveTokenMiserCodexRuntimeFn"];
  let codexEnvironmentCommandEnv: RegistryDependencies["codexEnvironmentCommandEnv"];
  let codexEnvironmentCommandRunner: RegistryDependencies["codexEnvironmentCommandRunner"];
  let codexEnvironmentHydrationStore: RegistryDependencies["codexEnvironmentHydrationStore"];
  let tokenMiserDiagnostics: RegistryDependencies["tokenMiserDiagnostics"];
  let tokenMiserStore: RegistryDependencies["tokenMiserStore"];
  let tokenMiserServiceValue: RegistryDependencies["tokenMiserService"];
  let tokenMiserHookBridge: RegistryDependencies["tokenMiserHookBridge"];
  let tokenMiserCodeModeReducerDescriptorPath: RegistryDependencies["tokenMiserCodeModeReducerDescriptorPath"];
  let tokenMiserPluginManager: RegistryDependencies["tokenMiserPluginManager"];
  let acpAvailableCommandsStore: RegistryDependencies["acpAvailableCommandsStore"];
  let mcpGatewayTools: RegistryDependencies["mcpGatewayTools"];
  let pdfToolMcpServer: RegistryDependencies["pdfToolMcpServer"];
  let claudeAgentToolMcpServer: RegistryDependencies["claudeAgentToolMcpServer"];
  let messagingStore: RegistryDependencies["messagingStore"];
  let messagingArchiveCleaner: RegistryDependencies["messagingArchiveCleaner"];
  let appManagementHandler: RegistryDependencies["appManagementHandler"];
  let starMapHandler: RegistryDependencies["starMapHandler"];
  let createScheduledThreadActionFn: RegistryDependencies["createScheduledThreadActionFn"];
  let threadTitleGenerationService: RegistryDependencies["threadTitleGenerationService"];
  ownerAdmission = options?.ownerAdmission;
  initialize.push(() => {
    ports.activeTurnKeys.onDelete((key) => { ports.activeCodexTurnCollaborationModes.delete(key); });
  });
  const managedMaintenanceRoots = options?.managedWorktreeRoots
    ?? (async () => [userHomeWorktreesRoot(), resolveActiveProfilePath("worktrees")]);
  const readThreadArchivePolicy = options?.getThreadArchivePolicy ?? (() => {
    try { return getDesktopSettingsService().resolveThreadArchivePolicy(); }
    catch { return { ...DEFAULT_THREAD_ARCHIVE_POLICY }; }
  });
  const readCheckoutHibernationPolicy = options?.getCheckoutHibernationPolicy ?? (() => {
    try { return getDesktopSettingsService().resolveCheckoutHibernationPolicy(); }
    catch { return { ...DEFAULT_CHECKOUT_HIBERNATION_POLICY }; }
  });
  const processRuntimeIdentity = getProcessRuntimeIdentity();
  configStore = options?.configStore;
  const runtimeInstanceId =
    options?.runtimeInstanceId ?? processRuntimeIdentity.instanceId;
  archiveCleanupCheckpointStore = options?.archiveCleanupCheckpointStore === null ? undefined
    : options?.archiveCleanupCheckpointStore ?? (isAppStateInitialized() ? createArchiveCleanupCheckpointStorage() : undefined);
  projectHeldWakeupStore = options?.projectHeldWakeupStore === null ? undefined
    : options?.projectHeldWakeupStore ?? (isAppStateInitialized() ? createProjectHeldWakeupStorage() : undefined);
  restartContinuationStore = options?.restartContinuationStore === null ? undefined
    : options?.restartContinuationStore ?? (isAppStateInitialized() ? createRestartContinuationStorage() : undefined);
  const restartDispatchPlanOptions = options?.restartDispatchPlan ?? {};
  const registrySessionId = options?.registrySessionId ?? randomUUID();
  const runningTurnShutdownStopTimeoutMs =
    options?.runningTurnShutdownStopTimeoutMs
    ?? RUNNING_TURN_SHUTDOWN_STOP_TIMEOUT_MS;
  const resolveLiveProfileRuntimeInstanceIdsFn =
    options?.resolveLiveProfileRuntimeInstanceIds ??
    (() =>
      findLiveProfileRuntimeMarkers(resolveActiveProfileName()).map(
        (marker) => marker.instanceId,
      ));
  mcpConnectionService =
    options?.mcpConnectionService === null
      ? undefined
      : options?.mcpConnectionService ??
        (isAppStateInitialized() ? getMcpConnectionGatewayService() : undefined);
  initialize.push(() => {
    ports.mcpConnectionService?.setThreadRootsResolver?.(
      async (scope) => await ports.resolveThreadMcpRootDirectories(scope),
    );
  });
  providerThreadSnapshotStore =
    options?.providerThreadSnapshotStore === null
      ? undefined
      : options?.providerThreadSnapshotStore
        ?? (isAppStateInitialized()
          ? createProviderThreadSnapshotStorage()
          : undefined);
  retainedOwnerThreadStorage = options?.retainedOwnerThreadStorage === null ? undefined
    : options?.retainedOwnerThreadStorage ?? (isAppStateInitialized() ? createRetainedOwnerThreadStorage() : undefined);
  const replayClients = createReplayClientsFromEnv();
  const createsLiveCodexClient =
    !options?.codexClient && !replayClients?.codexClient;
  codexProtocolCaptureSession = createsLiveCodexClient
    ? new CodexProtocolCaptureSession()
    : undefined;
  const codexCapture = options?.codexClient
    || replayClients
    ? undefined
    : createProtocolCaptureFromEnv({
        backend: "codex",
        backendInstance: "default",
      });
  if (codexCapture) {
    captureStores.push(codexCapture.store);
  }
  const codexObserver = createCompositeJsonRpcObserver([
    codexCapture?.observer,
    codexProtocolCaptureSession?.observer,
    createProtocolLogObserverFromEnv({
      backend: "codex",
    }),
  ]);
  const settingsService = createsLiveCodexClient
    ? getDesktopSettingsService()
    : undefined;
  const correspondenceStore = options?.correspondenceStore
    ?? new ThreadCorrespondenceStore(isAppStateInitialized()
      ? resolveActiveProfilePath("state/thread-correspondence")
      : undefined);
  const pendingEnvironmentLaunchStore = options?.pendingEnvironmentLaunchStore
    ?? new PendingEnvironmentLaunchStore(isAppStateInitialized()
      ? resolveActiveProfilePath("state/pending-environment-launches")
      : undefined);
  const tokenMiserStateDir =
    createsLiveCodexClient && isAppStateInitialized()
      ? resolveActiveProfilePath("state/token-miser")
      : undefined;
  const tokenMiserBridgeDescriptorPath = tokenMiserStateDir
    ? getTokenMiserBridgeDescriptorPath(
        tokenMiserStateDir,
        runtimeInstanceId,
      )
    : undefined;
  const tokenMiserActivationNonce = tokenMiserStateDir
    ? randomBytes(32).toString("base64url")
    : undefined;
  const resolveCodexDefaultModeRequestUserInputFn =
    options?.resolveCodexDefaultModeRequestUserInput ??
    (() => {
      try {
        return (
          settingsService?.resolveCodexDefaultModeRequestUserInput() ?? false
        );
      } catch (error) {
        backendRegistryLog.warn(
          "failed to resolve Codex default-mode request_user_input setting",
          {
            error: error instanceof Error ? error.message : String(error),
          },
        );
        return false;
      }
    });
  const resolveCodexToolDiscoveryFn = options?.resolveCodexToolDiscovery ?? (() => {
    try {
      return settingsService?.resolveCodexToolDiscovery() ?? true;
    } catch (error) {
      backendRegistryLog.warn("failed to resolve Codex tool discovery setting", {
        error: error instanceof Error ? error.message : String(error),
      });
      return true;
    }
  });
  const resolveDefaultPrAutoDispatchEnabledFn =
    options?.resolveDefaultPrAutoDispatchEnabled ??
    (() => {
      try {
        return (
          settingsService?.resolveDefaultPrAutoDispatchEnabled()
          ?? DEFAULT_PR_AUTO_DISPATCH_ENABLED_FOR_NEW_THREADS
        );
      } catch (error) {
        backendRegistryLog.warn(
          "failed to resolve default Auto-fix PR setting",
          {
            error: error instanceof Error ? error.message : String(error),
          },
        );
        return DEFAULT_PR_AUTO_DISPATCH_ENABLED_FOR_NEW_THREADS;
      }
    });
  const resolveProviderModelDefaultsFn =
    options?.resolveProviderModelDefaults ??
    (() => settingsService?.resolveProviderModelDefaults() ?? {});
  const resolveHelperModelSettingsFn =
    options?.resolveHelperModelSettings ??
    (() => settingsService?.resolveHelperModelSettings?.() ?? { helpers: {} });
  const resolveTaskMonitorModelsFn =
    options?.resolveTaskMonitorModels ??
    (() => settingsService?.resolveTaskMonitorModels?.() ?? {});
  const resolvePassSetupVariablesToAgentsFn =
    options?.resolvePassSetupVariablesToAgents ??
    (() => settingsService?.resolvePassSetupVariablesToAgents?.() ?? true);
  const resolveUsageAccountGroupsFn = options?.resolveUsageAccountGroups
    ?? (() => settingsService?.resolveUsageAccountGroups?.() ?? {});
  const resolveProviderThreadModelMigrationsFn =
    options?.resolveProviderThreadModelMigrations ??
    (() => settingsService?.resolveProviderThreadModelMigrations() ?? {});
  const resolveCodexLocalModelIdsFn = options?.resolveCodexLocalModelIds
    ?? (() => settingsService?.resolveCodexLocalModelIds?.() ?? []);
  const resolveCodexModelProvidersFn = options?.resolveCodexModelProviders
    ?? (() => settingsService?.resolveCodexModelProviders?.() ?? []);
  const resolveCodexModelProviderKeysFn = options?.resolveCodexModelProviderKeys
    ?? (async () => await settingsService?.resolveCodexModelProviderKeys?.() ?? {});
  const resolveCodexFastAllowedFn =
    options?.resolveCodexFastAllowed ??
    (() => settingsService?.resolveCodexFastAllowed() ?? true);
  const resolvePdfAnalysisEnabledFn =
    options?.resolvePdfAnalysisEnabled ??
    (() => {
      try {
        return (
          settingsService ?? getDesktopSettingsService()
        ).resolvePdfAnalysisEnabled();
      } catch (error) {
        backendRegistryLog.warn("failed to resolve PDF analysis setting", {
          error: error instanceof Error ? error.message : String(error),
        });
        return true;
      }
    });
  const acpSessionIdleCloseMs =
    options?.acpSessionIdleCloseMs ?? ACP_SESSION_IDLE_CLOSE_MS;
  const codexThreadIdleUnsubscribeMs =
    options?.codexThreadIdleUnsubscribeMs ?? CODEX_THREAD_IDLE_UNSUBSCRIBE_MS;
  const resolveTokenMiserEnabledFn = options?.resolveTokenMiserEnabled ?? (() => {
    try {
      return (
        settingsService ?? getDesktopSettingsService()
      ).resolveTokenMiserEnabled();
    } catch (error) {
      backendRegistryLog.warn("failed to resolve Token Miser setting", {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  });
  const resolveCodexAppServerRecycleSettingsFn =
    options?.resolveCodexAppServerRecycleSettings ?? (() => {
      try {
        return (
          settingsService ?? getDesktopSettingsService()
        ).resolveCodexAppServerRecycleSettings();
      } catch (error) {
        backendRegistryLog.warn("failed to resolve Codex app server recycle settings", {
          error: error instanceof Error ? error.message : String(error),
        });
        return DEFAULT_CODEX_APP_SERVER_RECYCLE_SETTINGS;
      }
    });
  const resolveTokenMiserDefaultEnabledFn = () => {
    try {
      return (
        settingsService ?? getDesktopSettingsService()
      ).resolveTokenMiserDefaultEnabled();
    } catch (error) {
      backendRegistryLog.warn(
        "failed to resolve Token Miser thread default setting",
        {
          error: error instanceof Error ? error.message : String(error),
        },
      );
      return true;
    }
  };
  const resolveTokenMiserPollingReviewsEnabledFn =
    options?.resolveTokenMiserPollingReviewsEnabled
    ?? (() => {
      try {
        return (
          settingsService ?? getDesktopSettingsService()
        ).resolveTokenMiserPollingReviewsEnabled?.() ?? false;
      } catch (error) {
        backendRegistryLog.warn(
          "failed to resolve Token Miser polling review setting",
          {
            error: error instanceof Error ? error.message : String(error),
          },
        );
        return false;
      }
    });
  const resolveManagedTokenMiserActivationRequiredFn =
    options?.resolveManagedTokenMiserActivationRequired
    ?? (() => settingsService?.requiresManagedTokenMiserActivation() ?? false);
  const markManagedCodexRuntimeSwitchCompleteFn =
    options?.markManagedCodexRuntimeSwitchComplete
    ?? (() => settingsService?.markManagedCodexRuntimeSwitchComplete());
  // A replay or test registry has no settings service and therefore no
  // startup discovery to wait for: its summary is final the moment it is
  // read, never pending.
  const resolveCodexDiscoveryPendingFn =
    options?.resolveCodexDiscoveryPending
    ?? (() => settingsService?.isCodexDiscoveryPending() ?? false);
  const resolveToolOutputAlertPolicyFn =
    options?.resolveToolOutputAlertPolicy ??
    (() => {
      try {
        if (options?.configStore) {
          return resolveToolOutputAlertPolicy(
            options.configStore.read("general"),
          );
        }
        return (
          settingsService ?? getDesktopSettingsService()
        ).resolveToolOutputAlertPolicy();
      } catch (error) {
        backendRegistryLog.warn(
          "failed to resolve tool-output alert settings",
          {
            error: error instanceof Error ? error.message : String(error),
          },
        );
        return DESKTOP_TOOL_OUTPUT_ALERT_POLICY_DEFAULT;
      }
    });
  const resolveSpendAlertPolicyFn =
    options?.resolveSpendAlertPolicy ??
    (() => {
      try {
        if (options?.configStore) {
          return resolveSpendAlertPolicy(
            options.configStore.read("general"),
          );
        }
        if (settingsService) {
          return typeof settingsService.resolveSpendAlertPolicy === "function"
            ? settingsService.resolveSpendAlertPolicy()
            : DESKTOP_SPEND_ALERT_POLICY_DEFAULT;
        }
        return getDesktopSettingsService().resolveSpendAlertPolicy();
      } catch (error) {
        backendRegistryLog.warn(
          "failed to resolve spend alert settings",
          {
            error: error instanceof Error ? error.message : String(error),
          },
        );
        return DESKTOP_SPEND_ALERT_POLICY_DEFAULT;
      }
    });
  const spendAlertPolicy = resolveSpendAlertPolicyFn();
  const toolOutputAlertPolicy = resolveToolOutputAlertPolicyFn();
  initialize.push(() => {
    if (options?.configStore) {
      ports.unsubscribers.push(
        options.configStore.subscribe(["general"], () => {
          ports.spendAlertPolicy = ports.resolveSpendAlertPolicyFn();
          ports.toolOutputAlertPolicy = ports.resolveToolOutputAlertPolicyFn();
        }),
      );
    } else if (typeof settingsService?.onConfigWritten === "function") {
      ports.unsubscribers.push(
        settingsService.onConfigWritten(() => {
          ports.spendAlertPolicy = ports.resolveSpendAlertPolicyFn();
          ports.toolOutputAlertPolicy = ports.resolveToolOutputAlertPolicyFn();
        }),
      );
    }
  });
  const codexCommand = settingsService?.resolveCodexCommandPreference();
  const codexEnv =
    typeof settingsService?.resolveCodexSpawnEnv === "function"
      ? settingsService.resolveCodexSpawnEnv()
      : undefined;
  const codexSpawnEnv = withTokenMiserBridgeDescriptorEnv(
    codexEnv,
    tokenMiserBridgeDescriptorPath,
  );
  resolveCodexRuntimeCommandFn =
    options?.resolveCodexRuntimeCommand
    ?? (settingsService
      ? async () => {
            const selected = await settingsService.resolveCodexCommand();
            const pinned = getOwnerHostServices().runtimePolicy?.codexCommand;
            if (pinned && selected.command !== pinned) throw new Error("The configured Outpost Codex executable is unavailable; refusing to launch another installation.");
            return selected;
          }
      : undefined);
  resolveTokenMiserCodexRuntimeFn = settingsService
    ? async () => {
        const [resolvedCommand, resolvedEnv] = await Promise.all([
          settingsService.resolveCodexCommand(),
          settingsService.resolveCodexSpawnEnvAsync(),
        ]);
        return {
          codexCommand: resolvedCommand.command,
          codexEnv: resolvedEnv,
        };
      }
    : async () => ({
        codexCommand: codexCommand ?? "codex",
        codexEnv: codexEnv ?? process.env,
      });
  codexEnvironmentCommandEnv = codexEnv;
  codexEnvironmentCommandRunner = options?.codexEnvironmentCommandRunner;
  codexEnvironmentHydrationStore =
    options?.codexEnvironmentHydrationStore ??
    createDefaultCodexEnvironmentHydrationStore();
  const codexHome = codexEnv?.CODEX_HOME?.trim() || undefined;
  const localFilePrivateStorageRoots = codexHome ? [codexHome] : [];
  const clientVersion =
    typeof app?.getVersion === "function" ? app.getVersion() : "0.0.0";
  const createCodexClient = (provider?: CodexModelProviderSettings): CodexAppServerClient => {
    let resources: Promise<Awaited<ReturnType<typeof prepareBonsaiRuntime>>> | undefined;
    let cleanup = Promise.resolve();
    const releaseResources = (): Promise<void> => {
      const previous = resources;
      resources = undefined;
      cleanup = cleanup.then(async () => {
        const runtime = await previous?.catch(() => undefined);
        await runtime?.close();
      });
      return cleanup;
    };
    const client = new CodexAppServerClient({
      assertOwnerAdmission: () => ports.assertThreadOwnership(),
      args: settingsService ? undefined : buildCodexClientArgs(codexEnv, [], [], getOwnerHostServices().runtimePolicy),
      command: codexCommand,
      connectionObserver: codexObserver,
      env: codexSpawnEnv,
      resolveArgs: async (env) => {
        const args = buildCodexClientArgs(
            env,
            settingsService?.resolveCodexConfigOverrides?.() ?? [],
            settingsService?.resolveCodexModelProviders?.() ?? [],
            getOwnerHostServices().runtimePolicy,
          );
        if (!provider) return args;
        await cleanup;
        resources ??= prepareBonsaiRuntime(provider, env?.[codexModelProviderApiKeyEnv(provider.id)]);
        try {
          const prepared = await resources;
          const nativeMcpNames = await ports.codexClient.readConfiguredMcpServerNames?.() ?? [];
          return [
            ...args,
            ...bonsaiNativeMcpOverrides(nativeMcpNames).flatMap((override) => ["-c", override]),
            ...prepared.overrides.flatMap((override) => ["-c", override]),
          ];
        } catch (error) {
          await releaseResources();
          throw error;
        }
      },
      resolveCommand: settingsService
        ? async () => {
            const selected = await settingsService.resolveCodexCommand();
            const pinned = getOwnerHostServices().runtimePolicy?.codexCommand;
            if (pinned && selected.command !== pinned) throw new Error("The configured Outpost Codex executable is unavailable; refusing to launch another installation.");
            return selected;
          }
        : undefined,
      resolveEnv: settingsService
        ? async () => withTokenMiserBridgeDescriptorEnv(
            {
              ...await settingsService.resolveCodexSpawnEnvAsync(),
              // Model provider keys go to the App Server alone.
              ...await settingsService.resolveCodexModelProviderEnv?.(),
            },
            tokenMiserBridgeDescriptorPath,
          )
        : undefined,
      resolveModelProviderIds: () => new Set(
        (settingsService?.resolveCodexModelProviders?.() ?? []).map((provider) => provider.id),
      ),
      // Codex reaches PwrAgent through dynamic tools, so the skills PwrAgent
      // ships reach it as files under a root it scans.
      resolveSkillExtraRoots: settingsService
        ? async () => [await materializeBundledSkills(bundledSkillRoot())]
        : undefined,
      clientVersion,
      readHelperModelSettings: () => ports.resolveHelperModelSettingsFn(),
      passSetupVariablesToAgents: () => ports.resolvePassSetupVariablesToAgentsFn(),
      resolveUsageAccountKey: () => ports.captureUsageAccount("codex"),
      resolvePwrdrvrTokenMiserActivationNonce: () =>
        ports.resolveTokenMiserEnabledFn()
          ? tokenMiserActivationNonce
          : undefined,
      // Fire the bootstrap gate at the client level too, not just the
      // listThreads layer. Startup and explicit Settings/setup discovery
      // may initialize this client; ordinary backend summaries are passive.
      isCodexBootstrapDeferred: () => ports.isCodexBootstrapDeferredFn(),
    });
    if (provider) {
      const close = client.close.bind(client);
      client.close = async () => {
        try { await close(); } finally { await releaseResources(); }
      };
      client.onAppServerUnexpectedExit(() => {
        void releaseResources().catch((error) => backendRegistryLog.warn("Bonsai runtime cleanup failed", { error: String(error) }));
      });
    }
    return client;
  };
  const codexClient: RegistryDependencies["codexClient"] = options?.codexClient ?? replayClients?.codexClient ?? createProviderRuntimeClient(
    createCodexClient(),
    {
      resolveProviders: () => settingsService?.resolveCodexModelProviders?.() ?? [],
      create: createCodexClient,
    },
  );
  initialize.push(() => {
    if (typeof settingsService?.onCodexModelProviderKeysChanged === "function") {
      ports.unsubscribers.push(settingsService.onCodexModelProviderKeysChanged(() => {
        ports.codexModelProviderKeysRead = undefined;
        ports.codexModelProviderCatalog?.invalidate();
        void ports.invalidateProviderRuntimeSelections({ acp: false, codex: true }).catch((error) => {
          backendRegistryLog.warn("Codex reconnect after a provider key change failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }));
    }
  });
  initialize.push(() => {
    if (ports.codexClient.onAppServerUnexpectedExit) {
      ports.unsubscribers.push(
        ports.codexClient.onAppServerUnexpectedExit((threadIds) => {
          void ports.handleCodexAppServerUnexpectedExit(threadIds).catch((error) => {
            backendRegistryLog.warn("Codex app server exit cleanup failed", {
              error: error instanceof Error ? error.message : String(error),
            });
          });
        }),
      );
    }
  });
  const watchManagedCodexRuntime =
    options?.watchManagedCodexRuntime
    ?? (typeof settingsService?.watchManagedCodexRuntime === "function"
      ? settingsService.watchManagedCodexRuntime.bind(settingsService)
      : undefined);
  initialize.push(() => {
    if (watchManagedCodexRuntime) {
      ports.unsubscribers.push(
        watchManagedCodexRuntime((change) => {
          backendRegistryLog.info("managed Codex selection changed", {
            enabled: change.enabled,
            reason: change.reason,
            version: change.runtime?.metadata.version,
          });
          ports.codexRuntimeRestartPending = true;
          ports.managedCodexRuntimeSwitchPending = true;
          ports.redescribeCachedCodexRuntime(change.runtime);
          return ports.maybeRestartCodexForManagedRuntimeChange();
        }),
      );
    }
  });
  if (tokenMiserStateDir) {
    tokenMiserDiagnostics = new TokenMiserDiagnostics({
      filePath: path.join(tokenMiserStateDir, TOKEN_MISER_DIAGNOSTICS_DIRNAME, `${runtimeInstanceId}.jsonl`),
      isEnabled: () => {
        try {
          return ports.resolveTokenMiserEnabledFn()
            && ((settingsService ?? getDesktopSettingsService()).resolveTokenMiserDiagnosticsEnabled?.() ?? false);
        } catch { return false; }
      },
      onError: () => backendRegistryLog.warn("Token Miser diagnostic batch could not be saved"),
    });
    tokenMiserStore = createTokenMiserStorage(
      path.join(tokenMiserStateDir, "objects"),
      {
        onMetadataUpdated: async (metadata, reason) => {
          if (reason === "retrieval") ports.tokenMiserDiagnostics?.recordRetrieval(metadata);
          ports.pendingTokenMiserInterceptions.set(metadata.objectId, metadata);
          ports.rememberActiveTokenMiserReplayEntry(metadata);
          // A replay-counter write changes nothing the gate card or its usage
          // line renders, and it fires once per active gate per model
          // request. Republishing the whole ledger for each one turned a
          // single usage event into N pricing reads and 2N notifications;
          // `recordTokenMiserParentModelRequest` already emits once for the
          // whole batch.
          if (reason === "replay" || reason === "flushed") {
            return;
          }
          const publish = ports.tokenMiserLivePublishChain.then(() =>
            ports.publishLiveTokenMiserLedgerEntry(metadata),
          );
          ports.tokenMiserLivePublishChain = publish.catch(() => undefined);
          try {
            await publish;
          } catch (error) {
            backendRegistryLog.warn("live Token Miser ledger publish failed", {
              error: error instanceof Error ? error.message : String(error),
              objectId: metadata.objectId,
              threadId: metadata.threadId,
            });
          }
        },
        onCodeModeObservationUpdated: (observation) => {
          // Persist the observation before Codex receives its result, but do
          // not make the reducer response wait for a full accounting read
          // and renderer notification. Those are observational UI work.
          void ports.emitThreadToolAccountingUpdated({
            backend: "codex",
            threadId: observation.threadId,
          }).catch((error) => {
            backendRegistryLog.warn("live Code Mode accounting publish failed", {
              error: error instanceof Error ? error.message : String(error),
              threadId: observation.threadId,
            });
          });
        },
      },
    );
    const tokenMiserService = new TokenMiserService({
      diagnostics: tokenMiserDiagnostics,
      store: tokenMiserStore,
      isEnabled: () => ports.resolveTokenMiserEnabledFn(),
      isFocusedEnabled: () => {
        try {
          return (settingsService ?? getDesktopSettingsService())
            .resolveTokenMiserFocusedSummariesEnabled?.() ?? false;
        } catch {
          return false;
        }
      },
      isEnabledByDefault: () => ports.resolveTokenMiserDefaultEnabledFn(),
      // A thread can override the inherited default while the experiment is
      // available; the global experimental flag remains the outer gate.
      isEnabledForThread: async (threadId) =>
        await ports.resolveTokenMiserThreadOverride("codex", threadId),
      getParentCumulativeInputTokens: (threadId) =>
        ports.liveThreadReplayInputCursor.get(
          ["codex", threadId].join(":"),
        )?.cumulativeInputTokens,
      resolveParentModel: (threadId) =>
        ports.resolveTokenMiserParentModel(threadId),
      codeModeGroupingVersion: () =>
        ports.tokenMiserCodeModeGroupingVersion,
      postToolUseExactOutputVersion: () =>
        ports.tokenMiserPostToolUseExactOutputVersion,
      onFocusedInference: (params) => ports.recordTokenMiserFocusedInference(params),
      generateSummary: async (params) => {
        if (!ports.codexClient.generateStructuredObject) {
          return {
            status: "unavailable",
            reason: "codex_structured_generation_unavailable",
          };
        }
        return await ports.codexClient.generateStructuredObject({
          ...params,
          isMatch: (record) =>
            params.schema.properties && "answers" in (params.schema.properties as Record<string, unknown>)
              ? Array.isArray(record.answers)
              : (record.disposition === "pass_through"
              || record.disposition === "summarize")
            && typeof record.summary === "string"
            && Array.isArray(record.usefulDetails)
            && (
              !Array.isArray(params.schema.required)
              || !params.schema.required.includes("members")
              || Array.isArray(record.members)
            ),
        });
      },
    });
    tokenMiserServiceValue = tokenMiserService;
    tokenMiserHookBridge = new TokenMiserHookBridge({
      stateDir: tokenMiserStateDir,
      service: tokenMiserService,
      instanceId: runtimeInstanceId,
      activationNonce: tokenMiserActivationNonce,
    });
    tokenMiserCodeModeReducerDescriptorPath =
      tokenMiserHookBridge.codeModeReducerDescriptorPath;
    tokenMiserPluginManager = new TokenMiserPluginManager({
      stateDir: tokenMiserStateDir,
      profileName: resolveActiveProfileName(),
      executablePath: process.execPath,
      hookEntryPath: path.join(__dirname, "token-miser-hook.js"),
    });
  }
  const acpWorktreeRepositoryResolver =
    options?.acpWorktreeRepositoryResolver ??
    resolveWorktreeRepositoryDirectory;
  acpAvailableCommandsStore =
    options?.acpAvailableCommandsStore === null
      ? undefined
      : options?.acpAvailableCommandsStore ??
        (isAppStateInitialized()
          ? createAcpAvailableCommandsStorage()
          : undefined);
  const acpAvailableCommandProbeBudgetMs =
    options?.acpAvailableCommandProbeBudgetMs
    ?? ACP_AVAILABLE_COMMAND_PROBE_BUDGET_MS;
  const overlayStore = wrapCodexProviderUsageAttribution(
    options?.overlayStore ?? getDesktopOverlayStore(),
    (line) => ports.attributeCodexProviderUsage(line),
  );
  const gatewayConnections = mcpConnectionService;
  if (gatewayConnections?.requestGatewayToolOperation) {
    mcpGatewayTools = new McpGatewayToolService({
      connections: { requestGatewayToolOperation: (params) => gatewayConnections.requestGatewayToolOperation!(params) },
      selectedConnections: async (context) => {
        if (!ports.isLiveDynamicToolCall(context.backend, context)) throw new Error("MCP gateway tools require an active turn on the owning thread.");
        const denied = await ports.dynamicToolPermissionDenied(context.backend, "mcp_connections", {
          ...context, tool: "call_mcp_tool",
        });
        if (denied) throw new Error(`The messaging actor lacks permission for MCP gateway tools (${denied}).`);
        return await ports.readMcpGatewaySelection(context);
      },
      scopeKey: (context) => {
        const access = ports.taskMonitorForThread(context)?.mcpAccess;
        return JSON.stringify(["gateway", context.backend, context.threadId, ...(access ? [{
          selectionOwner: access.selectionOwner, connectionIds: access.connectionIds,
          grantedConnectionIds: access.automation?.grantedConnectionIds, readOnly: true,
        }] : [])]);
      },
      serverNameInAgent: (connectionId, context) => ports.threadMcpServerNameInAgent(connectionId, context),
      toolAllowed: (tool, context) => !ports.isTaskMonitorThread(context)
        || (tool.definition.annotations?.readOnlyHint === true && tool.definition.annotations.destructiveHint !== true),
      approve: (invocation, context, signal, annotations, catalogRevision, consentRevision) => ports.approveGatewayInvocation(invocation, context, signal, annotations, catalogRevision, consentRevision),
      elicit: (request, invocation, context, signal) => ports.requestUpstreamMcpForm(request, invocation, context, signal),
    });
  }
  initialize.push(() => {
    if (ports.tokenMiserStore) {
      void ports.initializeTokenMiserLedger();
    }
  });
  const gitDirectoryService =
    options?.gitDirectoryService ??
    new GitDirectoryService({
      codexHome,
      gitEnv: codexEnv,
      resolveWorktreeStorage: () =>
        getDesktopSettingsService().resolveWorktreeStorage(),
    });
  const gitWorkingStateService =
    options?.gitWorkingStateService ??
    new GitWorkingStateService({ gitEnv: codexEnv });
  const worktreeArchiveService =
    options?.worktreeArchiveService ??
    new WorktreeArchiveService({ gitEnv: codexEnv });
  const worktreeRecoveryService =
    options?.worktreeRecoveryService ??
    new WorktreeRecoveryService({ gitEnv: codexEnv });
  const worktreeContainerService = new WorktreeContainerService({ codexHome });
  const agentToolMcpServer =
    options?.agentToolMcpServer === null
      ? undefined
      : options?.agentToolMcpServer ??
        new AgentToolMcpServer({
          resolveCallContext: (context) =>
            ports.resolveAgentToolMcpCallContext(context),
          resolveCatalogs: (context) => context.threadId && ports.isTaskMonitorThread({ ...context, threadId: context.threadId })
            ? [
                { id: "thread_orchestration", router: new AgentToolRouter([
                  ...buildPwrAgentTaskMonitorToolDefinitions(async (request) => await ports.handleAgentTaskMonitorRequest(request), "monitor"),
                  buildPwrAgentToolGuideDefinition(),
                ]) },
                { id: "mcp_connections", router: new AgentToolRouter(buildMcpGatewayToolDefinitions(ports.mcpGatewayTools)) },
                { id: "forge", router: new AgentToolRouter(ports.buildTaskMonitorForgeToolDefinitions(ports.resolveForgeToolPolicy())) },
              ]
            : resolveAgentToolCatalogs({
              appManagementHandler: ports.appManagementHandler,
              automationInspectionHandler: ports.automationInspectionHandler,
              federationHandler: ports.federationHandler,
              mcpGatewayTools: ports.mcpGatewayTools,
              mcpConnectionHandler: async (request) =>
                await ports.handleAgentMcpConnectionRequest(request),
              messagingHandler: ports.messagingHandler,
              taskMonitorHandler: async (request) =>
                await ports.handleAgentTaskMonitorRequest(request),
              threadInspectionHandler: ports.threadInspectionHandler,
              forgeReadHandler: ports.gatedForgeReadHandler,
              forgePrToolHandler: ports.gatedForgePrToolHandler,
              forgeToolPolicy: ports.resolveForgeToolPolicy(),
              threadOrchestrationHandler: ports.threadOrchestrationHandler,
              tokenMiserStore: ports.tokenMiserStore,
              tokenMiserFocused: ports.tokenMiserService?.focused,
              starMapHandler: ports.starMapHandler,
              threadTodoHandler: ports.threadTodoHandler,
            }, { taskMonitorRole: "all" }),
          authorizeToolCall: (params) =>
            ports.authorizeAgentToolMcpCall(params),
          isToolAdvertised: isMcpToolAdvertised,
          resolveToolResultReminder: (context) =>
            ports.takeAcpMonitorJobSuggestion(context),
        });
  pdfToolMcpServer =
    options?.pdfToolMcpServer === null
      ? undefined
      : options?.pdfToolMcpServer ??
        (createsLiveCodexClient
          ? new AgentToolMcpServer({
              resolveCallContext: (context) =>
                ports.resolveAgentToolMcpCallContext(context),
              resolveCatalogs: () => [
                {
                  // These are messaging-context tools; none of them maps to
                  // a permission today, so naming the category leaves them
                  // ungated while routing any future mapping through RBAC.
                  id: "messaging_context",
                  router: buildPwrAgentMessagingPdfToolRouter(
                    ports.messagingHandler,
                  ),
                },
              ],
            })
          : undefined);
  claudeAgentToolMcpServer = agentToolMcpServer;
  const claudeBackend = new ClaudeBackend({
    inspectInstallation: options?.useMachineClaudeDiscovery
      ? async () => inspectClaudeInstallation({ env: await settingsService?.resolveTerminalSpawnEnvAsync() })
      : async () => ({ authStatus: "unknown" }),
    resolveEnv: async () => await settingsService?.resolveTerminalSpawnEnvAsync() ?? process.env,
    // A chunk's __dirname is its own folder; this module is bundled into
    // the main entry, beside the worker.
    openSessionReader: (env) => openClaudeSessionReader(env, {
      workerPath: path.join(__dirname, "claude-session-reader-worker.js"),
    }),
    emit: async (event) => { await ports.emit(event); },
    request: async (request, signal) => await ports.handleServerRequest("claude", request, signal),
    cancelRequest: async (threadId, turnId, requestId) => {
      const key = buildPendingRequestKey({ backend: "claude", threadId, requestId });
      const pending = ports.pendingServerRequests.get(key);
      ports.pendingServerRequests.delete(key);
      pending?.resolve({ decision: "cancel" });
      await ports.emit({ backend: "claude", notification: {
        method: "serverRequest/resolved", params: { threadId, turnId, requestId },
      } });
    },
    resolveReviewContext: async ({ threadId, cwd, pullRequests }) => await ports.resolveReviewContext({
      backend: "claude", cwd, threadId,
      overlay: await ports.overlayStore.getThreadOverlayState({ backend: "claude", threadId }),
      // `/code-review` with no target reviews the checked-out work, so the
      // branch and its attached pull request name the card. One that named
      // pull requests is named by those.
      target: { type: "custom", instructions: "/code-review" },
      ...(pullRequests ? { namedPullRequests: pullRequests } : {}),
    }),
    suggestMonitorJob: async (request) => await ports.suggestClaudeMonitorJob(request),
    holdSelfStartedTurn: async ({ threadId, prompt, source }) => await ports.holdBackendSelfStartedTurn({
      backend: "claude", threadId, prompt, source,
    }),
    recordSubAgents: async (params) => await ports.recordClaudeSubAgents(params),
    planLimits: planLimits,
    ...options?.claudeBackendOptions,
    assertOwnerAdmission: () => ports.assertThreadOwnership(),
  });
  const acpBackend = new AcpBackendAdapter({
    assertOwnerAdmission: () => ports.assertThreadOwnership(),
    planLimits: planLimits,
    acpAgentStore: options?.acpAgentStore,
    acpRolloutStore: options?.acpRolloutStore,
    acpSessionStore: options?.acpSessionStore,
    agentToolMcpServer,
    captureStores: captureStores,
    createAcpClient: options?.createAcpClient,
    createAcpTransport: options?.createAcpTransport,
    discoverLocalAcpAgents:
      options?.discoverLocalAcpAgents
      ?? (options?.useMachineAcpDiscovery
        ? createLocalAcpAgentDiscovery(
            {
              configStore: options?.configStore ?? getDesktopConfigStore(),
              ...(settingsService
                ? {
                    resolveEnv: async () =>
                      await settingsService.resolveTerminalSpawnEnvAsync(),
                  }
                : {}),
            },
          )
        : noLocalAcpAgentDiscovery),
    isAcpAgentEnabled:
      options?.isAcpAgentEnabled
      ?? (options?.configStore
        ? (registryId) => {
            const providers = options.configStore?.read("providers");
            return providers
              ? acpProviderEnabledFromSnapshot(providers, registryId)
              : true;
          }
        : undefined),
    resolveProviderDependencyFingerprint: options?.configStore
      ? (registryId) =>
          providerProjectionForRegistryId(
            options.configStore!.read("providers"),
            registryId,
          )?.dependencyFingerprint
      : undefined,
    emit: async (event) => {
      ports.rememberAcpAvailableCommands(event);
      await ports.emit(event);
    },
    handleServerRequest: async (backend, request) =>
      await ports.handleServerRequest(backend, request),
    resolveMcpConnectionServers: async ({ backendId, sessionId }) => {
      if (!sessionId) return undefined;
      const overlay = await ports.overlayStore.getThreadOverlayState({
        backend: backendId,
        threadId: sessionId,
      });
      return await ports.registerAcpMcpConnections(
        overlay?.mcpConnectionIds,
        sessionId,
        backendId,
      );
    },
    automationInspectionMcpCommand:
      options?.automationInspectionMcpCommand ??
      resolveAutomationInspectionMcpCommand(),
  });
  initialize.push(() => {
    // A Codex window leaves the summary when it resets; tell listeners, so a
    // surface that refreshes only on events drops the row. Claude and the ACP
    // agents report their own.
    ports.unsubscribers.push(ports.planLimits.subscribe((provider) => {
      if (provider !== "codex" || ports.closed) return;
      void ports.emit({
        backend: "codex",
        notification: { method: "backend/providerStatus/updated", params: { backend: "codex" } },
      }).catch((error) => {
        backendRegistryLog.warn("Codex rate-limit expiry broadcast failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }));
  });
  const providerRuntimeFingerprints = configStore
    ? readProviderRuntimeFingerprints(configStore.read("providers"))
    : undefined;
  initialize.push(() => {
    if (ports.configStore) {
      ports.unsubscribers.push(
        ports.configStore.subscribe(["experimental"], () => {
          ports.tokenMiserDiagnostics?.isEnabled();
        }),
      );
  
      ports.unsubscribers.push(
        ports.configStore.subscribe(["providers"], () => {
          void ports.synchronizeProviderRuntimeSelections().catch((error) => {
            backendRegistryLog.warn(
              "provider runtime config invalidation failed",
              {
                error: error instanceof Error ? error.message : String(error),
              },
            );
          });
        }),
      );
    }
  });
  messagingStore = options?.messagingStore;
  messagingArchiveCleaner = options?.messagingArchiveCleaner;
  appManagementHandler = options?.appManagementHandler ?? undefined;
  starMapHandler = options?.starMapHandler ?? undefined;
  const gitWorkspaceHandoffService =
    options?.gitWorkspaceHandoffService ??
    new GitWorkspaceHandoffService({
      gitEnv: codexEnv,
      worktreeArchiveService: worktreeArchiveService,
      resolveWorktreeStorage: () =>
        getDesktopSettingsService().resolveWorktreeStorage(),
    });
  const resolveAcpHelperWorkspace =
    options?.resolveAcpHelperWorkspace ?? ensureAcpHelperWorkspace;
  const createScratchProjectDirectory =
    options?.createScratchProjectDirectory ?? defaultCreateScratchProjectDirectory;
  createScheduledThreadActionFn = options?.createScheduledThreadAction;
  threadTitleGenerationService =
    options?.threadTitleGenerationService === null
      ? undefined
      : options?.threadTitleGenerationService ??
        (replayClients
          ? createReplayThreadTitleService()
          : new ThreadTitleGenerationService({
              generators: {
                codex: codexClient.generateTitle
                  ? {
                      generateTitle: (params) =>
                        ports.codexClient.generateTitle!(params),
                    }
                  : undefined,
              },
              generatorResolver: (backend) => {
                if (!isAcpBackendId(backend)) {
                  return undefined;
                }
                const helperSession =
                  backend === "acp:grok"
                    ? GROK_TITLE_HELPER_SESSION_POLICY
                    : undefined;
                return new AcpThreadTitleGenerator({
                  backend,
                  resolveUsageAccountKey: () => ports.captureUsageAccount(backend),
                  configureHelperSession: async ({
                    client,
                    parentSession,
                    reasoningEffort,
                    session,
                  }) => {
                    const model = parentSession?.acpRuntime?.currentModelId
                      ?? parentSession?.acpRuntime?.configValues?.model
                      ?? session.acpRuntime?.currentModelId
                      ?? session.acpRuntime?.configValues?.model;
                    await ports.applyAcpRuntimeSelection(
                      backend,
                      client,
                      session.sessionId,
                      model ? { currentModelId: model } : undefined,
                      reasoningEffort,
                    );
                  },
                  helperSession,
                  getClient: (acpBackend) =>
                    ports.acpBackend.getClient(acpBackend),
                  getSession: (acpBackend, threadId) =>
                    ports.acpBackend.getSession(acpBackend, threadId),
                });
              },
            }));
  const threadInspectionSearchService =
    options && "threadSearchService" in options
      ? options.threadSearchService ?? null
      : options?.codexClient || replayClients
        ? null
        : undefined;
  const codexModelProviderCatalog = new CodexModelProviderCatalog({
    resolveProviders: () => ports.resolveCodexModelProvidersFn(),
    resolveKeys: () => ports.resolveCodexModelProviderKeysFn(),
    ...(options?.codexModelProviderFetch ? { fetch: options.codexModelProviderFetch } : {}),
  });
  const codexModelClient = codexClient;
  const modelCatalog = new BackendModelCatalog({
    codex: {
      // Codex's own catalog, then every configured provider's models. A
      // provider that cannot be reached must not hide Codex's models.
      listModels: codexModelClient.listModels || resolveCodexModelProvidersFn().length
        ? async (diagnostics) => [
            ...await codexModelClient.listModels?.(diagnostics) ?? [],
            ...await ports.codexModelProviderCatalog.listModelOptions().catch((error: unknown) => {
              backendRegistryLog.warn("Codex model provider models unavailable", {
                error: error instanceof Error ? error.message : String(error),
              });
              return [];
            }),
          ]
        : undefined,
    },
  });
  let providersFingerprint = JSON.stringify(resolveCodexModelProvidersFn());
  const refreshCodexProviderModels = (): void => {
    const next = JSON.stringify(ports.resolveCodexModelProvidersFn());
    if (next === providersFingerprint) return;
    providersFingerprint = next;
    ports.codexModelProviderCatalog.invalidate();
    ports.modelCatalog.invalidate("codex");
  };
  initialize.push(() => {
    if (ports.configStore) {
      ports.unsubscribers.push(ports.configStore.subscribe(["models"], refreshCodexProviderModels));
    } else if (typeof settingsService?.onConfigWritten === "function") {
      ports.unsubscribers.push(settingsService.onConfigWritten(refreshCodexProviderModels));
    }
  });
  const queuedMessageTitler = new QueuedMessageTitler({
    generate: async (params) =>
      await ports.generateStructuredObject({
        ...params,
        helper: "queued_message_titles",
      }),
    isCurrent: (request) => ports.isQueuedMessageTitleCurrent(request),
    apply: (request, title) => ports.applyQueuedMessageTitle(request, title),
    settle: async (request, settlement) =>
      await ports.recordQueuedMessageTitle(request, settlement),
    log: (message, fields) => backendRegistryLog.info(message, fields),
    ...(options?.queuedMessageTitleSettleMs !== undefined
      ? { settleMs: options.queuedMessageTitleSettleMs }
      : {}),
  });
  const threadTurnQueue = new ThreadTurnQueue({
    startTurn: async (entry) => await ports.startTurnNow(entry),
    canSteerThread: (entry) => !ports.stoppingRunningTurnsForShutdown
      && !ports.threadHasBlockingWorkspaceMove(entry)
      && ports.getActiveTurnForThread(entry) !== undefined
      && ports.findReviewForParentTurn({
        backend: entry.backend,
        parentThreadId: entry.threadId,
      })?.mode !== "native",
    steerTurn: async (entry) => {
      const active = ports.getActiveTurnForThread(entry);
      if (!active) return undefined;
      const backend = (await ports.listBackends({ includeUnavailable: true })).backends
        .find((candidate) => candidate.kind === entry.backend);
      if (!backend?.capabilities.steerTurn) return undefined;
      // Review ownership can change while backend discovery is pending.
      if (ports.findReviewForParentTurn({
        backend: entry.backend,
        parentThreadId: entry.threadId,
      })?.mode === "native") return undefined;
      try {
        const result = await ports.steerTurn({
          backend: entry.backend,
          threadId: entry.threadId,
          expectedTurnId: active.turnId,
          requestId: entry.id,
          input: entry.input,
        }, entry.messageOrigin);
        return { backend: result.backend, threadId: result.threadId, turnId: result.turnId };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/no active turn|expected active turn id/.test(message)) {
          const current = ports.getActiveTurnForThread(entry);
          return current?.turnId !== active.turnId ? "retry" : undefined;
        }
        throw error;
      }
    },
    // A turn a quit stopped releases its thread; the next queued turn must
    // not start in its place, so every thread reads as busy from then on.
    isThreadActive: ({ backend, threadId }) =>
      ports.stoppingRunningTurnsForShutdown
      || ports.threadHasActiveTurn(threadId, backend)
      || ports.threadHasBlockingWorkspaceMove({ backend, threadId })
      // A send waits behind a checkout restore like a queued message.
      || ports.checkoutRestores.has(buildThreadIdentityKey(backend, threadId)),
    isDispatchHeld: (entry) => restartGateHolds(ports.restartGate, {
      ...(entry.restartContinuation && entry.id ? { restartEntryId: entry.id } : {}),
    }, Date.now()),
    onLifecycle: async (event) => await ports.emitTurnQueueLifecycle(event),
  });
  initialize.push(() => {
    ports.restoreProjectHeldWakeups();
  });
  initialize.push(() => {
    ports.restoreRestartContinuations();
  });

  const isCodexBootstrapDeferredFn =
    options?.isCodexBootstrapDeferred ??
    (() => {
      try {
        return ONBOARDING_CODEX_GATE_ENABLED
          && !getDesktopConfigStore().read("onboarding").completed;
      } catch (error) {
        // The settings singleton can only throw if app-state init
        // never ran. That should not be reachable in production —
        // `initializeAppState()` runs before any IPC handler that
        // reaches the registry. If it does happen, default to "gate
        // off" so we fall back to the historical behavior (Codex
        // prewarm runs) rather than presenting an empty sidebar that
        // the operator has no way to unstick. Surface the failure
        // loudly so the underlying init bug is fixable.
        backendRegistryLog.warn(
          "isCodexBootstrapDeferred fell back to false; settings service unavailable",
          {
            error: error instanceof Error ? error.message : String(error),
          },
        );
        return false;
      }
    });
  const isBootstrapModeFn =
    options?.isBootstrapMode ?? (() => getAppStateMode() === "bootstrap");
  const maintenanceHandler = options?.handlers?.threadMaintenanceToolHandler;
  const threadMaintenanceToolScans = maintenanceHandler ? new ThreadMaintenanceToolScans({
    scan: async (request) => await maintenanceHandler.scan(request),
    getScan: (scanId) => maintenanceHandler.getScan(scanId),
  }) : undefined;
  // Optional store methods are read on each access, as the registry's own
  // `this.overlayStore.method?.(...)` reads were, never captured once here.
  const context: RegistryContext = {
    stores: {
      threads: {
        getThreadOverlayState: (...args) => overlayStore.getThreadOverlayState(...args),
        getThreadOverlayStates: (...args) => overlayStore.getThreadOverlayStates(...args),
        get getThreadMetadata() { return overlayStore.getThreadMetadata?.bind(overlayStore); },
        get updateThreadMetadata() { return overlayStore.updateThreadMetadata?.bind(overlayStore); },
      },
      usage: {
        get upsertThreadUsageLines() { return overlayStore.upsertThreadUsageLines?.bind(overlayStore); },
        readThreadPricing: (...args) => overlayStore.readThreadPricing(...args),
        get completeThreadUsageTurn() { return overlayStore.completeThreadUsageTurn?.bind(overlayStore); },
        get completeThreadUsageTurns() { return overlayStore.completeThreadUsageTurns?.bind(overlayStore); },
        get readThreadUsageActivities() { return overlayStore.readThreadUsageActivities?.bind(overlayStore); },
        get readThreadUsageActivityForTurn() { return overlayStore.readThreadUsageActivityForTurn?.bind(overlayStore); },
      },
      subAgents: {
        get upsertThreadSubAgents() { return overlayStore.upsertThreadSubAgents?.bind(overlayStore); },
        get reconcileOrphanedThreadSubAgents() { return overlayStore.reconcileOrphanedThreadSubAgents?.bind(overlayStore); },
        get moveLegacyThreadSubAgents() { return overlayStore.moveLegacyThreadSubAgents?.bind(overlayStore); },
      },
      workspaces: {
        get readThreadGitWorkingStateCache() { return overlayStore.readThreadGitWorkingStateCache?.bind(overlayStore); },
        get writeThreadGitWorkingStateCacheEntry() { return overlayStore.writeThreadGitWorkingStateCacheEntry?.bind(overlayStore); },
        get acknowledgeThreadEnvironmentFailure() { return overlayStore.acknowledgeThreadEnvironmentFailure?.bind(overlayStore); },
      },
      toolAccounting: {
        readThreadToolAccounting: (...args) => overlayStore.readThreadToolAccounting(...args),
        get persistThreadToolInvocationBoundary() { return overlayStore.persistThreadToolInvocationBoundary?.bind(overlayStore); },
        get markThreadToolInvocationsNoisy() { return overlayStore.markThreadToolInvocationsNoisy?.bind(overlayStore); },
        get setThreadSpendAlertPending() { return overlayStore.setThreadSpendAlertPending?.bind(overlayStore); },
      },
      pullRequests: {
        addThreadPullRequestReference: (...args) => overlayStore.addThreadPullRequestReference(...args),
      },
    },
    providers: { codex: codexClient, claude: claudeBackend, acp: acpBackend },
    lifecycle: { get closed() { return ports.closed; } },
    emit: (event) => ports.emit(event),
  };

  const handlers: RegistryDependencies["handlers"] = {
    messagingArchiveCleaner,
    appManagementHandler,
    starMapHandler,
    createScheduledThreadActionFn,
    ...options?.handlers,
  };
  // The registry's construction ports are each module's host, bound once the registry connects them.
  const forgeToolBridge = new ForgeToolBridge(context, handlers, () => ports);
  const threadInspectionTools = new ThreadInspectionTools(context, handlers, {
    forgeToolBridge,
    threadInspectionSearchService,
    threadMaintenanceToolScans,
  }, () => ports);

  const registry = new DesktopBackendRegistry({
    context,
    forgeToolBridge,
    threadInspectionTools,
    handlers,
    ownerAdmission,
    managedMaintenanceRoots,
    readThreadArchivePolicy,
    readCheckoutHibernationPolicy,
    configStore,
    runtimeInstanceId,
    archiveCleanupCheckpointStore,
    projectHeldWakeupStore,
    restartContinuationStore,
    restartDispatchPlanOptions,
    registrySessionId,
    runningTurnShutdownStopTimeoutMs,
    resolveLiveProfileRuntimeInstanceIdsFn,
    mcpConnectionService,
    providerThreadSnapshotStore,
    retainedOwnerThreadStorage,
    codexProtocolCaptureSession,
    correspondenceStore,
    pendingEnvironmentLaunchStore,
    resolveCodexDefaultModeRequestUserInputFn,
    resolveCodexToolDiscoveryFn,
    resolveDefaultPrAutoDispatchEnabledFn,
    resolveProviderModelDefaultsFn,
    resolveHelperModelSettingsFn,
    resolveTaskMonitorModelsFn,
    resolvePassSetupVariablesToAgentsFn,
    resolveUsageAccountGroupsFn,
    resolveProviderThreadModelMigrationsFn,
    resolveCodexLocalModelIdsFn,
    resolveCodexModelProvidersFn,
    resolveCodexModelProviderKeysFn,
    resolveCodexFastAllowedFn,
    resolvePdfAnalysisEnabledFn,
    acpSessionIdleCloseMs,
    codexThreadIdleUnsubscribeMs,
    resolveTokenMiserEnabledFn,
    resolveCodexAppServerRecycleSettingsFn,
    resolveTokenMiserDefaultEnabledFn,
    resolveTokenMiserPollingReviewsEnabledFn,
    resolveManagedTokenMiserActivationRequiredFn,
    markManagedCodexRuntimeSwitchCompleteFn,
    resolveCodexDiscoveryPendingFn,
    resolveToolOutputAlertPolicyFn,
    resolveSpendAlertPolicyFn,
    spendAlertPolicy,
    toolOutputAlertPolicy,
    resolveCodexRuntimeCommandFn,
    resolveTokenMiserCodexRuntimeFn,
    codexEnvironmentCommandEnv,
    codexEnvironmentCommandRunner,
    codexEnvironmentHydrationStore,
    localFilePrivateStorageRoots,
    codexClient,
    tokenMiserDiagnostics,
    tokenMiserStore,
    tokenMiserService: tokenMiserServiceValue,
    tokenMiserHookBridge,
    tokenMiserCodeModeReducerDescriptorPath,
    tokenMiserStateDir,
    tokenMiserPluginManager,
    acpWorktreeRepositoryResolver,
    acpAvailableCommandsStore,
    acpAvailableCommandProbeBudgetMs,
    overlayStore,
    mcpGatewayTools,
    gitDirectoryService,
    gitWorkingStateService,
    worktreeArchiveService,
    worktreeRecoveryService,
    worktreeContainerService,
    pdfToolMcpServer,
    claudeAgentToolMcpServer,
    claudeBackend,
    acpBackend,
    providerRuntimeFingerprints,
    messagingStore,
    messagingArchiveCleaner,
    appManagementHandler,
    starMapHandler,
    gitWorkspaceHandoffService,
    resolveAcpHelperWorkspace,
    createScratchProjectDirectory,
    createScheduledThreadActionFn,
    threadTitleGenerationService,
    codexModelProviderCatalog,
    modelCatalog,
    queuedMessageTitler,
    threadTurnQueue,
    isCodexBootstrapDeferredFn,
    isBootstrapModeFn,
    planLimits,
    captureStores,
  }, (connected) => {
    ports = connected;
    for (const run of initialize) run();
  });
  registryModulesByRegistry.set(registry, { forgeToolBridge, threadInspectionTools });
  return registry;
}
