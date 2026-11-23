import type { ApprovedLabCheckout } from "./resource-checkouts/pwrsuitelab-checkout-adapter";
import { createResourceCheckoutToolHandler } from "./agent-tools/pwragent-resource-checkout-agent-tools";
import { disposeResourceCheckouts, initializeResourceCheckouts } from "./resource-checkouts/checkout-runtime";
import { createDesktopBackendRegistry } from "./app-server/backend-registry-wiring";
import { ProfileThreadOwnerAdmission } from "@pwragent/owner-core/thread-owner-admission";
import { createResearchOwnerIdentity } from "./research/research-owner-identity";
import { initializeResearchRuntime, closeResearchRuntime } from "./research/research-runtime";
import { bindResearchRegistry, createResearchRegistryPorts } from "./research/research-registry";
import { researchToolsOffered } from "./agent-tools/pwragent-research-agent-tools";
import { isAcpBackendId } from "@pwragent/shared/contracts/navigation";
import { initializeDesktopAutomationService, prepareDesktopAutomationShutdown, disposeDesktopAutomationService } from "./automations/desktop-automation-service";
import { initializeScheduledThreadActionService } from "./scheduled-actions/scheduled-thread-action-service";
import { setManagedGrokSignatureRejectionReporter } from "./acp/grok-managed-runtime";
import { subscribeManagedRuntimeProgress } from "./managed-runtime-progress";
import { setInboundPreviewSink } from "./messaging/inbound-preview-bus";
import { setFederationMessagingPlatformStatusReader } from "./federation/federation-runtime";
import type { DesktopMessagingRuntime } from "./messaging/messaging-runtime";
import { createShutdownBarrier } from "./shutdown-barrier";
import { disposeDesktopSettingsService, closeDesktopSettingsCommandDiscovery } from "./settings/desktop-settings-singleton";
import { disposeDesktopMessagingRuntime } from "./messaging/messaging-runtime";
import { disposeDesktopFederationRuntime, getExistingDesktopFederationRuntime } from "./federation/federation-runtime";
import { getExistingRuntimeMessagingLeaseCoordinator } from "./runtime-messaging-lease";
import { getExistingRuntimeFederationLeaseCoordinator } from "./runtime-federation-lease";
import { getExistingRuntimeLeaseManager } from "./runtime-lease-manager";
import { stopAllCodexEnvironmentDetachedCommands } from "./app-server/codex-environment-runtime";
import { disposeScheduledThreadActionService } from "./scheduled-actions/scheduled-thread-action-service";
import { stopProfileRuntimeHeartbeatRefresh } from "./storage/desktop-state-lifecycle";
import type { AppServerThreadMessageOrigin } from "@pwragent/shared/contracts/normalized-app-server";
import type {
  DesktopProviderModelDefaults,
  DesktopSettingsConfigPatch,
} from "@pwragent/shared/contracts/settings";
import { type OwnerHostServices, getOwnerHostServices, rendererSubscribers } from "./owner-host";
import { initializeDesktopConfigStore } from "./settings/config-store/desktop-config-store-singleton";
import { initializeDesktopSettingsService } from "./settings/desktop-settings-singleton";
import { initializeDesktopBackendRegistry } from "./app-server/backend-registry";
import { getDesktopAppServerService, initializeDesktopAppServerService, startAppServerOwnerNavigation } from "./app-server/desktop-app-server-service";
import { initializeDesktopFederationRuntime } from "./federation/federation-runtime";
import { initializeDesktopMessagingRuntime } from "./messaging/messaging-runtime";
import { reconcileAppUpdateRestart, subscribeAgentUpdateNotices } from "./messaging/agent-update-notices";
import { MessagingAppUpdateControls, sameTarget } from "./messaging/app-update-controls";
import { pendingUpdateBlockingWork } from "./app-update-admission";
import { createAppUpdateNoticeStore } from "./storage/desktop-messaging-storage";
import { DEFAULT_DEVELOPMENT_WORKING_UPDATES_MODE } from "@pwragent/shared/contracts/messaging";
import { initializeRuntimeLeaseManager } from "./runtime-lease-manager";
import { initializeRuntimeFederationLeaseCoordinator } from "./runtime-federation-lease";
import { initializeRuntimeMessagingLeaseCoordinator } from "./runtime-messaging-lease";
import { installOwnerHostServices } from "./owner-host";
import { markAgentProjectRead } from "./app-server/agent-project-read";
import { getDesktopBackendRegistry, getExistingDesktopBackendRegistry } from "./app-server/backend-registry";
import { interruptStartupStorageMaintenance, runStartupStorageMaintenance } from "./storage-maintenance";
import { removeRetiredCiArtifactStore } from "./pr-status/forge-artifact-download";
import { hadExistingAppStateDatabase, initializeDesktopState } from "./storage/desktop-state-lifecycle";
import { getDesktopStorageMaintenanceStorage } from "./storage/desktop-storage-maintenance";
import { getDesktopOverlayStore } from "./storage/desktop-overlay-store";
import { createOpenAIDecisionsAgentToolsHandler, flushOpenAIDecisionsUsage } from "./openai-decisions/openai-decisions-runtime";
import { createPwrAgentAppManagementHandler } from "./agent-tools/pwragent-app-management-service";
import type {
  CreateInstanceThreadResult,
  PwrAgentFederationContext,
} from "@pwragent/shared/contracts/federation-tools";
import { createStarMapAgentToolsHandler } from "./star-map/star-map-agent-tools-service";
import { isVoiceManagerThread } from "./native-voice/voice-manager-thread";
import { createFederationAgentToolsHandler } from "./federation/federation-agent-tools-service";
import { createFederatedThreadInspectionHandler } from "./federation/federated-thread-inspection-service";
import { createFederatedThreadMutationHandler } from "./federation/federated-thread-mutation-service";
import { createFederatedThreadControlHandler, createFederatedThreadMessageHandler } from "./federation/federated-thread-message-service";
import { getDesktopFederationRuntime } from "./federation/federation-runtime";
import { applyFederationConfigPatch, subscribeFederationConfig } from "./federation/federation-config-subscription";
import { getMcpConnectionGatewayService, initializeMcpConnectionGatewayService, getExistingMcpConnectionGatewayService } from "./mcp-connections/mcp-connection-gateway-service";
import { setPwrSnapMediaReader } from "./transcript-images";
import { getMainLogger } from "./log";
import { recordStartupProfileEvent } from "./diagnostics/startup-profile-events";
import { loadDesktopMessagingConfigFromSettings } from "./messaging/messaging-config";
import { resolveRuntimeMessagingOverride } from "./runtime-flags";
import { getRuntimeMessagingLeaseCoordinator } from "./runtime-messaging-lease";
import { getDesktopConfigStore, getDesktopSettingsService } from "./settings/desktop-settings-singleton";
import { issueProviderDiscoveryPermit, type ProviderDiscoveryPermit } from "./settings/provider-discovery-permit";
import { type ForgeReadArgs, type ForgeReadOperation } from "./pr-status/forge-tool-contract";
import type { AgentToolCallContext } from "./agent-tools/agent-tool-definition";
import { createOwnerRoutedForgeReadHandler } from "./federation/federated-forge-read-service";
import { navigationDiagnosticCause, navigationDiagnosticTrigger } from "../shared/navigation-diagnostic-cause";
import { setBundledGitLfsAdvisory } from "./bundled-git-lfs-advisory";
import { navigationQueryEventRequiresRefresh } from "@pwragent/shared/navigation-query-events";
import { type AgentEvent } from "@pwragent/shared/contracts/agent";
import { forgeRuleProjectLabel } from "@pwragent/shared/contracts/forge-agent-tools";
import { AUTOMATIONS_SCHEDULING_STATUS_EVENT_CHANNEL, CODEX_RESTART_STATUS_CHANGED_EVENT_CHANNEL, THREAD_ARCHIVE_SWEEP_STATUS_CHANGED_EVENT_CHANNEL, RESEARCH_CHANGED_EVENT_CHANNEL } from "../shared/ipc";
import { disposeThreadMaintenanceService, getThreadMaintenanceService } from "./thread-maintenance-runtime";
import { readFederationThreadPrWatchesRequest } from "./pr-status/thread-pr-watches-federation";
import { getDesktopNavigationQueryStore } from "./app-server/navigation-query-store";
import { getDesktopNavigationQueryPool } from "./app-server/navigation-query-pool";
import { readLocalNavigationDirectoryIndex } from "./app-server/navigation-directory-index";
import { setNavigationDetailPendingWakesProjector } from "./app-server/navigation-detail-service";
import { appServerService } from "./app-server/desktop-app-server-service";
import { startOwnerQueues } from "./owner-queue-services";
import { disposeOperatorRequestService } from "./operator-requests/operator-request-runtime";

const MAIN_PROCESS_SHUTDOWN_TIMEOUT_MS = 12_000;
const RUNNING_TURNS_STOP_TIMEOUT_MS = 2_000;
const RUNNING_TURNS_SHUTDOWN_TIMEOUT_MS = RUNNING_TURNS_STOP_TIMEOUT_MS + 500;
const INTEGRATED_TERMINAL_SHUTDOWN_TIMEOUT_MS = 2_000;
const MESSAGING_SHUTDOWN_TIMEOUT_MS = 4_000;
const FEDERATION_SHUTDOWN_TIMEOUT_MS = 4_000;
const APP_SERVER_SHUTDOWN_TIMEOUT_MS = 7_500;
const MCP_CONNECTION_SHUTDOWN_TIMEOUT_MS = 2_000;
let federationLeaseReleasedSync = false;
let shutdownOwner: ReturnType<typeof createShutdownBarrier> | undefined;
const ownerSubscriptions = new Set<() => void>();

export interface OwnerStartOptions {
  bootMode: "active-profile" | "bootstrap";
  startedAt: number;
  shutdown?: {
    closeTerminal?: () => Promise<void>;
    closeMessagingStatus?: () => Promise<void>;
    closeAppServerIpc?: () => Promise<void>;
    observer?: Parameters<typeof createShutdownBarrier>[0]["observer"];
  };
  approvedLabCheckouts?: ReadonlyMap<string, ApprovedLabCheckout>;
  onStateInitialized?: (state: ReturnType<typeof initializeDesktopState>) => void;
}

let unsubscribeWorkingStateEvents: (() => void) | undefined;
let unsubscribeNavigationRemoteEvents: (() => void) | undefined;
let unsubscribeCodexRestartStatus: (() => void) | undefined;
let unsubscribeThreadArchiveSweepStatus: (() => void) | undefined;
let unsubscribeRegistryEvents: (() => void) | undefined;
let mainProcessShutdownPromise: Promise<void> | undefined;
let ownerShutdownStarted = false;
const isDevelopment = process.env.NODE_ENV !== "production";
const mainLog = getMainLogger("pwragent:main");
async function closeResearchOwner(): Promise<void> {
  try { await closeResearchRuntime(); }
  catch (error) { mainLog.warn("research shutdown failed", { error: String(error) }); }
}
const navigationQueryPool = getDesktopNavigationQueryPool();

function invalidateNavigationEvent(event: AgentEvent): void {
  if (event.notification.method === "thread/subAgentFailures/dismissed") {
    navigationQueryPool.invalidateExactOwner(event.federationTarget, {
      backend: event.backend, threadId: event.notification.params.threadId,
    }, "detail");
    return;
  }
  appServerService.invalidateThreadPendingWakes(event);
  getDesktopNavigationQueryStore().observeAttentionEvent(event);
  if (event.notification.method === "federation/eventStream/changed" && event.notification.params.navigationContinuous) return;
  if (!navigationQueryEventRequiresRefresh(event.notification.method)) return;
  const params = event.notification.params as { threadId?: string; parentThreadId?: string; thread?: { id?: string } } | undefined;
  const threadId = params?.threadId ?? params?.parentThreadId ?? params?.thread?.id;
  if (navigationQueryEventRequiresRefresh(event.notification.method, event.notification.params)) {
    navigationQueryPool.invalidateQueryOwner(event.federationTarget, navigationDiagnosticCause(event), navigationDiagnosticTrigger(event), event);
  }
  navigationQueryPool.invalidateExactOwner(event.federationTarget,
    typeof threadId === "string" ? { backend: event.backend, threadId } : undefined);
}
function startStartupSettingsDiscovery(permit: ProviderDiscoveryPermit): void {
  void getDesktopSettingsService()
    .refreshStartupDiscovery(permit)
    .catch((error) => {
      mainLog.warn("startup settings discovery failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
}

function prewarmInitialThreadList(permit: ProviderDiscoveryPermit): void {
  if (!getDesktopConfigStore().read("onboarding").completed) {
    mainLog.info("startup thread list prewarm deferred until onboarding completes");
    // Nothing re-enters this function when the wizard completes in the same
    // process, so no startup Codex discovery is coming. Say so, or every
    // surface that waits on `isCodexDiscoveryPending()` waits for the life of
    // the process — the startup landing included.
    getDesktopSettingsService().markStartupCodexDiscoverySkipped();
    recordStartupProfileEvent({
      type: "startup-thread-list-prewarm:deferred",
    });
    return;
  }
  const startedAt = Date.now();
  startStartupSettingsDiscovery(permit);
  // The durable thread snapshot painted below is allowed to appear
  // immediately. A cold profile has no executable selection yet, though, so
  // this live provider refresh waits only until Codex has a usable selection.
  // A warm profile uses its pinned last-known-good executable immediately;
  // discovery updates the next launch in the background.
  //
  // It must NOT hang off the prewarm `listThreads` result. This chain owns the
  // only `navigation/providerThreads/refreshed` emit, which is the renderer's
  // sole automatic trigger to re-read backend summaries; a rejected prewarm —
  // a broken Codex being exactly when that happens — would otherwise leave the
  // renderer holding a stale `discoveryPending` summary with nothing left to
  // clear it.
  const startupProviderRefresh = getDesktopSettingsService().resolveCodexCommand()
    // A missing executable must still publish the provider's degraded state.
    .catch(() => undefined)
    .then(async () => {
      // A pending quit confirmation can be canceled. Resource shutdown owns
      // permanent startup admission, just as it owns the boot guards below.
      if (ownerShutdownStarted) return;
      await getDesktopBackendRegistry().refreshProvidersAtStartup(permit);
    })
    .catch((error) => {
      mainLog.warn("startup provider refresh failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  // Token Miser preparation carries the same dependency — reading its server
  // capabilities opens the app-server, which cannot resolve an executable
  // until startup discovery has published a selection. Running it from the
  // registry constructor raced that and left Token Miser recorded as
  // unavailable for the whole session.
  //
  // It queues behind the provider refresh rather than beside it: preparation
  // spawns `codex plugin marketplace` subprocesses and a full retention prune,
  // and the refresh above owns the event that releases the renderer's startup
  // hold. Contending with it would delay first paint to no purpose.
  // Its own chain, so an archive sweeper failure cannot leave idle Codex
  // threads (and their MCP servers) loaded for the whole session.
  void startupProviderRefresh.then(() => {
    if (ownerShutdownStarted) return;
    getExistingDesktopBackendRegistry()?.startCodexIdleThreadUnsubscriber();
  }).catch((error) => {
    mainLog.warn("startup idle Codex thread unsubscriber initialization failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  });
  // The idle app-server recycle is the leak backstop; it gets its own chain
  // for the same reason.
  void startupProviderRefresh.then(() => {
    if (ownerShutdownStarted) return;
    getExistingDesktopBackendRegistry()?.startCodexAppServerRecycler();
  }).catch((error) => {
    mainLog.warn("startup Codex app server recycler initialization failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  });
  // And for idle ACP sessions.
  void startupProviderRefresh.then(() => {
    if (ownerShutdownStarted) return;
    getExistingDesktopBackendRegistry()?.startAcpIdleSessionCloser();
  }).catch((error) => {
    mainLog.warn("startup idle ACP session closer initialization failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  });
  // Continuations a quiet restart left start once providers can take a
  // turn, a few threads at a time.
  void startupProviderRefresh.then(async () => {
    if (ownerShutdownStarted) return;
    try {
      await getDesktopAppServerService().resumeInterruptedStackOperations();
    } finally {
      getExistingDesktopBackendRegistry()?.beginRestartContinuationDispatch();
    }
  }).catch((error) => {
    mainLog.warn("restart continuation dispatch failed to start", {
      error: error instanceof Error ? error.message : String(error),
    });
  });
  void startupProviderRefresh.then(() => {
    if (ownerShutdownStarted) return;
    getExistingDesktopBackendRegistry()?.startThreadArchiveSweeper();
  }).catch((error) => {
    mainLog.warn("startup thread archive sweeper initialization failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  });
  void startupProviderRefresh.then(async () => {
    if (ownerShutdownStarted) return;
    const registry = getExistingDesktopBackendRegistry();
    if (!registry) return;
    await registry.resumeArchiveCleanupsAtStartup();
  }).catch((error) => {
    mainLog.warn("archived worktree repair interrupted", { error: error instanceof Error ? error.message : String(error) });
  });
  void startupProviderRefresh
    .then(async () => {
      if (ownerShutdownStarted) return;
      await getDesktopBackendRegistry().prepareTokenMiserRuntimeAtStartup();
    })
    .catch((error) => {
      mainLog.warn("startup Token Miser preparation failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  void getDesktopBackendRegistry()
    .listThreads({
      callerReason: "startup-prewarm",
      limit: 50,
      maxPages: 1,
      skipArchivedMetadataRefresh: true,
    })
    .then((threads) => {
      recordStartupProfileEvent({
        type: "startup-thread-list-prewarm:completed",
        detail: {
          count: threads.length,
          durationMs: Date.now() - startedAt,
        },
      });
      if (!isDevelopment) {
        return;
      }
      mainLog.info("startup thread list prewarm completed", {
        count: threads.length,
        durationMs: Date.now() - startedAt,
      });
    })
    .catch((error) => {
      recordStartupProfileEvent({
        type: "startup-thread-list-prewarm:failed",
        detail: {
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      if (!isDevelopment) {
        return;
      }
      mainLog.warn("startup thread list prewarm failed", {
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
    });
}

let ownerStartup: Promise<OwnerServices> | undefined;
export type OwnerServices = Awaited<ReturnType<typeof constructOwnerServices>>;

export function startOwnerServices(host: OwnerHostServices, options: OwnerStartOptions): Promise<OwnerServices> {
  if (ownerStartup) throw new Error("startOwnerServices() has already been called.");
  ownerStartup = Promise.resolve().then(() => constructOwnerServices(host, options));
  return ownerStartup;
}

async function constructOwnerServices(host: OwnerHostServices, options: OwnerStartOptions) {
  if (ownerShutdownStarted) throw new Error("Owner startup was cancelled by shutdown.");
  installOwnerHostServices(host);
  setManagedGrokSignatureRejectionReporter((event) => host.renderer.managedGrokSignatureRejected(event));
  ownerSubscriptions.add(subscribeManagedRuntimeProgress((event) => host.renderer.managedRuntimeProgress(event)));
  shutdownOwner = createShutdownBarrier({
    globalTimeoutMs: MAIN_PROCESS_SHUTDOWN_TIMEOUT_MS,
    logger: mainLog,
    observer: options.shutdown?.observer,
    phases: [
      {
        // Ask each backend to stop its running turns while messaging and
        // federation still listen, so chats and peers see those turns end as
        // interrupted instead of never hearing that they ended.
        name: "running-turns",
        timeoutMs: RUNNING_TURNS_SHUTDOWN_TIMEOUT_MS,
        run: async () => {
          await closeResearchOwner();
          await getExistingDesktopBackendRegistry()?.stopRunningTurnsForShutdown({
            timeoutMs: RUNNING_TURNS_STOP_TIMEOUT_MS,
          });
        },
      },
      {
        name: "integrated-terminal",
        timeoutMs: INTEGRATED_TERMINAL_SHUTDOWN_TIMEOUT_MS,
        run: async () => {
          await options.shutdown?.closeTerminal?.();
        },
      },
      {
        name: "messaging",
        timeoutMs: MESSAGING_SHUTDOWN_TIMEOUT_MS,
        run: async () => {
          await options.shutdown?.closeMessagingStatus?.();
          disposeOwnerMessagingServices();
          await disposeDesktopMessagingRuntime();
          if (host.runtimePolicy?.exclusiveProfileOwner) getExistingRuntimeLeaseManager()?.release("messaging", "thread_owner");
        },
      },
      {
        name: "federation",
        timeoutMs: FEDERATION_SHUTDOWN_TIMEOUT_MS,
        run: async () => {
          await disposeDesktopFederationRuntime();
          // Release the profile lease only after the listener is down: a
          // replacement that acquired while the old socket was still bound
          // would hit EADDRINUSE, keep the lease, and stay degraded even
          // after this process exits. If this phase rejects or times out,
          // the will-quit/process-exit sync dispose releases instead.
          releaseOwnerFederationLeaseSync();
        },
      },
      {
        name: "settings-discovery",
        timeoutMs: APP_SERVER_SHUTDOWN_TIMEOUT_MS,
        run: closeDesktopSettingsCommandDiscovery,
      },
      {
        name: "app-server",
        timeoutMs: APP_SERVER_SHUTDOWN_TIMEOUT_MS,
        run: async () => {
          // Batched decision spend is written while the registry is alive.
          await flushOpenAIDecisionsUsage().catch((error: unknown) => mainLog.warn("decision usage flush failed", { error: String(error) }));
          await options.shutdown?.closeAppServerIpc?.();
          await disposeAppServerOwnerServices();
          if (host.runtimePolicy?.exclusiveProfileOwner) getExistingRuntimeLeaseManager()?.release("federation", "thread_owner");
        },
      },
      {
        name: "mcp-connections",
        timeoutMs: MCP_CONNECTION_SHUTDOWN_TIMEOUT_MS,
        run: async () => {
          await getExistingMcpConnectionGatewayService()?.close();
        },
      },
    ],
  });
  const bootMode = options.bootMode;
  const state = initializeDesktopState(bootMode);
  options.onStateInitialized?.(state);
  const leaseManager = initializeRuntimeLeaseManager({ exitedInstanceIds: host.runtimePolicy?.exitedRuntimeInstanceIds });
  if (host.runtimePolicy?.exclusiveProfileOwner) {
    for (const kind of ["federation", "messaging"] as const) {
      const result = leaseManager.acquire(kind, "thread_owner");
      if (!result.acquired) throw new Error(`Profile ${kind} lease is held by another runtime (${result.holder.instanceId}); stop that owner before starting Outpost.`);
    }
  }
  const config = initializeDesktopConfigStore({ appVersion: host.application.getVersion() });
  if (host.runtimePolicy?.exclusiveProfileOwner && host.runtimePolicy.codexCommand) {
    await config.write({ onboarding: { completed: true }, models: { codex: { path: host.runtimePolicy.codexCommand } } }, ["onboarding", "models"]);
  }
  const settings = initializeDesktopSettingsService();
  const federationLease = initializeRuntimeFederationLeaseCoordinator();
  const messagingLease = initializeRuntimeMessagingLeaseCoordinator();
  const mcpGateway = initializeMcpConnectionGatewayService();
  const registry = initializeDesktopBackendRegistry(() => createDesktopBackendRegistry({
    ownerAdmission: new ProfileThreadOwnerAdmission(() => leaseManager),
    configStore: config,
    useMachineAcpDiscovery: !host.runtimePolicy || host.runtimePolicy.enabledBackends.some(isAcpBackendId),
    useMachineClaudeDiscovery: !host.runtimePolicy || host.runtimePolicy.enabledBackends.includes("claude"),
  }));
  const service = initializeDesktopAppServerService();
  const scheduledActions = initializeScheduledThreadActionService(registry);
  const automations = initializeDesktopAutomationService(registry);
  if (bootMode === "active-profile") {
    registry.onEvent(async (event) => {
      const method = event.notification.method;
      if (method === "thread/archived" || method === "thread/unarchived") {
        await interruptStartupStorageMaintenance();
        getDesktopStorageMaintenanceStorage().observeArchive(event.backend, event.notification.params.threadId, method === "thread/archived");
      }
    });
  }
  const federationRuntime = initializeDesktopFederationRuntime();
  const resourceCheckouts = bootMode === "active-profile"
    ? await initializeResourceCheckouts(federationRuntime, options.approvedLabCheckouts, host.application.isPackaged)
    : undefined;
  if (resourceCheckouts) registry.setResourceCheckoutHandler(
    createResourceCheckoutToolHandler(
      resourceCheckouts,
      (context, resourceId, key, continuation) => service.registerResourceCheckoutContinuation(context, resourceId, key, continuation),
      (context, { instanceId, ...target }, prompt, bind) => registry.sendResourceCheckoutHandoff(context, {
        ...target, ...(instanceId === resourceCheckouts.handoffInstanceId() ? {} : { instanceId }),
      }, prompt, bind),
    ),
    (entry, id) => service.prepareResourceCheckoutWakeup(entry, id),
  );
  getDesktopBackendRegistry().setPwrAgentAppManagementHandler(
    createPwrAgentAppManagementHandler({
      authorize: (context, phase) => registry.canManagePwrAgent(context, false, phase === "accepted"),
      prepareRestart: (context, verification) => registry.prepareAgentRestartVerification(context, verification),
      runtimeId: registry.getAppManagementRuntimeId(),
      startedAt: options.startedAt,
      version: () => host.application.getVersion(),
      readCodexAppServerDiagnostics: async () =>
        await getExistingDesktopBackendRegistry()?.readCodexAppServerDiagnostics(),
    }),
  );
  // Reads the view the Star Map renderer publishes, so an Agent turn can
  // resolve "that thread" and "its cloud" against what is on screen.
  getDesktopBackendRegistry().setPwrAgentStarMapHandler(
    createStarMapAgentToolsHandler({
      openThread: (args) => host.threads.openThread(args),
      // It raises the window and replaces the operator's selection; only
      // the Voice manager acts on the operator's spoken request to open one.
      mayOpenThread: (caller) => caller.backend === "codex" && isVoiceManagerThread(caller.threadId),
    }),
  );
  // Registered OpenAI Decisions: seven fixed tools over a profile registry.
  // The key stays in the settings secret store until an invoke needs it.
  // A batch's moves are announced to its thread's windows (the Decisions
  // tab and the strip above the composer read it); a background batch
  // wakes the thread with a queued turn when it ends.
  getDesktopBackendRegistry().setPwrAgentOpenAIDecisionsHandler(
    createOpenAIDecisionsAgentToolsHandler({
      settings: getDesktopSettingsService(),
      recordUsageLines: async (lines) =>
        await getDesktopBackendRegistry().recordOpenAIDecisionsUsageLines(lines),
      announceBatch: async (update) =>
        await getDesktopBackendRegistry().publishDecisionBatchUpdate(update),
      wakeThread: async (caller, wake) =>
        await getDesktopBackendRegistry().deliverDecisionBatchWakeup({ ...caller, ...wake }),
    }),
  );
  const researchEnabled = () => getDesktopSettingsService().resolveResearchEnabled?.() === true;
  const research = initializeResearchRuntime({
    enabled: researchEnabled,
    ...createResearchOwnerIdentity(),
    onError: (error) => mainLog.warn("research operation failed", { error: String(error) }),
    changed: (change) => {
      for (const target of rendererSubscribers(RESEARCH_CHANGED_EVENT_CHANNEL)) {
        try { target.send(RESEARCH_CHANGED_EVENT_CHANNEL, change); }
        catch (error) { mainLog.warn("research view notification failed", { error: String(error) }); }
      }
    },
    ...createResearchRegistryPorts(registry),
  });
  ownerSubscriptions.add(bindResearchRegistry(registry, research, researchEnabled));
  // Codex threads are offered research only while Codex Tool Discovery is on.
  const codexResearchOffered = () => researchToolsOffered("codex", { enabled: researchEnabled(), codexToolDiscovery: () => getDesktopSettingsService().resolveCodexToolDiscovery?.() !== false });
  let researchWasEnabled = researchEnabled();
  let codexResearchWasOffered = codexResearchOffered();
  ownerSubscriptions.add(getDesktopConfigStore().subscribe(["experimental"], () => {
    const next = researchEnabled();
    const codexNext = codexResearchOffered();
    const stop = researchWasEnabled && !next;
    // A Codex coordinator and its workers can no longer post, review or stop, so their native runs stop.
    const stopCodex = !stop && codexResearchWasOffered && !codexNext;
    researchWasEnabled = next;
    codexResearchWasOffered = codexNext;
    if (stop) void research.stopOwnedRuns("Research runs were disabled in Experimental settings").catch((error) => mainLog.warn("research disable cancellation failed", { error: String(error) }));
    if (stopCodex) void research.stopOwnedRuns("Codex Tool Discovery was turned off, so Codex threads can no longer use research tools", (run) => run.coordinator.backend === "codex" && !run.harness)
      .catch((error) => mainLog.warn("research Codex discovery cancellation failed", { error: String(error) }));
  }));
  // Injected rather than owned by the registry: the federation runtime
  // already imports the registry, so the reverse import would be a cycle.
  const federationAgentToolOptions = {
    targetStore: getDesktopOverlayStore(),
    resolveCallerExecutionMode: async (context: PwrAgentFederationContext) =>
      await getDesktopBackendRegistry().resolveAgentCallerExecutionMode(context),
    resolveSourceTurnAttachments: (context: PwrAgentFederationContext) => {
      const turnId = context.turnId?.trim();
      return turnId
        ? getDesktopBackendRegistry().getTurnInputAttachments({
            backend: context.backend,
            threadId: context.threadId,
            turnId,
          })
        : [];
    },
    onRemoteChildMounted: async ({
      backend,
      instanceId,
      threadId,
    }: {
      backend: CreateInstanceThreadResult["backend"];
      instanceId: string;
      threadId: string;
    }) => {
      await getDesktopBackendRegistry().publishLocalEvent({
        backend,
        notification: {
          method: "navigation/remoteThreadPins/changed",
          params: { instanceId, threadId, pinned: true },
        },
      });
    },
  };
  const federationAgentToolsHandler =
    createFederationAgentToolsHandler(federationAgentToolOptions);
  getDesktopBackendRegistry().setPwrAgentFederationHandler(
    federationAgentToolsHandler,
  );
  // A thread handoff_task creates here is mounted on the viewers whose input
  // the calling turn carried, as create_instance_thread's threads are.
  getDesktopBackendRegistry().setAgentCreatedThreadObserver((turn, created) => {
    void getDesktopFederationRuntime().mountCreatedThreadOnTurnViewers({ turn, created });
  });
  // The same tools, for the Star Map [+] intake agent — built per intake
  // rather than once, because two of its options are properties of the one
  // request rather than of the machine:
  //
  // - `resolveMessageOrigin`: the intake's calling thread is an ephemeral
  //   turn that dissolves the moment it finishes, so crediting it as the
  //   created thread's `sourceThread` would leave a ThreadChip linking to
  //   nothing. An intake thread was asked for by the operator through
  //   PwrAgent, which is what the dialog recorded before there was an agent
  //   in the loop.
  // - `resolveSourceTurnAttachments`: the shared resolver looks the calling
  //   thread's turn up in the registry, and an ephemeral helper turn is not
  //   in it — so it returns nothing and the operator's pasted screenshots
  //   never reach the thread they described. The intake's staged
  //   attachments are handed in directly instead.
  // - `resolveCallerExecutionMode`: the helper turn has no thread whose
  //   access it could pass on. The intake agent may name Default Access;
  //   without a mode the thread takes the project's own.
  getDesktopBackendRegistry().setStarMapIntakeFederationHandlerFactory(
    (attachments) =>
      createFederationAgentToolsHandler({
        ...federationAgentToolOptions,
        resolveMessageOrigin: () => ({ kind: "pwragent" }),
        resolveSourceTurnAttachments: () => attachments,
        resolveCallerExecutionMode: () => "default",
      }),
  );
  getDesktopBackendRegistry().setFederatedThreadMessageHandler(
    createFederatedThreadMessageHandler({
      targetStore: getDesktopOverlayStore(),
    }),
  );
  getDesktopBackendRegistry().setLocalFederationInstanceId(
    () => getDesktopFederationRuntime().knownLocalInstanceId(),
  );
  getDesktopBackendRegistry().setFederatedThreadInspectionHandler(
    createFederatedThreadInspectionHandler({
      targetStore: getDesktopOverlayStore(),
    }),
  );
  getDesktopBackendRegistry().setFederatedThreadMutationHandler(
    createFederatedThreadMutationHandler({
      targetStore: getDesktopOverlayStore(),
    }),
  );
  getDesktopBackendRegistry().setFederatedThreadControlHandler(
    createFederatedThreadControlHandler({
      targetStore: getDesktopOverlayStore(),
    }),
  );
  // The app's own paths, so an Agent's archive also ungroups the thread's
  // children on other instances, and its pins and read marks reach every
  // window the way a click does.
  getDesktopBackendRegistry().setAgentThreadActions({
    markProjectRead: async (args) => await markAgentProjectRead(getDesktopFederationRuntime(), args),
    archiveThread: async (request) =>
      await appServerService.archiveThread(request),
    setThreadPin: async (request) =>
      await appServerService.setThreadPin(request),
    markThreadSeen: async (request) =>
      await appServerService.markThreadSeen(request),
    setThreadParent: async (request) =>
      await appServerService.setThreadParent(request),
  });

wireAppServerOwnerServices();
wireOwnerRendererEvents();
  const messagingRuntime = initializeDesktopMessagingRuntime(
    (options) => loadDesktopMessagingConfigFromSettings(
      getDesktopSettingsService(),
      process.env,
      options,
    ),
    () => config.read("messaging").toolUpdateMode ?? DEFAULT_DEVELOPMENT_WORKING_UPDATES_MODE,
  );

  getDesktopBackendRegistry().setMessagingArchiveCleaner({
    requestBindingRevokeAllForThread: (request) =>
      messagingRuntime.requestBindingRevokeAllForThread(request),
  });
  getDesktopBackendRegistry().setMessagingAgentToolService(messagingRuntime);
  if (bootMode === "active-profile") registry.setMessagingWorkingUpdatesSettings(settings);
  wireOwnerMessagingServices(messagingRuntime);
  if (host.updates.subscribeToNotices && bootMode === "active-profile") {
    ownerSubscriptions.add(wireMessagingAppUpdates({ host, registry, messagingRuntime,
      subscribe: host.updates.subscribeToNotices, readMachine: () => config.read("federation").instanceLabel }));
  }


  if (bootMode === "active-profile") {
    const registry = getDesktopBackendRegistry();
    void removeRetiredCiArtifactStore();
    await runStartupStorageMaintenance({
      storage: getDesktopStorageMaintenanceStorage(),
      existingDatabase: hadExistingAppStateDatabase(),
      onboardingCompleted: getDesktopConfigStore().read("onboarding").completed === true,
      discover: async () => {
        // Discovery is normally started after the main window appears. This
        // earlier consumer must start it and await only Codex readiness.
        startStartupSettingsDiscovery(issueProviderDiscoveryPermit("startup"));
        await getDesktopSettingsService().resolveCodexCommand();
        const [archived, active] = await Promise.all([
          registry.listThreads({ callerReason: "archive-cleanup", archived: true, forceRefresh: true, enrichDirectories: false, skipArchivedMetadataRefresh: true }),
          registry.listThreads({ callerReason: "archive-cleanup", archived: false, forceRefresh: true, enrichDirectories: false }),
        ]);
        return {
          archived: archived.map((thread) => ({ backend: thread.source, threadId: thread.id, archivedAt: thread.archivedAt })),
          active: active.map((thread) => ({ backend: thread.source, threadId: thread.id })),
        };
      },
    });
  }

  if (ownerShutdownStarted) throw new Error("Owner startup was cancelled by shutdown.");
  const queues = startOwnerQueues(federationRuntime, {
    registry,
    readDefaultMergeMethod: () => settings.resolveDefaultMergeMethod(),
    // Clicking a card approves the mode it shows, so these handlers skip the agent access ceiling.
    federation: createFederationAgentToolsHandler({ ...federationAgentToolOptions, operatorApproved: true }),
    federationWithOrigin: (messageOrigin: AppServerThreadMessageOrigin) => createFederationAgentToolsHandler({
      ...federationAgentToolOptions, operatorApproved: true, resolveMessageOrigin: () => messageOrigin,
    }),
  });
  void startAppServerOwnerNavigation().catch((error) => {
    mainLog.warn("failed to initialize owner navigation metadata", { error: String(error) });
  });
  scheduledActions.start();
  // Windows read the status once at load; this tells them when another
  // instance on the profile takes or hands back scheduled automations.
  ownerSubscriptions.add(automations.onSchedulingStatusChanged((status) => {
    for (const target of rendererSubscribers(AUTOMATIONS_SCHEDULING_STATUS_EVENT_CHANNEL)) {
      if (!target.isDestroyed()) target.send(AUTOMATIONS_SCHEDULING_STATUS_EVENT_CHANNEL, status);
    }
  }));
  automations.start();

  // Transcript images from PwrSnap are read through the MCP session that
  // returned them. With the gateway off there is no such session.
  setPwrSnapMediaReader(async (request) =>
    getDesktopSettingsService().resolveMcpGatewayEnabled()
      ? await getMcpConnectionGatewayService().readPwrSnapMediaResource(request)
      : { ok: false, reason: "session-ended" });

  // Only pre-start the bridge for a profile that actually uses it. Settings
  // still reaches the gateway on demand, so turning the switch back on does
  // not require a restart.
  if (
    bootMode === "active-profile"
    && getDesktopSettingsService().resolveMcpGatewayEnabled()
  ) {
    void getMcpConnectionGatewayService().start().catch((error) => {
      mainLog.error("MCP connection gateway failed during startup", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  ownerSubscriptions.add(subscribeFederationConfig(
    getDesktopConfigStore(),
    getDesktopFederationRuntime(),
    (error) => {
      mainLog.error("federation runtime config refresh failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    },
  ));

  void getDesktopFederationRuntime().restart().catch((error) => {
    mainLog.error("federation runtime failed during startup", {
      error: error instanceof Error ? error.message : String(error),
    });
  });
  const fingerprintMessagingLifecycleConfig = () => {
    // Controllers read this default from the current config snapshot.
    const { toolUpdateMode: _toolUpdateMode, ...messaging } = config.read("messaging");
    return JSON.stringify({
      messaging,
      pdfAnalysisEnabled: config.read("general").settings.pdfAnalysisEnabled ?? true,
    });
  };
  let messagingConfigFingerprint = fingerprintMessagingLifecycleConfig();
  ownerSubscriptions.add(getDesktopConfigStore().subscribe(
    ["general", "messaging"],
    () => {
      const nextFingerprint = fingerprintMessagingLifecycleConfig();
      if (nextFingerprint === messagingConfigFingerprint) {
        return;
      }
      messagingConfigFingerprint = nextFingerprint;
      const runtimeOverride = resolveRuntimeMessagingOverride();
      void getRuntimeMessagingLeaseCoordinator()
        .applyLatestConfig(
          messagingRuntime,
          (options) =>
            loadDesktopMessagingConfigFromSettings(
              getDesktopSettingsService(),
              process.env,
              options,
            ),
          {
            allowStart:
              !runtimeOverride.disabled || messagingRuntime.isEnabled(),
            logStartupEligibility: true,
          },
        )
        .catch((error) => {
          mainLog.error("messaging runtime config refresh failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
    },
  ));
  const messagingOverride = resolveRuntimeMessagingOverride();
  if (messagingOverride.disabled) {
    mainLog.info("messaging runtime disabled for this app instance", {
      reason: messagingOverride.reason,
    });
    void getRuntimeMessagingLeaseCoordinator()
      .start(messagingRuntime, (options) =>
        loadDesktopMessagingConfigFromSettings(
          getDesktopSettingsService(),
          process.env,
          options,
        ),
      )
      .catch((error) => {
        mainLog.error("messaging runtime lease recording failed during startup", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  } else {
    void getRuntimeMessagingLeaseCoordinator()
      .start(messagingRuntime, (options) =>
        loadDesktopMessagingConfigFromSettings(
          getDesktopSettingsService(),
          process.env,
          options,
        ),
      )
      .catch((error) => {
        mainLog.error("messaging runtime failed during background startup", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  return {
    registry, service, config, settings, federationRuntime, messagingRuntime,
    mcpGateway, scheduledActions, automations, leaseManager, federationLease, messagingLease,
    queues, resourceCheckouts,
    prewarm: prewarmInitialThreadList,
    onConfigPatchWritten: async (patch: DesktopSettingsConfigPatch, previousProviderDefaults?: Record<string, DesktopProviderModelDefaults>) => {
      if (previousProviderDefaults) {
        getDesktopOverlayStore().applyProviderModelDefaults(
          previousProviderDefaults,
          getDesktopSettingsService().resolveProviderModelDefaults(),
        );
      }
      // The registry observes the normalized provider domain, including
      // external file replacements. Await the same deduplicated invalidation
      // here so a direct Settings write cannot return ahead of its runtime
      // ownership boundary.
      await getDesktopBackendRegistry().synchronizeProviderRuntimeSelections();
      if (patch.federation !== undefined) {
        // Store subscriptions also cover external config-file edits. Keep
        // direct settings writes awaiting the runtime change, while the
        // Cloudflare ingress switch leaves other peer sessions intact.
        await applyFederationConfigPatch(getDesktopFederationRuntime(), patch.federation);
      }
      if (patch.general?.mcpGatewayEnabled === false) {
        // The switch forbids new bridges on its own, but a session opened
        // while it was on stays authorized until something ends it.
        await getMcpConnectionGatewayService()
          .closeAllUpstreamSessions()
          .catch((error) => {
            mainLog.error("MCP connection gateway failed to close sessions", {
              error: error instanceof Error ? error.message : String(error),
            });
          });
      }
    },
  };
}

function wireMessagingAppUpdates(options: {
  host: OwnerHostServices;
  registry: ReturnType<typeof getDesktopBackendRegistry>;
  messagingRuntime: DesktopMessagingRuntime;
  subscribe: NonNullable<OwnerHostServices["updates"]["subscribeToNotices"]>;
  readMachine(): string | undefined;
}): () => void {
  const { host, registry, messagingRuntime } = options;
  const selectDelivery = (binding: Parameters<DesktopMessagingRuntime["selectAppUpdateNoticeDelivery"]>[0]) =>
    messagingRuntime.selectAppUpdateNoticeDelivery(binding);
  const readMachine = () => options.readMachine();
  const onConnection = (listener: () => void) => messagingRuntime.onPlatformStatus((event) => {
    if (event.kind === "health-changed" && event.health === "enabled") listener();
  });
  const unsubscribe = subscribeAgentUpdateNotices({ subscribe: options.subscribe, selectDelivery, readMachine, onConnection,
    restoreReadyCards: Boolean(host.updates.messagingInstallTarget) });
  const { messagingInstallTarget, messagingInstallBlockerCount } = host.updates;
  if (!messagingInstallTarget || !messagingInstallBlockerCount) return unsubscribe;
  const runtimeId = registry.getAppManagementRuntimeId();
  const blockers = () => messagingInstallBlockerCount() + pendingUpdateBlockingWork()
    + messagingRuntime.countUnsubmittedUpdateBlockingWork();
  const controls = new MessagingAppUpdateControls({
    runtimeId, readTarget: messagingInstallTarget,
    blockerCount: () => Math.max(blockers(), Number(registry.hasDispatchBlockingIdleUpdate())),
    async install({ target, authorize, beforeHandoff }) {
      let busy = false;
      const result = await host.updates.install({
        expectedVersion: target.version,
        requestQuit: (performQuit, beforeQuit) => host.updates.requestQuit({
          source: "update-install", performQuit, authorizeAgent: authorize,
          holdIdleUpdateAdmission: () => {
            const release = blockers() === 0 ? registry.holdAdmissionForIdleUpdate() : undefined;
            busy = !release;
            return release;
          },
          beforeQuit: () => sameTarget(target, messagingInstallTarget()) && beforeQuit?.() === true && beforeHandoff(),
        }),
      });
      return result.status === "restarting" ? "accepted" : busy ? "busy" : "refused";
    },
    saveReceipt: (receipt) => createAppUpdateNoticeStore().saveRestartReceipt(receipt),
    clearReceipt: (receipt) => createAppUpdateNoticeStore().clearRestartReceipt(receipt),
  });
  messagingRuntime.setAppUpdateControls(controls);
  const unsubscribeRestart = reconcileAppUpdateRestart({
    runtimeId, currentVersion: () => host.application.getVersion(),
    selectDelivery, readMachine,
    isSameConnection: (binding, connectionId) => messagingRuntime.isAppUpdateConnectionCurrent(binding, connectionId),
    onConnection,
  });
  return () => {
    unsubscribe();
    unsubscribeRestart();
    controls.dispose();
    messagingRuntime.setAppUpdateControls(undefined);
  };
}

export async function disposeAppServerOwnerServices(): Promise<void> {
  await closeResearchOwner();
  disposeOwnerRendererEvents();
  setNavigationDetailPendingWakesProjector(undefined);
  setBundledGitLfsAdvisory(undefined);
  unsubscribeWorkingStateEvents?.();
  unsubscribeWorkingStateEvents = undefined;
  unsubscribeNavigationRemoteEvents?.();
  unsubscribeNavigationRemoteEvents = undefined;
  unsubscribeCodexRestartStatus?.();
  unsubscribeCodexRestartStatus = undefined;
  unsubscribeThreadArchiveSweepStatus?.();
  unsubscribeThreadArchiveSweepStatus = undefined;
  disposeThreadMaintenanceService();
  const registry = getExistingDesktopBackendRegistry();
  registry?.setResearchHandler(undefined);
  registry?.setThreadDependencyToolHandler(undefined);
  registry?.setThreadDependenciesPeerHandler(undefined);
  registry?.setThreadMaintenanceToolHandler(undefined);
  registry?.setThreadPullRequestStatusToolHandler(undefined);
  registry?.setThreadPullRequestCanonicalizer(undefined);
  registry?.setPullRequestReferenceResolver(undefined);
  registry?.setThreadPrimaryGitRepositoryReader(undefined);
  registry?.setLocalPullRequestAuthorityResolver(undefined);
  registry?.setThreadPullRequestWatchToolHandler(undefined);
  registry?.setDirectoryGitStatusWriter(undefined);
  registry?.setThreadPrAutoDispatchHandler(undefined);
  registry?.setThreadPullRequestDetachHandler(undefined);
  registry?.setThreadPrWatchesPeerHandler(undefined);
  registry?.setThreadPullRequestRefreshHandler(undefined);
  registry?.setProjectForgeAutomationHandler(undefined);
  try {
    await appServerService?.close();
  } finally {
    disposeOperatorRequestService();
  }
}

export function releaseOwnerFederationLeaseSync(): void {
  if (federationLeaseReleasedSync) {
    return;
  }
  federationLeaseReleasedSync = true;
  const runtimeFederationLeaseCoordinator =
    getExistingRuntimeFederationLeaseCoordinator();
  runtimeFederationLeaseCoordinator?.shutdownSync();
}

export function prepareOwnerShutdown(): void {
  ownerShutdownStarted = true;
  for (const unsubscribe of ownerSubscriptions) unsubscribe();
  ownerSubscriptions.clear();
  setManagedGrokSignatureRejectionReporter(undefined);
  try { getExistingDesktopBackendRegistry()?.checkpointArchiveCleanupsForQuit(); }
  catch (error) { mainLog.error("archive cleanup quit checkpoint failed", { error: error instanceof Error ? error.message : String(error) }); }
  // Announce while the sockets and publishers still exist. No peer acknowledgement wait.
  getExistingDesktopFederationRuntime()?.shutdown.exiting();
  getExistingRuntimeMessagingLeaseCoordinator()?.stopRecovery();
  getExistingRuntimeFederationLeaseCoordinator()?.stopRecovery();
  void closeDesktopSettingsCommandDiscovery();
}

export function disposeOwnerServicesSync(options: { releaseFederationLease?: boolean } = {}): void {
  void closeResearchOwner();
  if (options.releaseFederationLease === false) {
    // Electron's synchronous prelude is followed by the async registry drain.
    prepareDesktopAutomationShutdown();
  } else {
    disposeDesktopAutomationService();
    releaseOwnerFederationLeaseSync();
  }
  // Detached env-action trees (`pnpm dev` and friends) were previously just
  // abandoned here. They keep their stdio pipes, so they *usually* died of
  // SIGPIPE once we went away — but a quiet one could outlive the app and hold
  // its port. The quit dialog promises they get stopped, so stop them.
  const stoppedDetachedCommands = stopAllCodexEnvironmentDetachedCommands();
  if (stoppedDetachedCommands > 0) {
    mainLog.info("stopped detached environment actions on shutdown", {
      count: stoppedDetachedCommands,
    });
  }

  getExistingRuntimeMessagingLeaseCoordinator()?.shutdownSync();
  const manager = getExistingRuntimeLeaseManager();
  if (manager && getOwnerHostServices().runtimePolicy?.exclusiveProfileOwner) {
    manager.release("messaging", "thread_owner");
    if (options.releaseFederationLease !== false) manager.release("federation", "thread_owner");
  }
  if (options.releaseFederationLease !== false) getExistingRuntimeLeaseManager()?.markExited();
}

export async function disposeOwnerServices(source: string, remainingTimeoutMs?: number, disposeUnstartedHost?: () => Promise<void>): Promise<void> {
  ownerShutdownStarted = true;
  mainProcessShutdownPromise ??= (async () => {
    prepareDesktopAutomationShutdown();
    const checkoutShutdown = disposeResourceCheckouts(remainingTimeoutMs === undefined ? undefined : Math.min(2_000, remainingTimeoutMs))
      .catch((error: unknown) => mainLog.warn("checkout shutdown failed", { error: String(error) }));
    try {
      if (shutdownOwner) {
        await shutdownOwner(source, remainingTimeoutMs);
      } else {
        // An interrupted shell boot may have no constructed owner at all.
        // These disposers only release existing instances; they never call getters.
        await disposeUnstartedHost?.();
        await disposeDesktopMessagingRuntime();
        await disposeDesktopFederationRuntime();
        await closeDesktopSettingsCommandDiscovery();
      }
    } finally {
      // The registry has published its buffered pricing on the clean path.
      disposeDesktopAutomationService();
    }
    // Keep the scheduler subscribed until registry shutdown drains accepted work.
    disposeScheduledThreadActionService();
    await checkoutShutdown;
    disposeDesktopSettingsService();
    getExistingRuntimeLeaseManager()?.markExited();
    stopProfileRuntimeHeartbeatRefresh();
  })();
  await mainProcessShutdownPromise;
}

/** Owner bindings shared by the composition root and service contract tests. */
export function wireAppServerOwnerServices(): void {
  setBundledGitLfsAdvisory((repositoryPath) => {
    appServerService.publishBundledGitLfsAdvisory(repositoryPath);
  });
  unsubscribeWorkingStateEvents?.();
  unsubscribeNavigationRemoteEvents?.();
  unsubscribeNavigationRemoteEvents = getDesktopFederationRuntime().onRemoteBackendEvent(invalidateNavigationEvent);
  unsubscribeWorkingStateEvents = getDesktopBackendRegistry().onEvent((event) => {
    invalidateNavigationEvent(event);
    appServerService.handleAgentEventForWorkingState(event);
    appServerService.handleAgentEventForPrAttachments(event);
    appServerService.handleAgentEventForDependencies(event);
    appServerService.handleAgentEventForPrWatches(event);
  });
  const localForgeRead = (operation: ForgeReadOperation, args: ForgeReadArgs, context: AgentToolCallContext) => appServerService.readForgeForTool(operation, args, context);
  getDesktopBackendRegistry().setForgeReadHandlers(localForgeRead, createOwnerRoutedForgeReadHandler({
    local: localForgeRead,
    runtime: getDesktopFederationRuntime,
    targetStore: getDesktopOverlayStore(),
  }));
  getDesktopBackendRegistry().setForgePrToolHandler(
    async (operation, args, context) => await appServerService.runForgePrToolForAgent(operation, args, context),
    async (operation, args, context) => await appServerService.prepareForgePrToolForAgent(operation, args, context),
  );
  getDesktopBackendRegistry().setForgeToolPolicyResolver(
    () => getDesktopSettingsService().resolveForgeAgentToolPolicy(),
  );
  getDesktopBackendRegistry().setForgeToolRuleWriter(
    async (update) => await getDesktopSettingsService().upsertForgeAgentToolRule(update),
  );
  getDesktopBackendRegistry().setForgeProjectLabelResolver(
    async (repository) => forgeRuleProjectLabel(await readLocalNavigationDirectoryIndex(), repository),
  );
  getDesktopBackendRegistry().setThreadPullRequestStatusToolHandler(
    async (args, context) =>
      await appServerService.checkThreadPullRequestStatusForTool(args, context),
  );
  getDesktopBackendRegistry().setThreadPullRequestCanonicalizer(
    async (prs, demand, verifyAttachments) =>
      await appServerService.canonicalizeStoredPullRequests(prs, demand, verifyAttachments),
  );
  getDesktopBackendRegistry().setPullRequestReferenceResolver(
    async (params) => await appServerService.resolvePullRequestReference(params),
  );
  getDesktopBackendRegistry().setThreadPrimaryGitRepositoryReader((backend, threadId) =>
    appServerService.readPrimaryGitRepository(backend, threadId)
  );
  getDesktopBackendRegistry().setThreadProjectRepositoryResolver(async (backend, threadId) =>
    await appServerService.resolvePrimaryGitRepository(backend, threadId)
  );
  getDesktopBackendRegistry().setLocalPullRequestAuthorityResolver((prKey) =>
    appServerService.isPullRequestLocallyMonitored(prKey)
  );
  getDesktopBackendRegistry().setThreadMaintenanceToolHandler({
    scan: async (request) => await getThreadMaintenanceService().scan(request),
    getScan: (scanId) => getThreadMaintenanceService().getScan(scanId),
    getRun: () => getThreadMaintenanceService().getRun(),
    start: (request) => getThreadMaintenanceService().start(request),
    open: (request) => getOwnerHostServices().threads.openMaintenance(request),
  });
  getDesktopBackendRegistry().setThreadDependencyToolHandler(async (request, provenance, actor) => {
    try {
      const threadDependencies = await appServerService.manageThreadDependencies(request, provenance, actor);
      const projectNotice = appServerService.dependencyProjectNotice(request);
      return { ok: true, data: { threadDependencies, ...(projectNotice ? { projectNotice } : {}) } };
    } catch (error) {
      return { ok: false, error: { code: "invalid_arguments", message: error instanceof Error ? error.message : String(error) } };
    }
  });
  getDesktopBackendRegistry().setThreadDependenciesPeerHandler(async (request, requesterInstanceId, provenance) =>
    await appServerService.manageThreadDependenciesForPeer(request, requesterInstanceId, provenance));
  setNavigationDetailPendingWakesProjector(async (thread, activePrWatches) =>
    await appServerService.listThreadPendingWakes(thread, 0, activePrWatches));
  getDesktopBackendRegistry().setThreadPrWatchesPeerHandler(async (request) => {
    // Envelope params are the viewer's; only the named fields reach the store.
    const owned = readFederationThreadPrWatchesRequest(request);
    if (!owned) {
      return {
        ok: false,
        error: { code: "invalid_arguments", message: "backend, threadId and the action's argument are required." },
      };
    }
    return await appServerService.manageThreadPrWatches(owned);
  });
  getDesktopBackendRegistry().setThreadPullRequestWatchToolHandler(
    async (args, provenance) => await appServerService.watchThreadPullRequestForTool(args, provenance),
  );
  getDesktopBackendRegistry().setDirectoryGitStatusWriter(
    async (params) => await appServerService.writeDirectoryGitStatusEntry(params),
  );
  getDesktopBackendRegistry().setThreadPullRequestDetachHandler(
    async (request) => await appServerService.detachThreadPullRequest(request),
  );
  getDesktopBackendRegistry().setThreadPullRequestRefreshHandler(
    async (request) =>
      await appServerService.refreshOwnedThreadPullRequests(request),
  );
  getDesktopBackendRegistry().setProjectForgeAutomationHandler({
    set: async (request) => await appServerService.setProjectForgeAutomation({
      directoryKey: request.directoryKey,
      automation: request.automation,
    }),
    listHeldWakeups: async (request) => await appServerService.listProjectHeldWakeups({
      directoryKey: request.directoryKey,
    }),
    resolveHeldWakeups: async (request) => await appServerService.resolveProjectHeldWakeups({
      directoryKey: request.directoryKey,
      resolutions: request.resolutions,
    }),
  });
  getDesktopBackendRegistry().setThreadGitWorkingStateRefreshHandler(
    async (request) =>
      await appServerService.refreshThreadGitWorkingState(request),
  );
  getDesktopBackendRegistry().setThreadPrAutoDispatchHandler({
    preferenceChanged: async (request) =>
      await appServerService.handleThreadPrAutoDispatchPreference(request),
    preferencesChanged: async (requests) =>
      await appServerService.handleThreadPrAutoDispatchPreferences(requests),
    cancelPending: async (request) =>
      await appServerService.cancelThreadPrAutoDispatch(request),
    lockChanged: async (request) =>
      await appServerService.handleThreadLockChanged(request),
    sendPendingNow: async (request) =>
      await appServerService.sendThreadPrAutoDispatchNow(request),
    inspect: async (request, context) =>
      await appServerService.getThreadPullRequestAutomationStatus(
        request,
        context,
      ),
  });
  unsubscribeCodexRestartStatus?.();
  unsubscribeCodexRestartStatus =
    getDesktopBackendRegistry().onCodexAppServerRestartStatusChanged((status) => {
      for (const webContents of rendererSubscribers(
        CODEX_RESTART_STATUS_CHANGED_EVENT_CHANNEL,
      )) {
        if (!webContents.isDestroyed()) {
          webContents.send(CODEX_RESTART_STATUS_CHANGED_EVENT_CHANNEL, status);
        }
      }
    });
  unsubscribeThreadArchiveSweepStatus?.();
  unsubscribeThreadArchiveSweepStatus =
    getDesktopBackendRegistry().onThreadArchiveSweepStatusChanged((status) => {
      for (const webContents of rendererSubscribers(
        THREAD_ARCHIVE_SWEEP_STATUS_CHANGED_EVENT_CHANNEL,
      )) {
        if (!webContents.isDestroyed()) {
          webContents.send(THREAD_ARCHIVE_SWEEP_STATUS_CHANGED_EVENT_CHANNEL, status);
        }
      }
    });

}

export function wireOwnerRendererEvents(): void {
  const registry = getDesktopBackendRegistry();
  const host = getOwnerHostServices();
  unsubscribeRegistryEvents?.();
  getDesktopFederationRuntime().setAgentEventPublisher((event) => host.renderer.agentEvent(event));
  getDesktopFederationRuntime().setEnvironmentSetupProgressPublisher(
    (event) => host.renderer.environmentSetupProgress(event),
  );
  unsubscribeRegistryEvents = registry.onEvent((event) => {
    host.renderer.agentEvent(event);
  });

}

export function disposeOwnerRendererEvents(): void {
  unsubscribeRegistryEvents?.();
  unsubscribeRegistryEvents = undefined;
}

/** Messaging's owner health and preview publishers exist before any adapter starts. */
export function wireOwnerMessagingServices(runtime: Pick<DesktopMessagingRuntime, "getPlatformStatuses">): void {
  setFederationMessagingPlatformStatusReader(() => runtime.getPlatformStatuses());
  setInboundPreviewSink((message) => getOwnerHostServices().renderer.inboundPreview(message));
}

export function disposeOwnerMessagingServices(): void {
  setInboundPreviewSink(undefined);
  setFederationMessagingPlatformStatusReader(undefined);
}
