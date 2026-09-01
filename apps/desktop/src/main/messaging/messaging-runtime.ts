import { randomBytes, randomUUID } from "node:crypto";
import {
  isMessagingInteractivePendingRequest,
  MessagingController,
  type MessagingControllerDeliveryBudgetEvent,
} from "./core/messaging-controller";
import { getRbacPolicyService } from "./rbac-policy-service";
import { getDesktopAutomationService } from "../automations/desktop-automation-service";
import type { MessagingStoreLike } from "../state/messaging-store-sqlite";
import type {
  MessagingAdapter,
  MessagingBackendBridge,
  MessagingConversationTitleUpdateRequest,
  MessagingConversationTitleUpdateResult,
} from "./core/messaging-adapter";
import type {
  AgentEvent,
  AppServerBackendKind,
  GenerateMessagingPairingTokenRequest,
  GenerateMessagingPairingTokenResponse,
  FederationEventSubscription,
  InboundPreviewMessage,
  ListMessagingPairingRequestsRequest,
  ListMessagingPairingRequestsResponse,
  MessagingDegradationReason,
  MessagingPairingEntry,
  MessagingPairingObservedActor,
  MessagingPairingObservedChat,
  MessagingPlatformHealth,
  MessagingPlatformStatus,
  MessagingPlatformStatusEvent,
  PwrAgentMessagingRequest,
  PwrAgentMessagingResponse,
} from "@pwragent/shared";
import { buildThreadIdentityKey } from "@pwragent/shared";
import type {
  MessagingBindingRecord,
  MessagingAdapterAuthorizationUpdate,
  MessagingAdapterDiagnosticEvent,
  MessagingAdapterRenderingPreferencesUpdate,
  MessagingCapabilityProfile,
  MessagingDirectoryActor,
  MessagingChannelRef,
  MessagingChannelKind,
  MessagingClientRateLimitStrategy,
  MessagingCredentialValidationResult,
  MessagingDeliveryResult,
  MessagingDeliveryScope,
  MessagingInboundEvent,
  MessagingInboundRejectedListener,
  MessagingManagedConversationActionRequest,
  MessagingManagedConversationActionResult,
  MessagingManagedConversationCreateRequest,
  MessagingManagedConversationCreateResult,
  MessagingManagedConversationRightsRequest,
  MessagingManagedConversationRightsResult,
  MessagingPrivateConversationResolveRequest,
  MessagingPrivateConversationResolveResult,
  MessagingRateLimitInfo,
  MessagingReconnectInfo,
  MessagingRejectedInboundEvent,
  MessagingSurfaceIntent,
} from "@pwragent/messaging-interface";
import {
  extractMessagingPairingToken,
  isMessagingPairingCommand,
  MESSAGING_PAIRING_COMMAND,
  MESSAGING_PAIRING_TOKEN_PATTERN,
} from "@pwragent/messaging-interface";
import { getMainLogger } from "../log";
import { getDesktopMessagingStore } from "./desktop-messaging-store";
import {
  type DesktopMessagingConfigLoadOptions,
  classifyDesktopMessagingChannelConfigUpdate,
  loadDesktopMessagingConfig,
  type DesktopMessagingConfig,
  type DesktopMessagingConfigChannel,
  type DesktopMessagingChannelConfigUpdate,
} from "./messaging-config";
import { resolveMessagingResponseModeForChannel } from "./messaging-response-mode";
import { DesktopMessagingBackendBridge } from "./desktop-backend-bridge";
import { resolvePwragentRoot } from "../profile";
import { getDesktopFederationRuntime } from "../federation/federation-runtime";
import { getDesktopMessagingActivityLog } from "./desktop-messaging-activity-log";
import {
  hasActiveInboundPreview,
  inboundEventToPreviewMessage,
  publishInboundPreview,
} from "./inbound-preview-bus";
import { getDesktopMessagingPairingStore } from "./desktop-messaging-pairing-store";
import {
  configuredMessagingProviderIds,
  loadConfiguredMessagingAdapters,
} from "./provider-loader";
import {
  MessagingDeliveryBudget,
  type MessagingDeliveryPriority,
} from "./core/messaging-delivery-budget";
import type {
  DynamicToolPermissionCheck,
  DynamicToolPermissionResult,
  MessagingAgentToolService,
} from "./messaging-agent-tool-service";

export type DesktopMessagingAdapter = {
  authorizedActorIds: readonly string[];
  capabilityProfile: MessagingCapabilityProfile;
  channel: MessagingChannelKind;
  clientRateLimitStrategy?: MessagingClientRateLimitStrategy;
  readCredentialMetadata?(): MessagingCredentialMetadata | undefined;
  deliver(intent: MessagingSurfaceIntent): Promise<MessagingDeliveryResult>;
  resolveDeliveryScope?(intent: MessagingSurfaceIntent): MessagingDeliveryScope | undefined;
  downloadAttachment?: MessagingAdapter["downloadAttachment"];
  /**
   * Optional people/app directory search, gated by
   * `capabilityProfile.directory`. Providers without a searchable directory
   * omit it and callers fall back to senders already observed.
   */
  searchDirectoryActors?: MessagingAdapter["searchDirectoryActors"];
  /**
   * Push the set of conversations automations observe. Adapters forward all
   * senders' messages there flagged observedOnly instead of dropping them at
   * the per-user access gate.
   */
  updateObservedConversations?: (conversationIds: readonly string[]) => void;
  /**
   * Optional history fetch for the Automations editor live preview. Providers
   * that can read recent conversation messages (e.g. Slack) implement this;
   * others omit it and the preview falls back to going-forward capture.
   */
  fetchRecentMessages?: (request: {
    conversationId: string;
    limit?: number;
  }) => Promise<MessagingInboundEvent[]>;
  /**
   * Optional subscription for serious runtime errors after a successful
   * start (e.g. Telegram's 409 Conflict when a second bot instance starts
   * polling, or Mattermost's sustained reconnect failures). The runtime
   * flips platform health to `errored`; an adapter that keeps retrying can
   * later restore health by emitting `onReconnect({ state: "recovered" })`.
   */
  onRuntimeError?(listener: (reason: string) => void): () => void;
  onRateLimit?(listener: (info: MessagingRateLimitInfo) => void): () => void;
  onReconnect?(listener: (info: MessagingReconnectInfo) => void): () => void;
  onInboundRejected?(listener: MessagingInboundRejectedListener): () => void;
  onDiagnostic?(listener: (event: MessagingAdapterDiagnosticEvent) => void): () => void;
  updateAuthorization?(update: MessagingAdapterAuthorizationUpdate): Promise<void>;
  updateRenderingPreferences?(
    update: MessagingAdapterRenderingPreferencesUpdate,
  ): Promise<void>;
  setConversationTitle?(
    request: MessagingConversationTitleUpdateRequest,
  ): Promise<MessagingConversationTitleUpdateResult>;
  getManagedConversationRights?(
    request: MessagingManagedConversationRightsRequest,
  ): Promise<MessagingManagedConversationRightsResult>;
  createManagedConversation?(
    request: MessagingManagedConversationCreateRequest,
  ): Promise<MessagingManagedConversationCreateResult>;
  resolvePrivateConversation?(
    request: MessagingPrivateConversationResolveRequest,
  ): Promise<MessagingPrivateConversationResolveResult>;
  closeManagedConversation?(
    request: MessagingManagedConversationActionRequest,
  ): Promise<MessagingManagedConversationActionResult>;
  reopenManagedConversation?(
    request: MessagingManagedConversationActionRequest,
  ): Promise<MessagingManagedConversationActionResult>;
  deleteManagedConversation?(
    request: MessagingManagedConversationActionRequest,
  ): Promise<MessagingManagedConversationActionResult>;
  start?(listener: (event: MessagingInboundEvent) => Promise<void>): Promise<void>;
  stop?(): Promise<void>;
};

export type MessagingCredentialMetadata = {
  account?: string;
  detail?: string;
};

export type DesktopMessagingAdapterFactory = (params: {
  config: DesktopMessagingConfig;
  store: MessagingStoreLike;
}) => DesktopMessagingAdapter[] | Promise<DesktopMessagingAdapter[]>;

export type DesktopMessagingConfigLoader = (
  options?: DesktopMessagingConfigLoadOptions,
) =>
  | DesktopMessagingConfig
  | Promise<DesktopMessagingConfig>;

export type MessagingAutomationInboundHandler = (
  event: Extract<MessagingInboundEvent, { kind: "media" | "text" }>,
) => Promise<boolean>;

/**
 * Pure predicate: would any inbound automation's filter match this event? Lets
 * the runtime keep delivering automation-matched messages even when the
 * @mention response mode would otherwise drop them. No side effects.
 */
export type MessagingAutomationInboundMatcher = (
  event: MessagingInboundEvent,
) => boolean;

type RunningMessagingAdapter = {
  adapter: DesktopMessagingAdapter;
  authorization: RunningMessagingAuthorization;
  config: DesktopMessagingConfig;
  controller: MessagingController;
  fingerprint: string;
  unsubscribeDiagnostic?: () => void;
  unsubscribeInboundRejected?: () => void;
  unsubscribeRateLimit?: () => void;
  unsubscribeReconnect?: () => void;
  unsubscribeRuntimeError?: () => void;
};

type RunningMessagingAuthorization = {
  actorIds: string[];
  actorIdSet: Set<string>;
};

type RejectedInboundRoute = {
  backend: MessagingBindingRecord["backend"];
  bindingId?: string;
  destinationAgentName?: string;
  routeSource: "binding" | "default-agent";
  targetKind: NonNullable<MessagingBindingRecord["targetKind"]>;
  threadId: MessagingBindingRecord["threadId"];
};

type PendingAdapterStart = {
  cancel(reason: string): void;
};

type AdapterStartOutcome = "cancelled" | "failed" | "started";

class AdapterStartCancelledError extends Error {
  constructor(
    message: string,
    readonly startInvoked = true,
  ) {
    super(message);
    this.name = "AdapterStartCancelledError";
  }
}

class AdapterStartTimeoutError extends Error {
  constructor(channel: MessagingChannelKind, timeoutMs: number) {
    super(
      `${channel} adapter startup did not complete within ${formatDuration(timeoutMs)}.`,
    );
    this.name = "AdapterStartTimeoutError";
  }
}

const messagingLog = getMainLogger("pwragent:messaging");
const PAIRING_INSTANCE_ID = "default";
const DEFAULT_PAIRING_TTL_MS = 5 * 60 * 1000;
const MIN_PAIRING_TTL_MS = 60 * 1000;
const MAX_PAIRING_TTL_MS = 30 * 60 * 1000;
const MAX_OUTSTANDING_PAIRING_TOKENS = 5;
const PAIRING_TOKEN_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const RATE_LIMIT_HEALTH_BUFFER_MS = 2_000;
const DELIVERY_BUDGET_WARNING_TTL_MS = 30_000;
const DELIVERY_BUDGET_DIAGNOSTIC_THROTTLE_MS = 30_000;
const REJECTED_ROUTE_AGENT_METADATA_TTL_MS = 60_000;
const DEFAULT_ADAPTER_START_TIMEOUT_MS = 90_000;
const FAILED_START_STOP_TIMEOUT_MS = 3_000;
const CONFIGURABLE_MESSAGING_CHANNELS = [
  "discord",
  "feishu",
  "line",
  "mattermost",
  "slack",
  "telegram",
] as const satisfies readonly MessagingChannelKind[];

export type MessagingPairingChangedEvent = {
  at: number;
  entry: MessagingPairingEntry;
};

/**
 * Origin tag carried on `requestBindingRevoke` /
 * `requestBindingRevokeAllForThread` so subscribers and observability
 * can distinguish UI-initiated detaches from archive flows or
 * platform-side commands. Adding a new origin must NOT introduce a
 * platform branch — origins are routing-neutral metadata.
 */
export type BindingRevokeOrigin =
  | "ui"
  | "platform-command"
  | "thread-archive"
  | "permanent-failure";

export type BindingRevokeRequest = {
  bindingId: string;
  origin: BindingRevokeOrigin;
};

export type BindingRevokeAllForThreadRequest = {
  backend: MessagingBindingRecord["backend"];
  threadId: MessagingBindingRecord["threadId"];
  origin: BindingRevokeOrigin;
};

export type BindingRevokeResult = {
  /** True if the binding existed and was either retired by a
   * controller or removed via the runtime fallback. */
  revoked: boolean;
  /** True if a controller's adapter scoped the binding's channel and
   * delivered the platform-side retirement + confirmation. False
   * means the binding was removed from the store but no platform
   * notification was sent (e.g., messaging is currently disabled). */
  notifiedPlatform: boolean;
};

export type BindingRevokeAllForThreadResult = {
  /** Number of bindings revoked in total. */
  revokedCount: number;
  /** Number that were retired through a controller's platform
   * notification flow. The remainder were store-only fallbacks. */
  notifiedCount: number;
};

/**
 * Request payload for `requestCredentialValidation`. The runtime
 * routes by `channel` and forwards `credential` to the matching
 * provider package's `validateCredentials` function.
 *
 * The runtime is channel-neutral: it does not parse the credential,
 * does not branch on platform, and does not know which library each
 * provider uses. Adding a new platform means adding a new
 * dynamic-import case to `dispatchCredentialValidation` below — no
 * other changes to the runtime.
 */
export type CredentialValidationRequest =
  | { channel: "telegram"; credential: { botToken: string } }
  | { channel: "discord"; credential: { botToken: string } }
  | {
      channel: "mattermost";
      credential: { botToken: string; serverUrl: string };
    }
  | { channel: "slack"; credential: { botToken: string; appToken?: string } }
  | {
      channel: "feishu";
      credential: { appId: string; appSecret: string; tenantUrl: string };
    }
  | { channel: "line"; credential: { channelAccessToken: string } };

export class DesktopMessagingRuntime implements MessagingAgentToolService {
  private adapters: DesktopMessagingAdapter[] = [];
  private automationsChangedUnsubscribe?: () => void;
  private controllers: MessagingController[] = [];
  private readonly runningAdapters = new Map<
    MessagingChannelKind,
    RunningMessagingAdapter
  >();
  private unsubscribeBackendEvents?: () => void;
  private started = false;
  /**
   * Per-platform health snapshot. Keyed by `MessagingChannelKind`. Updated
   * by `setPlatformHealth` and read by `getPlatformStatuses` for the
   * renderer's initial paint. Survives `stop()` so a paused state shows
   * `suspended` in the UI rather than disappearing.
   */
  private readonly platformStatuses = new Map<
    MessagingChannelKind,
    MessagingPlatformStatus
  >();
  private readonly platformCredentialMetadata = new Map<
    MessagingChannelKind,
    MessagingCredentialMetadata & { observedAt: number }
  >();
  private readonly platformDegradationReasons = new Map<
    MessagingChannelKind,
    Map<string, MessagingDegradationReason>
  >();
  private readonly platformDegradationTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly deliveryBudgetDiagnosticLastLoggedAt = new Map<string, number>();
  private readonly rejectedRouteAgentNameCache = new Map<
    string,
    { expiresAt: number; value: Promise<string | undefined> }
  >();
  private readonly platformStatusListeners = new Set<
    (event: MessagingPlatformStatusEvent) => void
  >();
  private readonly pendingAdapterStarts = new Map<
    MessagingChannelKind,
    PendingAdapterStart
  >();
  private readonly pendingAdapterStartCancellationReasons = new Map<
    MessagingChannelKind,
    string
  >();
  private pendingAdapterStopReason?: string;
  private lifecycleQueue: Promise<void> = Promise.resolve();
  /**
   * Listeners notified whenever any controller mutates a binding
   * (create / refresh metadata / sync title / detach / revoke). The
   * payload is intentionally empty — listeners refetch the navigation
   * snapshot rather than diffing per-binding changes themselves.
   */
  private readonly bindingsChangedListeners = new Set<() => void>();
  private readonly pairingChangedListeners = new Set<
    (event: MessagingPairingChangedEvent) => void
  >();

  constructor(
    private readonly options: {
      adapterFactory: DesktopMessagingAdapterFactory;
      backendBridge: MessagingBackendBridge & {
        onEvent?: (listener: (event: AgentEvent) => void | Promise<void>) => () => void;
        setRemoteEventSubscriptions?: (
          subscriptions: readonly FederationEventSubscription[],
        ) => void;
      };
      config: DesktopMessagingConfig | DesktopMessagingConfigLoader;
      automationInboundHandler?: MessagingAutomationInboundHandler;
      automationInboundMatches?: MessagingAutomationInboundMatcher;
      adapterStartTimeoutMs?: number;
    },
  ) {}

  async start(): Promise<void> {
    this.pendingAdapterStopReason = undefined;
    this.pendingAdapterStartCancellationReasons.clear();
    await this.enqueueLifecycle(async () => {
      const config = await this.loadConfig({ logStartupEligibility: true });
      await this.applyConfigWithFailureStatus(config);
    });
  }

  async stop(
    options: { preserveStartupFailures?: boolean } = {},
  ): Promise<void> {
    const reason = "Messaging was stopped while adapter startup was still pending.";
    this.pendingAdapterStopReason = reason;
    this.cancelPendingAdapterStarts(reason);
    await this.enqueueLifecycle(async () => {
      await this.stopNow(options);
    });
  }

  async handlePwrAgentMessagingRequest(
    request: PwrAgentMessagingRequest,
  ): Promise<PwrAgentMessagingResponse> {
    let firstNotFound: PwrAgentMessagingResponse | undefined;
    for (const controller of this.controllers) {
      const response = await controller.handlePwrAgentMessagingRequest(request);
      if (response.ok) {
        return response;
      }
      if (response.error.code === "not_found") {
        firstNotFound ??= response;
        continue;
      }
      return response;
    }
    return firstNotFound ?? {
      ok: false,
      error: {
        code: "not_found",
        message: "No running messaging adapter has this Agent turn location.",
      },
    };
  }

  checkDynamicToolPermission(
    check: DynamicToolPermissionCheck,
  ): DynamicToolPermissionResult {
    for (const controller of this.controllers) {
      const result = controller.checkDynamicToolPermission(check);
      if (result.owns) {
        return result.permission !== undefined
          ? { allowed: result.allowed, permission: result.permission }
          : { allowed: result.allowed };
      }
    }
    // No messaging controller started this turn → desktop-operator turn →
    // unrestricted (RBAC only governs messaging-originated agents). Note:
    // origins are controller-memory only, so a controller torn down mid-turn
    // makes its still-running turn land here too — see the "Known window"
    // note on MessagingController.checkDynamicToolPermission.
    return { allowed: true };
  }

  private async stopNow(
    options: { preserveStartupFailures?: boolean } = {},
  ): Promise<void> {
    this.automationsChangedUnsubscribe?.();
    this.automationsChangedUnsubscribe = undefined;
    if (!this.started) {
      if (!options.preserveStartupFailures) {
        this.clearRetainedStartupFailures();
      }
      return;
    }
    this.started = false;

    this.unsubscribeBackendEvents?.();
    this.unsubscribeBackendEvents = undefined;
    this.options.backendBridge.setRemoteEventSubscriptions?.([]);
    const stoppedChannels = [...this.runningAdapters.keys()];
    await Promise.all(
      [...this.runningAdapters.values()].map(async (running) =>
        this.stopRunningAdapter(running)
      ),
    );
    this.runningAdapters.clear();
    this.adapters = [];
    this.controllers = [];
    this.rejectedRouteAgentNameCache.clear();
    // Mark each previously-running platform as suspended (not removed),
    // so the renderer keeps the icon visible with a gray dot — the user
    // knows it's configured but currently off.
    for (const channel of stoppedChannels) {
      const previous = this.platformStatuses.get(channel);
      const preserveStartupFailure =
        options.preserveStartupFailures && previous?.startupFailure === true;
      this.setPlatformHealth(channel, "suspended", {
        reason: preserveStartupFailure ? previous.reason : undefined,
        startupFailure: preserveStartupFailure || undefined,
      });
    }
    if (!options.preserveStartupFailures) {
      this.clearRetainedStartupFailures();
    }
  }

  async applyConfig(
    config: DesktopMessagingConfig,
    options: { allowStart?: boolean } = {},
  ): Promise<void> {
    this.updatePendingAdapterStartIntent(config);
    await this.enqueueLifecycle(async () => {
      await this.applyConfigWithFailureStatus(config, options);
    });
  }

  private async applyConfigWithFailureStatus(
    config: DesktopMessagingConfig,
    options: { allowStart?: boolean } = {},
  ): Promise<void> {
    try {
      await this.applyConfigNow(config, options);
      this.clearStartupFailuresForDisabledPlatforms(config);
    } catch (error) {
      // Config application can reject after adapters have already reported
      // enabled (for example, a post-start federation subscription sync).
      // Mark every configured platform before cleanup so the failure remains
      // visible even when stopNow subsequently suspends running adapters.
      const reason = error instanceof Error ? error.message : String(error);
      for (const platform of configuredMessagingProviderIds(config)) {
        this.setPlatformHealth(platform, "errored", {
          reason,
          startupFailure: true,
        });
      }
      throw error;
    }
  }

  private clearRetainedStartupFailures(): void {
    for (const [platform, status] of this.platformStatuses) {
      if (!status.startupFailure) continue;
      this.setPlatformHealth(platform, "suspended");
    }
  }

  private clearStartupFailuresForDisabledPlatforms(
    config: DesktopMessagingConfig,
  ): void {
    const configuredPlatforms = new Set<MessagingChannelKind>(
      configuredMessagingProviderIds(config),
    );
    for (const [platform, status] of this.platformStatuses) {
      if (!status.startupFailure || configuredPlatforms.has(platform)) continue;
      this.setPlatformHealth(platform, "suspended");
    }
  }

  private async applyConfigNow(
    config: DesktopMessagingConfig,
    options: { allowStart?: boolean } = {},
  ): Promise<void> {
    if (config.enabled === false) {
      await this.stopNow();
      return;
    }

    if (!this.started) {
      if (options.allowStart === false) {
        return;
      }
      this.started = true;
      this.subscribeBackendEvents();
    }

    const store = getDesktopMessagingStore();
    const configuredAdapters = await this.options.adapterFactory({
      config,
      store,
    });
    const nextAdapters = new Map<MessagingChannelKind, DesktopMessagingAdapter>();
    for (const adapter of configuredAdapters) {
      nextAdapters.set(adapter.channel, adapter);
    }

    const stoppedChannels: MessagingChannelKind[] = [];
    const hotUpdatedChannels: MessagingChannelKind[] = [];
    for (const [channel, running] of [...this.runningAdapters.entries()]) {
      const next = nextAdapters.get(channel);
      if (!next) {
        await this.stopRunningAdapter(running);
        this.runningAdapters.delete(channel);
        stoppedChannels.push(channel);
        continue;
      }

      if (!isDesktopMessagingConfigChannel(channel)) {
        const nextFingerprint = messagingAdapterConfigFingerprint(config, channel);
        if (running.fingerprint !== nextFingerprint) {
          await this.stopRunningAdapter(running);
          this.runningAdapters.delete(channel);
          stoppedChannels.push(channel);
        }
        continue;
      }

      const configUpdate = classifyDesktopMessagingChannelConfigUpdate(
        running.config,
        config,
        channel,
      );
      if (configUpdate.action === "unchanged") {
        continue;
      }

      const nextFingerprint = messagingAdapterConfigFingerprint(config, channel);
      if (
        configUpdate.action === "hot"
        && await this.hotApplyRunningAdapter(running, configUpdate, {
          config,
          fingerprint: nextFingerprint,
        })
      ) {
        hotUpdatedChannels.push(channel);
        continue;
      }

      if (configUpdate.action === "hot") {
        messagingLog.info(`${channel}: hot config update unsupported — restarting adapter`, {
          channel,
          changedFields: configUpdate.changedFields,
        });
      }

      if (running.fingerprint !== nextFingerprint) {
        await this.stopRunningAdapter(running);
        this.runningAdapters.delete(channel);
        stoppedChannels.push(channel);
      }
    }
    this.syncRunningAdapterLists();

    const startResults = await Promise.all(
      [...nextAdapters.entries()].map(async ([channel, adapter]) => {
        if (this.runningAdapters.has(channel)) {
          return { channel, unchanged: true };
        }

        const outcome = await this.startRunningAdapter({
          adapter,
          config,
          store,
        });
        return { channel, outcome, unchanged: false };
      }),
    );
    const startedChannels = startResults
      .filter((result) => !result.unchanged && result.outcome === "started")
      .map((result) => result.channel);
    const failedChannels = startResults
      .filter((result) => !result.unchanged && result.outcome === "failed")
      .map((result) => result.channel);
    const cancelledChannels = startResults
      .filter((result) => !result.unchanged && result.outcome === "cancelled")
      .map((result) => result.channel);

    this.syncRunningAdapterLists();

    const failedChannelSet = new Set<MessagingChannelKind>(failedChannels);
    for (const channel of stoppedChannels) {
      if (!this.runningAdapters.has(channel) && !failedChannelSet.has(channel)) {
        this.setPlatformHealth(channel, "suspended");
      }
    }

    if (
      startedChannels.length > 0
      || stoppedChannels.length > 0
      || failedChannels.length > 0
      || cancelledChannels.length > 0
      || hotUpdatedChannels.length > 0
    ) {
      messagingLog.info("messaging runtime config applied", {
        cancelled: cancelledChannels.length > 0 ? cancelledChannels : undefined,
        hotUpdated: hotUpdatedChannels.length > 0 ? hotUpdatedChannels : undefined,
        started: startedChannels.length > 0 ? startedChannels : undefined,
        stopped: stoppedChannels.length > 0 ? stoppedChannels : undefined,
        failed: failedChannels.length > 0 ? failedChannels : undefined,
      });
    } else if (this.runningAdapters.size === 0) {
      messagingLog.info(
        "messaging runtime started with no adapters — no platforms configured",
      );
    }
    await this.syncFederationEventSubscriptions();
  }

  async applyLatestConfig(
    options: { allowStart?: boolean } = {},
  ): Promise<void> {
    await this.enqueueLifecycle(async () => {
      await this.applyConfigWithFailureStatus(await this.loadConfig(), options);
    });
  }

  isEnabled(): boolean {
    return this.started;
  }

  /**
   * Subscribe to platform status transitions. Returns an unsubscribe.
   * Listeners receive every `health-changed` and `activity` event;
   * synchronous, off the runtime's event loop. The renderer uses this
   * to keep its `MessagingPlatformStatus[]` cache in sync without
   * polling.
   */
  onPlatformStatus(
    listener: (event: MessagingPlatformStatusEvent) => void,
  ): () => void {
    this.platformStatusListeners.add(listener);
    return () => {
      this.platformStatusListeners.delete(listener);
    };
  }

  /**
   * Snapshot of the current per-platform health. Used by the IPC
   * handler that backs the renderer's initial paint — the renderer
   * subscribes to the event stream right after to stay current.
   */
  getPlatformStatuses(): MessagingPlatformStatus[] {
    for (const platform of this.platformStatuses.keys()) {
      this.clearExpiredDegradationReasons(platform);
    }
    return [...this.platformStatuses.values()];
  }

  getPlatformCredentialMetadata(
    platform: MessagingChannelKind,
  ): (MessagingCredentialMetadata & { observedAt: number }) | undefined {
    const status = this.platformStatuses.get(platform);
    if (
      !this.runningAdapters.has(platform)
      || (status?.health !== "enabled" && status?.health !== "degraded")
    ) {
      return undefined;
    }
    return this.platformCredentialMetadata.get(platform);
  }

  /**
   * Whether a provider's adapter can read recent conversation history (Slack
   * today). Callers use this to tell "no history support" apart from "the
   * conversation is simply empty", which fetchRecentPreviewMessages cannot.
   */
  supportsPreviewHistory(provider: MessagingChannelKind): boolean {
    const adapter = this.adapters.find((entry) => entry.channel === provider);
    return Boolean(adapter?.fetchRecentMessages);
  }

  /**
   * Fetch recent messages for the Automations editor live preview. Delegates
   * to the provider adapter's optional history fetch (Slack today), maps to the
   * compact preview shape, and filters to the requested conversation scope.
   * Returns `[]` when the provider has no history support or the call fails.
   */
  async fetchRecentPreviewMessages(params: {
    provider: MessagingChannelKind;
    conversationId: string;
    parentId?: string;
    limit?: number;
  }): Promise<InboundPreviewMessage[]> {
    const adapter = this.adapters.find(
      (entry) => entry.channel === params.provider,
    );
    const fetch = adapter?.fetchRecentMessages?.bind(adapter);
    if (!adapter || !fetch) return [];
    let events: MessagingInboundEvent[];
    try {
      events = await fetch({
        conversationId: params.conversationId,
        ...(params.limit ? { limit: params.limit } : {}),
      });
    } catch {
      return [];
    }
    const messages: InboundPreviewMessage[] = [];
    for (const event of events) {
      const message = inboundEventToPreviewMessage(event);
      if (!message) continue;
      if (
        message.conversationId === params.conversationId ||
        message.parentId === params.conversationId
      ) {
        messages.push({ ...message, origin: "history" });
      }
    }
    // Breadcrumb for "why is the preview showing X": records exactly which
    // conversation the provider was asked for and how much survived the
    // conversation-scope check, so a suspected cross-channel leak can be
    // ruled in or out from the profile log.
    messagingLog.debug("preview history backfill", {
      provider: params.provider,
      conversationId: params.conversationId,
      fetched: events.length,
      forwarded: messages.length,
    });
    return messages;
  }

  /**
   * Conversations an enabled inbound automation watches on this platform.
   * These become the adapter's observed set: all senders' messages there are
   * forwarded (flagged observedOnly) instead of dying at the per-user gate —
   * which is what lets a sender filter see bot alerts at all.
   */
  private collectAutomationObservedConversations(
    platform: MessagingChannelKind,
  ): string[] {
    try {
      const ids = new Set<string>();
      for (const automation of getDesktopAutomationService().list({}).automations) {
        if (automation.status !== "enabled") continue;
        for (const trigger of automation.triggers) {
          if (trigger.kind !== "inbound_message") continue;
          if (trigger.conversation.channel !== platform) continue;
          ids.add(trigger.conversation.conversationId);
          if (trigger.conversation.parentId) {
            ids.add(trigger.conversation.parentId);
          }
        }
      }
      return [...ids];
    } catch (error) {
      messagingLog.warn("failed to collect observed conversations", {
        platform,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /** Re-push the observed-conversation sets to every running adapter. */
  pushObservedConversations(): void {
    for (const adapter of this.adapters) {
      try {
        adapter.updateObservedConversations?.(
          this.collectAutomationObservedConversations(adapter.channel),
        );
      } catch (error) {
        messagingLog.warn("failed to push observed conversations", {
          platform: adapter.channel,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Search a provider's directory for candidate senders.
   *
   * Returns an empty, `supported: false` result when the provider advertises
   * no directory capability. The capability is the gate — not the presence of
   * `searchDirectoryActors` — so an adapter that loses the scope at runtime can
   * turn the feature off in exactly one place and every caller follows.
   */
  async searchDirectoryActors(params: {
    provider: MessagingChannelKind;
    conversationId?: string;
    query: string;
    limit?: number;
  }): Promise<{
    actors: MessagingDirectoryActor[];
    label?: string;
    supported: boolean;
    truncated?: boolean;
  }> {
    const adapter = this.adapters.find((entry) => entry.channel === params.provider);
    const directory = adapter?.capabilityProfile.directory;
    const search = adapter?.searchDirectoryActors?.bind(adapter);
    if (!directory?.supportsActorSearch || !search) {
      return { actors: [], supported: false };
    }
    try {
      const result = await search({
        query: params.query,
        ...(params.conversationId ? { conversationId: params.conversationId } : {}),
        ...(params.limit ? { limit: params.limit } : {}),
      });
      return {
        actors: result.actors,
        supported: true,
        ...(directory.actorSearchLabel ? { label: directory.actorSearchLabel } : {}),
        ...(result.truncated ? { truncated: true } : {}),
      };
    } catch {
      // A directory outage must not break the picker — observed senders still
      // answer most searches.
      return { actors: [], supported: true };
    }
  }

  /**
   * Subscribe to bindings-changed events. Returns an unsubscribe.
   * Fires after any controller has mutated a binding (create, refresh
   * metadata, sync title, detach, revoke). Renderer-side IPC bridge
   * uses this to push a marker event so `useThreadNavigation`
   * refetches the navigation snapshot — that's where binding chips
   * live (issue #191).
   */
  onBindingsChanged(listener: () => void): () => void {
    this.bindingsChangedListeners.add(listener);
    return () => {
      this.bindingsChangedListeners.delete(listener);
    };
  }

  onPairingChanged(
    listener: (event: MessagingPairingChangedEvent) => void,
  ): () => void {
    this.pairingChangedListeners.add(listener);
    return () => {
      this.pairingChangedListeners.delete(listener);
    };
  }

  generatePairingToken(
    request: GenerateMessagingPairingTokenRequest,
  ): GenerateMessagingPairingTokenResponse {
    const now = Date.now();
    const ttlMs = clampPairingTtlMs(request.ttlMs);
    const instanceId = request.instanceId ?? PAIRING_INSTANCE_ID;
    const store = getDesktopMessagingPairingStore();
    const outstanding = store.countOutstanding({
      platform: request.platform,
      instanceId,
      now,
    });
    if (outstanding >= MAX_OUTSTANDING_PAIRING_TOKENS) {
      throw new Error(
        `Too many active pairing tokens for ${request.platform}. Wait for one to expire or approve/reject a pending request.`,
      );
    }
    const token = generatePairingToken();
    const entry = store.create({
      token,
      platform: request.platform,
      instanceId,
      scope: request.scope,
      generatedAt: now,
      expiresAt: now + ttlMs,
    });
    this.recordPairingActivity(entry, "Generated pairing token");
    this.broadcastPairingChanged(entry);
    return {
      entry,
      token,
      expiresAt: entry.expiresAt,
      message: `${MESSAGING_PAIRING_COMMAND} ${token}`,
    };
  }

  listPairingRequests(
    request: ListMessagingPairingRequestsRequest = {},
  ): ListMessagingPairingRequestsResponse {
    return {
      entries: getDesktopMessagingPairingStore().list({
        includeResolved: request.includeResolved,
        platform: request.platform,
        now: Date.now(),
      }),
    };
  }

  async deliverPairingOutcome(
    entry: MessagingPairingEntry,
    outcome: "approved" | "rejected" | "expired",
    options?: { text?: string },
  ): Promise<void> {
    const running = this.runningAdapters.get(entry.platform);
    if (!running || !entry.observedActor || !entry.observedChat) return;
    const text = options?.text
      ?? (outcome === "approved"
        ? "PwrAgent pairing approved."
        : outcome === "expired"
          ? "PwrAgent pairing expired."
          : "PwrAgent pairing rejected.");
    await running.adapter.deliver({
      id: `pairing:${outcome}:${entry.id}`,
      kind: "message",
      createdAt: Date.now(),
      parts: [{ type: "text", text }],
      audit: {
        actor: {
          platformUserId: entry.observedActor.id,
          displayName: entry.observedActor.displayName,
          phoneNumber: entry.observedActor.phoneNumber,
          username: entry.observedActor.username,
        },
        action: `pairing.${outcome}`,
        channel: {
          channel: entry.platform,
          conversation: {
            id: entry.observedChat.id,
            kind: entry.observedChat.kind,
            parentId: entry.observedChat.parentId,
            title: entry.observedChat.title,
            parentTitle: entry.observedChat.parentTitle,
          },
        },
        occurredAt: Date.now(),
      },
    });
  }

  /**
   * Public emitter so non-controller code (the unbind IPC handler in
   * `messaging-status.ts`, future bind paths) can fan out the same
   * event without reaching into the listener set directly.
   */
  notifyBindingsChanged(): void {
    this.broadcastBindingsChanged();
  }

  /**
   * Bus entry point for "the user wants this binding revoked,
   * source-of-request agnostic." Used by the desktop unbind IPC
   * handler today; future archive flows and CLI tools route through
   * the same call.
   *
   * The runtime fans the request out to every running controller.
   * The controller whose adapter owns the binding's channel runs the
   * platform-agnostic detach pipeline (retire status surface →
   * revoke in store → "Thread detached" confirmation). This keeps
   * the IPC layer free of any per-platform knowledge — adding Slack
   * / Mattermost requires zero changes here.
   *
   * If no controller's scope matches (e.g., messaging is currently
   * disabled, or the platform's adapter failed to start), the
   * runtime still revokes the binding in the store so the renderer
   * chip clears. Best-effort platform notification, guaranteed local
   * state cleanup.
   */
  async requestBindingRevoke(
    request: BindingRevokeRequest,
  ): Promise<BindingRevokeResult> {
    const store = getDesktopMessagingStore();
    const binding = await store.getBinding(request.bindingId);
    if (!binding || binding.revokedAt) {
      return { revoked: false, notifiedPlatform: false };
    }

    const notifiedPlatform = await this.dispatchRevokeToControllers(binding);
    if (!notifiedPlatform) {
      await store.revokeBinding({ bindingId: binding.id });
      await this.recordBindingUnbound(binding);
      this.broadcastBindingsChanged();
    }

    messagingLog.info("messaging binding revoke handled", {
      bindingId: binding.id,
      origin: request.origin,
      backend: binding.backend,
      platform: binding.channel.channel,
      threadId: binding.threadId,
      notifiedPlatform,
    });

    return { revoked: true, notifiedPlatform };
  }

  /**
   * Bus entry point for "revoke every binding on this thread." Used
   * for the upcoming "Unbind all" context-menu item and for implicit
   * unbind-on-archive. Mirrors `requestBindingRevoke` semantics: per
   * binding, in-scope controller handles platform notification; any
   * unmatched binding falls back to store-only revoke.
   */
  async requestBindingRevokeAllForThread(
    request: BindingRevokeAllForThreadRequest,
  ): Promise<BindingRevokeAllForThreadResult> {
    const store = getDesktopMessagingStore();
    const bindings = await store.findActiveBindingsForThread({
      backend: request.backend,
      threadId: request.threadId,
    });
    if (bindings.length === 0) {
      return { revokedCount: 0, notifiedCount: 0 };
    }

    let notifiedCount = 0;
    const fallbackBindings: MessagingBindingRecord[] = [];
    for (const binding of bindings) {
      const notified = await this.dispatchRevokeToControllers(binding);
      if (notified) {
        notifiedCount++;
      } else {
        fallbackBindings.push(binding);
      }
    }

    for (const binding of fallbackBindings) {
      await store.revokeBinding({ bindingId: binding.id });
      await this.recordBindingUnbound(binding);
    }
    if (fallbackBindings.length > 0) {
      this.broadcastBindingsChanged();
    }

    messagingLog.info("messaging binding revoke-all handled", {
      backend: request.backend,
      threadId: request.threadId,
      origin: request.origin,
      revokedCount: bindings.length,
      notifiedCount,
    });

    return { revokedCount: bindings.length, notifiedCount };
  }

  /**
   * Bus entry point for the per-credential "Test" button on Settings →
   * Messaging. Routes to the matching provider package's
   * `validateCredentials(config)` via dynamic import — the provider is
   * loaded on first invocation and cached by Node's module registry,
   * so subsequent tests reuse the same imported module without
   * re-loading.
   *
   * The runtime stays channel-neutral: it does not import provider
   * packages statically, does not parse credentials, and does not
   * know which library (grammy / discord.js / etc.) each provider
   * uses for its smoke check. Adding a new platform means adding one
   * branch here and exporting `validateCredentials` from the new
   * provider package.
   *
   * NOTE: this path does NOT require the messaging runtime to be
   * `started()` — credential validation works regardless of whether
   * the platform is currently enabled. Loading the provider here also
   * does NOT spin up its full adapter (no polling, no gateway, no
   * store mutation). The provider's `validateCredentials` is a
   * stateless REST call.
   */
  async requestCredentialValidation(
    request: CredentialValidationRequest,
  ): Promise<MessagingCredentialValidationResult> {
    switch (request.channel) {
      case "telegram": {
        const telegramProvider = await import(
          "@pwragent/messaging-provider-telegram"
        );
        return await telegramProvider.validateCredentials(request.credential);
      }
      case "discord": {
        const discordProvider = await import(
          "@pwragent/messaging-provider-discord"
        );
        return await discordProvider.validateCredentials(request.credential);
      }
      case "mattermost": {
        const mattermostProvider = await import(
          "@pwragent/messaging-provider-mattermost"
        );
        return await mattermostProvider.validateCredentials(request.credential);
      }
      case "slack": {
        const slackProvider = await import("@pwragent/messaging-provider-slack");
        return await slackProvider.validateCredentials(request.credential);
      }
      case "feishu": {
        const feishuProvider = await import(
          "@pwragent/messaging-provider-feishu"
        );
        return await feishuProvider.validateCredentials(request.credential);
      }
      case "line": {
        const lineProvider = await import("@pwragent/messaging-provider-line");
        return await lineProvider.validateCredentials(request.credential);
      }
      default: {
        const exhaustive: never = request;
        throw new Error(
          `unknown credential validation channel: ${(exhaustive as { channel: string }).channel}`,
        );
      }
    }
  }

  private async enqueueLifecycle(
    operation: () => Promise<void>,
  ): Promise<void> {
    const run = this.lifecycleQueue.catch(() => undefined).then(operation);
    this.lifecycleQueue = run.then(
      () => undefined,
      () => undefined,
    );
    await run;
  }

  private cancelPendingAdapterStarts(reason: string): void {
    for (const pending of this.pendingAdapterStarts.values()) {
      pending.cancel(reason);
    }
  }

  private updatePendingAdapterStartIntent(
    config: DesktopMessagingConfig,
  ): void {
    if (config.enabled === false) {
      const reason =
        "Messaging was disabled while adapter startup was still pending.";
      this.pendingAdapterStopReason = reason;
      this.cancelPendingAdapterStarts(reason);
      return;
    }

    this.pendingAdapterStopReason = undefined;
    for (const channel of CONFIGURABLE_MESSAGING_CHANNELS) {
      if (messagingChannelConfig(config, channel)) {
        this.pendingAdapterStartCancellationReasons.delete(channel);
        continue;
      }
      const reason = `${channel} was disabled while adapter startup was still pending.`;
      this.pendingAdapterStartCancellationReasons.set(channel, reason);
      this.pendingAdapterStarts.get(channel)?.cancel(reason);
    }
  }

  private async shouldDropAmbientSharedMessage(params: {
    channel: MessagingChannelKind;
    event: MessagingInboundEvent;
    reportsBotMention: boolean;
    store: MessagingStoreLike;
  }): Promise<boolean> {
    const { event } = params;
    if (event.kind !== "text" && event.kind !== "media") {
      return false;
    }
    if (
      event.botMention
      || event.channel.conversation.kind === "dm"
      || event.channel.conversation.isDirectMessage === true
    ) {
      return false;
    }
    if (!params.reportsBotMention) {
      return false;
    }
    const binding = await params.store.findActiveBindingForChannel(event.channel);
    const responseMode = resolveMessagingResponseModeForChannel({
      bindingResponseMode: binding?.preferences?.responseMode,
      channel: params.channel,
      channelRef: event.channel,
      config: await this.loadConfig(),
    });
    if (responseMode !== "mention_only") {
      return false;
    }
    const [pendingIntent, browseSession] = await Promise.all([
      params.store.findActivePendingIntentForChannel({
        actorId: event.actor.platformUserId,
        channel: event.channel,
      }),
      params.store.findActiveBrowseSessionForChannel({
        actorId: event.actor.platformUserId,
        channel: event.channel,
      }),
    ]);
    if (pendingIntent || browseSession) {
      return false;
    }
    // @mention-only mode suppresses the bot's NORMAL replies, but it must not
    // starve features with their own per-message config. Keep delivering a
    // message when an editor is live-previewing trigger candidates, or when an
    // inbound automation's filter (conversation / sender / text) matches it —
    // the controller's own ambient gate still blocks a normal agent reply.
    // Check the O(1) preview flag before the automation matcher, which runs a
    // per-message query.
    if (hasActiveInboundPreview()) {
      return false;
    }
    if (this.options.automationInboundMatches?.(event)) {
      return false;
    }
    // The message is about to be dropped by mention-only mode after matching
    // no automation filter. This is the correct outcome for ordinary chatter,
    // but it is also exactly where a misconfigured filter (wrong sender id,
    // typo'd text) disappears without a trace — so leave a debug breadcrumb
    // an operator can find in the profile log.
    messagingLog.debug("mention-only drop: no automation filter matched", {
      platform: event.channel.channel,
      conversationId: event.channel.conversation.id,
      actorId: event.actor.platformUserId,
      actorIsBot: event.actor.isBot === true,
      kind: event.kind,
      textLength: "text" in event ? event.text?.length ?? 0 : 0,
    });
    return true;
  }

  private async startRunningAdapter(params: {
    adapter: DesktopMessagingAdapter;
    config: DesktopMessagingConfig;
    store: MessagingStoreLike;
  }): Promise<AdapterStartOutcome> {
    const { adapter, config, store } = params;
    const authorizedActorIds = [...adapter.authorizedActorIds];
    const authorization: RunningMessagingAuthorization = {
      actorIds: authorizedActorIds,
      actorIdSet: new Set(authorizedActorIds),
    };
    const deliveryBudget = new MessagingDeliveryBudget();
    if (adapter.clientRateLimitStrategy === "sdk-managed") {
      messagingLog.warn(`${adapter.channel}: SDK-managed rate-limit retries are enabled`, {
        channel: adapter.channel,
        clientRateLimitStrategy: adapter.clientRateLimitStrategy,
      });
    }
    const controller = new MessagingController({
      adapter,
      attachmentPolicy: config.attachmentPolicy,
      authorizedActorIds,
      rbacPolicy: getRbacPolicyService().providerFor(adapter.channel),
      automationInboundHandler: this.options.automationInboundHandler,
      onInboundPreview: (event) => publishInboundPreview(event),
      backend: this.options.backendBridge,
      channel: adapter.channel,
      deliveryBudget,
      inputDebounceMs: config.inputDebounceMs,
      pdfAnalysisEnabled: async () =>
        (await this.loadConfig()).pdfAnalysisEnabled !== false,
      store,
      activityLog: getDesktopMessagingActivityLog,
      streamingResponsesDefault: streamingResponsesDefaultForChannel(
        config,
        adapter.channel,
      ),
      showStreamingOption: async () =>
        (await this.loadConfig()).showStreamingOption ?? false,
      responseModeForConversation: async (channel) =>
        resolveMessagingResponseModeForChannel({
          channel: adapter.channel,
          channelRef: channel,
          config: await this.loadConfig(),
        }),
      toolUpdateDefaultMode: async (targetKind) => {
        const config = await this.loadConfig();
        return targetKind === "agent_thread"
          ? config.managerToolUpdateDefaultMode ?? "show_none"
          : config.toolUpdateDefaultMode ?? "show_some";
      },
      fullAccessControls: async () =>
        (await this.loadConfig()).fullAccessControls,
      onBindingChanged: () => this.broadcastBindingsChanged(),
      onDeliveryBudgetEvent: (event) => {
        void this.handleDeliveryBudgetEvent(event);
      },
      onFullAccessPolicyViolation: (event) =>
        this.recordFullAccessPolicyViolation(adapter.channel, event),
      // Resolved per tool call, not at adapter start, and read through the
      // bridge rather than `getDesktopBackendRegistry()`: that getter builds a
      // registry with real machine ACP discovery, so touching it here would
      // make sending a file scan PATH, fetch releases, and probe a binary.
      outboundFileAccess: () => ({
        allowedRoots: [],
        privateStorageRoots: [
          ...(this.options.backendBridge.getLocalFilePrivateStorageRoots?.()
            ?? []),
          resolvePwragentRoot(),
        ],
      }),
    });

    let unsubscribeDiagnostic: (() => void) | undefined;
    let unsubscribeInboundRejected: (() => void) | undefined;
    try {
      unsubscribeDiagnostic = adapter.onDiagnostic?.((event) => {
        this.emitPlatformActivity(adapter.channel);
        messagingLog.info("messaging adapter diagnostic", {
          actorDisplayName: event.actor?.displayName,
          actorId: event.actor?.platformUserId,
          channel: adapter.channel,
          conversationId: event.channel?.conversation.id,
          conversationKind: event.channel?.conversation.kind,
          eventId: event.id,
          summary: event.summary,
        });
        this.recordDiagnosticActivity({
          platform: adapter.channel,
          summary: event.summary,
          createdAt: event.observedAt,
          conversation: event.channel?.conversation,
          actor: event.actor,
          payload: {
            eventId: event.id,
            ...(event.payload ?? {}),
          },
        });
      });
      unsubscribeInboundRejected = adapter.onInboundRejected?.(async (event) => {
        await this.handleRejectedInbound(adapter.channel, event, store);
      });
      this.setPlatformHealth(adapter.channel, "unknown");
      await this.startAdapterWithDeadline(adapter, async (event) => {
        // Activity ping fires on every inbound, before authorization checks.
        this.emitPlatformActivity(adapter.channel);
        if (await this.handlePairingInbound(adapter, event, store)) {
          return;
        }
        // Provider adapters admit only conversation-authorized events. Remember
        // the surface before actor and ambient-message gates so an approved
        // channel remains selectable even when this sender cannot steer Agents.
        await this.recordObservedSurface(store, event.channel, event.receivedAt);
        if (
          (event.kind === "text" || event.kind === "media")
          && event.observedOnly === true
        ) {
          // Observed-only traffic exists for automations and the editor's
          // live preview; it must never reach the controller's reply/command
          // path — the sender did not clear the per-user access gate.
          // A matching automation is its own narrow authorization context:
          // classify that event as routed without widening the sender's
          // adapter or RBAC permissions for any interactive messaging path.
          const automationMatched =
            this.options.automationInboundMatches?.(event) === true;
          this.recordActivityFromInbound(
            adapter.channel,
            event,
            automationMatched,
          );
          publishInboundPreview(event);
          if (automationMatched) {
            await this.options.automationInboundHandler?.(event);
          } else {
            messagingLog.debug(
              "observed-only message matched no automation filter",
              {
                platform: adapter.channel,
                conversationId: event.channel.conversation.id,
                actorId: event.actor.platformUserId,
                actorIsBot: event.actor.isBot === true,
              },
            );
          }
          return;
        }
        const authorized = authorization.actorIdSet.has(event.actor.platformUserId);
        if (
          authorized &&
          await this.shouldDropAmbientSharedMessage({
            channel: adapter.channel,
            event,
            reportsBotMention:
              adapter.capabilityProfile.conversationInput?.reportsBotMention ===
              true,
            store,
          })
        ) {
          return;
        }
        this.recordActivityFromInbound(adapter.channel, event, authorized);
        try {
          if (!authorized) {
            messagingLog.warn("messaging event rejected by authorization", {
              actorDisplayName: event.actor.displayName,
              actorId: event.actor.platformUserId,
              actorIsBot: event.actor.isBot,
              actorUsername: event.actor.username,
              authorizedActorCount: authorization.actorIds.length,
              channel: adapter.channel,
              conversationId: event.channel.conversation.id,
              conversationKind: event.channel.conversation.kind,
              eventId: event.id,
              eventKind: event.kind,
            });
          }
          await controller.handleInboundEvent(event);
        } catch (error) {
          messagingLog.error("messaging controller failed to handle inbound event", {
            actorDisplayName: event.actor.displayName,
            actorId: event.actor.platformUserId,
            channel: adapter.channel,
            conversationId: event.channel.conversation.id,
            conversationKind: event.channel.conversation.kind,
            error,
            eventId: event.id,
            eventKind: event.kind,
          });
        }
      });
    } catch (error) {
      try {
        unsubscribeDiagnostic?.();
      } catch {
        // Best effort cleanup after startup failure.
      }
      try {
        unsubscribeInboundRejected?.();
      } catch {
        // Best effort cleanup after startup failure.
      }
      controller.dispose();
      const cancelled = error instanceof AdapterStartCancelledError;
      if (cancelled) {
        messagingLog.info(`${adapter.channel}: adapter startup cancelled`, {
          channel: adapter.channel,
          reason: error.message,
        });
        this.setPlatformHealth(adapter.channel, "suspended", {
          reason: error.message,
        });
      } else {
        messagingLog.error(`${adapter.channel}: failed to start adapter`, {
          channel: adapter.channel,
          error: error instanceof Error ? error.message : String(error),
        });
        this.setPlatformHealth(adapter.channel, "errored", {
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      if (!(error instanceof AdapterStartCancelledError && !error.startInvoked)) {
        await this.stopAdapterAfterFailedStart(adapter);
      }
      return cancelled ? "cancelled" : "failed";
    }

    const unsubscribeRuntimeError = adapter.onRuntimeError?.((reason) => {
      messagingLog.warn(`${adapter.channel}: adapter runtime error`, {
        channel: adapter.channel,
        reason,
      });
      this.setPlatformHealth(adapter.channel, "errored", { reason });
    });
    const unsubscribeRateLimit = adapter.onRateLimit?.((info) => {
      deliveryBudget.recordRateLimit(info);
      this.handleAdapterRateLimit(adapter.channel, info);
    });
    const unsubscribeReconnect = adapter.onReconnect?.((info) => {
      this.handleAdapterReconnect(adapter.channel, info);
    });

    try {
      await controller.startMonitoringForEnabledBindings();
    } catch (error) {
      messagingLog.warn(`${adapter.channel}: monitor rehydrate failed`, {
        channel: adapter.channel,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    this.runningAdapters.set(adapter.channel, {
      adapter,
      authorization,
      config,
      controller,
      fingerprint: messagingAdapterConfigFingerprint(config, adapter.channel),
      unsubscribeDiagnostic,
      unsubscribeInboundRejected,
      unsubscribeRateLimit,
      unsubscribeReconnect,
      unsubscribeRuntimeError,
    });
    this.syncRunningAdapterLists();
    this.setPlatformHealth(adapter.channel, "enabled", {
      credentialMetadata: adapter.readCredentialMetadata?.(),
    });
    messagingLog.info(`${adapter.channel}: adapter started successfully`, {
      channel: adapter.channel,
    });
    return "started";
  }

  private async startAdapterWithDeadline(
    adapter: DesktopMessagingAdapter,
    listener: (event: MessagingInboundEvent) => Promise<void>,
  ): Promise<void> {
    const timeoutMs = Math.max(
      1,
      this.options.adapterStartTimeoutMs ?? DEFAULT_ADAPTER_START_TIMEOUT_MS,
    );
    let cancel: ((reason: string) => void) | undefined;
    let cancelled = false;
    const cancellation = new Promise<never>((_resolve, reject) => {
      cancel = (reason) => {
        if (cancelled) return;
        cancelled = true;
        reject(new AdapterStartCancelledError(reason));
      };
    });
    const pending: PendingAdapterStart = {
      cancel: (reason) => cancel?.(reason),
    };
    this.pendingAdapterStarts.set(adapter.channel, pending);
    const queuedCancellationReason = this.pendingAdapterStopReason
      ?? this.pendingAdapterStartCancellationReasons.get(adapter.channel);
    if (queuedCancellationReason) {
      this.pendingAdapterStarts.delete(adapter.channel);
      throw new AdapterStartCancelledError(queuedCancellationReason, false);
    }

    const startPromise = Promise.resolve().then(async () => {
      await adapter.start?.(listener);
    });
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new AdapterStartTimeoutError(adapter.channel, timeoutMs));
      }, timeoutMs);
      if (timeoutHandle.unref) timeoutHandle.unref();
    });

    try {
      await Promise.race([startPromise, cancellation, timeout]);
    } catch (error) {
      if (
        error instanceof AdapterStartCancelledError
        || error instanceof AdapterStartTimeoutError
      ) {
        void startPromise.then(
          async () => this.stopAdapterAfterLateStart(adapter),
          async () => this.stopAdapterAfterLateStart(adapter),
        );
      }
      throw error;
    } finally {
      clearTimeout(timeoutHandle);
      if (this.pendingAdapterStarts.get(adapter.channel) === pending) {
        this.pendingAdapterStarts.delete(adapter.channel);
      }
    }
  }

  private async stopAdapterAfterFailedStart(
    adapter: DesktopMessagingAdapter,
  ): Promise<void> {
    try {
      await promiseWithTimeout(
        Promise.resolve().then(async () => adapter.stop?.()),
        FAILED_START_STOP_TIMEOUT_MS,
        `${adapter.channel} adapter cleanup after failed startup`,
      );
    } catch (stopError) {
      messagingLog.warn(`${adapter.channel}: adapter stop after failed start threw`, {
        channel: adapter.channel,
        error: stopError instanceof Error ? stopError.message : String(stopError),
      });
    }
  }

  private async stopAdapterAfterLateStart(
    adapter: DesktopMessagingAdapter,
  ): Promise<void> {
    try {
      await adapter.stop?.();
      messagingLog.info(`${adapter.channel}: stopped adapter after late startup`, {
        channel: adapter.channel,
      });
    } catch (error) {
      messagingLog.warn(`${adapter.channel}: adapter stop after late start threw`, {
        channel: adapter.channel,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async hotApplyRunningAdapter(
    running: RunningMessagingAdapter,
    update: Extract<DesktopMessagingChannelConfigUpdate, { action: "hot" }>,
    next: {
      config: DesktopMessagingConfig;
      fingerprint: string;
    },
  ): Promise<boolean> {
    const { adapter } = running;
    if (update.authorization && !adapter.updateAuthorization) {
      return false;
    }
    if (update.renderingPreferences && !adapter.updateRenderingPreferences) {
      return false;
    }

    try {
      if (update.authorization) {
        await adapter.updateAuthorization?.(update.authorization);
        this.replaceRunningAuthorization(running, update.authorization.authorizedActorIds);
      }
      if (update.renderingPreferences) {
        await adapter.updateRenderingPreferences?.(update.renderingPreferences);
      }
    } catch (error) {
      messagingLog.warn(`${adapter.channel}: hot config update failed — restarting adapter`, {
        channel: adapter.channel,
        changedFields: update.changedFields,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }

    running.config = next.config;
    running.fingerprint = next.fingerprint;
    this.recordDiagnosticActivity({
      platform: adapter.channel,
      summary: `Hot-applied messaging config: ${adapter.channel}`,
      createdAt: Date.now(),
      payload: {
        mode: "hot-update",
        changedFields: [...update.changedFields],
      },
    });
    messagingLog.info(`${adapter.channel}: hot-applied messaging config`, {
      channel: adapter.channel,
      changedFields: update.changedFields,
    });
    return true;
  }

  private replaceRunningAuthorization(
    running: RunningMessagingAdapter,
    actorIds: readonly string[],
  ): void {
    running.authorization.actorIds.splice(
      0,
      running.authorization.actorIds.length,
      ...actorIds,
    );
    running.authorization.actorIdSet.clear();
    for (const actorId of actorIds) {
      running.authorization.actorIdSet.add(actorId);
    }
    running.controller.updateAuthorizedActorIds(actorIds);
  }

  private async stopRunningAdapter(running: RunningMessagingAdapter): Promise<void> {
    try {
      running.unsubscribeDiagnostic?.();
    } catch (error) {
      messagingLog.warn("messaging adapter diagnostic unsubscribe threw", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    try {
      running.unsubscribeRateLimit?.();
    } catch (error) {
      messagingLog.warn("messaging adapter rate-limit unsubscribe threw", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    try {
      running.unsubscribeReconnect?.();
    } catch (error) {
      messagingLog.warn("messaging adapter reconnect unsubscribe threw", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    try {
      running.unsubscribeRuntimeError?.();
    } catch (error) {
      messagingLog.warn("messaging adapter runtime-error unsubscribe threw", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    try {
      running.unsubscribeInboundRejected?.();
    } catch (error) {
      messagingLog.warn("messaging adapter inbound-rejected unsubscribe threw", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    running.controller.dispose();
    await running.adapter.stop?.();
  }

  private subscribeBackendEvents(): void {
    if (this.unsubscribeBackendEvents) {
      return;
    }

    this.unsubscribeBackendEvents = this.options.backendBridge.onEvent?.(async (event) => {
      await Promise.all(
        this.controllers.map(async (controller) => {
          try {
            if (isMessagingInteractivePendingRequest(event.notification)) {
              await controller.handleBackendPendingRequest(
                event.backend,
                event.notification,
                event.federationTarget,
              );
            } else {
              await controller.handleBackendEvent(event);
            }
          } catch (error) {
            messagingLog.error("messaging controller failed to handle backend event", {
              backend: event.backend,
              error,
              method: event.notification.method,
            });
          }
        }),
      );
    });
  }

  private async syncFederationEventSubscriptions(): Promise<void> {
    if (!this.options.backendBridge.setRemoteEventSubscriptions) return;
    if (!this.started || this.runningAdapters.size === 0) {
      this.options.backendBridge.setRemoteEventSubscriptions([]);
      return;
    }
    const threadsByInstanceId = new Map<
      string,
      Map<string, { backend: AppServerBackendKind; threadId: string }>
    >();
    for (const binding of await getDesktopMessagingStore().findActiveBindings()) {
      if (
        this.runningAdapters.has(binding.channel.channel)
        && binding.federatedThread?.target.scope === "remote"
      ) {
        const instanceId = binding.federatedThread.target.instanceId;
        const threads = threadsByInstanceId.get(instanceId) ?? new Map();
        threads.set(
          buildThreadIdentityKey(
            binding.federatedThread.backend,
            binding.federatedThread.threadId,
          ),
          {
            backend: binding.federatedThread.backend,
            threadId: binding.federatedThread.threadId,
          },
        );
        threadsByInstanceId.set(instanceId, threads);
      }
    }
    this.options.backendBridge.setRemoteEventSubscriptions(
      [...threadsByInstanceId].map(([sourceInstanceId, threads]) => ({
        sourceInstanceId,
        eventClasses: [
          "navigation",
          "transcript",
          "pending_requests",
          "scheduled_actions",
        ],
        threadSelection: {
          kind: "threads",
          threads: [...threads.values()],
        },
      })),
    );
  }

  private syncRunningAdapterLists(): void {
    const running = [...this.runningAdapters.values()];
    this.adapters = running.map((record) => record.adapter);
    this.controllers = running.map((record) => record.controller);
    // The automation service may be unavailable (unit harnesses, an app
    // instance with automations disabled); messaging must start regardless —
    // observed sets simply stay empty.
    try {
      this.pushObservedConversations();
      if (!this.automationsChangedUnsubscribe) {
        this.automationsChangedUnsubscribe = getDesktopAutomationService()
          .onAutomationsChanged(() => this.pushObservedConversations());
      }
    } catch (error) {
      messagingLog.debug("observed-conversation sync unavailable", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async dispatchRevokeToControllers(
    binding: MessagingBindingRecord,
  ): Promise<boolean> {
    for (const controller of this.controllers) {
      try {
        if (await controller.handleBindingRevokeRequest(binding)) {
          return true;
        }
      } catch (error) {
        messagingLog.error("messaging controller revoke handler threw", {
          bindingId: binding.id,
          platform: binding.channel.channel,
          error: error instanceof Error ? error.message : String(error),
        });
        // Swallow — try the next controller; if none handle, the
        // runtime fallback revokes from the store. We never want a
        // platform-side failure to leave the binding visibly attached
        // in the renderer.
      }
    }
    return false;
  }

  private async recordBindingUnbound(binding: MessagingBindingRecord): Promise<void> {
    const conversation = binding.channel.conversation;
    const occurredAt = Date.now();
    if (this.options.backendBridge.recordMessagingBindingTransition) {
      try {
        await this.options.backendBridge.recordMessagingBindingTransition({
          backend: binding.backend,
          threadId: binding.threadId,
          transition: {
            id: randomUUID(),
            action: "unbound",
            bindingId: binding.id,
            platform: binding.channel.channel,
            conversationKind: conversation.kind,
            conversationTitle: conversation.title,
            parentTitle: conversation.parentTitle,
            ancestorTitle: conversation.ancestorTitle,
            occurredAt,
          },
        });
      } catch (error) {
        messagingLog.warn("messaging binding-transition audit failed", {
          bindingId: binding.id,
          error: error instanceof Error ? error.message : String(error),
          threadId: binding.threadId,
        });
      }
    }
    this.recordBindingActivity("unbound", binding, occurredAt);
  }

  private broadcastBindingsChanged(): void {
    void this.syncFederationEventSubscriptions().catch((error) => {
      messagingLog.warn("federation event subscription sync failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    for (const listener of this.bindingsChangedListeners) {
      try {
        listener();
      } catch (error) {
        messagingLog.error("messaging bindings-changed listener threw", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private broadcastPairingChanged(entry: MessagingPairingEntry): void {
    const event = { at: Date.now(), entry };
    for (const listener of this.pairingChangedListeners) {
      try {
        listener(event);
      } catch (error) {
        messagingLog.error("messaging pairing-changed listener threw", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private setPlatformHealth(
    platform: MessagingChannelKind,
    health: MessagingPlatformHealth,
    options: {
      credentialMetadata?: MessagingCredentialMetadata;
      reason?: string;
      startupFailure?: boolean;
    } = {},
  ): void {
    const at = Date.now();
    const previous = this.platformStatuses.get(platform);
    if (
      options.credentialMetadata
      && (options.credentialMetadata.account || options.credentialMetadata.detail)
    ) {
      this.platformCredentialMetadata.set(platform, {
        ...definedCredentialMetadata(options.credentialMetadata),
        observedAt: at,
      });
    } else if (health !== "enabled") {
      this.platformCredentialMetadata.delete(platform);
    }
    const credentialMetadata = this.platformCredentialMetadata.get(platform);
    const {
      account: _previousAccount,
      detail: _previousDetail,
      ...previousWithoutCredentialMetadata
    } = previous ?? {};
    if (health === "enabled" || health === "suspended" || health === "errored") {
      if (health !== "enabled") {
        this.clearPlatformDegradationReasons(platform, { broadcast: false });
      } else {
        this.clearExpiredDegradationReasons(platform);
      }
    }
    const degradationReasons = this.currentDegradationReasons(platform);
    const effectiveHealth =
      health === "enabled" && degradationReasons.length > 0 ? "degraded" : health;
    const next: MessagingPlatformStatus = {
      ...previousWithoutCredentialMetadata,
      platform,
      health: effectiveHealth,
      changedAt: at,
      ...definedCredentialMetadata(credentialMetadata ?? {}),
      reason: options.reason,
      startupFailure: options.startupFailure,
      degradationReasons,
      // Preserve the existing activity timestamp through health
      // transitions; activity is independent of health and shouldn't
      // be reset just because the user toggled messaging off.
      lastActivityAt: previous?.lastActivityAt,
    };
    this.platformStatuses.set(platform, next);
    this.broadcastPlatformStatus({
      kind: "health-changed",
      platform,
      health: effectiveHealth,
      ...definedCredentialMetadata(next),
      reason: options.reason,
      startupFailure: options.startupFailure,
      degradationReasons,
      at,
    });
  }

  private handleAdapterRateLimit(
    platform: MessagingChannelKind,
    info: MessagingRateLimitInfo,
  ): void {
    const startedAt = info.observedAt ?? Date.now();
    const retryAfterMs = Math.max(0, Math.floor(info.retryAfterMs ?? 0));
    const expiresAt = startedAt + retryAfterMs + RATE_LIMIT_HEALTH_BUFFER_MS;
    const key = degradationKey(platform, "rate-limited", info.scope.id);
    this.addPlatformDegradationReason(platform, {
      kind: "rate-limited",
      key,
      message: clipStatusText(
        info.message ?? `Cool Off active for ${formatDurationForStatus(retryAfterMs)}.`,
      ),
      scope: sanitizeDeliveryScope(info.scope),
      retryAfterMs,
      startedAt,
      expiresAt,
    });
    this.recordDiagnosticActivity({
      platform,
      summary: `Cool Off started: ${info.scope.id}`,
      createdAt: startedAt,
      payload: {
        type: "provider-cool-off",
        scope: sanitizeDeliveryScope(info.scope),
        retryAfterMs,
        expiresAt,
        message: clipStatusText(info.message),
      },
    });
  }

  private async handleDeliveryBudgetEvent(
    event: MessagingControllerDeliveryBudgetEvent,
  ): Promise<void> {
    const scopeId = event.scope?.id ?? "unknown";
    const reason = event.reason ?? (event.outcome === "deferred" ? "deferred" : "dropped");
    const retryDelayMs = event.retryAt !== undefined
      ? Math.max(0, event.retryAt - event.at)
      : undefined;
    const isCoolOff = reason === "cool-off";
    const modeLabel = isCoolOff ? "Cool Off" : "Slow Mode";
    const targetKey = deliveryBudgetTargetKey(event);

    const diagnosticKey = [
      event.channel,
      scopeId,
      targetKey,
      event.outcome,
      event.reason ?? "deferred",
      event.priority,
      event.intentKind,
    ].join("\0");
    const lastLoggedAt = this.deliveryBudgetDiagnosticLastLoggedAt.get(diagnosticKey);
    if (
      lastLoggedAt !== undefined &&
      event.at - lastLoggedAt < DELIVERY_BUDGET_DIAGNOSTIC_THROTTLE_MS
    ) {
      return;
    }
    this.deliveryBudgetDiagnosticLastLoggedAt.set(diagnosticKey, event.at);
    const localThreadTitle = await this.resolveDeliveryBudgetThreadTitle(event);
    const targetPhrase = describeDeliveryBudgetTarget(event, localThreadTitle);

    messagingLog.info("messaging delivery budget constrained", {
      bindingId: event.bindingId,
      channel: event.channel,
      intentId: event.intentId,
      intentKind: event.intentKind,
      outcome: event.outcome,
      priority: event.priority,
      reason,
      retryAt: event.retryAt,
      retryDelayMs,
      scopeId,
      slowModeActive: event.slowMode,
      threadId: event.threadId,
    });

    const expiresAt = event.outcome === "deferred"
      ? event.retryAt
      : event.at + DELIVERY_BUDGET_WARNING_TTL_MS;
    const key = degradationKey(
      event.channel,
      "warning",
      `delivery-budget:${scopeId}:${targetKey}`,
    );
    const priorityPhrase = describeDeliveryPriority(event.priority);
    this.addPlatformDegradationReason(event.channel, {
      kind: "warning",
      key,
      message: event.outcome === "deferred"
        ? `${modeLabel} active; holding ${priorityPhrase} for ${formatDurationForStatus(retryDelayMs ?? 0)}${targetPhrase}.`
        : `${modeLabel} active; dropped ${priorityPhrase} (${reason})${targetPhrase}.`,
      scope: event.scope ? sanitizeDeliveryScope(event.scope) : undefined,
      startedAt: event.at,
      expiresAt,
    });
    this.recordDiagnosticActivity({
      platform: event.channel,
      backend: event.backend,
      threadId: event.threadId,
      bindingId: event.bindingId,
      conversation: event.conversation,
      summary: event.outcome === "deferred"
        ? `${modeLabel} held ${priorityPhrase} for ${formatDurationForStatus(retryDelayMs ?? 0)}${targetPhrase}`
        : `${modeLabel} dropped ${priorityPhrase}: ${reason}${targetPhrase}`,
      createdAt: event.at,
      payload: {
        type: isCoolOff ? "cool-off" : "slow-mode",
        bindingId: event.bindingId,
        conversationKind: event.conversation?.kind,
        conversationParentId: event.conversation?.parentId,
        conversationTitle: event.conversation
          ? describeConversation(event.conversation)
          : undefined,
        intentId: event.intentId,
        intentKind: event.intentKind,
        localThreadTitle,
        outcome: event.outcome,
        priority: event.priority,
        reason,
        retryAt: event.retryAt,
        retryDelayMs,
        scope: event.scope ? sanitizeDeliveryScope(event.scope) : undefined,
        scopeId,
        scopeKind: event.scope?.kind,
        slowModeActive: event.slowMode,
        threadId: event.threadId,
      },
    });
  }

  private handleAdapterReconnect(
    platform: MessagingChannelKind,
    info: MessagingReconnectInfo,
  ): void {
    const key = degradationKey(platform, "reconnecting", "adapter");
    if (info.state === "recovered") {
      this.clearPlatformDegradationReason(platform, key);
      const previous = this.platformStatuses.get(platform);
      if (previous?.health === "errored") {
        const adapter = this.runningAdapters.get(platform)?.adapter;
        this.setPlatformHealth(platform, "enabled", {
          credentialMetadata: adapter?.readCredentialMetadata?.(),
        });
      }
      return;
    }
    this.addPlatformDegradationReason(platform, {
      kind: "reconnecting",
      key,
      attemptCount: info.attemptCount,
      lastFailureReason: clipStatusText(info.lastFailureReason),
      startedAt: info.observedAt ?? Date.now(),
    });
  }

  private async resolveDeliveryBudgetThreadTitle(
    event: MessagingControllerDeliveryBudgetEvent,
  ): Promise<string | undefined> {
    if (!event.backend || !event.threadId) {
      return undefined;
    }
    try {
      const snapshot = await this.options.backendBridge.getNavigationSnapshot({
        backend: "all",
      });
      const thread = snapshot.threads.find(
        (candidate) =>
          candidate.source === event.backend && candidate.id === event.threadId,
      );
      return clipStatusText(thread?.title);
    } catch (error) {
      messagingLog.debug("messaging budget diagnostic thread-title lookup failed", {
        backend: event.backend,
        error: error instanceof Error ? error.message : String(error),
        threadId: event.threadId,
      });
      return undefined;
    }
  }

  private addPlatformDegradationReason(
    platform: MessagingChannelKind,
    reason: MessagingDegradationReason,
  ): void {
    this.clearExpiredDegradationReasons(platform);
    const reasons = this.platformDegradationReasonsFor(platform);
    reasons.set(reason.key, reason);
    this.scheduleDegradationExpiry(platform, reason);
    this.refreshDegradedPlatformHealth(platform);
  }

  private clearPlatformDegradationReason(
    platform: MessagingChannelKind,
    key: string,
  ): void {
    const reasons = this.platformDegradationReasons.get(platform);
    if (!reasons?.delete(key)) {
      return;
    }
    this.clearDegradationTimer(platform, key);
    this.refreshDegradedPlatformHealth(platform);
  }

  private clearPlatformDegradationReasons(
    platform: MessagingChannelKind,
    options: { broadcast: boolean },
  ): void {
    const reasons = this.platformDegradationReasons.get(platform);
    if (!reasons || reasons.size === 0) {
      return;
    }
    for (const key of reasons.keys()) {
      this.clearDegradationTimer(platform, key);
    }
    reasons.clear();
    if (options.broadcast) {
      this.refreshDegradedPlatformHealth(platform);
    }
  }

  private clearExpiredDegradationReasons(platform: MessagingChannelKind): void {
    const reasons = this.platformDegradationReasons.get(platform);
    if (!reasons || reasons.size === 0) {
      return;
    }
    const now = Date.now();
    let mutated = false;
    for (const [key, reason] of [...reasons.entries()]) {
      const expiresAt = degradationExpiresAt(reason);
      if (expiresAt !== undefined && expiresAt <= now) {
        reasons.delete(key);
        this.clearDegradationTimer(platform, key);
        mutated = true;
      }
    }
    if (mutated) {
      this.refreshDegradedPlatformHealth(platform);
    }
  }

  private refreshDegradedPlatformHealth(platform: MessagingChannelKind): void {
    const previous = this.platformStatuses.get(platform);
    if (!previous || previous.health === "errored" || previous.health === "suspended") {
      return;
    }
    const degradationReasons = this.currentDegradationReasons(platform);
    const nextHealth: MessagingPlatformHealth =
      degradationReasons.length > 0 ? "degraded" : "enabled";
    const at = Date.now();
    this.platformStatuses.set(platform, {
      ...previous,
      health: nextHealth,
      changedAt: at,
      reason: nextHealth === "degraded" ? previous.reason : undefined,
      degradationReasons,
    });
    this.broadcastPlatformStatus({
      kind: "health-changed",
      platform,
      health: nextHealth,
      reason: nextHealth === "degraded" ? previous.reason : undefined,
      degradationReasons,
      at,
    });
  }

  private currentDegradationReasons(
    platform: MessagingChannelKind,
  ): MessagingDegradationReason[] {
    return [...(this.platformDegradationReasons.get(platform)?.values() ?? [])];
  }

  private platformDegradationReasonsFor(
    platform: MessagingChannelKind,
  ): Map<string, MessagingDegradationReason> {
    let reasons = this.platformDegradationReasons.get(platform);
    if (!reasons) {
      reasons = new Map();
      this.platformDegradationReasons.set(platform, reasons);
    }
    return reasons;
  }

  private scheduleDegradationExpiry(
    platform: MessagingChannelKind,
    reason: MessagingDegradationReason,
  ): void {
    const expiresAt = degradationExpiresAt(reason);
    if (expiresAt === undefined) {
      return;
    }
    const timerKey = degradationTimerKey(platform, reason.key);
    this.clearDegradationTimer(platform, reason.key);
    const delayMs = Math.max(0, expiresAt - Date.now());
    this.platformDegradationTimers.set(
      timerKey,
      setTimeout(() => {
        this.platformDegradationTimers.delete(timerKey);
        this.clearPlatformDegradationReason(platform, reason.key);
      }, delayMs),
    );
  }

  private clearDegradationTimer(
    platform: MessagingChannelKind,
    key: string,
  ): void {
    const timerKey = degradationTimerKey(platform, key);
    const timer = this.platformDegradationTimers.get(timerKey);
    if (!timer) {
      return;
    }
    clearTimeout(timer);
    this.platformDegradationTimers.delete(timerKey);
  }

  private emitPlatformActivity(platform: MessagingChannelKind): void {
    const at = Date.now();
    const previous = this.platformStatuses.get(platform);
    if (previous) {
      this.platformStatuses.set(platform, { ...previous, lastActivityAt: at });
    }
    this.broadcastPlatformStatus({ kind: "activity", platform, at });
  }

  private async handlePairingInbound(
    adapter: DesktopMessagingAdapter,
    event: MessagingInboundEvent,
    messagingStore: MessagingStoreLike,
  ): Promise<boolean> {
    const token = tokenFromInboundEvent(event);
    if (!token) return false;

    const now = Date.now();
    const store = getDesktopMessagingPairingStore();
    const entry = store.findMatchingPending({
      token,
      platform: adapter.channel,
      instanceId: PAIRING_INSTANCE_ID,
      now,
    });
    if (!entry) {
      await this.deliverPairingReply(
        adapter,
        event,
        "That PwrAgent pairing token is invalid or expired.",
      );
      this.recordPairingAttemptActivity(adapter.channel, event, "Invalid pairing token");
      return true;
    }

    const scopeFailure = pairingScopeFailure(entry, event);
    if (scopeFailure) {
      const rejected = store.markStatus({
        entryId: entry.id,
        status: "rejected",
        failureReason: scopeFailure,
      }) ?? entry;
      this.recordPairingActivity(rejected, `Rejected pairing token: ${scopeFailure}`);
      this.broadcastPairingChanged(rejected);
      await this.deliverPairingReply(adapter, event, `Pairing rejected: ${scopeFailure}`);
      return true;
    }

    const observed = store.markObserved({
      entryId: entry.id,
      observedAt: now,
      actor: observedActorFromEvent(event),
      chat: observedChatFromEvent(event),
    }) ?? entry;
    await this.recordObservedSurface(messagingStore, event.channel, now);
    this.recordPairingActivity(observed, "Observed pairing token");
    this.broadcastPairingChanged(observed);
    await this.deliverPairingReply(
      adapter,
      event,
      "Pairing request received. Approve it in PwrAgent to finish.",
    );
    return true;
  }

  private async recordObservedSurface(
    store: MessagingStoreLike,
    channel: MessagingInboundEvent["channel"],
    observedAt = Date.now(),
  ): Promise<void> {
    try {
      await store.upsertObservedSurface?.(channel, observedAt);
    } catch (error) {
      messagingLog.warn("failed to remember observed messaging surface", {
        platform: channel.channel,
        conversationId: channel.conversation.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async deliverPairingReply(
    adapter: DesktopMessagingAdapter,
    event: MessagingInboundEvent,
    text: string,
  ): Promise<void> {
    try {
      await adapter.deliver({
        id: `pairing:reply:${event.id}:${Date.now()}`,
        kind: "message",
        createdAt: Date.now(),
        parts: [{ type: "text", text }],
        audit: {
          actor: event.actor,
          action: "pairing.reply",
          channel: event.channel,
          occurredAt: Date.now(),
        },
      });
    } catch (error) {
      messagingLog.warn("messaging pairing reply failed", {
        channel: adapter.channel,
        eventId: event.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private recordPairingActivity(entry: MessagingPairingEntry, summary: string): void {
    try {
      getDesktopMessagingActivityLog().record({
        platform: entry.platform,
        kind: "pairing",
        conversationId: entry.observedChat?.id,
        conversationTitle: entry.observedChat?.title,
        actorId: entry.observedActor?.id,
        actorDisplayName: entry.observedActor?.displayName,
        summary,
        payload: {
          pairingId: entry.id,
          scope: entry.scope,
          status: entry.status,
          instanceId: entry.instanceId,
          expiresAt: entry.expiresAt,
          failureReason: entry.failureReason,
          conversationKind: entry.observedChat?.kind,
          conversationParentId: entry.observedChat?.parentId,
          conversationParentTitle: entry.observedChat?.parentTitle,
          conversationBucketId: entry.observedChat?.bucketId,
          actorUsername: entry.observedActor?.username,
        },
      });
    } catch (error) {
      messagingLog.warn("messaging pairing activity write failed", {
        pairingId: entry.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private recordPairingAttemptActivity(
    platform: MessagingChannelKind,
    event: MessagingInboundEvent,
    summary: string,
  ): void {
    try {
      getDesktopMessagingActivityLog().record({
        platform,
        kind: "pairing",
        conversationId: event.channel.conversation.id,
        conversationTitle: event.channel.conversation.title,
        actorId: event.actor.platformUserId,
        actorDisplayName: event.actor.displayName,
        summary,
        payload: {
          eventId: event.id,
          eventKind: event.kind,
          conversationKind: event.channel.conversation.kind,
        },
      });
    } catch {
      // Best effort only.
    }
  }

  private recordBindingActivity(
    action: "bound" | "unbound",
    binding: MessagingBindingRecord,
    occurredAt: number,
  ): void {
    try {
      const conversation = binding.channel.conversation;
      getDesktopMessagingActivityLog().record({
        platform: binding.channel.channel,
        kind: "binding",
        backend: binding.backend,
        threadId: binding.threadId,
        bindingId: binding.id,
        conversationId: conversation.id,
        conversationTitle: conversation.title,
        summary: `Channel ${action}: ${describeConversation(conversation)} / ${binding.threadId}`,
        createdAt: occurredAt,
        payload: {
          action,
          conversationKind: conversation.kind,
          conversationParentId: conversation.parentId,
          parentTitle: conversation.parentTitle,
          ancestorTitle: conversation.ancestorTitle,
        },
      });
    } catch (error) {
      messagingLog.warn("messaging binding activity write failed", {
        action,
        bindingId: binding.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private recordDiagnosticActivity(params: {
    platform: MessagingChannelKind;
    backend?: AgentEvent["backend"];
    threadId?: string;
    bindingId?: string;
    conversation?: MessagingChannelRef["conversation"];
    actor?: { platformUserId: string; displayName?: string };
    summary: string;
    createdAt: number;
    payload: Record<string, unknown>;
  }): void {
    try {
      getDesktopMessagingActivityLog().record({
        platform: params.platform,
        kind: "diagnostic",
        backend: params.backend,
        threadId: params.threadId,
        bindingId: params.bindingId,
        conversationId: params.conversation?.id,
        conversationTitle: params.conversation
          ? describeConversation(params.conversation)
          : undefined,
        actorId: params.actor?.platformUserId,
        actorDisplayName: params.actor?.displayName,
        summary: params.summary,
        createdAt: params.createdAt,
        payload: params.payload,
      });
    } catch (error) {
      messagingLog.warn("messaging diagnostic activity write failed", {
        bindingId: params.bindingId,
        error: error instanceof Error ? error.message : String(error),
        platform: params.platform,
      });
    }
  }

  private recordActivityFromInbound(
    platform: MessagingChannelKind,
    event: MessagingInboundEvent,
    authorized: boolean,
  ): void {
    // Best-effort write — never throw out of the adapter listener path.
    // The activity log is observability, not the source of truth for
    // routing decisions, so a failed write means we lose a row, not a
    // misrouted message.
    try {
      const conversation = event.channel.conversation;
      const summary = authorized
        ? `Inbound from ${event.actor.displayName ?? event.actor.platformUserId}`
        : `Rejected inbound from ${event.actor.displayName ?? event.actor.platformUserId}`;
      getDesktopMessagingActivityLog().record({
        platform,
        kind: authorized ? "inbound-routed" : "inbound-rejected",
        conversationId: conversation.id,
        conversationTitle: conversation.title,
        actorId: event.actor.platformUserId,
        actorDisplayName: event.actor.displayName,
        summary,
        payload: {
          eventId: event.id,
          eventKind: event.kind,
          conversationKind: conversation.kind,
          conversationParentId: conversation.parentId,
          actorUsername: event.actor.username,
          actorIsBot: event.actor.isBot,
        },
      });
    } catch (error) {
      messagingLog.warn("messaging activity log write failed", {
        platform,
        eventId: event.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private recordActivityFromRejected(
    platform: MessagingChannelKind,
    event: MessagingRejectedInboundEvent,
    route: RejectedInboundRoute,
  ): void {
    try {
      const conversation = event.channel.conversation;
      const actorName = event.actor.displayName ?? event.actor.platformUserId;
      const destinationName =
        route.destinationAgentName
        ?? route.threadId;
      const conversationName = describeRejectedConversation(platform, conversation);
      const attemptKind = event.botMention ? "@mention" : event.kind;
      getDesktopMessagingActivityLog().record({
        platform,
        kind: "inbound-rejected",
        backend: route.backend,
        threadId: route.threadId,
        bindingId: route.bindingId,
        conversationId: conversation.id,
        conversationTitle: conversation.title,
        actorId: event.actor.platformUserId,
        actorDisplayName: event.actor.displayName,
        summary:
          `Blocked ${attemptKind} to ${destinationName} from ${actorName}`
          + ` in ${conversationName}`,
        payload: {
          eventId: event.id,
          eventKind: event.kind,
          conversationKind: conversation.kind,
          conversationParentId: conversation.parentId,
          actorUsername: event.actor.username,
          actorIsBot: event.actor.isBot,
          conversationDisplayName: conversationName,
          rejectionReason: event.reason,
          destinationAgentName: route.destinationAgentName,
          destinationBackend: route.backend,
          destinationTargetKind: route.targetKind,
          destinationThreadId: route.threadId,
          routeSource: route.routeSource,
        },
      });
    } catch (error) {
      messagingLog.warn("messaging rejected activity log write failed", {
        platform,
        eventId: event.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleRejectedInbound(
    platform: MessagingChannelKind,
    event: MessagingRejectedInboundEvent,
    store: MessagingStoreLike,
  ): Promise<void> {
    if (!isActionableRejectedInbound(event)) {
      return;
    }
    try {
      const route = await this.resolveRejectedInboundRoute(store, event);
      if (!route) {
        return;
      }
      this.emitPlatformActivity(platform);
      this.recordActivityFromRejected(platform, event, route);
      messagingLog.warn("actionable messaging event rejected for a routed destination", {
        actorDisplayName: event.actor.displayName,
        actorId: event.actor.platformUserId,
        actorIsBot: event.actor.isBot,
        actorUsername: event.actor.username,
        channel: platform,
        conversationId: event.channel.conversation.id,
        conversationKind: event.channel.conversation.kind,
        conversationDisplayName: describeRejectedConversation(
          platform,
          event.channel.conversation,
        ),
        conversationTitle: event.channel.conversation.title,
        destinationAgentName: route.destinationAgentName,
        destinationBackend: route.backend,
        destinationTargetKind: route.targetKind,
        destinationThreadId: route.threadId,
        eventId: event.id,
        eventKind: event.kind,
        reason: event.reason,
        routeSource: route.routeSource,
      });
    } catch (error) {
      messagingLog.warn("messaging rejected-event route resolution failed", {
        channel: platform,
        eventId: event.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async resolveRejectedInboundRoute(
    store: MessagingStoreLike,
    event: MessagingRejectedInboundEvent,
  ): Promise<RejectedInboundRoute | undefined> {
    const binding = await store.findActiveBindingForChannel(event.channel);
    const assignment = binding
      ? undefined
      : await store.findActiveDefaultAgentAssignmentForChannel(event.channel);
    if (!binding && !assignment) {
      return undefined;
    }
    const backend = binding?.backend ?? assignment!.target.backend;
    const threadId = binding?.threadId ?? assignment!.target.threadId;
    return {
      backend,
      ...(binding ? { bindingId: binding.id } : {}),
      destinationAgentName: await this.resolveRejectedRouteAgentName(
        backend,
        threadId,
      ),
      routeSource: binding ? "binding" : "default-agent",
      targetKind: binding?.targetKind ?? "agent_thread",
      threadId,
    };
  }

  private async resolveRejectedRouteAgentName(
    backend: MessagingBindingRecord["backend"],
    threadId: MessagingBindingRecord["threadId"],
  ): Promise<string | undefined> {
    if (!this.options.backendBridge.readThreadAgentMetadata) {
      return undefined;
    }
    const key = buildThreadIdentityKey(backend, threadId);
    const now = Date.now();
    const cached = this.rejectedRouteAgentNameCache.get(key);
    if (cached && cached.expiresAt > now) {
      return await cached.value;
    }
    const value = this.options.backendBridge.readThreadAgentMetadata({
      backend,
      threadId,
    })
      .then((metadata) => clipStatusText(metadata?.name))
      .catch((error) => {
        messagingLog.debug("messaging rejected route Agent-name lookup failed", {
          backend,
          error: error instanceof Error ? error.message : String(error),
          threadId,
        });
        return undefined;
      });
    this.rejectedRouteAgentNameCache.set(key, {
      expiresAt: now + REJECTED_ROUTE_AGENT_METADATA_TTL_MS,
      value,
    });
    return await value;
  }

  private broadcastPlatformStatus(event: MessagingPlatformStatusEvent): void {
    for (const listener of this.platformStatusListeners) {
      try {
        listener(event);
      } catch (error) {
        messagingLog.error("messaging platform status listener threw", {
          error: error instanceof Error ? error.message : String(error),
          platform: event.platform,
          kind: event.kind,
        });
      }
    }
  }

  private recordFullAccessPolicyViolation(
    platform: MessagingChannelKind,
    event: {
      actorId: string;
      actorDisplayName?: string;
      backend?: MessagingBindingRecord["backend"];
      bindingId?: string;
      channel: MessagingInboundEvent["channel"];
      requestedAction: string;
      threadId?: MessagingBindingRecord["threadId"];
    },
  ): void {
    try {
      const conversation = event.channel.conversation;
      getDesktopMessagingActivityLog().record({
        platform,
        kind: "inbound-rejected",
        backend: event.backend,
        threadId: event.threadId,
        bindingId: event.bindingId,
        conversationId: conversation.id,
        conversationTitle: conversation.title,
        actorId: event.actorId,
        actorDisplayName: event.actorDisplayName,
        summary: "Rejected Full Access escalation request from messaging",
        payload: {
          conversationKind: conversation.kind,
          conversationParentId: conversation.parentId,
          policyViolation: true,
          requestedAction: event.requestedAction,
        },
      });
    } catch (error) {
      messagingLog.warn("messaging full-access policy activity write failed", {
        actorId: event.actorId,
        error: error instanceof Error ? error.message : String(error),
        platform,
      });
    }
  }

  private async loadConfig(
    options?: DesktopMessagingConfigLoadOptions,
  ): Promise<DesktopMessagingConfig> {
    return typeof this.options.config === "function"
      ? await this.options.config(options)
      : this.options.config;
  }
}

let runtime: DesktopMessagingRuntime | null = null;

export function getDesktopMessagingRuntime(
  config?: DesktopMessagingConfig | DesktopMessagingConfigLoader,
): DesktopMessagingRuntime {
  if (!runtime) {
    runtime = new DesktopMessagingRuntime({
      adapterFactory: createConfiguredAdapters,
      backendBridge: new DesktopMessagingBackendBridge(
        undefined,
        getDesktopFederationRuntime(),
      ),
      config: config ?? (() => loadDesktopMessagingConfig()),
      automationInboundHandler: (event) =>
        getDesktopAutomationService().handleMessagingInboundEvent(event),
      automationInboundMatches: (event) =>
        getDesktopAutomationService().matchesInboundEvent(event),
    });
  }

  return runtime;
}

export async function disposeDesktopMessagingRuntime(): Promise<void> {
  if (!runtime) {
    return;
  }

  const current = runtime;
  runtime = null;
  await current.stop();
}

export function resetDesktopMessagingRuntimeForTests(): void {
  runtime = null;
}

function createConfiguredAdapters(params: {
  config: DesktopMessagingConfig;
  store: MessagingStoreLike;
}): Promise<DesktopMessagingAdapter[]> {
  return loadConfiguredMessagingAdapters(params);
}

function messagingAdapterConfigFingerprint(
  config: DesktopMessagingConfig,
  channel: MessagingChannelKind,
): string {
  const channelConfig =
    channel === "telegram"
      ? config.telegram
      : channel === "discord"
        ? config.discord
        : channel === "mattermost"
          ? config.mattermost
          : channel === "slack"
            ? config.slack
            : channel === "line"
              ? config.line
            : undefined;

  return stableStringify({
    attachmentPolicy: config.attachmentPolicy,
    channelConfig,
    inputDebounceMs: config.inputDebounceMs,
  });
}

function isDesktopMessagingConfigChannel(
  channel: MessagingChannelKind,
): channel is DesktopMessagingConfigChannel {
  return channel === "telegram"
    || channel === "discord"
    || channel === "mattermost"
    || channel === "slack"
    || channel === "line";
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function clampPairingTtlMs(ttlMs: number | undefined): number {
  if (ttlMs === undefined) return DEFAULT_PAIRING_TTL_MS;
  if (!Number.isFinite(ttlMs)) return DEFAULT_PAIRING_TTL_MS;
  return Math.min(
    Math.max(Math.floor(ttlMs), MIN_PAIRING_TTL_MS),
    MAX_PAIRING_TTL_MS,
  );
}

function generatePairingToken(): string {
  const bytes = randomBytes(32);
  let token = "";
  for (let index = 0; token.length < 32; index += 1) {
    token += PAIRING_TOKEN_ALPHABET[bytes[index % bytes.length] % PAIRING_TOKEN_ALPHABET.length];
  }
  return token;
}

function tokenFromInboundEvent(event: MessagingInboundEvent): string | undefined {
  if (event.kind === "text") {
    return extractMessagingPairingToken(event.text);
  }
  if (event.kind === "command" && isMessagingPairingCommand(event.command)) {
    const candidate = event.args[0];
    return candidate && MESSAGING_PAIRING_TOKEN_PATTERN.test(candidate)
      ? candidate
      : undefined;
  }
  if (event.kind === "media" && event.text) {
    return extractMessagingPairingToken(event.text);
  }
  return undefined;
}

function pairingScopeFailure(
  entry: MessagingPairingEntry,
  event: MessagingInboundEvent,
): string | undefined {
  if (entry.scope === "observed") return undefined;

  const isDm = event.channel.conversation.kind === "dm";
  if (entry.scope === "user_dm" && !isDm) {
    return "token was generated for a DM but was pasted in a group/channel";
  }
  if (entry.scope === "user_in_group" && isDm) {
    return "token was generated for a user-in-group flow but was pasted in a DM";
  }
  if (entry.scope === "bucket" && isDm) {
    return "token was generated for a group/server bucket but was pasted in a DM";
  }
  return undefined;
}

function observedActorFromEvent(event: MessagingInboundEvent): MessagingPairingObservedActor {
  return {
    id: event.actor.platformUserId,
    displayName: event.actor.displayName,
    phoneNumber: event.actor.phoneNumber,
    username: event.actor.username,
  };
}

function observedChatFromEvent(event: MessagingInboundEvent): MessagingPairingObservedChat {
  const conversation = event.channel.conversation;
  return {
    id: conversation.id,
    kind: conversation.kind,
    title: conversation.title,
    parentId: conversation.parentId,
    parentTitle: conversation.parentTitle,
    ancestorTitle: conversation.ancestorTitle,
    bucketId: bucketIdFromEvent(event),
  };
}

function bucketIdFromEvent(event: MessagingInboundEvent): string | undefined {
  const opaque = event.routingState?.opaque;
  if (opaque && typeof opaque === "object" && !Array.isArray(opaque)) {
    const record = opaque as Record<string, unknown>;
    if (typeof record.guildId === "string" && record.guildId) {
      return record.guildId;
    }
    if (typeof record.chatId === "number" || typeof record.chatId === "string") {
      return String(record.chatId);
    }
    if (typeof record.teamId === "string" && record.teamId) {
      return record.teamId;
    }
  }
  return event.channel.conversation.parentId ?? event.channel.conversation.id;
}

function degradationKey(
  platform: MessagingChannelKind,
  kind: MessagingDegradationReason["kind"],
  id: string,
): string {
  return `${platform}:${kind}:${id}`;
}

function messagingChannelConfig(
  config: DesktopMessagingConfig,
  channel: MessagingChannelKind,
): unknown {
  switch (channel) {
    case "discord":
      return config.discord;
    case "feishu":
      return config.feishu;
    case "line":
      return config.line;
    case "mattermost":
      return config.mattermost;
    case "slack":
      return config.slack;
    case "telegram":
      return config.telegram;
    default:
      return undefined;
  }
}

async function promiseWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  operation: string,
): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(
        new Error(`${operation} did not complete within ${formatDuration(timeoutMs)}.`),
      );
    }, timeoutMs);
    if (timeoutHandle.unref) timeoutHandle.unref();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timeoutHandle);
  }
}

function formatDuration(durationMs: number): string {
  if (durationMs % 1000 === 0) {
    const seconds = durationMs / 1000;
    return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
  }
  return `${durationMs} ms`;
}

function streamingResponsesDefaultForChannel(
  config: DesktopMessagingConfig,
  channel: MessagingChannelKind,
): boolean {
  switch (channel) {
    case "discord":
      return config.discord?.streamingResponses ?? false;
    case "mattermost":
      return config.mattermost?.streamingResponses ?? false;
    case "slack":
      return config.slack?.streamingResponses ?? false;
    case "telegram":
      return config.telegram?.streamingResponses ?? false;
    case "feishu":
      return config.feishu?.streamingResponses ?? false;
    // LINE has no message-edit API, so it never streams — the `default` false
    // is correct for it (there is no LINE streaming setting).
    default:
      return false;
  }
}

function definedCredentialMetadata(
  metadata: MessagingCredentialMetadata,
): MessagingCredentialMetadata {
  return {
    ...(metadata.account !== undefined ? { account: metadata.account } : {}),
    ...(metadata.detail !== undefined ? { detail: metadata.detail } : {}),
  };
}

function degradationTimerKey(
  platform: MessagingChannelKind,
  key: string,
): string {
  return `${platform}\0${key}`;
}

function degradationExpiresAt(
  reason: MessagingDegradationReason,
): number | undefined {
  return "expiresAt" in reason ? reason.expiresAt : undefined;
}

function sanitizeDeliveryScope(
  scope: MessagingDeliveryScope,
): MessagingDeliveryScope {
  return {
    ...scope,
    label: clipStatusText(scope.label),
    bucketId: clipStatusText(scope.bucketId),
  };
}

function describeDeliveryBudgetTarget(
  event: MessagingControllerDeliveryBudgetEvent,
  localThreadTitle?: string,
): string {
  const pieces: string[] = [];
  if (event.conversation) {
    pieces.push(`conversation ${shortIdentifier(describeConversation(event.conversation), 80)}`);
  } else if (event.bindingId) {
    pieces.push(`binding ${shortIdentifier(event.bindingId)}`);
  }
  if (localThreadTitle) {
    pieces.push(`thread ${shortIdentifier(localThreadTitle, 48)}`);
  } else if (event.threadId) {
    pieces.push(`thread ${shortIdentifier(event.threadId)}`);
  }
  if (event.scope && !event.conversation) {
    pieces.push(`${event.scope.kind} ${shortIdentifier(event.scope.label ?? event.scope.id, 48)}`);
  }
  return pieces.length > 0 ? ` for ${pieces.join(", ")}` : "";
}

function deliveryBudgetTargetKey(
  event: MessagingControllerDeliveryBudgetEvent,
): string {
  const pieces: string[] = [];
  if (event.bindingId) {
    pieces.push(`binding:${encodeURIComponent(event.bindingId)}`);
  }
  if (event.threadId) {
    pieces.push(`thread:${encodeURIComponent(event.threadId)}`);
  }
  return pieces.length > 0 ? pieces.join("|") : "scope";
}

function shortIdentifier(value: string, maxLength = 24): string {
  const normalized = clipStatusText(value) ?? value;
  if (normalized.length <= maxLength) {
    return normalized;
  }
  const prefixLength = Math.max(10, Math.ceil((maxLength - 3) * 0.6));
  const suffixLength = Math.max(8, maxLength - 3 - prefixLength);
  return `${normalized.slice(0, prefixLength)}...${normalized.slice(-suffixLength)}`;
}

function clipStatusText(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = replaceAsciiControlCharacterRuns(value).trim();
  return normalized.length > 160 ? `${normalized.slice(0, 157)}...` : normalized;
}

function replaceAsciiControlCharacterRuns(value: string): string {
  let result = "";
  let replacingControlRun = false;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    const isControl = codePoint <= 0x1f || codePoint === 0x7f;
    if (isControl) {
      if (!replacingControlRun) {
        result += " ";
      }
      replacingControlRun = true;
      continue;
    }
    replacingControlRun = false;
    result += character;
  }
  return result;
}

function describeConversation(
  conversation: MessagingChannelRef["conversation"],
): string {
  const pieces = [
    conversation.ancestorTitle,
    conversation.parentTitle,
    conversation.title,
  ].filter((piece): piece is string => Boolean(piece));
  return pieces.length > 0 ? pieces.join(" / ") : conversation.id;
}

function describeRejectedConversation(
  platform: MessagingChannelKind,
  conversation: MessagingChannelRef["conversation"],
): string {
  const description = describeConversation(conversation);
  if (
    platform === "slack"
    && conversation.kind !== "dm"
    && conversation.isDirectMessage !== true
  ) {
    return description.startsWith("#") ? description : `#${description}`;
  }
  return description;
}

function isActionableRejectedInbound(
  event: MessagingRejectedInboundEvent,
): boolean {
  if (
    event.channel.conversation.kind === "dm"
    || event.channel.conversation.isDirectMessage === true
  ) {
    return true;
  }
  if (event.kind === "text" || event.kind === "media") {
    return event.botMention === true;
  }
  return true;
}

/**
 * Operator-legible name for a delivery priority. The raw tokens
 * (`critical_interactive`, `stream_partial`, …) are internal scheduling labels;
 * Messaging Activity rows should say what an operator recognizes. Notably an
 * approval/questionnaire delayed or dropped by the budget reads as
 * "approval / interactive prompt" so a starved approval surfaces a clear reason
 * instead of an opaque token (or nothing at all).
 */
function describeDeliveryPriority(priority: MessagingDeliveryPriority): string {
  switch (priority) {
    case "critical_interactive":
      return "approval / interactive prompt";
    case "final_turn":
      return "final response";
    case "user_command":
      return "command reply";
    case "routine_status":
      return "status update";
    case "tool_progress":
      return "tool progress";
    case "stream_partial":
      return "streaming update";
    default:
      return priority;
  }
}

function formatDurationForStatus(durationMs: number): string {
  const seconds = Math.max(0, Math.ceil(durationMs / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.ceil(seconds / 60);
  return `${minutes}m`;
}
