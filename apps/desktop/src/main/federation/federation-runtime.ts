import type { ReadQueuedTurnRequest, ReadQueuedTurnResponse } from "@pwragent/shared";
import { randomBytes, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import path from "node:path";
import type {
  ReadFederationActivityRequest,
  ReadFederationActivityResponse,
  AnalyzeThreadToolHistoryRequest,
  AnalyzeThreadToolHistoryResponse,
  AgentEvent,
  AppServerListSkillsResponse,
  AppServerListThreadsResponse,
  AppServerReadThreadResponse,
  AppServerThreadSummary,
  AttachDirectoryToThreadResponse,
  CancelQueuedTurnResponse,
  ReleaseQueuedTurnResponse,
  CancelThreadExecutionModeQueueResponse,
  CheckThreadBranchDriftResponse,
  CompactThreadResponse,
  ControlActiveTurnResponse,
  CreateScheduledThreadActionRequest,
  CodexEnvironmentSetupProgressEvent,
  FederationCapability,
  FederationConnectionState,
  FederationDiagnosticEvent,
  FederationEndpointStatus,
  FederationEventClass,
  FederationEventSubscription,
  FederationThreadSelection,
  FederatedSearchRequest,
  FederatedSearchResponse,
  FederationHealthStatus,
  FederationHostInfo,
  FederationInstanceId,
  FederationInstanceRole,
  FederationLoadStatus,
  FederationPeerSummary,
  FederationPinDisposition,
  FederationProtocolEnvelope,
  FederationSessionId,
  ForkThreadResponse,
  HandoffThreadWorkspaceResponse,
  InterruptTurnResponse,
  ListScheduledThreadActionsRequest,
  ListScheduledThreadActionsResponse,
  ListThreadMcpServersResponse,
  MaterializeDirectoryLaunchpadResponse,
  ListModelSettingsRecentsRequest,
  ListModelSettingsRecentsResponse,
  ListRecentFileReferencesResponse,
  MarkThreadSeenResponse,
  MessagingPlatformStatus,
  NavigationSnapshotTransportState,
  NavigationSnapshotTransportSelection,
  PwrSnapConnectionStatus,
  OpenDesktopApplicationResponse,
  QueueThreadExecutionModeResponse,
  ReadFederationPinImpactRequest,
  ReadFederationPinImpactResponse,
  RefreshDirectoryGitStatusesResponse,
  RefreshThreadPullRequestsResponse,
  ResetFederationEnrollmentRequest,
  RetainThreadBranchDriftResponse,
  RenameThreadResponse,
  ReloadCodexMcpConfigResponse,
  RunCodexEnvironmentActionResponse,
  ScheduledThreadActionIdRequest,
  ScheduledThreadActionMutationResponse,
  SetAcpSessionRuntimeOptionResponse,
  SetCodexThreadEnvironmentResponse,
  SetThreadExecutionModeResponse,
  SetThreadModelSettingsResponse,
  StartReviewResponse,
  StartThreadResponse,
  SteerTurnResponse,
  StopCodexEnvironmentActionResponse,
  StopSubAgentResponse,
  SubmitServerRequestResponse,
  TrustCodexProjectResponse,
  UpdateThreadExpectedBranchResponse,
  UpdateScheduledThreadActionRequest,
} from "@pwragent/shared";
import {
  FEDERATION_EVENT_CLASSES,
  FEDERATION_INVITE_VERSION,
  FEDERATION_PROTOCOL_VERSION,
  MAX_CELESTIAL_ASSIGNMENTS,
  applyNavigationSnapshotTransportResponse,
  buildAppendPinRank,
  buildFederatedThreadRef,
  buildThreadIdentityKey,
  encodeLegacyThreadIdentityKey,
  federatedThreadIdentityKey,
  federationEndpointAcceptsCloudflareCredentials,
  isCelestialIconAssignment,
  isCelestialIconId,
  isStarMapArrangementEntry,
  isFederationGatewayEndpointUrl,
  isFederationInstanceId,
  isFederationEventClass,
  isAppServerBackendKind,
  formatFederationPeerDisplayLabel,
  isRemoteFederationTarget,
  mergeCelestialIconAssignments,
  normalizeNavigationSnapshotThreadKeys,
  pickCelestialIcon,
  resolveThreadTerminalCwd,
  threadMatchesQuery,
  type AppServerListSkillsRequest,
  type AppServerListThreadsRequest,
  type AppServerReadThreadRequest,
  type AppServerBackendKind,
  type AttachDirectoryToThreadRequest,
  type CancelQueuedTurnRequest,
  type ReleaseQueuedTurnRequest,
  type CancelThreadExecutionModeQueueRequest,
  type CelestialIconAssignment,
  type CelestialIconId,
  type CheckThreadBranchDriftRequest,
  type CompactThreadRequest,
  type ControlActiveTurnRequest,
  type ForkThreadRequest,
  type EnsureDirectoryLaunchpadRequest,
  type FederationRemoteTarget,
  type FederatedThreadRef,
  type DesktopApplicationsSnapshot,
  type DesktopFederationMode,
  type HandoffThreadWorkspaceRequest,
  type GetNavigationSnapshotRequest,
  type GetNavigationSnapshotTransportRequest,
  type GetWorktreeUnpublishedCommitDiffRequest,
  type GetWorktreeUnpublishedCommitDiffResponse,
  type InterruptTurnRequest,
  type ListWorktreeUnpublishedCommitsRequest,
  type ListWorktreeUnpublishedCommitsResponse,
  type ListThreadMcpServersRequest,
  type MaterializeDirectoryLaunchpadRequest,
  type MaterializeDirectoryLaunchpadOptions,
  type MarkThreadSeenRequest,
  type ReloadCodexMcpConfigRequest,
  type SetThreadPinRequest,
  type SetThreadPinResponse,
  type SetThreadReactionRequest,
  type SetThreadReactionResponse,
  type SetThreadPrAutoDispatchRequest,
  type SetThreadPrAutoDispatchResponse,
  type CancelThreadPrAutoDispatchRequest,
  type CancelThreadPrAutoDispatchResponse,
  type SendThreadPrAutoDispatchNowRequest,
  type SendThreadPrAutoDispatchNowResponse,
  type DetachThreadPullRequestRequest,
  type DetachThreadPullRequestResponse,
  type ReorderThreadPinsRequest,
  type ReorderThreadPinsResponse,
  type NavigationSnapshot,
  type NavigationSnapshotTransportResponse,
  type NavigationThreadSummary,
  type OpenDesktopApplicationRequest,
  type QueueThreadExecutionModeRequest,
  type RefreshDirectoryGitStatusesRequest,
  type RecordModelSettingsRecentRequest,
  type RecordRecentFileReferencesRequest,
  type RetainThreadBranchDriftRequest,
  type RenameThreadRequest,
  type ResolveActiveTurnRequest,
  type ResolveActiveTurnResponse,
  type RunCodexEnvironmentActionRequest,
  type SetAcpSessionRuntimeOptionRequest,
  type SetCelestialIconRequest,
  type SetCelestialIconResponse,
  type StarMapArrangementEntry,
  type StarMapIntakeRequest,
  type StarMapIntakeResponse,
  type SetCodexThreadEnvironmentRequest,
  type SetThreadExecutionModeRequest,
  type SetThreadModelSettingsRequest,
  type SetThreadParentRequest,
  type SetSubthreadsCollapsedRequest,
  type SetSubthreadsCollapsedResponse,
  type StartReviewRequest,
  type StartThreadRequest,
  type SteerTurnRequest,
  type StartTurnResponse,
  type SubmitServerRequestRequest,
  type StopCodexEnvironmentActionRequest,
  type StopSubAgentRequest,
  type TrustCodexProjectRequest,
  type UpdateSubthreadOrderRequest,
  type UpdateSubthreadOrderResponse,
  type UpdateThreadExpectedBranchRequest,
} from "@pwragent/shared";
import { getDesktopBackendRegistry } from "../app-server/backend-registry";
import { registerDirectoryFromDisk } from "../app-server/directory-registration-service";
import { getDesktopOverlayStore } from "../app-server/desktop-overlay-store";
import { dispatchStarMapIntake } from "../app-server/star-map-intake";
import { spawnTerminalPty } from "../terminal/integrated-terminal-service";
import {
  readTranscriptImageProtocolRequest,
  rewriteFederatedTranscriptImageUrlsForRenderer,
  rewriteTranscriptImageUrlsForRenderer,
  toFederatedTranscriptImageProtocolUrl,
} from "../transcript-image-protocol";
import { getMainLogger } from "../log";
import {
  discoverDesktopApplications,
  openDesktopApplication,
} from "../settings/application-discovery";
import { getPwrSnapConnectionService } from "../mcp-connections/pwrsnap-connection-service";
import { getDesktopSettingsService } from "../settings/desktop-settings-singleton";
import { getAppStateDb, isAppStateInitialized } from "../state/app-state";
import {
  getExistingRuntimeFederationLeaseCoordinator,
  getRuntimeFederationLeaseCoordinator,
} from "../runtime-federation-lease";
import {
  listModelSettingsRecents,
  recordModelSettingsRecent,
} from "../state/model-settings-recents-store";
import {
  listRecentFileReferencePaths,
  recordRecentFileReferencePaths,
} from "../state/recent-file-references-store";
import { DesktopMessagingBackendBridge } from "../messaging/desktop-backend-bridge";
import { NavigationSnapshotTransport } from "../navigation-snapshot-transport";
import {
  createFederationEnrollmentInvite,
  decodeFederationInvite,
  encodeFederationInvite,
} from "./federation-enrollment";
import { FederatedSearchService } from "./federated-search-service";
import {
  collectFederationHostInfo,
  collectFederationLoadStatus,
} from "./federation-host-info";
import { FederationActivityLedger } from "./federation-activity-ledger";
import { FederationTransferLedger } from "./federation-transfer-ledger";
import { RemoteThreadSummaryCache } from "./remote-thread-summary-cache";
import { hydrateFederatedThreadMessageOrigins } from "./federated-thread-origin-hydrator";
import {
  FEDERATION_BACKEND_EVENT_METHOD,
  FEDERATION_BACKEND_METHOD_CAPABILITIES,
  FEDERATION_ENVIRONMENT_SETUP_PROGRESS_METHOD,
  additionalFederationBackendCapabilities,
  FederationRemoteBackendClient,
  registerFederationBackendHandlers,
  type FederationBackendEventNotification,
  type FederationBackendOperations,
  type FederationEnvironmentSetupProgressNotification,
  type FederationRefreshThreadPullRequestsRequest,
  type FederationStartTurnRequest,
} from "./federation-backend-bridge";
import {
  FederationTurnInputAttachmentReceiver,
  hasFederationTurnInputAttachments,
  prepareOutgoingFederationTurnInput,
} from "./federation-turn-input-attachments";
import {
  applyFederationLeaseSnapshot,
  buildFederationHealthStatus,
  publicPeerSummary,
} from "./federation-health";
import {
  resolveFederationRuntimeConfig,
  type FederationRuntimeConfig,
} from "./federation-runtime-config";
import {
  FEDERATION_PTY_EXIT_METHOD,
  FEDERATION_PTY_OUTPUT_METHOD,
  FEDERATION_PTY_METHOD_CAPABILITIES,
  FederationPtyService,
  FederationRemotePtyClient,
  isFederationPtyStreamMethod,
  registerFederationPtyHandlers,
  type FederationPtyStreamEvent,
  type FederationRemotePtyOperations,
} from "./federation-pty-service";
import { FederationRouter } from "./federation-router";
import {
  FederationRpcEndpoint,
  type FederationRpcRequestOptions,
} from "./federation-rpc";
import {
  FederationPeerUnavailableError,
} from "./federation-peer-unavailable-error";
import { FederationStore } from "./federation-store";
import {
  classifyFederationClientFailure,
  redactFederationDiagnostic,
} from "./federation-redaction";
import {
  connectFederationClient,
  FEDERATION_CLOSE_REPLACED_CODE,
  FEDERATION_CLOSE_REVOKED_CODE,
  FederationGatewayWebSocketServer,
  type FederationClientWebSocketClient,
  type FederationGatewayConnection,
} from "./federation-transport";
import {
  buildFederationAdvertisedEndpoints,
  collectFederationInterfaceAddresses,
  type FederationTailscaleAdvertisement,
} from "./federation-advertised-endpoints";
import { orderFederationEndpointAttempts } from "./federation-endpoints";
import {
  dialFederationSshEndpoint,
  isFederationSshEndpointUrl,
  parseFederationSshEndpoint,
} from "./federation-ssh";
import { noiseKeyPairFromRawPrivate } from "./federation-noise";
import { federationReconnectDelayMs } from "./federation-reconnect-policy";

const log = getMainLogger("pwragent:federation-runtime");

export function navigationWireResponseThreadCount(
  response: NavigationSnapshot | NavigationSnapshotTransportResponse,
): number {
  if ("threads" in response) {
    return response.threads.length;
  }
  switch (response.kind) {
    case "full":
      return response.snapshot.threads.length;
    case "delta":
      return response.upsertedThreads.length;
    case "changes":
      return response.changes.reduce(
        (count, change) => count + change.upsertedThreads.length,
        0,
      );
    case "unchanged":
      return 0;
  }
}

const INSTANCE_ID_META_KEY = "federation_instance_id";
const GATEWAY_INSTANCE_ID_META_KEY = "federation_gateway_instance_id";
const GATEWAY_PUBLIC_KEY_META_KEY = "federation_gateway_public_key_pem";
const GATEWAY_NOISE_PUBLIC_KEY_META_KEY = "federation_gateway_noise_public_key";
const GATEWAY_LAST_ENDPOINT_META_KEY = "federation_gateway_last_endpoint";
const PENDING_INVITE_TOKEN_META_KEY = "federation_pending_invite_token";
const GATEWAY_ENROLLED_AT_META_KEY = "federation_gateway_enrolled_at";
const FEDERATION_PEER_DIRECTORY_METHOD = "federation.peerDirectory";
const FEDERATION_CELESTIAL_ICONS_METHOD = "federation.celestialIcons";
const FEDERATION_STAR_MAP_ARRANGEMENT_METHOD = "federation.starMapArrangement";
const FEDERATION_EVENT_SUBSCRIPTION_METHOD = "federation.eventSubscription";
const FEDERATION_EVENT_RELAY_MAX_HOPS = 4;
const REMOTE_NAVIGATION_SELECTION_CACHE_LIMIT = 8;
const CELESTIAL_ICON_ASSIGNMENTS_META_KEY =
  "federation_celestial_icon_assignments";
/**
 * How long a celestial tombstone stays in the map after the removal. Long
 * enough for every enrolled peer to reconnect at least once and merge the
 * removal; after that the entry is pure bloat and gets deleted locally.
 */
const CELESTIAL_TOMBSTONE_TTL_MS = 7 * 24 * 60 * 60_000;
const DUPLICATE_IDENTITY_NOTE_TTL_MS = 5 * 60_000;
/** A session must last this long before it counts as stable enough to reset backoff. */
const FEDERATION_STABLE_SESSION_MS = 60_000;

function rewriteLiveTranscriptImagesForFederation(
  event: AgentEvent,
  ownerInstanceId: FederationInstanceId,
): AgentEvent {
  if (
    event.notification.method !== "item/started"
    && event.notification.method !== "item/completed"
  ) {
    return event;
  }
  const params = event.notification.params as Record<string, unknown>;
  const itemValue = params.item;
  if (
    !itemValue
    || typeof itemValue !== "object"
    || Array.isArray(itemValue)
  ) {
    return event;
  }
  const item = itemValue as Record<string, unknown>;
  if (item.type !== "userMessage" || !Array.isArray(item.content)) {
    return event;
  }
  let changed = false;
  const content = item.content.map((part) => {
    if (
      !part
      || typeof part !== "object"
      || Array.isArray(part)
      || !("type" in part)
      || !("url" in part)
      || part.type !== "image"
      || typeof part.url !== "string"
      || !part.url.startsWith("pwragent-image://file/")
    ) {
      return part;
    }
    changed = true;
    return {
      ...part,
      url: toFederatedTranscriptImageProtocolUrl(ownerInstanceId, part.url),
    };
  });
  if (!changed) {
    return event;
  }
  return {
    ...event,
    notification: {
      ...event.notification,
      params: {
        ...params,
        item: {
          ...item,
          content,
        },
      },
    },
  } as AgentEvent;
}

const DEFAULT_CAPABILITIES: FederationCapability[] = [
  "remote_window",
  "thread_navigation",
  "navigation_snapshot_deltas",
  "thread_grouping",
  "thread_detail",
  "turn_control",
  "scheduled_actions",
  "pending_request_control",
  "environment_actions",
  "launchpad_metadata",
  "federated_search",
  "messaging_route",
  "pwrsnap_connection",
  "gateway_relay",
  // Federation is a same-operator trust domain and turn_control already
  // permits code execution via agent turns, so the direct shell defaults to
  // granted — but stays a dedicated capability so it is revocable on its own.
  "remote_pty",
  "event_subscriptions",
  "turn_input_blobs",
];

const REMOTE_THREAD_SUMMARY_EVENT_CONSUMER_ID =
  "remote-thread-summary-cache";

type FederationPeerDirectoryNotification = {
  method: typeof FEDERATION_PEER_DIRECTORY_METHOD;
  params: {
    peers: FederationPeerSummary[];
  };
};

type FederationCelestialIconsNotification = {
  method: typeof FEDERATION_CELESTIAL_ICONS_METHOD;
  params: {
    assignments: CelestialIconAssignment[];
  };
};

type FederationStarMapArrangementNotification = {
  method: typeof FEDERATION_STAR_MAP_ARRANGEMENT_METHOD;
  params: {
    entries: StarMapArrangementEntry[];
  };
};

function encodeStarMapEntriesForProtocolV1(
  entries: StarMapArrangementEntry[],
): StarMapArrangementEntry[] {
  return entries.map((entry) => ({
    ...entry,
    threadKey:
      encodeLegacyThreadIdentityKey(entry.threadKey) ?? entry.threadKey,
  }));
}

type FederationEventSubscriptionNotification = {
  method: typeof FEDERATION_EVENT_SUBSCRIPTION_METHOD;
  params: {
    eventClasses: FederationEventClass[];
    threadSelection?: FederationThreadSelection;
  };
};

type IncomingEventSubscription = {
  eventClasses: Set<FederationEventClass>;
  threadSelection: FederationThreadSelection;
  viaPeerId: FederationInstanceId;
};

type DesiredEventSubscription = {
  eventClasses: Set<FederationEventClass>;
  threadSelection: FederationThreadSelection;
};

type RelayedEventSubscription = IncomingEventSubscription & {
  sourceInstanceId: FederationInstanceId;
  subscriberInstanceId: FederationInstanceId;
};

const NAVIGATION_EVENT_METHODS = new Set<string>([
  "automation/run/transcript/updated",
  "automation/run/updated",
  "directory/pin/added",
  "directory/pin/removed",
  "directory/pin/reordered",
  "directory/threadsCollapsed/updated",
  "navigation/directoryGitStatus/updated",
  "navigation/threadDirectories/updated",
  "navigation/threadGitWorkingState/updated",
  "pullRequest/status/updated",
  "thread/acpRuntime/updated",
  "thread/agent/updated",
  "thread/archived",
  "thread/automations/updated",
  "thread/codexEnvironment/updated",
  "thread/codexInvalidIdRecovery/updated",
  "thread/executionMode/queueCleared",
  "thread/executionMode/queued",
  "thread/executionMode/updated",
  "thread/modelSettings/updated",
  "thread/name/updated",
  "thread/parent/cleared",
  "thread/parent/set",
  "thread/pin/added",
  "thread/pin/removed",
  "thread/pin/reordered",
  "thread/reactions/updated",
  "thread/prAutoDispatch/pendingUpdated",
  "thread/prAutoDispatch/updated",
  "thread/pullRequests/updated",
  "thread/started",
  "thread/status/changed",
  "thread/subAgents/updated",
  "thread/subthreadOrder/updated",
  "thread/subthreadsCollapsed/updated",
  "thread/turnQueue/updated",
  "thread/unarchived",
  "turn/cancelled",
  "turn/completed",
  "turn/failed",
  "turn/started",
]);

/**
 * Live events patch renderer state, but pinned remote rows also come from a
 * cached owner snapshot. Turn boundaries can advance `updatedAt` while that
 * cache still holds the pre-turn value, leaving a previously hydrated
 * transcript convinced it is current. Invalidate only at lifecycle
 * boundaries — never for streamed transcript items — so the next pinned-row
 * refresh catches up without turning every token into a snapshot fetch.
 */
const REMOTE_THREAD_SUMMARY_LIFECYCLE_METHODS = new Set<string>([
  "thread/status/changed",
  "thread/parent/cleared",
  "thread/parent/set",
  "thread/subthreadOrder/updated",
  "thread/subthreadsCollapsed/updated",
  "turn/cancelled",
  "turn/completed",
  "turn/failed",
  "turn/started",
]);

export function federationEventClassForMethod(
  method: string,
): FederationEventClass {
  if (method === "thread/scheduledAction/updated") {
    return "scheduled_actions";
  }
  if (
    method === "item/tool/requestUserInput"
    || method === "mcpServer/elicitation/request"
    || method === "applyPatchApproval"
    || method === "execCommandApproval"
    || method === "serverRequest/resolved"
    || method.toLowerCase().includes("requestapproval")
  ) {
    return "pending_requests";
  }
  if (
    method === "starMap/arrangement/changed"
    || method === "starMap/intake/status"
    || method === "federation/celestialIcons/changed"
  ) {
    return "star_map";
  }
  if (NAVIGATION_EVENT_METHODS.has(method)) {
    return "navigation";
  }
  // Fail closed: newly introduced notification methods do not reach
  // navigation-only or Star Map subscribers until explicitly classified.
  return "transcript";
}

function eventSubscriptionKey(params: {
  sourceInstanceId: FederationInstanceId;
  subscriberInstanceId: FederationInstanceId;
}): string {
  return `${params.sourceInstanceId}\u0000${params.subscriberInstanceId}`;
}

function equalEventClassSets(
  left: ReadonlySet<FederationEventClass> | undefined,
  right: ReadonlySet<FederationEventClass> | undefined,
): boolean {
  if (!left || !right) return left === right;
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function normalizeFederationThreadSelection(
  value: unknown,
): FederationThreadSelection {
  if (
    !value
    || typeof value !== "object"
    || (value as { kind?: unknown }).kind !== "threads"
    || !Array.isArray((value as { threads?: unknown }).threads)
  ) {
    return { kind: "all" };
  }
  const byKey = new Map<
    string,
    Extract<FederationThreadSelection, { kind: "threads" }>["threads"][number]
  >();
  for (const candidate of (value as { threads: unknown[] }).threads) {
    if (!candidate || typeof candidate !== "object") continue;
    const backend = (candidate as { backend?: unknown }).backend;
    const threadId = (candidate as { threadId?: unknown }).threadId;
    if (
      typeof backend !== "string"
      || !isAppServerBackendKind(backend)
      || typeof threadId !== "string"
    ) {
      continue;
    }
    byKey.set(buildThreadIdentityKey(backend, threadId), { backend, threadId });
  }
  return {
    kind: "threads",
    threads: [...byKey.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, thread]) => thread),
  };
}

function mergeFederationThreadSelections(
  left: FederationThreadSelection | undefined,
  right: FederationThreadSelection,
): FederationThreadSelection {
  if (!left) return right;
  if (left.kind === "all" || right.kind === "all") {
    return { kind: "all" };
  }
  return normalizeFederationThreadSelection({
    kind: "threads",
    threads: [...left.threads, ...right.threads],
  });
}

function federationThreadSelectionKey(
  selection: FederationThreadSelection,
): string {
  return selection.kind === "all"
    ? "all"
    : JSON.stringify(selection.threads.map((thread) =>
        buildThreadIdentityKey(thread.backend, thread.threadId)
      ));
}

function equalFederationThreadSelections(
  left: FederationThreadSelection | undefined,
  right: FederationThreadSelection | undefined,
): boolean {
  if (!left || !right) return left === right;
  return federationThreadSelectionKey(left) === federationThreadSelectionKey(right);
}

function federationThreadSelectionIncludes(
  available: FederationThreadSelection,
  requested: FederationThreadSelection,
): boolean {
  if (available.kind === "all") return true;
  if (requested.kind === "all") return false;
  const availableKeys = new Set(available.threads.map((thread) =>
    buildThreadIdentityKey(thread.backend, thread.threadId)
  ));
  return requested.threads.every((thread) => availableKeys.has(
    buildThreadIdentityKey(thread.backend, thread.threadId)
  ));
}

function transportSelectionFor(
  selection: FederationThreadSelection,
): NavigationSnapshotTransportSelection {
  return selection.kind === "all"
    ? { kind: "all" }
    : {
        kind: "threads",
        threadKeys: selection.threads.map((thread) =>
          buildThreadIdentityKey(thread.backend, thread.threadId)
        ),
      };
}

function eventMatchesThreadSelection(
  event: AgentEvent,
  eventClass: FederationEventClass,
  selection: FederationThreadSelection,
): boolean {
  if (selection.kind === "all") return true;
  const params = event.notification.params as Record<string, unknown> | undefined;
  const nestedThread = params?.thread as Record<string, unknown> | undefined;
  const scheduledAction =
    event.notification.method === "thread/scheduledAction/updated"
      ? params?.action as Record<string, unknown> | undefined
      : undefined;
  const threadId =
    typeof scheduledAction?.threadId === "string"
      ? scheduledAction.threadId
      : typeof params?.threadId === "string"
        ? params.threadId
        : typeof nestedThread?.id === "string"
          ? nestedThread.id
          : undefined;
  // Some navigation invalidations (for example PR status observations) name
  // a shared resource rather than one thread. Sparse consumers still need the
  // tiny invalidation so they can refresh their selected rows; the expensive
  // snapshot response remains filtered.
  if (!threadId) return eventClass === "navigation";
  const actionBackend =
    typeof scheduledAction?.backend === "string"
    && isAppServerBackendKind(scheduledAction.backend)
      ? scheduledAction.backend
      : event.backend;
  const key = buildThreadIdentityKey(actionBackend, threadId);
  return selection.threads.some((thread) =>
    buildThreadIdentityKey(thread.backend, thread.threadId) === key
  );
}

function projectNavigationSnapshot(
  snapshot: NavigationSnapshot,
  request: {
    backend?: GetNavigationSnapshotRequest["backend"];
    filter?: string;
  },
): NavigationSnapshot {
  const query = request.filter?.trim();
  const threads = snapshot.threads.filter((thread) =>
    (
      !request.backend
      || request.backend === "all"
      || thread.source === request.backend
    )
    && (!query || threadMatchesQuery(thread, query))
  );
  const threadKeys = new Set(
    threads.map((thread) => buildThreadIdentityKey(thread.source, thread.id)),
  );
  return {
    ...snapshot,
    backend: request.backend ?? "all",
    threads,
    inboxThreadKeys: snapshot.inboxThreadKeys.filter((key) =>
      threadKeys.has(key)
    ),
    directories: snapshot.directories.flatMap((directory) => {
      const directoryThreadKeys = directory.threadKeys.filter((key) =>
        threadKeys.has(key)
      );
      return directoryThreadKeys.length > 0
        ? [{ ...directory, threadKeys: directoryThreadKeys }]
        : [];
    }),
  };
}

function eventClassAllowedByCapabilities(
  eventClass: FederationEventClass,
  capabilities: readonly FederationCapability[],
): boolean {
  if (!capabilities.includes("event_subscriptions")) return false;
  switch (eventClass) {
    case "navigation":
    case "star_map":
      return capabilities.includes("thread_navigation");
    case "transcript":
      return capabilities.includes("thread_detail");
    case "pending_requests":
      return capabilities.includes("pending_request_control");
    case "scheduled_actions":
      return capabilities.includes("scheduled_actions");
  }
}

export class DesktopFederationRuntime {
  private router?: FederationRouter;
  private server?: FederationGatewayWebSocketServer;
  private client?: FederationClientWebSocketClient;
  private localInstanceId?: FederationInstanceId;
  private instanceLabel?: string;
  private instanceNotes?: string;
  private localHostInfo?: FederationHostInfo;
  private listenUrl?: string;
  private gatewayUrl?: string;
  private gatewayInstanceId?: FederationInstanceId;
  private configuredEndpoints: string[] = [];
  private readonly endpointStatuses = new Map<
    string,
    Omit<FederationEndpointStatus, "url">
  >();
  private readonly rpcByPeer = new Map<FederationInstanceId, FederationRpcEndpoint>();
  private readonly remoteNavigationTransportByPeer = new Map<
    FederationInstanceId,
    Map<string, NavigationSnapshotTransportState>
  >();
  private ownedNavigationSnapshotTransport?: NavigationSnapshotTransport;
  private readonly turnInputAttachmentReceiver =
    new FederationTurnInputAttachmentReceiver();
  private readonly remotePeerDirectory = new Map<
    FederationInstanceId,
    FederationPeerSummary
  >();
  /** Lazily loaded from state.db meta; authoritative copy on the gateway. */
  private celestialAssignments?: Map<
    FederationInstanceId,
    CelestialIconAssignment
  >;
  private readonly publishedPeerStatuses = new Map<
    FederationInstanceId,
    {
      status: FederationConnectionState;
      unavailableReason?: string;
    }
  >();
  private publishAgentEvent?: (event: AgentEvent) => void;
  private publishEnvironmentSetupProgress?: (
    event: CodexEnvironmentSetupProgressEvent,
  ) => void;
  private ptyService?: FederationPtyService;
  private readonly remotePtyEventListeners = new Set<
    (event: FederationPtyStreamEvent) => void
  >();
  private readonly remoteBackendEventListeners = new Set<
    (event: AgentEvent) => void | Promise<void>
  >();
  private readonly peerStatusListeners = new Set<() => void>();
  private readonly desiredEventSubscriptions = new Map<
    string,
    Map<FederationInstanceId, DesiredEventSubscription>
  >();
  private readonly incomingEventSubscriptions = new Map<
    FederationInstanceId,
    IncomingEventSubscription
  >();
  private readonly relayedEventSubscriptions = new Map<
    string,
    RelayedEventSubscription
  >();
  private unsubscribeLocalBackendEvents?: () => void;
  private restartPromise: Promise<void> | undefined;
  private remoteThreadSummaryCache: RemoteThreadSummaryCache | undefined;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnectAttempt = 0;
  private connectionGeneration = 0;
  /** Bumped only by stop(), so an in-flight endpoint walk can detect teardown. */
  private walkEpoch = 0;
  private lastConnectedAt?: number;
  private stopping = true;
  private lastConnectionError?: string;
  private lastConnectionFailureKind?: "auth" | "replaced" | "transport";
  /** Peer ids the gateway recently flagged for duplicate-identity churn. */
  private readonly duplicateIdentitySuspectedAt = new Map<
    FederationInstanceId,
    number
  >();
  /**
   * Per-peer wire counters, fed by the transports' envelope taps.
   * Deliberately a runtime-lifetime field (not reset in stop/restart):
   * the operator's baseline-vs-optimized comparison spans reconnects.
   */
  private readonly transferLedger = new FederationTransferLedger();
  private readonly activityLedger = new FederationActivityLedger();
  private gatewayListenerError?: string;

  setAgentEventPublisher(publisher: (event: AgentEvent) => void): void {
    this.publishAgentEvent = publisher;
  }

  setEnvironmentSetupProgressPublisher(
    publisher: (event: CodexEnvironmentSetupProgressEvent) => void,
  ): void {
    this.publishEnvironmentSetupProgress = publisher;
  }

  onRemoteBackendEvent(
    listener: (event: AgentEvent) => void | Promise<void>,
  ): () => void {
    this.remoteBackendEventListeners.add(listener);
    return () => {
      this.remoteBackendEventListeners.delete(listener);
    };
  }

  setEventSubscriptions(
    consumerId: string,
    subscriptions: readonly FederationEventSubscription[],
  ): FederationEventSubscription[] {
    const previous = this.aggregateDesiredEventSubscriptions();
    const normalized = new Map<
      FederationInstanceId,
      DesiredEventSubscription
    >();
    for (const subscription of subscriptions) {
      if (!isFederationInstanceId(subscription.sourceInstanceId)) continue;
      const eventClasses = subscription.eventClasses.filter(isFederationEventClass);
      if (eventClasses.length === 0) continue;
      const current = normalized.get(subscription.sourceInstanceId);
      const currentClasses = current?.eventClasses ?? new Set();
      for (const eventClass of eventClasses) currentClasses.add(eventClass);
      normalized.set(subscription.sourceInstanceId, {
        eventClasses: currentClasses,
        threadSelection: mergeFederationThreadSelections(
          current?.threadSelection,
          normalizeFederationThreadSelection(subscription.threadSelection),
        ),
      });
    }
    if (normalized.size > 0) {
      this.desiredEventSubscriptions.set(consumerId, normalized);
    } else {
      this.desiredEventSubscriptions.delete(consumerId);
    }
    const next = this.aggregateDesiredEventSubscriptions();
    const sourceIds = new Set([...previous.keys(), ...next.keys()]);
    for (const sourceInstanceId of sourceIds) {
      if (
        equalEventClassSets(
          previous.get(sourceInstanceId)?.eventClasses,
          next.get(sourceInstanceId)?.eventClasses,
        )
        && equalFederationThreadSelections(
          previous.get(sourceInstanceId)?.threadSelection,
          next.get(sourceInstanceId)?.threadSelection,
        )
      ) {
        continue;
      }
      this.sendDesiredEventSubscription(
        sourceInstanceId,
        next.get(sourceInstanceId) ?? {
          eventClasses: new Set(),
          threadSelection: { kind: "threads", threads: [] },
        },
      );
    }
    return [...normalized].map(([sourceInstanceId, subscription]) => ({
      sourceInstanceId,
      eventClasses: [...subscription.eventClasses],
      threadSelection: subscription.threadSelection,
    }));
  }

  setRendererEventSubscriptions(
    webContentsId: number,
    consumerId: "remote-window" | "star-map" | "thread-view",
    subscriptions: readonly FederationEventSubscription[],
  ): FederationEventSubscription[] {
    return this.setEventSubscriptions(
      `renderer:${webContentsId}:${consumerId}`,
      subscriptions,
    );
  }

  /**
   * A full remote viewer holds one source-wide desired-state consumer for
   * every event class its peer capabilities authorize. Narrower consumers
   * (Star Map, pinned summaries, messaging) are unioned independently, so
   * their cleanup cannot unsubscribe a still-open remote desktop window.
   */
  setRemoteWindowEventSubscription(
    webContentsId: number,
    sourceInstanceId: FederationInstanceId,
    capabilities: readonly FederationCapability[],
  ): FederationEventSubscription[] {
    return this.setRendererEventSubscriptions(
      webContentsId,
      "remote-window",
      [{
        sourceInstanceId,
        eventClasses: FEDERATION_EVENT_CLASSES.filter((eventClass) =>
          eventClassAllowedByCapabilities(eventClass, capabilities)
        ),
        threadSelection: { kind: "all" },
      }],
    );
  }

  clearRendererEventSubscriptions(
    webContentsId: number,
    consumerId?: "remote-window" | "star-map" | "thread-view",
  ): void {
    const prefix = `renderer:${webContentsId}:`;
    if (consumerId) {
      this.setEventSubscriptions(`${prefix}${consumerId}`, []);
      return;
    }
    for (const key of [...this.desiredEventSubscriptions.keys()]) {
      if (key.startsWith(prefix)) {
        this.setEventSubscriptions(key, []);
      }
    }
  }

  rendererWantsRemoteEvent(
    webContentsId: number,
    sourceInstanceId: FederationInstanceId,
    eventClass: FederationEventClass,
  ): boolean {
    const prefix = `renderer:${webContentsId}:`;
    for (const [consumerId, subscriptions] of
      this.desiredEventSubscriptions) {
      if (
        consumerId.startsWith(prefix)
        && subscriptions.get(sourceInstanceId)?.eventClasses.has(eventClass)
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Fires whenever any peer's connection status changes. Used by the
   * application menu to keep its Remote Instances listing current.
   */
  onPeerStatusChanged(listener: () => void): () => void {
    this.peerStatusListeners.add(listener);
    return () => {
      this.peerStatusListeners.delete(listener);
    };
  }

  connectedPeerTargets(): Array<{
    target: FederationRemoteTarget;
    label: string;
    capabilities: FederationCapability[];
  }> {
    // Compose display labels against the full visible set so two
    // profiles of the same machine ("Mac-Mini-M4 / default",
    // "Mac-Mini-M4 / dev") stay tellable apart in window titles and
    // the Remote Instances menu.
    const visible = this.visiblePeers();
    return visible
      .filter((peer) => peer.status === "connected")
      .map((peer) => ({
        target: { scope: "remote", instanceId: peer.id },
        label: formatFederationPeerDisplayLabel(peer, visible),
        capabilities: [...peer.capabilities],
      }));
  }

  remoteTargetSupportsCapability(
    target: FederationRemoteTarget,
    capability: FederationCapability,
  ): boolean {
    const visiblePeer = this.visiblePeers().find(
      (peer) => peer.id === target.instanceId,
    );
    return this.viewerCapabilitiesFor(
      target.instanceId,
      visiblePeer,
    ).includes(capability);
  }

  async restart(): Promise<void> {
    this.restartPromise ??= this.restartNow().finally(() => {
      this.restartPromise = undefined;
    });
    return await this.restartPromise;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.connectionGeneration += 1;
    this.walkEpoch += 1;
    if (isAppStateInitialized()) {
      for (const peer of this.visiblePeers()) {
        if (peer.status === "connected") {
          this.publishPeerStatus(
            peer.id,
            "disconnected",
            "Federation runtime stopped.",
          );
        }
      }
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.unsubscribeLocalBackendEvents?.();
    this.unsubscribeLocalBackendEvents = undefined;
    this.remoteThreadSummaryCache?.dispose();
    this.remoteThreadSummaryCache = undefined;
    this.remoteNavigationTransportByPeer.clear();
    this.ownedNavigationSnapshotTransport?.clear();
    this.ownedNavigationSnapshotTransport = undefined;
    // Owner shutdown kills every remote session immediately, mirroring how
    // the local panel's shells die with the app.
    this.ptyService?.disposeAll();
    this.ptyService = undefined;
    this.client?.close();
    this.client = undefined;
    await this.server?.stop();
    this.server = undefined;
    this.router = undefined;
    this.listenUrl = undefined;
    this.gatewayUrl = undefined;
    this.gatewayInstanceId = undefined;
    this.configuredEndpoints = [];
    this.endpointStatuses.clear();
    this.rpcByPeer.clear();
    this.remotePeerDirectory.clear();
    this.publishedPeerStatuses.clear();
    this.incomingEventSubscriptions.clear();
    this.relayedEventSubscriptions.clear();
    this.reconnectAttempt = 0;
    this.lastConnectionError = undefined;
    this.lastConnectionFailureKind = undefined;
    this.gatewayListenerError = undefined;
  }

  async resetActivity(): Promise<ReadFederationActivityResponse> {
    this.activityLedger.reset();
    return this.activity();
  }

  async activity(request?: ReadFederationActivityRequest): Promise<ReadFederationActivityResponse> {
    return {
      activity: this.activityLedger.snapshot(Date.now(), request),
      health: await this.health(),
      configuredMode: this.readRuntimeConfig().mode,
      running: Boolean(this.listenUrl || this.client || this.reconnectTimer),
    };
  }

  async health(): Promise<FederationHealthStatus> {
    const config = this.readRuntimeConfig();
    const health = buildFederationHealthStatus({
      config,
      // Transfer counters attach here and only here — visiblePeers()
      // feeds the gossiped peer directory too, and these numbers
      // describe OUR socket with each peer, not facts about the peer.
      peers: this.visiblePeers().map((peer) => {
        const transfer = this.transferLedger.snapshot(peer.id);
        return transfer ? { ...peer, transfer } : peer;
      }),
      instanceId: this.ensureLocalInstanceId(),
      listenUrl: this.listenUrl,
      unavailableReason: this.gatewayListenerError,
    });
    if (
      config.mode === "client" ||
      config.mode === "dual"
    ) {
      // An auth-class failure (bad pin, revoked enrollment, version
      // skew) is terminal until the operator re-pairs — reporting it as
      // "connecting" hides the problem behind an infinite retry loop.
      health.status = this.client
        ? "connected"
        : this.lastConnectionFailureKind === "auth"
          ? "rejected"
          // A "replaced" eviction will reconnect (and evict the sibling
          // back) — degraded, not a clean connecting/disconnected, so
          // the panel surfaces the duplicate-identity explanation.
          : this.lastConnectionFailureKind === "replaced"
            ? "degraded"
            : this.reconnectTimer
              ? "connecting"
              : "disconnected";
      health.unavailableReason = this.lastConnectionError;
      const endpoints =
        this.configuredEndpoints.length > 0
          ? this.configuredEndpoints
          : config.gatewayEndpoints;
      health.gatewayEndpoints = endpoints.map((url) => ({
        url,
        state: "idle",
        ...this.endpointStatuses.get(url),
      }));
    }
    if (this.gatewayListenerError) {
      health.status = "degraded";
      health.unavailableReason = this.gatewayListenerError;
    }
    // Prefer the configured endpoint list: a profile that only ever used
    // multi-path endpoints has no legacy `gateway_url`, and the enrollment
    // card would otherwise show a paired gateway with no address.
    health.clientEnrollment = this.readClientEnrollment(
      config.gatewayEndpoints[0],
    );
    health.localCelestialIcon = this.activeCelestialAssignments().find(
      (assignment) => assignment.instanceId === health.instanceId,
    )?.icon;
    // Resolved from settings rather than `this.instanceLabel` so the label
    // is correct even before the runtime has started (federation disabled,
    // or health read during boot).
    health.localLabel =
      config.instanceLabel || defaultInstanceLabel();
    health.localProfileName = isAppStateInitialized()
      ? getAppStateDb().getMeta("profile_name") || undefined
      : undefined;
    // A live holder elsewhere keeps this instance's federation runtime
    // stopped; surface that (with the holder's identity while it is still
    // live) the same way the messaging lease does, instead of a bare
    // "disconnected".
    const federationLeaseSnapshot = isAppStateInitialized()
      ? getExistingRuntimeFederationLeaseCoordinator()?.snapshot()
      : undefined;
    applyFederationLeaseSnapshot(health, federationLeaseSnapshot);
    return health;
  }

  private readClientEnrollment(
    configuredGatewayUrl: string,
  ): FederationHealthStatus["clientEnrollment"] {
    if (!isAppStateInitialized()) return undefined;
    const stateDb = getAppStateDb();
    const gatewayInstanceId = stateDb.getMeta(GATEWAY_INSTANCE_ID_META_KEY);
    if (!gatewayInstanceId) return undefined;
    const enrolledAtRaw = stateDb.getMeta(GATEWAY_ENROLLED_AT_META_KEY);
    const enrolledAt = enrolledAtRaw ? Number(enrolledAtRaw) : Number.NaN;
    return {
      gatewayInstanceId,
      gatewayUrl: configuredGatewayUrl || undefined,
      enrolledAt: Number.isFinite(enrolledAt) ? enrolledAt : undefined,
      pendingInvite: Boolean(stateDb.getMeta(PENDING_INVITE_TOKEN_META_KEY)),
    };
  }

  /**
   * Forget the client-side pairing: drop the pinned gateway identity,
   * signing key, Noise key, and any pending invite token, then restart
   * the runtime. A client-only instance falls back to disabled mode so
   * it does not sit in a doomed reconnect loop against nothing.
   */
  async resetEnrollment(
    request?: ResetFederationEnrollmentRequest,
  ): Promise<{ cleared: boolean }> {
    const stateDb = getAppStateDb();
    const hadEnrollment = Boolean(
      stateDb.getMeta(GATEWAY_INSTANCE_ID_META_KEY),
    );
    stateDb.setMeta(GATEWAY_INSTANCE_ID_META_KEY, "");
    stateDb.setMeta(GATEWAY_PUBLIC_KEY_META_KEY, "");
    stateDb.setMeta(GATEWAY_NOISE_PUBLIC_KEY_META_KEY, "");
    stateDb.setMeta(PENDING_INVITE_TOKEN_META_KEY, "");
    stateDb.setMeta(GATEWAY_ENROLLED_AT_META_KEY, "");
    // The endpoint list and its last-good memory belong to the pairing being
    // forgotten. Leaving them behind would keep a dual-mode instance dialing
    // the forgotten gateway with no pins left to satisfy it.
    stateDb.setMeta(GATEWAY_LAST_ENDPOINT_META_KEY, "");
    const settingsService = getDesktopSettingsService();
    const mode = this.readRuntimeConfig().mode;
    if (mode === "client" || mode === "disabled") {
      // A pure client's own key material only matters to the gateway it
      // just forgot, so drop it too. This is the documented recovery when
      // the stored keys became undecryptable (keychain identity change):
      // the next enrollment mints fresh keys and the new invite pins
      // them. Gateway/dual instances keep their keys — enrolled clients
      // pinned them.
      await settingsService.clearSecret("federationInstancePrivateKey");
      await settingsService.clearSecret("federationNoiseStaticPrivateKey");
    }
    await settingsService.writeConfigPatchTargeted({
      federation: {
        gatewayUrl: "",
        gatewayEndpoints: [],
        ...(mode === "client" ? { mode: "disabled" as const } : {}),
      },
    });
    // The forgotten federation's icon map goes with it: peer entries are
    // meaningless outside that federation and would otherwise occupy icons
    // in whatever federation this instance joins next. The local entry
    // stays so this machine's own mark survives the reset.
    //
    // Deliberately a hard delete, not a tombstone: this is local amnesia
    // about a federation we are leaving, not an authoritative statement
    // about those instances (which keep their icons among themselves). A
    // dual instance's still-connected downstream clients therefore re-add
    // their own entries on the next broadcast, which is the correct
    // outcome — only the forgotten upstream's peers stay gone.
    const celestialMap = this.celestialAssignmentMap();
    const localInstanceId = this.ensureLocalInstanceId();
    let celestialChanged = false;
    for (const instanceId of [...celestialMap.keys()]) {
      if (instanceId === localInstanceId) continue;
      celestialMap.delete(instanceId);
      celestialChanged = true;
    }
    if (celestialChanged) {
      this.persistCelestialAssignments();
      this.publishCelestialIconsChanged();
    }
    // Every pinned instance reachable only through the forgotten gateway
    // goes with it, not just the gateway's own threads — those rows are
    // exactly as unreachable, and leaving them behind was the gap in the
    // first cut of this cleanup.
    const pinDisposition = request?.pinDisposition ?? "remember";
    const pinCountsByInstance = await getDesktopOverlayStore()
      .countRemoteThreadPinsByInstance();
    for (const instanceId of this.enrollmentScopedPinInstanceIds(
      pinCountsByInstance,
    )) {
      await this.cleanupRemoteThreadPins(instanceId, pinDisposition);
    }
    await this.restart();
    return { cleared: hadEnrollment };
  }

  async diagnostics(request: {
    limit?: number;
    peerId?: FederationInstanceId;
  }): Promise<{
    health: FederationHealthStatus;
    events: FederationDiagnosticEvent[];
  }> {
    return {
      health: await this.health(),
      events: this.store().listAudit(request).map((entry) => ({
        ...entry,
        detail: entry.detail
          ? redactFederationDiagnostic(entry.detail)
          : undefined,
      })),
    };
  }

  async revokePeer(
    peerId: FederationInstanceId,
    request?: { pinDisposition?: FederationPinDisposition },
  ): Promise<FederationPeerSummary> {
    const store = this.store();
    const peer = store.getPeer(peerId);
    if (!peer) {
      throw new Error("Federation peer is not enrolled.");
    }
    const revokedAt = Date.now();
    store.revokePeer(peerId, revokedAt);
    this.server?.closePeer(peerId);
    this.unregisterPeer(peerId);
    this.remotePeerDirectory.delete(peerId);
    this.publishPeerStatus(peerId, "revoked");
    this.broadcastPeerDirectory();
    // Free the revoked instance's celestial icon and propagate the removal
    // so it cannot squat one of the five ids forever.
    this.removeCelestialAssignment(peerId, revokedAt);
    await this.cleanupRemoteThreadPins(
      peerId,
      request?.pinDisposition ?? "remember",
      revokedAt,
    );
    return publicPeerSummary({
      ...peer,
      status: "revoked",
      revokedAt,
    });
  }

  /**
   * Put away (or discard) one instance's pinned rows. They must stop
   * rendering either way: unlike a peer that is merely offline, a revoked
   * instance is unreachable FOR CAUSE, so leaving the rows to dim would be
   * noise the operator cannot act on.
   *
   * `remember` tombstones, and is the default. Revoking a peer and
   * re-enrolling it to clear up a problem is a routine repair, and hard
   * deletion would make the operator re-find and re-pin every thread each
   * time. `forget` is reserved for the operator explicitly asking to
   * discard. Best-effort throughout: pin bookkeeping must never block or
   * fail the revocation itself.
   */
  private async cleanupRemoteThreadPins(
    instanceId: FederationInstanceId,
    disposition: FederationPinDisposition,
    revokedAt?: number,
  ): Promise<void> {
    try {
      this.remoteThreadSummaryCache?.invalidate(instanceId);
      const overlayStore = getDesktopOverlayStore();
      const affected =
        disposition === "forget"
          ? await overlayStore.removeRemoteThreadPinsForInstance({ instanceId })
          : await overlayStore.tombstoneRemoteThreadPinsForInstance({
              instanceId,
              revokedAt,
            });
      if (affected === 0) {
        return;
      }
      log.info("remote thread pins cleaned up after revocation", {
        instanceId,
        disposition,
        affected,
      });
      await getDesktopBackendRegistry().publishLocalEvent({
        backend: "codex",
        notification: {
          method: "navigation/remoteThreadPins/changed",
          params: { instanceId, pinned: false },
        },
      });
    } catch (error) {
      log.warn("remote thread pin cleanup failed", {
        instanceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * A peer that connects again has been re-enrolled (federation policy
   * refuses revoked peers), so its tombstoned pins are live again. This is
   * the payoff for tombstoning: the revoke → fix → re-enroll cycle returns
   * the operator's curated list without them lifting a finger.
   */
  private async restoreRemoteThreadPins(
    instanceId: FederationInstanceId,
  ): Promise<void> {
    try {
      const restored = await getDesktopOverlayStore()
        .restoreRemoteThreadPinsForInstance({ instanceId });
      if (restored === 0) {
        return;
      }
      this.remoteThreadSummaryCache?.invalidate(instanceId);
      log.info("remote thread pins restored after re-enrollment", {
        instanceId,
        restored,
      });
      await getDesktopBackendRegistry().publishLocalEvent({
        backend: "codex",
        notification: {
          method: "navigation/remoteThreadPins/changed",
          params: { instanceId, pinned: true },
        },
      });
    } catch (error) {
      log.warn("remote thread pin restore failed", {
        instanceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * How many pinned threads a pending revoke / forget would affect, so the
   * renderer can skip the keep-or-forget prompt entirely when the operator
   * has nothing pinned from the affected instances.
   */
  async readRemoteThreadPinImpact(
    request: ReadFederationPinImpactRequest,
  ): Promise<ReadFederationPinImpactResponse> {
    const countsByInstance = await getDesktopOverlayStore()
      .countRemoteThreadPinsByInstance();
    const instanceIds =
      request.scope.kind === "peer"
        ? [request.scope.peerId]
        : this.enrollmentScopedPinInstanceIds(countsByInstance);
    let pinnedThreadCount = 0;
    let tombstonedThreadCount = 0;
    const instanceLabels: string[] = [];
    let visible: FederationPeerSummary[];
    try {
      visible = this.visiblePeers();
    } catch {
      visible = [];
    }
    for (const instanceId of instanceIds) {
      const counts = countsByInstance.get(instanceId);
      if (!counts) {
        continue;
      }
      pinnedThreadCount += counts.live;
      tombstonedThreadCount += counts.revoked;
      const peer = visible.find((candidate) => candidate.id === instanceId);
      instanceLabels.push(
        peer ? formatFederationPeerDisplayLabel(peer, visible) : instanceId,
      );
    }
    return { pinnedThreadCount, tombstonedThreadCount, instanceLabels };
  }

  /**
   * Instances whose pins a "forget gateway pairing" would affect: the
   * gateway itself plus every pinned instance this viewer reaches only
   * THROUGH it. A directly connected peer (a dual instance's own enrolled
   * client) survives the upstream reset, so its pins must not be touched —
   * the same reasoning `resetEnrollment` applies to celestial icons.
   */
  private enrollmentScopedPinInstanceIds(
    countsByInstance: ReadonlyMap<string, unknown>,
  ): FederationInstanceId[] {
    return [...countsByInstance.keys()].filter(
      (instanceId) => !this.router?.getConnection(instanceId),
    );
  }

  async generateInvite(request: {
    label?: string;
    ttlMs?: number;
    /**
     * Reads the tailnet identity to advertise. Injected by the caller because
     * the Tailscale service reaches back into this runtime to verify the
     * listener, so reading it from here would close a dependency cycle. It
     * stays a thunk so an operator who pinned an explicit advertised list
     * never pays for a Tailscale CLI spawn whose result is discarded.
     */
    readTailscaleAdvertisement?: () => Promise<
      FederationTailscaleAdvertisement | undefined
    >;
  }): Promise<{ invite: string; expiresAt: number }> {
    const config = this.readRuntimeConfig();
    const mode = config.mode;
    if (mode !== "gateway" && mode !== "dual") {
      throw new Error(
        "Invites are issued by the gateway. Switch Mode to gateway or dual first.",
      );
    }
    const advertisedEndpoints = config.advertisedEndpoints;
    const gatewayEndpoints =
      advertisedEndpoints.length > 0
        ? advertisedEndpoints
        : await this.defaultAdvertisedEndpoints(
            config,
            request.readTailscaleAdvertisement,
          );
    const gatewayUrl = gatewayEndpoints[0];
    if (!gatewayUrl) {
      throw new Error("Federation gateway URL is not configured.");
    }
    const now = Date.now();
    const expiresAt = now + Math.max(60_000, Math.min(request.ttlMs ?? 3_600_000, 86_400_000));
    const gatewayIdentity = await getDesktopSettingsService()
      .getOrCreateFederationIdentityKeyPair();
    const noise =
      await getDesktopSettingsService().getOrCreateFederationNoiseStaticKeyPair();
    const entry = createFederationEnrollmentInvite({
      store: this.store(),
      token: randomBytes(24).toString("base64url"),
      gatewayInstanceId: this.ensureLocalInstanceId(),
      generatedAt: now,
      expiresAt,
      label: request.label,
      role: "client",
      endpoint: gatewayUrl,
    });
    return {
      invite: encodeFederationInvite({
        version: FEDERATION_INVITE_VERSION,
        token: entry.token,
        gatewayInstanceId: this.ensureLocalInstanceId(),
        gatewayPublicKeyPem: gatewayIdentity.publicKeyPem,
        gatewayUrl,
        gatewayEndpoints: [...gatewayEndpoints],
        gatewayNoisePublicKey: noise.publicKeyBase64,
        expiresAt,
      }),
      expiresAt,
    };
  }

  /**
   * Endpoints for an invite when the operator has pinned no advertised list.
   *
   * Synthesized from names that follow the machine rather than from whatever
   * address it happens to hold today — an invite outlives a DHCP lease, and a
   * literal that has since moved leaves every enrolled client dialing a
   * stranger. See federation-advertised-endpoints.ts for the ordering rules.
   */
  private async defaultAdvertisedEndpoints(
    config: FederationRuntimeConfig,
    readTailscaleAdvertisement?: () => Promise<
      FederationTailscaleAdvertisement | undefined
    >,
  ): Promise<string[]> {
    const publicUrl = config.publicUrl;
    if (!publicUrl && !this.listenUrl) {
      // Nothing designated a URL and no listener is up to name. Minting an
      // invite here would hand a peer endpoints that cannot answer until the
      // bind is repaired — most often another instance already holds the port,
      // since every profile defaults to the same one. Say that instead.
      throw new Error(
        this.gatewayListenerError
          ? `Federation gateway is not listening: ${this.gatewayListenerError}`
          : "Federation gateway is not listening yet. Wait for it to start, or set a Public URL.",
      );
    }
    const tailscale = await readTailscaleAdvertisement?.();
    const endpoints = buildFederationAdvertisedEndpoints({
      listenHost: config.listenHost,
      listenPort: config.listenPort,
      hostname: hostname(),
      platform: process.platform,
      interfaceAddresses: collectFederationInterfaceAddresses(),
      ...(publicUrl ? { publicUrl } : {}),
      ...(tailscale ? { tailscale } : {}),
    });
    if (endpoints.length > 0) return endpoints;
    // Nothing on this machine produced a usable candidate (an unusable
    // hostname on a listener bound to a wildcard with no external address).
    // The listener URL is wrong for a remote peer, but a caller that can see
    // it can still repair it by hand, which beats an invite with no endpoint.
    const fallbackUrl = publicUrl || this.listenUrl;
    return fallbackUrl ? [fallbackUrl] : [];
  }

  async importInvite(invite: string): Promise<{
    accepted: boolean;
    gatewayInstanceId: FederationInstanceId;
    gatewayUrl: string;
    gatewayEndpoints: string[];
  }> {
    const payload = decodeFederationInvite(invite);
    const stateDb = getAppStateDb();
    stateDb.setMeta(GATEWAY_INSTANCE_ID_META_KEY, payload.gatewayInstanceId);
    stateDb.setMeta(GATEWAY_PUBLIC_KEY_META_KEY, payload.gatewayPublicKeyPem);
    stateDb.setMeta(
      GATEWAY_NOISE_PUBLIC_KEY_META_KEY,
      payload.gatewayNoisePublicKey,
    );
    // A new gateway identity invalidates any endpoint memory from before.
    stateDb.setMeta(GATEWAY_LAST_ENDPOINT_META_KEY, "");
    stateDb.setMeta(PENDING_INVITE_TOKEN_META_KEY, payload.token);
    stateDb.setMeta(GATEWAY_ENROLLED_AT_META_KEY, String(Date.now()));
    // Importing on a listening instance must not silently kill its
    // listener: gateway/dual become dual, everything else becomes client.
    const currentMode = this.readRuntimeConfig().mode;
    const gatewayEndpoints = payload.gatewayEndpoints ?? [payload.gatewayUrl];
    await getDesktopSettingsService().writeConfigPatchTargeted({
      federation: {
        mode:
          currentMode === "gateway" || currentMode === "dual"
            ? "dual"
            : "client",
        gatewayUrl: payload.gatewayUrl,
        gatewayEndpoints,
      },
    });
    await this.restart();
    return {
      accepted: true,
      gatewayInstanceId: payload.gatewayInstanceId,
      gatewayUrl: payload.gatewayUrl,
      gatewayEndpoints,
    };
  }

  remoteBackend(target: FederationRemoteTarget): FederationRemoteBackendClient {
    return new FederationRemoteBackendClient(
      this.rpcFor(target),
      async (response) =>
        await this.hydrateThreadMessageOrigins(
          rewriteFederatedTranscriptImageUrlsForRenderer(
            response,
            target.instanceId,
          ),
          target.instanceId,
        ),
      async (input) => {
        if (!hasFederationTurnInputAttachments(input)) {
          return [...input];
        }
        if (
          !this.remotePeerAdvertisesCapability(
            target.instanceId,
            "turn_input_blobs",
          )
        ) {
          throw new Error(
            `Federation instance ${target.instanceId} does not support binary turn attachments.`,
          );
        }
        return await prepareOutgoingFederationTurnInput({
          input,
          localInstanceId: this.ensureLocalInstanceId(),
          targetInstanceId: target.instanceId,
          privateStorageRoots:
            getDesktopBackendRegistry().getLocalFilePrivateStorageRoots(),
          sendEnvelope: async (envelope) =>
            await this.sendEnvelopeToTargetWithBackpressure(
              target.instanceId,
              envelope,
            ),
        });
      },
    );
  }

  hydrateLiveThreadMessageOrigin(event: AgentEvent): AgentEvent {
    if (
      event.notification.method !== "item/started"
      && event.notification.method !== "item/completed"
    ) {
      return event;
    }
    const notificationParams = event.notification.params as Record<string, unknown>;
    const itemValue = notificationParams.item;
    if (
      !itemValue
      || typeof itemValue !== "object"
      || Array.isArray(itemValue)
    ) {
      return event;
    }
    const item = itemValue as Record<string, unknown>;
    const originValue = item.origin;
    if (
      item.type !== "userMessage"
      || !originValue
      || typeof originValue !== "object"
      || Array.isArray(originValue)
    ) {
      return event;
    }
    const origin = originValue as Record<string, unknown>;
    const sourceThreadValue = origin.sourceThread;
    if (
      !sourceThreadValue
      || typeof sourceThreadValue !== "object"
      || Array.isArray(sourceThreadValue)
    ) {
      return event;
    }
    const sourceThread = sourceThreadValue as Record<string, unknown>;
    if (typeof sourceThread.instanceId !== "string") {
      return event;
    }
    const instance = this.resolveThreadMessageOriginInstance(
      sourceThread.instanceId,
    );
    if (!instance) {
      return event;
    }
    const {
      celestialIcon: _callerCelestialIcon,
      instanceLabel: _callerInstanceLabel,
      ...trustedSourceThread
    } = sourceThread;

    return {
      ...event,
      notification: {
        ...event.notification,
        params: {
          ...notificationParams,
          item: {
            ...item,
            origin: {
              ...origin,
              sourceThread: {
                ...trustedSourceThread,
                instanceLabel: instance.label,
                ...(instance.celestialIcon
                  ? { celestialIcon: instance.celestialIcon }
                  : {}),
              },
            },
          },
        },
      },
    } as AgentEvent;
  }

  private resolveThreadMessageOriginInstance(
    instanceId: FederationInstanceId,
  ): { label: string; celestialIcon?: CelestialIconId } | undefined {
    let visible: FederationPeerSummary[] = [];
    try {
      visible = this.visiblePeers();
    } catch {
      // Early boot tests may not have initialized the app-state DB yet.
    }
    let peer = visible.find((candidate) => candidate.id === instanceId);
    if (!peer) {
      try {
        peer = this.store().getPeer(instanceId);
      } catch {
        // A source id remains actionable even when peer metadata is gone.
      }
    }
    return peer
      ? {
          label: formatFederationPeerDisplayLabel(peer, visible),
          celestialIcon:
            this.celestialIconFor(instanceId) ?? peer.celestialIcon,
        }
      : undefined;
  }

  async hydrateThreadMessageOrigins(
    response: AppServerReadThreadResponse,
    ownerInstanceId = this.ensureLocalInstanceId(),
  ): Promise<AppServerReadThreadResponse> {
    return await hydrateFederatedThreadMessageOrigins({
      localInstanceId: this.ensureLocalInstanceId(),
      ownerInstanceId,
      response,
      resolveInstance: (instanceId) =>
        this.resolveThreadMessageOriginInstance(instanceId),
      resolveThread: async (source) => {
        const resolveOnInstance = async (instanceId: FederationInstanceId) => {
          if (instanceId === this.ensureLocalInstanceId()) {
            return await getDesktopBackendRegistry().resolveThread({
              backend: source.backend,
              threadId: source.threadId,
            });
          }
          return (
            await new FederationRemoteBackendClient(
              this.rpcFor({ scope: "remote", instanceId }),
            ).resolveThread({
              backend: source.backend,
              threadId: source.threadId,
            })
          ).thread;
        };
        const preferred = await resolveOnInstance(source.instanceId).catch(
          () => undefined,
        );
        if (preferred) {
          return { instanceId: source.instanceId, thread: preferred };
        }
        if (!source.discoverAcrossInstances) {
          return undefined;
        }

        const candidateInstanceIds = new Set<FederationInstanceId>([
          this.ensureLocalInstanceId(),
          ...this.connectedPeerTargets()
            .filter((peer) => peer.capabilities.includes("thread_navigation"))
            .map((peer) => peer.target.instanceId),
        ]);
        candidateInstanceIds.delete(source.instanceId);
        const matches = (
          await Promise.all(
            [...candidateInstanceIds].map(async (instanceId) => {
              const thread = await resolveOnInstance(instanceId).catch(
                () => undefined,
              );
              return thread ? { instanceId, thread } : undefined;
            }),
          )
        ).filter(
          (match): match is {
            instanceId: FederationInstanceId;
            thread: AppServerThreadSummary;
          } => Boolean(match),
        );
        return matches.length === 1 ? matches[0] : undefined;
      },
    });
  }

  /**
   * The same backend-operations surface {@link remoteBackend} exposes for a
   * peer, served by this instance. Lets callers (the federation agent tools)
   * treat local and remote targets uniformly.
   */
  localBackend(): FederationBackendOperations {
    return localBackendOperations();
  }

  /**
   * Viewer-side control client for a peer's remote PTY sessions. Streamed
   * output/exit/error frames arrive via {@link onRemotePtyEvent}.
   */
  remotePty(target: FederationRemoteTarget): FederationRemotePtyOperations {
    return new FederationRemotePtyClient(this.rpcFor(target));
  }

  onRemotePtyEvent(
    listener: (event: FederationPtyStreamEvent) => void,
  ): () => void {
    this.remotePtyEventListeners.add(listener);
    return () => {
      this.remotePtyEventListeners.delete(listener);
    };
  }

  private rpcFor(target: FederationRemoteTarget): FederationRpcEndpoint {
    if (!isRemoteFederationTarget(target)) {
      throw new Error("Federation target is not remote.");
    }
    let rpc = this.rpcByPeer.get(target.instanceId);
    if (!rpc) {
      rpc = new FederationRpcEndpoint({
        localInstanceId: this.ensureLocalInstanceId(),
        remoteInstanceId: target.instanceId,
        sendEnvelope: (envelope) => {
          this.sendEnvelopeToTarget(target.instanceId, envelope);
        },
      });
      this.rpcByPeer.set(target.instanceId, rpc);
    }
    return rpc;
  }

  async remoteNavigationSnapshot(
    target: FederationRemoteTarget,
    request: Pick<GetNavigationSnapshotRequest, "backend" | "filter">,
    selectionOverride?: FederationThreadSelection,
    rpcOptions?: FederationRpcRequestOptions,
  ): Promise<NavigationSnapshot> {
    const backend = this.remoteBackend(target);
    const snapshotRequest = {
      backend: request.backend,
      filter: request.filter,
    };
    if (
      typeof backend.getNavigationSnapshotTransport !== "function"
      || !this.remotePeerAdvertisesCapability(
        target.instanceId,
        "navigation_snapshot_deltas",
      )
    ) {
      const startedAt = Date.now();
      const legacyResponse = rpcOptions
        ? await backend.getNavigationSnapshot(snapshotRequest, rpcOptions)
        : await backend.getNavigationSnapshot(snapshotRequest);
      this.logRemoteNavigationWireResponse({
        target,
        startedAt,
        response: legacyResponse,
        selection: "legacy-all",
      });
      return await this.stampRemoteNavigationSnapshot(
        target,
        projectNavigationSnapshot(
          normalizeNavigationSnapshotThreadKeys(
            legacyResponse,
          ),
          snapshotRequest,
        ),
      );
    }
    const desiredThreadSelection = this.desiredThreadSelectionFor(
      target.instanceId,
    );
    const threadSelection =
      desiredThreadSelection
      && selectionOverride
      && !federationThreadSelectionIncludes(
        desiredThreadSelection,
        selectionOverride,
      )
        ? selectionOverride
        : desiredThreadSelection ?? selectionOverride ?? { kind: "all" };
    const selection = transportSelectionFor(threadSelection);
    const selectionKey = federationThreadSelectionKey(threadSelection);
    const previousTransportState = this.remoteNavigationTransportStateFor(
      target.instanceId,
      selectionKey,
    );
    let startedAt = Date.now();
    const transportRequest: GetNavigationSnapshotTransportRequest = {
      transport: {
        protocol: 1,
        selection,
        ...(previousTransportState
          ? { baseRevision: previousTransportState.revision }
          : {}),
      },
    };
    let transportResponse = rpcOptions
      ? await backend.getNavigationSnapshotTransport(
          transportRequest,
          rpcOptions,
        )
      : await backend.getNavigationSnapshotTransport(transportRequest);
    this.logRemoteNavigationWireResponse({
      target,
      startedAt,
      response: transportResponse,
      selection: selection.kind,
    });
    if ("threads" in transportResponse) {
      return await this.stampRemoteNavigationSnapshot(
        target,
        projectNavigationSnapshot(
          normalizeNavigationSnapshotThreadKeys(transportResponse),
          snapshotRequest,
        ),
      );
    }
    let nextTransportState = applyNavigationSnapshotTransportResponse(
      previousTransportState,
      transportResponse,
    );
    if (!nextTransportState) {
      startedAt = Date.now();
      const baselineRequest: GetNavigationSnapshotTransportRequest = {
        transport: { protocol: 1, selection },
      };
      transportResponse = rpcOptions
        ? await backend.getNavigationSnapshotTransport(
            baselineRequest,
            rpcOptions,
          )
        : await backend.getNavigationSnapshotTransport(baselineRequest);
      this.logRemoteNavigationWireResponse({
        target,
        startedAt,
        response: transportResponse,
        selection: selection.kind,
      });
      if ("threads" in transportResponse) {
        return await this.stampRemoteNavigationSnapshot(
          target,
          projectNavigationSnapshot(
            normalizeNavigationSnapshotThreadKeys(transportResponse),
            snapshotRequest,
          ),
        );
      }
      nextTransportState = applyNavigationSnapshotTransportResponse(
        undefined,
        transportResponse,
      );
    }
    if (!nextTransportState) {
      throw new Error(
        "Federation navigation snapshot transport did not provide a recoverable baseline.",
      );
    }
    this.cacheRemoteNavigationTransportState(
      target.instanceId,
      selectionKey,
      nextTransportState,
    );
    const response = projectNavigationSnapshot(
      normalizeNavigationSnapshotThreadKeys(nextTransportState.snapshot),
      snapshotRequest,
    );
    return await this.stampRemoteNavigationSnapshot(target, response);
  }

  private remoteNavigationTransportStateFor(
    peerId: FederationInstanceId,
    selectionKey: string,
  ): NavigationSnapshotTransportState | undefined {
    const selections = this.remoteNavigationTransportByPeer.get(peerId);
    const state = selections?.get(selectionKey);
    if (!state || !selections) return undefined;
    selections.delete(selectionKey);
    selections.set(selectionKey, state);
    return state;
  }

  private cacheRemoteNavigationTransportState(
    peerId: FederationInstanceId,
    selectionKey: string,
    state: NavigationSnapshotTransportState,
  ): void {
    let selections = this.remoteNavigationTransportByPeer.get(peerId);
    if (!selections) {
      selections = new Map();
      this.remoteNavigationTransportByPeer.set(peerId, selections);
    }
    selections.delete(selectionKey);
    selections.set(selectionKey, state);
    if (selections.size <= REMOTE_NAVIGATION_SELECTION_CACHE_LIMIT) return;
    const leastRecentlyUsedSelection = selections.keys().next().value;
    if (leastRecentlyUsedSelection !== undefined) {
      selections.delete(leastRecentlyUsedSelection);
    }
  }

  private logRemoteNavigationWireResponse(params: {
    target: FederationRemoteTarget;
    startedAt: number;
    response: NavigationSnapshot | NavigationSnapshotTransportResponse;
    selection: string;
  }): void {
    const durationMs = Date.now() - params.startedAt;
    const responseKind = "threads" in params.response
      ? "legacy-full"
      : params.response.kind;
    const threadCount = navigationWireResponseThreadCount(params.response);
    // Exact size requires serialization. Avoid adding that work to ordinary
    // small responses; a large collection or an already-slow response earns
    // the diagnostic cost.
    if (durationMs < 1_000 && threadCount < 500) {
      return;
    }
    const responseBytes = Buffer.byteLength(
      JSON.stringify(params.response),
      "utf8",
    );
    if (durationMs < 1_000 && responseBytes < 512 * 1024) {
      return;
    }
    log.info("remote navigation wire response was slow or large", {
      durationMs,
      instanceId: params.target.instanceId,
      responseBytes,
      responseKind,
      selection: params.selection,
      threadCount,
    });
  }

  private remotePeerAdvertisesCapability(
    instanceId: FederationInstanceId,
    capability: FederationCapability,
  ): boolean {
    let visiblePeer: FederationPeerSummary | undefined;
    try {
      visiblePeer = this.visiblePeers().find(
        (candidate) => candidate.id === instanceId,
      );
    } catch {
      // Direct connection metadata remains available during early boot and
      // in store-injected harnesses where the app-state database is absent.
    }
    return this.viewerCapabilitiesFor(instanceId, visiblePeer).includes(
      capability,
    );
  }

  private async stampRemoteNavigationSnapshot(
    target: FederationRemoteTarget,
    response: NavigationSnapshot,
  ): Promise<NavigationSnapshot> {
    const stamped = this.stampRemoteNavigationThreads(target, response.threads);
    return {
      ...response,
      federationTarget: target,
      unchanged: false,
      threads: stamped.threads,
      inboxThreadKeys: response.inboxThreadKeys.map(
        (threadKey) =>
          stamped.threadKeyBySourceKey.get(threadKey) ?? threadKey,
      ),
      directories: response.directories.map((directory) => ({
        ...directory,
        threadKeys: directory.threadKeys.map(
          (threadKey) =>
            stamped.threadKeyBySourceKey.get(threadKey) ?? threadKey,
        ),
      })),
    };
  }

  private stampRemoteNavigationThreads(
    target: FederationRemoteTarget,
    responseThreads: readonly NavigationThreadSummary[],
  ): {
    threads: NavigationThreadSummary[];
    threadKeyBySourceKey: Map<string, string>;
  } {
    // visiblePeers reads the app-state db (local instance id); during
    // early boot or in store-injected test harnesses that db may be
    // absent — fall back to the bare store record (mirrors the menu's
    // peer-lookup guard in main/index.ts).
    let visible: FederationPeerSummary[];
    try {
      visible = this.visiblePeers();
    } catch {
      visible = [];
    }
    const visiblePeer = visible.find(
      (candidate) => candidate.id === target.instanceId,
    );
    const peer = visiblePeer ?? this.store().getPeer(target.instanceId);
    // Same composed label as connectedPeerTargets so search chips and
    // thread rows agree with the window title on multi-profile peers.
    const instanceLabel = peer
      ? formatFederationPeerDisplayLabel(peer, visible)
      : target.instanceId;
    const capabilities = this.viewerCapabilitiesFor(
      target.instanceId,
      visiblePeer,
    );
    const peerStatus = visiblePeer?.status ?? peer?.status;
    const threadKeyBySourceKey = new Map<string, string>();
    const threads = responseThreads.map((thread) => {
      const sourceKey = thread.federation?.ref
        ? federatedThreadIdentityKey(thread.federation.ref)
        : buildThreadIdentityKey(thread.source, thread.id);
      const existingOwner = thread.federation?.ref.target;
      const ownerInstanceId = existingOwner
        && isRemoteFederationTarget(existingOwner)
        ? existingOwner.instanceId
        : target.instanceId;
      const ownerVisiblePeer = visible.find(
        (candidate) => candidate.id === ownerInstanceId,
      );
      const ownerPeer =
        ownerVisiblePeer ?? this.store().getPeer(ownerInstanceId);
      const ownerLabel = ownerInstanceId === target.instanceId
        ? instanceLabel
        : ownerPeer
          ? formatFederationPeerDisplayLabel(ownerPeer, visible)
          : thread.federation?.instanceLabel ?? ownerInstanceId;
      const ref = buildFederatedThreadRef({
        backend: thread.source,
        instanceId: ownerInstanceId,
        threadId: thread.id,
      });
      threadKeyBySourceKey.set(
        sourceKey,
        federatedThreadIdentityKey(ref),
      );
      return {
        ...thread,
        federation: {
          ref,
          instanceLabel: ownerLabel,
          peerStatus:
            ownerInstanceId === target.instanceId
              ? peerStatus
              : ownerVisiblePeer?.status ?? ownerPeer?.status,
          capabilities:
            ownerInstanceId === target.instanceId
              ? capabilities
              : this.viewerCapabilitiesFor(ownerInstanceId, ownerVisiblePeer),
          celestialIcon: ownerVisiblePeer?.celestialIcon,
        },
      };
    });
    return { threads, threadKeyBySourceKey };
  }

  /**
   * The granted set the VIEWER can act on for a peer: the live connection's
   * capabilities for a direct peer, the gateway-advertised set for a relayed
   * one. Both are authoritative — PTY relays through gateways as of #1289,
   * so nothing is withheld from a relayed peer.
   *
   * Single source of truth for every viewer-side stamp — the live snapshot
   * rows AND the pinned-row fallback served from cache. Copying the rule
   * into the fallback path instead would let the two drift, and the drift
   * that matters is silent: a pinned row offering a capability the live row
   * refuses, or withholding one it grants. `connectedPeerTargets()` is NOT a
   * substitute — it only knows directly connected peers.
   */
  private viewerCapabilitiesFor(
    instanceId: FederationInstanceId,
    visiblePeer: FederationPeerSummary | undefined,
  ): FederationCapability[] {
    const directConnection = this.router?.getConnection(instanceId);
    return directConnection
      ? [...directConnection.capabilities]
      : [...(visiblePeer?.capabilities ?? [])];
  }

  /**
   * Stamped peer navigation summaries for bounded Cmd+K search, its
   * older-peer snapshot fallback, and the pinned-remote-thread merge.
   * Navigation-based (not `listThreads`) so remote rows carry PR chips and
   * share local matching semantics without sending a full snapshot per query.
   */
  remoteThreadSummaries(): RemoteThreadSummaryCache {
    this.remoteThreadSummaryCache ??= new RemoteThreadSummaryCache({
      peers: () => this.connectedPeerTargets(),
      fetchSnapshot: (target, selection, rpcOptions) =>
        this.remoteNavigationSnapshot(target, {}, selection, rpcOptions),
      searchPeer: async (target, request, rpcOptions) => {
        const startedAt = Date.now();
        const backend = this.remoteBackend(target);
        if (!backend.searchNavigationThreads) {
          const unavailable = new Error(
            "Remote peer does not support bounded navigation search.",
          ) as Error & { code?: string };
          unavailable.code = "method_not_found";
          throw unavailable;
        }
        try {
          const response = rpcOptions
            ? await backend.searchNavigationThreads(request, rpcOptions)
            : await backend.searchNavigationThreads(request);
          const durationMs = Date.now() - startedAt;
          if (durationMs >= 1_000) {
            const responseBytes = Buffer.byteLength(
              JSON.stringify(response),
              "utf8",
            );
            log.info("remote bounded navigation search was slow", {
              durationMs,
              instanceId: target.instanceId,
              queryLength: request.query.length,
              responseBytes,
              resultCount: response.results.length,
            });
          }
          return this.stampRemoteNavigationThreads(
            target,
            response.results,
          ).threads;
        } catch (error) {
          const durationMs = Date.now() - startedAt;
          const code =
            typeof error === "object"
            && error !== null
            && "code" in error
            && typeof error.code === "string"
              ? error.code
              : undefined;
          if (code !== "method_not_found" || durationMs >= 1_000) {
            log.warn("remote bounded navigation search failed", {
              code,
              durationMs,
              error: error instanceof Error ? error.message : String(error),
              instanceId: target.instanceId,
              queryLength: request.query.length,
            });
          }
          throw error;
        }
      },
      fetchArchivedThreads: async (target, backend) =>
        (
          await this.remoteBackend(target).listThreads({
            backend,
            archived: true,
          })
        ).threads,
      peerStatus: (instanceId) => {
        try {
          const visible = this.visiblePeers();
          const peer = visible.find((candidate) => candidate.id === instanceId);
          return peer
            ? {
                status: peer.status,
                label: formatFederationPeerDisplayLabel(peer, visible),
                celestialIcon: peer.celestialIcon,
                capabilities: this.viewerCapabilitiesFor(instanceId, peer),
              }
            : {};
        } catch {
          // Early boot: the app-state db backing visiblePeers may be absent.
          return {};
        }
      },
      onPeerInterestChanged: (interests) => {
        const byInstanceId = new Map(
          interests.map((interest) => [interest.instanceId, interest]),
        );
        this.setEventSubscriptions(
          REMOTE_THREAD_SUMMARY_EVENT_CONSUMER_ID,
          this.connectedPeerTargets()
            .filter(
              (peer) =>
                byInstanceId.has(peer.target.instanceId)
                && peer.capabilities.includes("event_subscriptions"),
            )
            .map((peer) => {
              const interest = byInstanceId.get(peer.target.instanceId)!;
              return {
                sourceInstanceId: peer.target.instanceId,
                eventClasses: ["navigation" as const],
                threadSelection: interest.threadSelection,
              };
            }),
        );
      },
      // Pinned-summary refreshes land in the background (the snapshot
      // merge never awaits a peer) — poke the renderer so its next
      // navigation refresh serves the fresh rows.
      onPinnedSummariesRefreshed: (instanceId) => {
        void getDesktopBackendRegistry()
          .publishLocalEvent({
            backend: "codex",
            notification: {
              method: "navigation/remoteThreadPins/changed",
              params: { instanceId },
            },
          })
          .catch((error: unknown) => {
            log.warn("remote pin summary refresh publish failed", {
              error: error instanceof Error ? error.message : String(error),
            });
          });
      },
    });
    return this.remoteThreadSummaryCache;
  }

  /**
   * Archiving a local group root must clear parent overlays on children owned
   * by other instances. Those relationships are visible here through the
   * root viewer's remote child pins; mutate each child on its owner, then
   * update the cached pin so restoring the root cannot reattach it.
   */
  async ungroupRemoteChildrenOfArchivedThread(params: {
    backend: AppServerBackendKind;
    parentThreadId: string;
  }): Promise<void> {
    const localInstanceId = (await this.health()).instanceId;
    if (!localInstanceId) {
      return;
    }
    const overlayStore = getDesktopOverlayStore();
    const pins = await overlayStore.listRemoteThreadPins();
    const children = pins.filter((pin) => {
      const summary = pin.summary;
      return summary?.parentThreadId === params.parentThreadId
        && (summary.parentThreadBackend ?? summary.source) === params.backend
        && summary.parentThreadInstanceId === localInstanceId
        && isRemoteFederationTarget(pin.ref.target);
    });
    if (children.length === 0) {
      return;
    }

    const refreshed: Array<{
      ref: FederatedThreadRef;
      summary: NavigationThreadSummary;
      instanceLabel: string;
    }> = [];
    await Promise.all(
      children.map(async (pin) => {
        if (!isRemoteFederationTarget(pin.ref.target) || !pin.summary) {
          return;
        }
        try {
          await this.remoteBackend(pin.ref.target).setThreadParent({
            backend: pin.ref.backend,
            threadId: pin.ref.threadId,
            parentThreadId: null,
          });
          const summary = { ...pin.summary };
          delete summary.parentThreadId;
          delete summary.parentThreadBackend;
          delete summary.parentThreadInstanceId;
          refreshed.push({
            ref: pin.ref,
            summary,
            instanceLabel: pin.instanceLabel,
          });
          this.remoteThreadSummaryCache?.invalidate(pin.ref.target.instanceId);
        } catch (error) {
          log.warn("failed to ungroup remote child after parent archive", {
            backend: pin.ref.backend,
            childInstanceId: pin.ref.target.instanceId,
            childThreadId: pin.ref.threadId,
            error: error instanceof Error ? error.message : String(error),
            parentThreadId: params.parentThreadId,
          });
        }
      }),
    );
    if (refreshed.length > 0) {
      await overlayStore.updateRemoteThreadPinSnapshots(refreshed);
    }
  }

  async searchConnectedPeers(
    request: FederatedSearchRequest,
  ): Promise<FederatedSearchResponse> {
    const service = new FederatedSearchService({
      includeLocal: false,
      local: localBackendOperations(),
      peers: () => {
        const visible = this.visiblePeers();
        return visible
          .filter(
            (peer) =>
              peer.status === "connected" &&
              peer.capabilities.includes("federated_search"),
          )
          .map((peer) => ({
            instanceId: peer.id,
            // Composed against the full visible set so multi-profile
            // machines keep distinct labels in search chips.
            label: formatFederationPeerDisplayLabel(peer, visible),
            status: peer.status,
            backend: this.remoteBackend({
              scope: "remote",
              instanceId: peer.id,
            }),
          }));
      },
    });
    return await service.search(request);
  }

  private async restartNow(): Promise<void> {
    await this.stop();
    const config = this.readRuntimeConfig();
    this.instanceLabel =
      config.instanceLabel || defaultInstanceLabel();
    this.instanceNotes = config.instanceNotes;
    try {
      this.localHostInfo = await collectFederationHostInfo();
    } catch {
      this.localHostInfo = undefined;
    }
    const mode = config.mode;
    // The profile-scoped lease decides which app instance may run federation
    // for this profile: instances sharing a profile present the same
    // federation instance identity, so without the lease two of them evict
    // each other from the gateway in a connect/replace loop.
    if (isAppStateInitialized()) {
      const leaseCoordinator = getRuntimeFederationLeaseCoordinator();
      const leaseGate = await leaseCoordinator.applyMode(this, mode);
      if (!leaseGate.enabled) {
        if (leaseGate.disabledReasonKind === "lease_held") {
          this.lastConnectionError = leaseGate.disabledReason;
        }
        return;
      }
      try {
        await this.startAfterLeaseAcquired(mode, config);
      } catch (error) {
        // A startup failure after acquisition (e.g. unreadable federation
        // key material) must not keep the profile lease with no runtime
        // behind it: release so another instance can take over,
        // mirroring the messaging lease's startup-failure cleanup.
        await leaseCoordinator.releaseAfterStartupFailure(this);
        throw error;
      }
      return;
    }
    if (mode === "disabled") {
      return;
    }
    await this.startAfterLeaseAcquired(mode, config);
  }

  private readRuntimeConfig(): FederationRuntimeConfig {
    return resolveFederationRuntimeConfig(
      getDesktopSettingsService().readFederationConfig(),
    );
  }

  private async startAfterLeaseAcquired(
    mode: DesktopFederationMode,
    config: FederationRuntimeConfig,
  ): Promise<void> {
    this.stopping = false;
    // Startup fence: a concurrent stop flips `stopping` and bumps `walkEpoch`.
    // A stale startup continuation must not create or publish sockets
    // afterwards (the same guard connectToGateway uses per attempt).
    const startupEpoch = this.walkEpoch;
    const startupAborted = (): boolean =>
      this.stopping || this.walkEpoch !== startupEpoch;

    const localInstanceId = this.ensureLocalInstanceId();
    const router = new FederationRouter({
      localInstanceId,
      trustedRelayPeerId: () =>
        this.gatewayInstanceId
        ?? (isAppStateInitialized()
          ? getAppStateDb().getMeta(GATEWAY_INSTANCE_ID_META_KEY) || undefined
          : undefined),
      methodCapabilities: {
        ...FEDERATION_BACKEND_METHOD_CAPABILITIES,
        ...FEDERATION_PTY_METHOD_CAPABILITIES,
      },
      additionalRequiredCapabilities: additionalFederationBackendCapabilities,
    });
    router.registerBlobChunkHandler(async (envelope) => {
      await this.turnInputAttachmentReceiver.receive(
        envelope,
        envelope.sourceInstanceId,
      );
    });
    this.ownedNavigationSnapshotTransport = registerFederationBackendHandlers({
      router,
      backend: localBackendOperations(),
      resolveTurnInput: async (input, sourceInstanceId) =>
        await this.turnInputAttachmentReceiver.resolveInput(
          input,
          sourceInstanceId,
        ),
      resolveSourceInstance: (instanceId) =>
        this.resolveThreadMessageOriginInstance(instanceId),
      onEnvironmentSetupProgress: (event, targetInstanceId) => {
        this.sendEnvironmentSetupProgress(event, targetInstanceId);
      },
    });
    this.ptyService = new FederationPtyService({
      spawnPty: async (params) => await spawnTerminalPty(params),
      resolveThreadCwd: async ({ backend, threadId }) => {
        // Owner-resolved shell + cwd from THIS instance's thread state; the
        // viewer never sends a path, so a compromised viewer cannot pick the
        // cwd or binary.
        const threads = await getDesktopBackendRegistry().listThreads({
          backend,
          callerReason: "federation-remote-pty",
        });
        const thread = threads.find((candidate) => candidate.id === threadId);
        if (!thread) {
          // Refuse rather than fall through to the home-directory default: a
          // shell should only ever open for a thread this instance actually
          // has. (A thread that exists but has no directory still gets the
          // same home fallback the local panel uses.)
          throw new Error(
            "Remote terminal thread was not found on the owning instance.",
          );
        }
        return resolveThreadTerminalCwd(thread);
      },
      sendNotification: (peerId, method, params) =>
        this.sendPtyNotification(peerId, method, params),
      onAudit: (entry) => {
        // The audit trail must show which machine drove the shell, not just
        // its opaque instance id.
        const label =
          this.store().getPeer(entry.peerId)?.label
          ?? this.remotePeerDirectory.get(entry.peerId)?.label
          ?? entry.peerId;
        this.store().appendAudit({
          peerId: entry.peerId,
          sessionId: entry.sessionId,
          kind: entry.kind,
          createdAt: Date.now(),
          detail: `${entry.detail} · ${label}`,
        });
      },
      log: {
        info: (message, meta) => log.info(message, meta),
        warn: (message, meta) => log.warn(message, meta),
      },
    });
    registerFederationPtyHandlers({ router, service: this.ptyService });
    this.router = router;
    this.subscribeLocalBackendEvents();

    const noise =
      await getDesktopSettingsService().getOrCreateFederationNoiseStaticKeyPair();
    if (startupAborted()) return;
    const noiseStatic = noiseKeyPairFromRawPrivate(
      Buffer.from(noise.privateKeyBase64, "base64"),
    );

    if (mode === "gateway" || mode === "dual") {
      const gatewayIdentity = await getDesktopSettingsService()
        .getOrCreateFederationIdentityKeyPair();
      if (startupAborted()) return;
      const server = new FederationGatewayWebSocketServer({
        gatewayInstanceId: localInstanceId,
        gatewayPrivateKeyPem: gatewayIdentity.privateKeyPem,
        gatewayPublicKeyPem: gatewayIdentity.publicKeyPem,
        host: config.listenHost,
        port: config.listenPort,
        store: this.store(),
        noiseStatic,
        onConnection: (connection) => this.registerGatewayConnection(connection),
        onDisconnect: (connection) => this.unregisterGatewayConnection(connection),
        onPeerReplaced: (info) => {
          if (info.duplicateInstanceIdSuspected) {
            this.duplicateIdentitySuspectedAt.set(info.peerId, Date.now());
          }
        },
        onEnvelope: (envelope, connection) =>
          void this.receiveEnvelope(envelope, connection.peerId),
        onEnvelopeTransfer: (info) => {
          this.transferLedger.record(info);
          this.activityLedger.record({
            ...info,
            localInstanceId: this.ensureLocalInstanceId(),
          });
        },
      });
      this.server = server;
      try {
        const started = await server.start();
        if (startupAborted()) {
          // The lease was lost while the listener was binding; tear down
          // the socket we just created instead of publishing it. stop()
          // may already have cleared this.server, so go through the local.
          if (this.server === server) this.server = undefined;
          await server.stop().catch(() => undefined);
          return;
        }
        this.listenUrl = started.url;
        log.info("federation gateway listening", { url: started.url });
      } catch (error) {
        this.gatewayListenerError = redactFederationDiagnostic(
          error instanceof Error ? error.message : String(error),
        );
        await server.stop().catch(() => undefined);
        if (this.server === server) this.server = undefined;
        log.error("federation gateway failed to listen", {
          error: this.gatewayListenerError,
        });
      }
    }

    if (mode === "client" || mode === "dual") {
      const configured = config.gatewayEndpoints;
      // Last line of defense before anything is dialed: the config file is
      // hand-editable and may predate the scheme allowlist.
      const endpoints = configured.filter(isFederationGatewayEndpointUrl);
      if (endpoints.length !== configured.length) {
        log.warn("ignoring federation endpoints with an unsupported scheme", {
          ignored: configured.length - endpoints.length,
        });
      }
      this.configuredEndpoints = endpoints;
      if (endpoints.length === 0) {
        this.lastConnectionError =
          configured.length > 0
            ? "No federation gateway endpoint uses a supported ws://, wss://, or ssh:// scheme."
            : "Federation gateway URL is not configured.";
      } else {
        await this.connectToGateway().catch((error) => {
          this.handleClientConnectionFailure(error);
        });
      }
    }
  }

  // One reconnect cycle: walk the configured endpoints (last-good first) and
  // stop at the first fully authenticated connection. Every endpoint runs the
  // identical pinned-identity + Noise handshake, so fallback can only change
  // reachability, never which gateway the client will trust.
  private async connectToGateway(): Promise<void> {
    const endpoints = this.configuredEndpoints;
    if (endpoints.length === 0) return;
    const lastGoodEndpoint =
      getAppStateDb().getMeta(GATEWAY_LAST_ENDPOINT_META_KEY) || undefined;
    const attempts = orderFederationEndpointAttempts(
      endpoints,
      lastGoodEndpoint,
    );
    // A restart during the walk flips `stopping` back to false, so `stopping`
    // alone would let a superseded walk keep dialing a stale endpoint list and
    // race the new one into `this.client`. `connectionGeneration` can't serve
    // here because connectClient bumps it per attempt; this epoch changes only
    // when the runtime is torn down.
    const walkEpoch = this.walkEpoch;
    let lastError: unknown;
    for (const endpoint of attempts) {
      if (this.stopping || this.walkEpoch !== walkEpoch) return;
      try {
        await this.connectClient(endpoint);
        return;
      } catch (error) {
        lastError = error;
        const rawMessage =
          error instanceof Error ? error.message : String(error);
        this.endpointStatuses.set(endpoint, {
          ...this.endpointStatuses.get(endpoint),
          state: "failed",
          lastError: redactFederationDiagnostic(rawMessage),
        });
        // Every endpoint authenticates against the SAME pinned gateway
        // identity, so an auth-class failure is a property of the pairing,
        // not of this path. Walking on would waste attempts and, worse, let
        // a later endpoint's network error mask a broken pin behind an
        // endless "connecting" retry instead of surfacing as "rejected".
        if (classifyFederationClientFailure(rawMessage) === "auth") {
          throw error;
        }
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(
          "Federation gateway is unreachable on every configured endpoint.",
        );
  }

  private async connectClient(gatewayUrl: string): Promise<void> {
    if (!gatewayUrl) return;
    this.endpointStatuses.set(gatewayUrl, {
      ...this.endpointStatuses.get(gatewayUrl),
      state: "connecting",
      lastAttemptAt: Date.now(),
    });
    const gatewayInstanceId = getAppStateDb().getMeta(GATEWAY_INSTANCE_ID_META_KEY);
    if (!gatewayInstanceId) {
      throw new Error("Federation client mode is missing its gateway identity.");
    }
    const gatewayPublicKeyPem = getAppStateDb().getMeta(GATEWAY_PUBLIC_KEY_META_KEY);
    if (!gatewayPublicKeyPem) {
      throw new Error("Federation client mode is missing its pinned gateway key.");
    }
    this.gatewayInstanceId = gatewayInstanceId;
    const gatewayNoisePublicKeyBase64 = getAppStateDb().getMeta(
      GATEWAY_NOISE_PUBLIC_KEY_META_KEY,
    );
    if (!gatewayNoisePublicKeyBase64) {
      throw new Error(
        "Federation client mode is missing its pinned gateway encryption key. Re-import the federation invite.",
      );
    }
    const pendingInviteToken = getAppStateDb().getMeta(PENDING_INVITE_TOKEN_META_KEY);
    const connectionMode = pendingInviteToken ? "enroll" : "reconnect";
    const keyPair = await getDesktopSettingsService()
      .getOrCreateFederationIdentityKeyPair();
    const settingsService = getDesktopSettingsService();
    const config = this.readRuntimeConfig();
    const cloudflareCredentials =
      await settingsService.resolveFederationCloudflareCredentials();
    const sshEndpoint = isFederationSshEndpointUrl(gatewayUrl)
      ? parseFederationSshEndpoint(gatewayUrl)
      : undefined;
    // Cloudflare edge credentials ride the WebSocket upgrade, which happens
    // BEFORE the Noise handshake pins anything. So they must be scoped to the
    // one host the operator designated as Cloudflare-fronted — not to "any
    // wss:// URL", which would hand the Access bearer token and the mTLS client
    // key to every TLS endpoint in the fallback list.
    const acceptsCloudflareCredentials =
      federationEndpointAcceptsCloudflareCredentials({
        endpoint: gatewayUrl,
        cloudflareEndpoint: config.cloudflareEndpoint,
        configuredEndpointCount: this.configuredEndpoints.length,
      });
    const cloudflareMtlsEnabled =
      acceptsCloudflareCredentials
      && config.cloudflareMtlsEnabled;
    const cloudflareAccessEnabled =
      acceptsCloudflareCredentials
      && config.cloudflareAccessServiceAuthEnabled;
    if (
      !acceptsCloudflareCredentials
      && (config.cloudflareMtlsEnabled
        || config.cloudflareAccessServiceAuthEnabled)
    ) {
      log.info("federation endpoint is not the designated Cloudflare endpoint", {
        withheldCredentials: true,
      });
    }
    if (
      cloudflareMtlsEnabled &&
      (!cloudflareCredentials.clientCertificate ||
        !cloudflareCredentials.clientPrivateKey)
    ) {
      throw new Error(
        "Cloudflare mTLS is enabled but the client certificate or private key is missing.",
      );
    }
    if (
      cloudflareAccessEnabled &&
      (!cloudflareCredentials.accessClientId ||
        !cloudflareCredentials.accessClientSecret)
    ) {
      throw new Error(
        "Cloudflare Access service auth is enabled but its credentials are missing.",
      );
    }
    const noise =
      await settingsService.getOrCreateFederationNoiseStaticKeyPair();
    this.gatewayUrl = gatewayUrl;
    const connectionGeneration = ++this.connectionGeneration;
    this.store().appendAudit({
      peerId: gatewayInstanceId,
      kind: "connect_attempt",
      createdAt: Date.now(),
      detail: connectionMode,
    });
    const clientSession: { id?: FederationSessionId } = {};
    // Node reports a failed ssh dial as a generic "socket hang up", so keep the
    // real cause (auth, host key, timeout) and report that instead.
    const sshFailure: { error?: Error } = {};
    const client = await connectFederationClient({
      url: sshEndpoint
        ? `ws://${sshEndpoint.forwardHost}:${sshEndpoint.forwardPort}`
        : gatewayUrl,
      createSocket: sshEndpoint
        ? () =>
            dialFederationSshEndpoint(sshEndpoint, {
              onFailure: (error) => {
                sshFailure.error ??= error;
              },
            })
        : undefined,
      mode: connectionMode,
      gatewayInstanceId,
      gatewayPublicKeyPem,
      peerInstanceId: this.ensureLocalInstanceId(),
      privateKeyPem: keyPair.privateKeyPem,
      publicKeyPem: keyPair.publicKeyPem,
      capabilities: DEFAULT_CAPABILITIES,
      inviteToken: pendingInviteToken || undefined,
      label:
        this.instanceLabel ||
        config.instanceLabel ||
        defaultInstanceLabel(),
      // Advertise which profile this instance runs so peers can tell
      // several enrollments of the same machine apart in their UI.
      profileName: getAppStateDb().getMeta("profile_name") || undefined,
      // Always a string: present-but-empty clears the gateway's stored
      // notes when the operator erases theirs (absent means "old client").
      notes: this.instanceNotes ?? config.instanceNotes,
      host: this.localHostInfo,
      // All client traffic rides this one socket, so the counters land
      // on the gateway's row — including relayed sibling traffic.
      onEnvelopeTransfer: (info) => {
        this.transferLedger.record({ ...info, peerId: gatewayInstanceId });
        this.activityLedger.record({
          ...info,
          peerId: gatewayInstanceId,
          localInstanceId: this.ensureLocalInstanceId(),
        });
      },
      role: "client",
      headers: cloudflareAccessEnabled
        ? {
            "CF-Access-Client-Id": cloudflareCredentials.accessClientId!,
            "CF-Access-Client-Secret":
              cloudflareCredentials.accessClientSecret!,
          }
        : undefined,
      clientCertificate: cloudflareMtlsEnabled
        ? cloudflareCredentials.clientCertificate
        : undefined,
      clientPrivateKey: cloudflareMtlsEnabled
        ? cloudflareCredentials.clientPrivateKey
        : undefined,
      noiseStatic: noiseKeyPairFromRawPrivate(
        Buffer.from(noise.privateKeyBase64, "base64"),
      ),
      gatewayNoisePublicKey: Buffer.from(
        gatewayNoisePublicKeyBase64,
        "base64",
      ),
      onClose: (info) => {
        if (
          this.stopping ||
          connectionGeneration !== this.connectionGeneration
        ) {
          return;
        }
        this.client = undefined;
        // 4001 is the gateway's "another connection authenticated with
        // your instance id" eviction — the signature of a cloned profile
        // state.db. Say so instead of the generic transport message, or
        // the operator sees an unexplained 30s connect/drop loop.
        const replaced = info?.code === FEDERATION_CLOSE_REPLACED_CODE;
        const revoked = info?.code === FEDERATION_CLOSE_REVOKED_CODE;
        this.lastConnectionError = replaced
          ? "Another instance connected with this federation identity "
            + "(a cloned profile state.db shares the instance id and key). "
            + "Reset federation on one of the profiles to stop the loop."
          : revoked
            ? "This instance's enrollment was revoked by the gateway. "
              + "Import a fresh invite to re-pair."
            : info
              ? `Federation gateway connection closed (${info.code}${
                  info.reason ? ` ${info.reason}` : ""
                }).`
              : "Federation gateway connection closed.";
        this.lastConnectionFailureKind = replaced
          ? "replaced"
          // Revocation is terminal until the operator re-pairs — the
          // auth kind makes health read "rejected" instead of hiding it
          // behind an endless "connecting".
          : revoked
            ? "auth"
            : "transport";
        const sessionAgeMs = this.lastConnectedAt
          ? Date.now() - this.lastConnectedAt
          : undefined;
        // Post-auth drops previously logged nothing at all; a repeating
        // short session age makes a kick loop obvious at a glance.
        log.warn("federation client session closed", {
          gatewayInstanceId,
          code: info?.code,
          reason: info?.reason,
          replaced,
          sessionAgeMs,
        });
        this.store().appendAudit({
          peerId: gatewayInstanceId,
          sessionId: clientSession.id,
          kind: "disconnected",
          createdAt: Date.now(),
          detail: replaced
            ? "replaced_by_new_session"
            : info
              ? `transport_closed:${info.code}`
              : "transport_closed",
        });
        this.unregisterPeer(gatewayInstanceId);
        this.publishPeerStatus(
          gatewayInstanceId,
          "disconnected",
          this.lastConnectionError,
        );
        this.disconnectAdvertisedPeers(this.lastConnectionError);
        this.endpointStatuses.set(gatewayUrl, {
          ...this.endpointStatuses.get(gatewayUrl),
          state: "idle",
        });
        this.scheduleReconnect();
      },
      onEnvelope: (envelope) =>
        void this.receiveEnvelope(envelope, gatewayInstanceId),
    }).catch((error: unknown) => {
      throw (
        sshFailure.error
        ?? (error instanceof Error ? error : new Error(String(error)))
      );
    });
    clientSession.id = client.sessionId;
    if (
      this.stopping ||
      connectionGeneration !== this.connectionGeneration
    ) {
      client.close();
      return;
    }
    this.client = client;
    this.router?.registerConnection({
      peerId: gatewayInstanceId,
      capabilities: client.capabilities,
      sendEnvelope: (envelope) => client.sendEnvelope(envelope),
      sendEnvelopeWithBackpressure: async (envelope) => {
        if (client.sendEnvelopeWithBackpressure) {
          await client.sendEnvelopeWithBackpressure(envelope);
          return;
        }
        client.sendEnvelope(envelope);
      },
    });
    // This instance can also be the OWNER of remote PTY sessions the gateway
    // is viewing; a reconnect inside the grace keeps those alive.
    this.ptyService?.notifyPeerConnected(gatewayInstanceId);
    this.recordClientConnection({
      gatewayInstanceId,
      gatewayUrl,
      client,
      connectionMode,
      connectedAt: Date.now(),
    });
    this.publishPeerStatus(gatewayInstanceId, "connected");
    // Icon assignments are sparse federation control-plane state rather than
    // a live backend event stream. Keep the existing reconnect convergence.
    this.broadcastCelestialIcons();
    this.syncDesiredEventSubscriptions();
    this.replayRelayedEventSubscriptions();
    if (pendingInviteToken) {
      getAppStateDb().setMeta(PENDING_INVITE_TOKEN_META_KEY, "");
    }
    this.markEndpointConnected(gatewayUrl);
    // Backoff is reset by session *durability*, not by the mere fact that a
    // handshake succeeded — otherwise a gateway that accepts and immediately
    // drops (restart loop, eviction) pins reconnects at 1 Hz forever, spawning
    // a fresh ssh process every second for ssh:// endpoints.
    this.lastConnectedAt = Date.now();
    this.lastConnectionError = undefined;
    this.lastConnectionFailureKind = undefined;
    log.info("federation client connected", { gatewayUrl });
  }

  // Only a fully authenticated session ever updates the last-good endpoint
  // memory, so a hostile endpoint can never steer future attempt ordering.
  private markEndpointConnected(gatewayUrl: string): void {
    this.endpointStatuses.set(gatewayUrl, {
      ...this.endpointStatuses.get(gatewayUrl),
      state: "active",
      lastConnectedAt: Date.now(),
      lastError: undefined,
    });
    getAppStateDb().setMeta(GATEWAY_LAST_ENDPOINT_META_KEY, gatewayUrl);
  }

  private recordClientConnection(params: {
    gatewayInstanceId: FederationInstanceId;
    gatewayUrl: string;
    client: FederationClientWebSocketClient;
    connectionMode: "enroll" | "reconnect";
    connectedAt: number;
  }): void {
    const existing = this.remotePeerDirectory.get(params.gatewayInstanceId);
    this.remotePeerDirectory.set(params.gatewayInstanceId, {
      id: params.gatewayInstanceId,
      label: existing?.label ?? this.defaultPeerLabel(params.gatewayInstanceId),
      role: "gateway",
      status: "connected",
      capabilities: [...params.client.capabilities],
      protocolVersion:
        existing?.protocolVersion ?? FEDERATION_PROTOCOL_VERSION,
      endpoint: existing?.endpoint ?? params.gatewayUrl,
      profileName: existing?.profileName,
      notes: existing?.notes,
      host: existing?.host,
      lastConnectedAt: params.connectedAt,
      lastActivityAt: params.connectedAt,
      canRevoke: false,
    });
    this.store().appendAudit({
      peerId: params.gatewayInstanceId,
      sessionId: params.client.sessionId,
      kind: "connected",
      createdAt: params.connectedAt,
      detail: params.connectionMode,
    });
  }

  private handleClientConnectionFailure(error: unknown): void {
    if (this.stopping) return;
    this.client = undefined;
    const rawMessage = error instanceof Error ? error.message : String(error);
    this.lastConnectionFailureKind = classifyFederationClientFailure(rawMessage);
    this.lastConnectionError = redactFederationDiagnostic(rawMessage);
    if (this.gatewayInstanceId) {
      this.publishPeerStatus(
        this.gatewayInstanceId,
        "disconnected",
        this.lastConnectionError,
      );
    }
    this.disconnectAdvertisedPeers(this.lastConnectionError);
    this.store().appendAudit({
      peerId: this.gatewayInstanceId,
      kind: "error",
      createdAt: Date.now(),
      detail: this.lastConnectionError,
    });
    log.warn("federation client connection failed", {
      endpoints: this.configuredEndpoints.length,
      error: this.lastConnectionError,
    });
    this.scheduleReconnect();
  }

  // Backoff applies per full cycle through the endpoint list; every cycle
  // re-walks the endpoints last-good-first via connectToGateway.
  private scheduleReconnect(): void {
    if (this.stopping || this.reconnectTimer) return;
    if (
      this.lastConnectedAt !== undefined
      && Date.now() - this.lastConnectedAt >= FEDERATION_STABLE_SESSION_MS
    ) {
      this.reconnectAttempt = 0;
    }
    this.lastConnectedAt = undefined;
    const delayMs = federationReconnectDelayMs(this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.stopping) return;
      void this.connectToGateway().catch((error) => {
        this.handleClientConnectionFailure(error);
      });
    }, delayMs);
  }

  private registerGatewayConnection(connection: FederationGatewayConnection): void {
    // A live socket can be replaced without a disconnected status transition.
    // Transport revisions are scoped to the remote process lifetime, so a
    // replacement must not reuse any selection state from the prior session.
    this.clearRemoteNavigationTransportForPeer(connection.peerId);
    this.router?.registerConnection({
      peerId: connection.peerId,
      capabilities: connection.capabilities,
      sendEnvelope: connection.sendEnvelope,
      sendEnvelopeWithBackpressure: connection.sendEnvelopeWithBackpressure,
    });
    // A transport blip that healed inside the reap grace keeps the peer's
    // remote PTY sessions alive.
    this.ptyService?.notifyPeerConnected(connection.peerId);
    this.publishPeerStatus(connection.peerId, "connected");
    this.replayRelayedEventSubscriptions(connection.peerId);
    this.syncDesiredEventSubscriptions();
    this.broadcastPeerDirectory();
    // Mirrors the broadcastPeerDirectory guard: connections registered
    // before app state exists (unit harnesses) skip icon coordination.
    if (isAppStateInitialized()) {
      this.reconcileCelestialAssignments();
    }
  }

  private unregisterGatewayConnection(connection: FederationGatewayConnection): void {
    const activeConnection = this.router?.getConnection(connection.peerId);
    if (activeConnection?.sendEnvelope !== connection.sendEnvelope) {
      return;
    }
    this.unregisterPeer(connection.peerId);
    this.publishPeerStatus(
      connection.peerId,
      "disconnected",
      "Federation peer connection closed.",
    );
    this.broadcastPeerDirectory();
  }

  private unregisterPeer(peerId: FederationInstanceId): void {
    this.removeEventSubscriptionsForPeer(peerId);
    this.router?.unregisterConnection(peerId);
    // Remote PTY sessions this peer opened get the 10s reap grace; if the
    // peer reconnects first, registerGatewayConnection cancels the reap.
    this.ptyService?.notifyPeerDisconnected(peerId);
    this.rpcByPeer.get(peerId)?.rejectAll(
      new FederationPeerUnavailableError(
        peerId,
        `Federation peer ${peerId} disconnected.`,
      ),
    );
    this.rpcByPeer.delete(peerId);
    this.clearRemoteNavigationTransportForPeer(peerId);
  }

  private clearRemoteNavigationTransportForPeer(
    peerId: FederationInstanceId,
  ): void {
    this.remoteNavigationTransportByPeer.delete(peerId);
  }

  private disconnectAdvertisedPeers(reason: string): void {
    for (const [peerId, peer] of this.remotePeerDirectory) {
      // Dual mode: a peer directly connected to THIS instance's own
      // gateway is still reachable when the upstream client link drops —
      // publishing "disconnected" for it would be false.
      if (this.router?.getConnection(peerId)) {
        continue;
      }
      this.remotePeerDirectory.set(peerId, {
        ...peer,
        status: peer.status === "revoked" ? "revoked" : "disconnected",
        unavailableReason: reason,
      });
      if (peer.status === "connected") {
        this.ptyService?.notifyPeerDisconnected(peerId);
      }
      this.clearRemoteNavigationTransportForPeer(peerId);
      this.publishPeerStatus(
        peerId,
        peer.status === "revoked" ? "revoked" : "disconnected",
        reason,
      );
    }
    for (const [peerId, rpc] of this.rpcByPeer) {
      rpc.rejectAll(new FederationPeerUnavailableError(peerId, reason));
    }
    this.rpcByPeer.clear();
  }

  private async receiveEnvelope(
    envelope: FederationProtocolEnvelope,
    sourcePeerId: FederationInstanceId,
  ): Promise<void> {
    // Subscription relays authenticate their delegated subscriber and route
    // explicitly inside applyEventSubscription. Other envelopes retain the
    // router's stricter direct-or-configured-upstream origin check.
    if (this.applyEventSubscription(envelope, sourcePeerId)) {
      return;
    }
    if (
      this.router
      && !this.router.authenticatesOrigin(envelope, sourcePeerId)
    ) {
      log.warn("federation envelope claimed an unauthenticated relay origin", {
        claimedSourceInstanceId: envelope.sourceInstanceId,
        sourcePeerId,
      });
      return;
    }
    if (this.applyPeerDirectory(envelope)) {
      return;
    }
    if (this.applyCelestialIcons(envelope, sourcePeerId)) {
      return;
    }
    if (this.applyStarMapArrangement(envelope, sourcePeerId)) {
      return;
    }
    if (this.publishRemotePtyStreamEvent(envelope, sourcePeerId)) {
      return;
    }
    if (this.publishRemoteEnvironmentSetupProgress(envelope, sourcePeerId)) {
      return;
    }
    if (this.publishRemoteBackendEvent(envelope, sourcePeerId)) {
      return;
    }
    if (envelope.kind === "response" || envelope.kind === "error") {
      const sourceInstanceId = envelope.sourceInstanceId;
      const originatingRpc = sourceInstanceId
        ? this.rpcByPeer.get(sourceInstanceId)
        : undefined;
      const handledByOrigin = originatingRpc?.receiveEnvelope(envelope) ?? false;
      const handled = handledByOrigin || [...this.rpcByPeer.entries()].some(
        ([peerId, rpc]) =>
          peerId !== sourceInstanceId && rpc.receiveEnvelope(envelope),
      );
      if (handled) return;
    }
    await this.router?.routeEnvelope({ envelope, sourcePeerId });
  }

  /** Owner → viewer PTY stream frame, routed directly when possible and
   * through this client's enrolled gateway otherwise. */
  private sendPtyNotification(
    peerId: FederationInstanceId,
    method: string,
    params: unknown,
  ): boolean {
    try {
      this.sendEnvelopeToTarget(peerId, {
        id: `federation-pty:${randomUUID()}`,
        kind: "notification",
        method,
        params,
        protocolVersion: FEDERATION_PROTOCOL_VERSION,
        sourceInstanceId: this.ensureLocalInstanceId(),
        targetInstanceId: peerId,
        createdAt: Date.now(),
      });
      return true;
    } catch {
      return false;
    }
  }

  private publishRemotePtyStreamEvent(
    envelope: FederationProtocolEnvelope,
    sourcePeerId: FederationInstanceId,
  ): boolean {
    if (
      envelope.kind !== "notification" ||
      !isFederationPtyStreamMethod(envelope.method)
    ) {
      return false;
    }
    // Gateway hop: keep the end-to-end source/target intact and let the
    // router enforce relay authorization + hop limits.
    if (
      envelope.targetInstanceId &&
      envelope.targetInstanceId !== this.ensureLocalInstanceId()
    ) {
      void this.router?.routeEnvelope({ envelope, sourcePeerId });
      return true;
    }
    const originInstanceId = envelope.sourceInstanceId ?? sourcePeerId;
    if (!isFederationInstanceId(originInstanceId)) {
      return true;
    }
    if (
      originInstanceId !== sourcePeerId
      && !this.router?.authenticatesOrigin(envelope, sourcePeerId)
    ) {
      return true;
    }
    const kind =
      envelope.method === FEDERATION_PTY_OUTPUT_METHOD
        ? "output"
        : envelope.method === FEDERATION_PTY_EXIT_METHOD
          ? "exit"
          : "error";
    const event = {
      kind,
      peerId: originInstanceId,
      params: envelope.params,
    } as FederationPtyStreamEvent;
    for (const listener of this.remotePtyEventListeners) {
      try {
        listener(event);
      } catch (error) {
        log.warn("federation remote pty event listener failed", {
          error: error instanceof Error ? error.message : String(error),
          method: envelope.method,
        });
      }
    }
    return true;
  }

  private sendEnvironmentSetupProgress(
    event: CodexEnvironmentSetupProgressEvent,
    targetInstanceId: FederationInstanceId,
  ): void {
    this.sendEnvelopeToTarget(targetInstanceId, {
      id: `federation-environment-setup:${randomUUID()}`,
      kind: "notification",
      method: FEDERATION_ENVIRONMENT_SETUP_PROGRESS_METHOD,
      params: event,
      protocolVersion: FEDERATION_PROTOCOL_VERSION,
      sourceInstanceId: this.ensureLocalInstanceId(),
      targetInstanceId,
      createdAt: Date.now(),
    });
  }

  private publishRemoteEnvironmentSetupProgress(
    envelope: FederationProtocolEnvelope,
    sourcePeerId: FederationInstanceId,
  ): boolean {
    if (
      envelope.kind !== "notification" ||
      envelope.method !== FEDERATION_ENVIRONMENT_SETUP_PROGRESS_METHOD
    ) {
      return false;
    }
    const notification =
      envelope as FederationEnvironmentSetupProgressNotification & typeof envelope;
    const targetInstanceId = envelope.targetInstanceId;
    if (
      targetInstanceId &&
      targetInstanceId !== this.ensureLocalInstanceId()
    ) {
      void this.router?.routeEnvelope({ envelope, sourcePeerId });
      return true;
    }
    this.publishEnvironmentSetupProgress?.({
      ...notification.params,
      federationTarget: {
        scope: "remote",
        instanceId: envelope.sourceInstanceId || sourcePeerId,
      },
    });
    return true;
  }

  private ensureLocalInstanceId(): FederationInstanceId {
    if (this.localInstanceId) return this.localInstanceId;
    const stateDb = getAppStateDb();
    const existing = stateDb.getMeta(INSTANCE_ID_META_KEY);
    if (existing) {
      this.localInstanceId = existing;
      return existing;
    }
    const next = `pwr_${randomUUID()}`;
    stateDb.setMeta(INSTANCE_ID_META_KEY, next);
    this.localInstanceId = next;
    return next;
  }

  private store(): FederationStore {
    return new FederationStore(getAppStateDb());
  }

  private sendEnvelopeToTarget(
    targetInstanceId: FederationInstanceId,
    envelope: FederationProtocolEnvelope,
  ): void {
    if (this.router?.sendToPeer(targetInstanceId, envelope)) {
      return;
    }

    const gatewayInstanceId = this.gatewayInstanceId ??
      getAppStateDb().getMeta(GATEWAY_INSTANCE_ID_META_KEY);
    if (
      gatewayInstanceId &&
      gatewayInstanceId !== targetInstanceId &&
      this.router?.sendToPeer(gatewayInstanceId, envelope)
    ) {
      return;
    }

    throw new FederationPeerUnavailableError(targetInstanceId);
  }

  private async sendEnvelopeToTargetWithBackpressure(
    targetInstanceId: FederationInstanceId,
    envelope: FederationProtocolEnvelope,
  ): Promise<void> {
    if (
      await this.router?.sendToPeerWithBackpressure(
        targetInstanceId,
        envelope,
      )
    ) {
      return;
    }

    const gatewayInstanceId = this.gatewayInstanceId
      ?? getAppStateDb().getMeta(GATEWAY_INSTANCE_ID_META_KEY);
    if (
      gatewayInstanceId
      && gatewayInstanceId !== targetInstanceId
      && await this.router?.sendToPeerWithBackpressure(gatewayInstanceId, envelope)
    ) {
      return;
    }

    throw new FederationPeerUnavailableError(targetInstanceId);
  }

  private sendEnvelopeToEventSubscriber(
    subscriberInstanceId: FederationInstanceId,
    envelope: FederationProtocolEnvelope,
  ): void {
    if (this.router?.sendToPeer(subscriberInstanceId, envelope)) {
      return;
    }
    const viaPeerId = this.incomingEventSubscriptions
      .get(subscriberInstanceId)
      ?.viaPeerId;
    if (
      viaPeerId
      && this.router?.sendToPeer(viaPeerId, envelope)
    ) {
      return;
    }
    this.sendEnvelopeToTarget(subscriberInstanceId, envelope);
  }

  private visiblePeers(): FederationPeerSummary[] {
    const localInstanceId = this.ensureLocalInstanceId();
    const visible = new Map<FederationInstanceId, FederationPeerSummary>();

    for (const peer of this.remotePeerDirectory.values()) {
      if (peer.id !== localInstanceId) {
        visible.set(peer.id, { ...peer, canRevoke: false });
      }
    }

    for (const peer of this.store().listPeers({ includeRevoked: true })) {
      if (peer.id === localInstanceId) continue;
      visible.set(peer.id, { ...peer, canRevoke: true });
    }

    for (const connection of this.router?.listConnections() ?? []) {
      if (connection.peerId === localInstanceId) continue;
      const existing = visible.get(connection.peerId);
      visible.set(connection.peerId, {
        id: connection.peerId,
        label: existing?.label ?? this.defaultPeerLabel(connection.peerId),
        role: existing?.role ?? this.defaultPeerRole(connection.peerId),
        status: "connected",
        capabilities: [...connection.capabilities],
        protocolVersion: existing?.protocolVersion,
        endpoint: existing?.endpoint,
        profileName: existing?.profileName,
        notes: existing?.notes,
        host: existing?.host,
        lastConnectedAt: existing?.lastConnectedAt,
        lastActivityAt: existing?.lastActivityAt,
        revokedAt: existing?.revokedAt,
        unavailableReason: existing?.unavailableReason,
        canRevoke: existing?.canRevoke ?? false,
      });
    }

    return [...visible.values()]
      .map((peer) =>
        this.router?.getConnection(peer.id)
          ? { ...peer, status: "connected" as const }
          : this.remotePeerDirectory.has(peer.id)
            ? peer
          : {
              ...peer,
              status:
                peer.status === "connected"
                  ? ("disconnected" as const)
                  : peer.status,
            },
      )
      .map((peer) => {
        // Surface a recent duplicate-identity eviction storm to everyone
        // observing this peer (Settings rows here, and remote viewers via
        // the peer directory) — the flapping peer itself only ever sees
        // its own 4001 close.
        const suspectedAt = this.duplicateIdentitySuspectedAt.get(peer.id);
        return suspectedAt !== undefined
          && Date.now() - suspectedAt < DUPLICATE_IDENTITY_NOTE_TTL_MS
          && !peer.unavailableReason
          ? {
              ...peer,
              unavailableReason:
                "Multiple instances are presenting this federation identity "
                + "(likely a cloned profile state.db); its connection is "
                + "unstable until one is reset.",
            }
          : peer;
      })
      .map((peer) => ({
        ...peer,
        celestialIcon: this.celestialIconFor(peer.id) ?? peer.celestialIcon,
      }));
  }

  private defaultPeerLabel(peerId: FederationInstanceId): string {
    return peerId === getAppStateDb().getMeta(GATEWAY_INSTANCE_ID_META_KEY)
      ? "Gateway"
      : peerId;
  }

  private defaultPeerRole(peerId: FederationInstanceId): FederationInstanceRole {
    return peerId === getAppStateDb().getMeta(GATEWAY_INSTANCE_ID_META_KEY)
      ? "gateway"
      : "client";
  }

  private buildPeerDirectory(
    recipientPeerId: FederationInstanceId,
  ): FederationPeerSummary[] {
    const localInstanceId = this.ensureLocalInstanceId();
    const localProfileName = getAppStateDb().getMeta("profile_name") || undefined;
    const peers: FederationPeerSummary[] = [
      {
        id: localInstanceId,
        label: this.instanceLabel || localProfileName || "Gateway",
        role: "gateway",
        status: "connected",
        capabilities: DEFAULT_CAPABILITIES,
        protocolVersion: FEDERATION_PROTOCOL_VERSION,
        profileName: localProfileName,
        celestialIcon: this.celestialIconFor(localInstanceId),
        notes: this.instanceNotes || undefined,
        host: this.localHostInfo,
      },
    ];

    for (const peer of this.visiblePeers()) {
      if (peer.id === recipientPeerId) continue;
      peers.push(peer);
    }

    return peers;
  }

  private broadcastPeerDirectory(): void {
    const router = this.router;
    if (!router) return;
    if (!isAppStateInitialized()) return;
    const localInstanceId = this.ensureLocalInstanceId();

    for (const connection of router.listConnections()) {
      connection.sendEnvelope({
        id: `federation-peers:${randomUUID()}`,
        kind: "notification",
        method: FEDERATION_PEER_DIRECTORY_METHOD,
        params: {
          peers: this.buildPeerDirectory(connection.peerId),
        },
        protocolVersion: FEDERATION_PROTOCOL_VERSION,
        sourceInstanceId: localInstanceId,
        targetInstanceId: connection.peerId,
        createdAt: Date.now(),
      });
    }
  }

  private applyPeerDirectory(envelope: FederationProtocolEnvelope): boolean {
    if (
      envelope.kind !== "notification" ||
      envelope.method !== FEDERATION_PEER_DIRECTORY_METHOD
    ) {
      return false;
    }

    const notification = envelope as FederationPeerDirectoryNotification & typeof envelope;
    const previousPeers = new Map(this.remotePeerDirectory);
    this.remotePeerDirectory.clear();
    for (const peer of notification.params.peers) {
      if (peer.id !== this.ensureLocalInstanceId()) {
        const previous = previousPeers.get(peer.id);
        this.remotePeerDirectory.set(peer.id, {
          ...peer,
          lastConnectedAt: peer.lastConnectedAt ?? previous?.lastConnectedAt,
          lastActivityAt: peer.lastActivityAt ?? previous?.lastActivityAt,
          canRevoke: false,
        });
        if (peer.status === "connected") {
          if (previous?.status !== "connected") {
            this.ptyService?.notifyPeerConnected(peer.id);
          }
        } else if (previous?.status === "connected") {
          this.ptyService?.notifyPeerDisconnected(peer.id);
        }
        previousPeers.delete(peer.id);
      }
    }
    // Publish only after the complete snapshot is installed. Status listeners
    // synchronously read visiblePeers() (the application menu is one of them),
    // so notifying while this map is still being rebuilt can expose a partial
    // directory. If the remaining peers retain their previous statuses, the
    // deduplicating publisher will not fire again and that partial view can
    // remain visible indefinitely.
    for (const peer of this.remotePeerDirectory.values()) {
      this.publishPeerStatus(peer.id, peer.status, peer.unavailableReason);
    }
    for (const peerId of previousPeers.keys()) {
      if (previousPeers.get(peerId)?.status === "connected") {
        this.ptyService?.notifyPeerDisconnected(peerId);
      }
      this.publishPeerStatus(
        peerId,
        "disconnected",
        "Federation peer is no longer advertised by the gateway.",
      );
    }
    return true;
  }

  /**
   * Lazily load the persisted celestial assignment map. Every instance
   * persists the latest merged snapshot so icons survive restarts and
   * offline periods everywhere, not just on the gateway.
   */
  private celestialAssignmentMap(): Map<
    FederationInstanceId,
    CelestialIconAssignment
  > {
    if (this.celestialAssignments) return this.celestialAssignments;
    if (!isAppStateInitialized()) {
      // Pre-init (and unit-test) callers get a throwaway empty map; the
      // persisted snapshot loads on the first post-init read.
      return new Map();
    }
    const map = new Map<FederationInstanceId, CelestialIconAssignment>();
    const raw = getAppStateDb().getMeta(CELESTIAL_ICON_ASSIGNMENTS_META_KEY);
    if (raw) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          for (const entry of parsed) {
            if (map.size >= MAX_CELESTIAL_ASSIGNMENTS) break;
            if (
              isCelestialIconAssignment(entry)
              && isFederationInstanceId(entry.instanceId)
            ) {
              map.set(entry.instanceId, entry);
            }
          }
        }
      } catch {
        // Corrupt cache — reconciliation rebuilds it.
      }
    }
    this.celestialAssignments = map;
    return map;
  }

  private persistCelestialAssignments(): void {
    if (!this.celestialAssignments || !isAppStateInitialized()) return;
    getAppStateDb().setMeta(
      CELESTIAL_ICON_ASSIGNMENTS_META_KEY,
      JSON.stringify([...this.celestialAssignments.values()]),
    );
  }

  /**
   * Drop tombstones old enough that every peer has long since merged the
   * removal. Purely local hygiene — no broadcast; a peer that still carries
   * the tombstone re-shares it harmlessly and expires it on its own clock.
   *
   * Runs on both the coordinator path (reconcile) and the receive path
   * (applyCelestialIcons): a pure client never reconciles, and would
   * otherwise accumulate tombstones for the life of the process.
   */
  private expireCelestialTombstones(): boolean {
    const map = this.celestialAssignmentMap();
    let changed = false;
    for (const entry of [...map.values()]) {
      if (
        entry.removed
        && Date.now() - entry.updatedAt > CELESTIAL_TOMBSTONE_TTL_MS
      ) {
        map.delete(entry.instanceId);
        changed = true;
      }
    }
    return changed;
  }

  /**
   * Tombstone one instance's assignment and propagate the removal. Plain
   * LWW merges only ever add, so a freed icon has to travel as a removed
   * entry that outranks the assignment it replaces.
   */
  private removeCelestialAssignment(
    instanceId: FederationInstanceId,
    removedAt: number,
  ): void {
    const map = this.celestialAssignmentMap();
    const existing = map.get(instanceId);
    if (!existing || existing.removed) return;
    map.set(instanceId, {
      instanceId,
      icon: existing.icon,
      source: "auto",
      updatedAt: Math.max(removedAt, existing.updatedAt + 1),
      removed: true,
    });
    this.persistCelestialAssignments();
    this.publishCelestialIconsChanged();
    this.broadcastCelestialIcons();
  }

  /**
   * The assignment coordinator is the root gateway — an instance with no
   * upstream enrollment. Dual instances defer to their upstream gateway; a
   * non-federated instance coordinates itself.
   */
  private actsAsCelestialCoordinator(): boolean {
    if (!isAppStateInitialized()) return true;
    return !getAppStateDb().getMeta(GATEWAY_INSTANCE_ID_META_KEY);
  }

  /** This instance's durable federation identity (creates one if absent). */
  localFederationInstanceId(): FederationInstanceId {
    return this.ensureLocalInstanceId();
  }

  /**
   * All known assignments, self-assigning the local instance on first read.
   * Includes tombstones — this is the protocol/persistence view; renderer
   * surfaces read through celestialIconFor / activeCelestialAssignments,
   * which treat removed entries as unassigned.
   */
  celestialIconAssignments(): CelestialIconAssignment[] {
    const map = this.celestialAssignmentMap();
    const localInstanceId = this.ensureLocalInstanceId();
    const local = map.get(localInstanceId);
    if (!local || local.removed) {
      map.set(localInstanceId, {
        instanceId: localInstanceId,
        icon: pickCelestialIcon(this.celestialIconsById(), localInstanceId, {
          isGateway: this.actsAsCelestialCoordinator(),
        }),
        source: "auto",
        updatedAt: local ? Math.max(Date.now(), local.updatedAt + 1) : Date.now(),
      });
      this.persistCelestialAssignments();
    }
    return [...map.values()];
  }

  private activeCelestialAssignments(): CelestialIconAssignment[] {
    return this.celestialIconAssignments().filter((entry) => !entry.removed);
  }

  celestialIconFor(
    instanceId: FederationInstanceId,
  ): CelestialIconId | undefined {
    const entry = this.celestialAssignmentMap().get(instanceId);
    return entry && !entry.removed ? entry.icon : undefined;
  }

  private celestialIconsById(): Map<string, CelestialIconId> {
    return new Map(
      [...this.celestialAssignmentMap().values()]
        .filter((entry) => !entry.removed)
        .map((entry) => [entry.instanceId, entry.icon]),
    );
  }

  /** The assignment view without one instance — used when reassigning it. */
  private celestialIconsByIdExcluding(
    instanceId: FederationInstanceId,
  ): Map<string, CelestialIconId> {
    const map = this.celestialIconsById();
    map.delete(instanceId);
    return map;
  }

  /**
   * Coordinator-side: ensure every visible peer and the local instance has
   * an icon, then broadcast the authoritative map. Runs on every peer
   * connect, so late joiners get icons without a dedicated request. The
   * broadcast goes out even when nothing changed — the peer that just
   * connected still needs the current map, and merges are idempotent.
   */
  private reconcileCelestialAssignments(): void {
    let changed = this.expireCelestialTombstones();
    if (!this.actsAsCelestialCoordinator()) {
      if (changed) {
        this.persistCelestialAssignments();
      }
      this.broadcastCelestialIcons();
      return;
    }
    const map = this.celestialAssignmentMap();
    const localInstanceId = this.ensureLocalInstanceId();
    // visiblePeers() deliberately retains revoked peers (it feeds the
    // Settings list, which must keep showing them). They are exactly what
    // this GC exists to reclaim, so every celestial pass below works off
    // the revoked-free view instead — using visiblePeers() directly would
    // both spare a revoked peer from pruning and re-assign it a live icon
    // on the next connect, undoing revokePeer's tombstone.
    const assignablePeers = this.visiblePeers().filter(
      (peer) => peer.status !== "revoked",
    );
    // GC first, so icons freed by a removal are reusable in the assignment
    // pass below. An entry that is neither the local instance, a live
    // advertised peer, nor a non-revoked enrolled peer in the store belongs
    // to a revoked or forgotten instance — or to a buggy peer's fabrication
    // — and would otherwise occupy one of the five icons forever.
    // Enrolled-but-offline peers stay in the store, so they are never
    // pruned; a nested sub-client whose hub is offline can get pruned, and
    // simply receives a fresh assignment when its hub reconnects and
    // re-advertises it.
    const activeIds = new Set<string>([localInstanceId]);
    for (const peer of assignablePeers) {
      activeIds.add(peer.id);
    }
    // listPeers() without includeRevoked already omits revoked enrollments.
    for (const peer of this.store().listPeers()) {
      activeIds.add(peer.id);
    }
    for (const entry of [...map.values()]) {
      if (entry.removed || activeIds.has(entry.instanceId)) continue;
      map.set(entry.instanceId, {
        instanceId: entry.instanceId,
        icon: entry.icon,
        source: "auto",
        updatedAt: Math.max(Date.now(), entry.updatedAt + 1),
        removed: true,
      });
      changed = true;
    }
    const local = map.get(localInstanceId);
    if (!local || local.removed) {
      map.set(localInstanceId, {
        instanceId: localInstanceId,
        icon: pickCelestialIcon(this.celestialIconsById(), localInstanceId, {
          isGateway: true,
        }),
        source: "auto",
        updatedAt: local
          ? Math.max(Date.now(), local.updatedAt + 1)
          : Date.now(),
      });
      changed = true;
    }
    for (const peer of assignablePeers) {
      const existing = map.get(peer.id);
      if (existing && !existing.removed) continue;
      map.set(peer.id, {
        instanceId: peer.id,
        icon: pickCelestialIcon(this.celestialIconsById(), peer.id),
        source: "auto",
        updatedAt: existing
          ? Math.max(Date.now(), existing.updatedAt + 1)
          : Date.now(),
      });
      changed = true;
    }
    // LWW merges can produce collisions (a client that self-assigned while
    // offline, two clients that never met). The coordinator resolves them:
    // overrides and older assignments keep their icon; newer auto entries
    // get reassigned, and the fresh updatedAt makes the fix win everywhere.
    const byIcon = new Map<CelestialIconId, CelestialIconAssignment[]>();
    for (const assignment of map.values()) {
      if (assignment.removed) continue;
      const bucket = byIcon.get(assignment.icon) ?? [];
      bucket.push(assignment);
      byIcon.set(assignment.icon, bucket);
    }
    for (const bucket of byIcon.values()) {
      if (bucket.length < 2) continue;
      const keeper = bucket.reduce((best, candidate) => {
        if (best.source !== candidate.source) {
          return best.source === "override" ? best : candidate;
        }
        return candidate.updatedAt < best.updatedAt ? candidate : best;
      });
      for (const loser of bucket) {
        if (loser === keeper || loser.source === "override") continue;
        map.set(loser.instanceId, {
          instanceId: loser.instanceId,
          icon: pickCelestialIcon(
            this.celestialIconsByIdExcluding(loser.instanceId),
            loser.instanceId,
            { isGateway: false },
          ),
          source: "auto",
          updatedAt: Date.now(),
        });
        changed = true;
      }
    }
    if (changed) {
      this.persistCelestialAssignments();
      this.publishCelestialIconsChanged();
    }
    this.broadcastCelestialIcons();
  }

  private broadcastCelestialIcons(excludePeerId?: FederationInstanceId): void {
    const router = this.router;
    if (!router) return;
    const localInstanceId = this.ensureLocalInstanceId();
    const assignments = this.celestialIconAssignments();
    for (const connection of router.listConnections()) {
      if (connection.peerId === excludePeerId) continue;
      connection.sendEnvelope({
        id: `federation-celestial:${randomUUID()}`,
        kind: "notification",
        method: FEDERATION_CELESTIAL_ICONS_METHOD,
        params: { assignments },
        protocolVersion: FEDERATION_PROTOCOL_VERSION,
        sourceInstanceId: localInstanceId,
        targetInstanceId: connection.peerId,
        createdAt: Date.now(),
      });
    }
  }

  private applyCelestialIcons(
    envelope: FederationProtocolEnvelope,
    sourcePeerId: FederationInstanceId,
  ): boolean {
    if (
      envelope.kind !== "notification" ||
      envelope.method !== FEDERATION_CELESTIAL_ICONS_METHOD
    ) {
      return false;
    }
    const notification =
      envelope as FederationCelestialIconsNotification & typeof envelope;
    const wellFormed = Array.isArray(notification.params?.assignments)
      ? notification.params.assignments.filter(
          (entry): entry is CelestialIconAssignment =>
            isCelestialIconAssignment(entry)
            && isFederationInstanceId(entry.instanceId),
        )
      : [];
    if (wellFormed.length === 0) return true;
    // This is the only celestial path a pure client ever runs, so it owns
    // tombstone expiry there — reconcile is gateway-only.
    const expired = this.expireCelestialTombstones();
    // Bound the accepted set: entries for already-known instances always
    // merge, but new ids only land while the map has room. Without the cap
    // a buggy peer streaming fabricated ids would permanently bloat every
    // instance's persisted map. Tombstones are deliberately excluded from
    // the budget: they are transient bookkeeping, and counting them would
    // let a churning federation starve out real peers.
    const current = this.celestialIconAssignments();
    const known = new Set(current.map((entry) => entry.instanceId));
    let liveCount = current.filter((entry) => !entry.removed).length;
    const incoming: CelestialIconAssignment[] = [];
    let dropped = 0;
    for (const entry of wellFormed) {
      if (known.has(entry.instanceId) || liveCount < MAX_CELESTIAL_ASSIGNMENTS) {
        incoming.push(entry);
        if (!known.has(entry.instanceId)) {
          known.add(entry.instanceId);
          if (!entry.removed) liveCount += 1;
        }
      } else {
        dropped += 1;
      }
    }
    if (dropped > 0) {
      log.warn("celestial assignment snapshot exceeded the entry cap", {
        sourcePeerId,
        dropped,
      });
    }
    if (incoming.length === 0) {
      if (expired) this.persistCelestialAssignments();
      return true;
    }
    const merged = mergeCelestialIconAssignments(current, incoming);
    if (!merged.changed) {
      if (expired) this.persistCelestialAssignments();
      return true;
    }
    const map = this.celestialAssignmentMap();
    map.clear();
    for (const assignment of merged.assignments) {
      map.set(assignment.instanceId, assignment);
    }
    this.persistCelestialAssignments();
    this.publishCelestialIconsChanged();
    // Re-fan-out on change only (idempotent merges terminate the loop):
    // a dual hub forwards the gateway's map down to its own clients, and a
    // client's offline overrides ride up to the gateway the same way.
    this.broadcastCelestialIcons(sourcePeerId);
    return true;
  }

  /**
   * Fan an arrangement delta out only to explicit Star Map subscribers.
   */
  broadcastStarMapArrangement(
    entries: StarMapArrangementEntry[],
  ): void {
    if (!this.router || entries.length === 0) return;
    const protocolEntries = encodeStarMapEntriesForProtocolV1(entries);
    for (const [subscriberInstanceId, subscription] of
      this.incomingEventSubscriptions) {
      if (!subscription.eventClasses.has("star_map")) {
        continue;
      }
      try {
        this.sendEnvelopeToEventSubscriber(subscriberInstanceId, {
          id: `federation-star-map:${randomUUID()}`,
          kind: "notification",
          method: FEDERATION_STAR_MAP_ARRANGEMENT_METHOD,
          params: { entries: protocolEntries },
          protocolVersion: FEDERATION_PROTOCOL_VERSION,
          sourceInstanceId: this.ensureLocalInstanceId(),
          targetInstanceId: subscriberInstanceId,
          createdAt: Date.now(),
        });
      } catch {
        // Live subscribers are cleaned up with their connection.
      }
    }
  }

  /** Subscription convergence: push the full persisted arrangement snapshot. */
  private sendStarMapArrangementSnapshot(
    subscriberInstanceId: FederationInstanceId,
  ): void {
    if (!isAppStateInitialized()) return;
    let store: ReturnType<typeof getDesktopOverlayStore>;
    try {
      // Connection churn can race overlay-store availability during boot
      // and teardown (and unit harnesses stub app-state without it); the
      // snapshot is a convergence optimization, not a correctness need.
      store = getDesktopOverlayStore();
    } catch {
      return;
    }
    void store
      .readStarMapArrangement()
      .then((entries) => {
        const subscription = this.incomingEventSubscriptions
          .get(subscriberInstanceId);
        if (!subscription?.eventClasses.has("star_map")) return;
        try {
          this.sendEnvelopeToEventSubscriber(subscriberInstanceId, {
            id: `federation-star-map:${randomUUID()}`,
            kind: "notification",
            method: FEDERATION_STAR_MAP_ARRANGEMENT_METHOD,
            params: {
              entries: encodeStarMapEntriesForProtocolV1(entries),
            },
            protocolVersion: FEDERATION_PROTOCOL_VERSION,
            sourceInstanceId: this.ensureLocalInstanceId(),
            targetInstanceId: subscriberInstanceId,
            createdAt: Date.now(),
          });
        } catch {
          // The subscription will replay on the next connection.
        }
      })
      .catch((error) => {
        log.warn("star map arrangement snapshot send failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  private applyStarMapArrangement(
    envelope: FederationProtocolEnvelope,
    sourcePeerId: FederationInstanceId,
  ): boolean {
    if (
      envelope.kind !== "notification" ||
      envelope.method !== FEDERATION_STAR_MAP_ARRANGEMENT_METHOD
    ) {
      return false;
    }
    if (
      envelope.targetInstanceId
      && envelope.targetInstanceId !== this.ensureLocalInstanceId()
    ) {
      this.relaySubscribedBackendEvent(envelope, sourcePeerId, "star_map");
      return true;
    }
    if (
      !envelope.targetInstanceId
      || !this.wantsRemoteEvent(envelope.sourceInstanceId, "star_map")
      || (
        envelope.sourceInstanceId !== sourcePeerId
        && sourcePeerId !== this.gatewayInstanceId
      )
    ) {
      return true;
    }
    if (!isAppStateInitialized()) return true;
    const notification =
      envelope as FederationStarMapArrangementNotification & typeof envelope;
    const entries = Array.isArray(notification.params?.entries)
      ? notification.params.entries.filter(isStarMapArrangementEntry)
      : [];
    if (entries.length === 0) return true;
    void getDesktopOverlayStore()
      .mergeStarMapArrangement(entries)
      .then(({ accepted }) => {
        if (accepted.length === 0) return;
        this.publishStarMapArrangementChanged(accepted);
      })
      .catch((error) => {
        log.warn("star map arrangement merge failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return true;
  }

  publishStarMapArrangementChanged(entries: StarMapArrangementEntry[]): void {
    this.publishAgentEvent?.({
      backend: "codex",
      notification: {
        method: "starMap/arrangement/changed",
        params: { entries },
      },
    });
  }

  private publishCelestialIconsChanged(): void {
    this.publishAgentEvent?.({
      backend: "codex",
      notification: {
        method: "federation/celestialIcons/changed",
        params: {
          // Renderers see the active view only — a tombstone is protocol
          // plumbing, not an icon to draw.
          assignments: this.activeCelestialAssignments(),
        },
      },
    });
  }

  /**
   * Apply an operator override, or clear one back to auto when the request
   * carries a null icon. Coordinators mutate directly; everyone else
   * forwards to the gateway when it is reachable and falls back to a local
   * LWW write that syncs up on the next reconnect.
   */
  async setCelestialIcon(
    request: SetCelestialIconRequest,
  ): Promise<SetCelestialIconResponse> {
    if (
      !isFederationInstanceId(request.instanceId)
      || (request.icon !== null && !isCelestialIconId(request.icon))
    ) {
      throw new Error("Invalid celestial icon override request.");
    }
    const gatewayInstanceId = this.actsAsCelestialCoordinator()
      ? undefined
      : getAppStateDb().getMeta(GATEWAY_INSTANCE_ID_META_KEY) || undefined;
    if (gatewayInstanceId && this.router?.getConnection(gatewayInstanceId)) {
      const response = await this.remoteBackend({
        scope: "remote",
        instanceId: gatewayInstanceId,
      }).setCelestialIcon(request);
      const merged = mergeCelestialIconAssignments(
        this.celestialIconAssignments(),
        response.assignments.filter(isCelestialIconAssignment),
      );
      if (merged.changed) {
        const map = this.celestialAssignmentMap();
        map.clear();
        for (const assignment of merged.assignments) {
          map.set(assignment.instanceId, assignment);
        }
        this.persistCelestialAssignments();
        this.publishCelestialIconsChanged();
      }
      return { assignments: this.celestialIconAssignments() };
    }
    const map = this.celestialAssignmentMap();
    const existing = map.get(request.instanceId);
    map.set(
      request.instanceId,
      request.icon === null
        ? {
            instanceId: request.instanceId,
            // Clearing an override re-runs auto assignment; the fresh
            // updatedAt makes the reset win LWW wherever the override won.
            icon: pickCelestialIcon(
              this.celestialIconsByIdExcluding(request.instanceId),
              request.instanceId,
              {
                isGateway:
                  this.actsAsCelestialCoordinator()
                  && request.instanceId === this.ensureLocalInstanceId(),
              },
            ),
            source: "auto",
            updatedAt: existing
              ? Math.max(Date.now(), existing.updatedAt + 1)
              : Date.now(),
          }
        : {
            instanceId: request.instanceId,
            icon: request.icon,
            source: "override",
            updatedAt: existing
              ? Math.max(Date.now(), existing.updatedAt + 1)
              : Date.now(),
          },
    );
    this.persistCelestialAssignments();
    this.publishCelestialIconsChanged();
    this.broadcastCelestialIcons();
    return { assignments: this.celestialIconAssignments() };
  }

  private aggregateDesiredEventSubscriptions(): Map<
    FederationInstanceId,
    DesiredEventSubscription
  > {
    const aggregated = new Map<
      FederationInstanceId,
      DesiredEventSubscription
    >();
    for (const subscriptions of this.desiredEventSubscriptions.values()) {
      for (const [sourceInstanceId, subscription] of subscriptions) {
        const current = aggregated.get(sourceInstanceId);
        const eventClasses = current?.eventClasses ?? new Set();
        for (const eventClass of subscription.eventClasses) {
          eventClasses.add(eventClass);
        }
        aggregated.set(sourceInstanceId, {
          eventClasses,
          threadSelection: mergeFederationThreadSelections(
            current?.threadSelection,
            subscription.threadSelection,
          ),
        });
      }
    }
    return aggregated;
  }

  private wantsRemoteEvent(
    sourceInstanceId: FederationInstanceId,
    eventClass: FederationEventClass,
  ): boolean {
    for (const subscriptions of this.desiredEventSubscriptions.values()) {
      if (subscriptions.get(sourceInstanceId)?.eventClasses.has(eventClass)) {
        return true;
      }
    }
    return false;
  }

  private desiredThreadSelectionFor(
    sourceInstanceId: FederationInstanceId,
  ): FederationThreadSelection | undefined {
    return this.aggregateDesiredEventSubscriptions().get(sourceInstanceId)
      ?.threadSelection;
  }

  private sendDesiredEventSubscription(
    sourceInstanceId: FederationInstanceId,
    subscription: DesiredEventSubscription,
  ): void {
    if (sourceInstanceId === this.ensureLocalInstanceId()) return;
    const supportsSelection = this.remotePeerAdvertisesCapability(
      sourceInstanceId,
      "navigation_snapshot_deltas",
    );
    try {
      this.sendEnvelopeToTarget(sourceInstanceId, {
        id: `federation-subscription:${randomUUID()}`,
        kind: "notification",
        method: FEDERATION_EVENT_SUBSCRIPTION_METHOD,
        params: {
          eventClasses: [...subscription.eventClasses],
          ...(supportsSelection
            ? { threadSelection: subscription.threadSelection }
            : {}),
        },
        protocolVersion: FEDERATION_PROTOCOL_VERSION,
        sourceInstanceId: this.ensureLocalInstanceId(),
        targetInstanceId: sourceInstanceId,
        createdAt: Date.now(),
      });
    } catch {
      // Desired state survives disconnects and is replayed after reconnect.
    }
  }

  private syncDesiredEventSubscriptions(): void {
    for (const [sourceInstanceId, subscription] of
      this.aggregateDesiredEventSubscriptions()) {
      this.sendDesiredEventSubscription(sourceInstanceId, subscription);
    }
  }

  private applyEventSubscription(
    envelope: FederationProtocolEnvelope,
    sourcePeerId: FederationInstanceId,
  ): boolean {
    if (
      envelope.kind !== "notification"
      || envelope.method !== FEDERATION_EVENT_SUBSCRIPTION_METHOD
    ) {
      return false;
    }
    const subscriberInstanceId = envelope.sourceInstanceId;
    const sourceInstanceId = envelope.targetInstanceId;
    if (
      !isFederationInstanceId(subscriberInstanceId)
      || !sourceInstanceId
      || !isFederationInstanceId(sourceInstanceId)
    ) {
      return true;
    }
    const sourceConnection = this.router?.getConnection(sourcePeerId);
    const delegatedSubscriber = subscriberInstanceId !== sourcePeerId;
    const authenticatedSubscriptionRelay =
      delegatedSubscriber
      && (envelope.hopCount ?? 0) >= 1
      && (
        sourcePeerId === this.gatewayInstanceId
        || sourceConnection?.capabilities.includes("gateway_relay")
      );
    if (
      !sourceConnection?.capabilities.includes("event_subscriptions")
      || (delegatedSubscriber && !authenticatedSubscriptionRelay)
    ) {
      return true;
    }
    const notification =
      envelope as FederationEventSubscriptionNotification & typeof envelope;
    const requestedClasses = Array.isArray(notification.params?.eventClasses)
      ? notification.params.eventClasses.filter(isFederationEventClass)
      : [];
    const requestedThreadSelection = normalizeFederationThreadSelection(
      notification.params?.threadSelection,
    );

    if (sourceInstanceId !== this.ensureLocalInstanceId()) {
      const allowedClasses = requestedClasses.filter((eventClass) =>
        eventClassAllowedByCapabilities(
          eventClass,
          sourceConnection.capabilities,
        )
      );
      const key = eventSubscriptionKey({
        sourceInstanceId,
        subscriberInstanceId,
      });
      const relayedSubscription: RelayedEventSubscription = {
        eventClasses: new Set(allowedClasses),
        sourceInstanceId,
        subscriberInstanceId,
        threadSelection: requestedThreadSelection,
        viaPeerId: sourcePeerId,
      };
      if (allowedClasses.length > 0) {
        this.relayedEventSubscriptions.set(key, relayedSubscription);
      } else {
        this.relayedEventSubscriptions.delete(key);
      }
      this.sendRelayedEventSubscription(
        relayedSubscription,
        relayedSubscription,
      );
      return true;
    }

    const previous = this.incomingEventSubscriptions.get(subscriberInstanceId);
    const allowedClasses = subscriberInstanceId === sourcePeerId
      ? requestedClasses.filter((eventClass) =>
          eventClassAllowedByCapabilities(
            eventClass,
            sourceConnection.capabilities,
          )
        )
      : requestedClasses;
    if (allowedClasses.length > 0) {
      this.incomingEventSubscriptions.set(subscriberInstanceId, {
        eventClasses: new Set(allowedClasses),
        threadSelection: requestedThreadSelection,
        viaPeerId: sourcePeerId,
      });
    } else {
      this.incomingEventSubscriptions.delete(subscriberInstanceId);
    }
    if (
      allowedClasses.includes("star_map")
      && !previous?.eventClasses.has("star_map")
    ) {
      this.sendStarMapArrangementSnapshot(subscriberInstanceId);
    }
    return true;
  }

  private relaySubscribedBackendEvent(
    envelope: FederationProtocolEnvelope,
    sourcePeerId: FederationInstanceId,
    eventClass: FederationEventClass,
  ): boolean {
    const subscriberInstanceId = envelope.targetInstanceId;
    if (!subscriberInstanceId) return false;
    const subscription = this.relayedEventSubscriptions.get(
      eventSubscriptionKey({
        sourceInstanceId: envelope.sourceInstanceId,
        subscriberInstanceId,
      }),
    );
    if (!subscription?.eventClasses.has(eventClass)) return false;
    if (
      envelope.sourceInstanceId !== sourcePeerId
      && !this.router?.authenticatesOrigin(envelope, sourcePeerId)
    ) {
      return false;
    }
    const hopCount = envelope.hopCount ?? 0;
    if (
      hopCount >= FEDERATION_EVENT_RELAY_MAX_HOPS
      || subscription.viaPeerId === sourcePeerId
    ) {
      return false;
    }
    return this.router?.sendToPeer(subscription.viaPeerId, {
      ...envelope,
      hopCount: hopCount + 1,
    }) ?? false;
  }

  private removeEventSubscriptionsForPeer(peerId: FederationInstanceId): void {
    for (const [subscriberInstanceId, subscription] of
      this.incomingEventSubscriptions) {
      if (
        subscriberInstanceId === peerId
        || subscription.viaPeerId === peerId
      ) {
        this.incomingEventSubscriptions.delete(subscriberInstanceId);
      }
    }
    for (const [key, subscription] of this.relayedEventSubscriptions) {
      if (subscription.subscriberInstanceId === peerId) {
        this.sendRelayedEventSubscription(subscription, {
          eventClasses: new Set(),
          threadSelection: { kind: "threads", threads: [] },
        });
        this.relayedEventSubscriptions.delete(key);
        continue;
      }
      if (subscription.viaPeerId === peerId) {
        this.sendRelayedEventSubscription(subscription, {
          eventClasses: new Set(),
          threadSelection: { kind: "threads", threads: [] },
        });
        this.relayedEventSubscriptions.delete(key);
      }
    }
  }

  private sendRelayedEventSubscription(
    subscription: RelayedEventSubscription,
    desired: DesiredEventSubscription,
  ): void {
    const supportsSelection = this.remotePeerAdvertisesCapability(
      subscription.sourceInstanceId,
      "navigation_snapshot_deltas",
    );
    try {
      this.sendEnvelopeToTarget(subscription.sourceInstanceId, {
        id: `federation-subscription-relay:${randomUUID()}`,
        kind: "notification",
        method: FEDERATION_EVENT_SUBSCRIPTION_METHOD,
        params: {
          eventClasses: [...desired.eventClasses],
          ...(supportsSelection
            ? { threadSelection: desired.threadSelection }
            : {}),
        },
        protocolVersion: FEDERATION_PROTOCOL_VERSION,
        sourceInstanceId: subscription.subscriberInstanceId,
        targetInstanceId: subscription.sourceInstanceId,
        hopCount: 1,
        createdAt: Date.now(),
      });
    } catch {
      // A disconnected source already cleared subscriptions via its route.
    }
  }

  private replayRelayedEventSubscriptions(
    sourceInstanceId?: FederationInstanceId,
  ): void {
    for (const subscription of this.relayedEventSubscriptions.values()) {
      if (
        sourceInstanceId === undefined
        || subscription.sourceInstanceId === sourceInstanceId
      ) {
        this.sendRelayedEventSubscription(
          subscription,
          subscription,
        );
      }
    }
  }

  private publishPeerStatus(
    instanceId: FederationInstanceId,
    status: FederationConnectionState,
    unavailableReason?: string,
  ): void {
    const previous = this.publishedPeerStatuses.get(instanceId);
    if (
      previous?.status === status
      && previous.unavailableReason === unavailableReason
    ) {
      return;
    }
    this.publishedPeerStatuses.set(instanceId, { status, unavailableReason });
    // A connection transition changes whether cached remote rows are live.
    // Drop both the snapshot and any remembered refresh failure before the
    // renderer refreshes. Otherwise a fetch that races the disconnect can
    // leave a still-fresh cache marked degraded, and the reconnect refresh
    // has no reason to retry it until another navigation event arrives.
    this.remoteThreadSummaryCache?.invalidate(instanceId);
    this.clearRemoteNavigationTransportForPeer(instanceId);
    if (status === "connected") {
      // Hooked to the status TRANSITION (this method already de-dupes
      // repeats) rather than to a specific enrollment call site, so every
      // way a peer can come back — invite redemption, gateway re-pairing,
      // a relayed peer reappearing — restores its pins through one path.
      void this.restoreRemoteThreadPins(instanceId);
    }
    for (const listener of this.peerStatusListeners) {
      try {
        listener();
      } catch (error) {
        log.warn("federation peer status listener failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    this.publishAgentEvent?.({
      backend: "codex",
      federationTarget: {
        scope: "remote",
        instanceId,
      },
      notification: {
        method: "federation/peerStatus/changed",
        params: {
          instanceId,
          status,
          ...(unavailableReason ? { unavailableReason } : {}),
        },
      },
    });
  }

  private subscribeLocalBackendEvents(): void {
    this.unsubscribeLocalBackendEvents?.();
    this.unsubscribeLocalBackendEvents = getDesktopBackendRegistry().onEvent((event) => {
      this.forwardLocalBackendEvent(event);
    });
  }

  private forwardLocalBackendEvent(event: AgentEvent): void {
    if (!this.router) return;
    const ownerInstanceId = this.ensureLocalInstanceId();
    const federatedEvent = rewriteLiveTranscriptImagesForFederation(
      event,
      ownerInstanceId,
    );
    const eventClass = federationEventClassForMethod(
      federatedEvent.notification.method,
    );

    for (const [subscriberInstanceId, subscription] of
      this.incomingEventSubscriptions) {
      if (!subscription.eventClasses.has(eventClass)) continue;
      if (
        eventClass !== "star_map"
        && !eventMatchesThreadSelection(
          federatedEvent,
          eventClass,
          subscription.threadSelection,
        )
      ) {
        continue;
      }
      try {
        this.sendEnvelopeToEventSubscriber(subscriberInstanceId, {
          id: `federation-event:${randomUUID()}`,
          kind: "notification",
          method: FEDERATION_BACKEND_EVENT_METHOD,
          params: {
            backend: federatedEvent.backend,
            notification: federatedEvent.notification,
          },
          protocolVersion: FEDERATION_PROTOCOL_VERSION,
          sourceInstanceId: ownerInstanceId,
          targetInstanceId: subscriberInstanceId,
          createdAt: Date.now(),
        });
      } catch {
        // Connection teardown clears the subscription. A route that vanished
        // between iteration and send simply misses this live notification.
      }
    }
  }

  private publishRemoteBackendEvent(
    envelope: FederationProtocolEnvelope,
    sourcePeerId: FederationInstanceId,
  ): boolean {
    if (
      envelope.kind !== "notification" ||
      envelope.method !== FEDERATION_BACKEND_EVENT_METHOD
    ) {
      return false;
    }

    const notification = envelope as FederationBackendEventNotification & typeof envelope;
    const eventClass = federationEventClassForMethod(
      notification.params.notification.method,
    );
    const targetInstanceId = envelope.targetInstanceId;
    if (
      targetInstanceId
      && targetInstanceId !== this.ensureLocalInstanceId()
    ) {
      this.relaySubscribedBackendEvent(envelope, sourcePeerId, eventClass);
      return true;
    }
    const sourceInstanceId = envelope.sourceInstanceId || sourcePeerId;
    if (
      !targetInstanceId
      || !this.wantsRemoteEvent(sourceInstanceId, eventClass)
    ) {
      return true;
    }
    if (
      sourceInstanceId !== sourcePeerId
      && sourcePeerId !== this.gatewayInstanceId
    ) {
      return true;
    }
    const event: AgentEvent = {
      backend: notification.params.backend,
      federationTarget: {
        scope: "remote",
        instanceId: sourceInstanceId,
      },
      notification: notification.params.notification,
    };
    if (
      eventClass !== "star_map"
      && !eventMatchesThreadSelection(
        event,
        eventClass,
        this.desiredThreadSelectionFor(sourceInstanceId) ?? { kind: "all" },
      )
    ) {
      return true;
    }
    if (
      event.notification.method === "thread/pullRequests/updated"
      || event.notification.method === "thread/reactions/updated"
      || event.notification.method === "thread/name/updated"
      || REMOTE_THREAD_SUMMARY_LIFECYCLE_METHODS.has(
        event.notification.method,
      )
    ) {
      this.remoteThreadSummaryCache?.invalidate(sourceInstanceId);
    }
    this.publishAgentEvent?.(event);
    for (const listener of this.remoteBackendEventListeners) {
      void Promise.resolve(listener(event)).catch((error) => {
        log.warn("federation remote backend event listener failed", {
          error: error instanceof Error ? error.message : String(error),
          method: event.notification.method,
        });
      });
    }
    return true;
  }
}

/**
 * Fallback display name when the operator has not set one: the machine
 * hostname (minus the mDNS suffix) beats both the profile name (almost
 * always "default") and the raw instance GUID for recognizing a peer.
 */
export function defaultInstanceLabel(): string {
  const host = hostname().trim().replace(/\.local$/i, "");
  return host || "PwrAgent";
}

let messagingPlatformStatusReader:
  | (() => MessagingPlatformStatus[] | Promise<MessagingPlatformStatus[]>)
  | undefined;

/**
 * Wire the local messaging runtime's platform statuses into the federation
 * backend so remote viewers can render this instance's MSG chip. Registered
 * by the messaging IPC layer (which owns the runtime singleton) to keep the
 * federation runtime free of a messaging-runtime import cycle.
 */
export function setFederationMessagingPlatformStatusReader(
  reader:
    | (() => MessagingPlatformStatus[] | Promise<MessagingPlatformStatus[]>)
    | undefined,
): void {
  messagingPlatformStatusReader = reader;
}

async function resolveFederatedWorktreeGitReadContext(request: {
  backend?: ListWorktreeUnpublishedCommitsRequest["backend"];
  threadId?: string;
  worktreePath: string;
}): Promise<{
  acceptedPushedCommitShas: string[];
  worktreePath: string;
}> {
  if (!request.backend || !request.threadId?.trim()) {
    throw new Error(
      "Federated unpublished commit reads require an owning thread identity.",
    );
  }
  const context = await getDesktopBackendRegistry()
    .resolveThreadWorktreeGitReadContext({
      backend: request.backend,
      threadId: request.threadId,
      worktreePath: request.worktreePath,
    });
  if (!context) {
    throw new Error(
      "Federated unpublished commit reads must target the owning thread's worktree.",
    );
  }
  return context;
}

/**
 * A cross-instance child is not legible on its owning instance unless the
 * remote parent is mounted beside it. Import that parent as part of accepting
 * the child creation request, then mirror the normal created-thread visibility
 * rule when the child's Directory Threads section is collapsed.
 */
async function mountRemoteParentForLocalChild(
  request: MaterializeDirectoryLaunchpadRequest,
  response: MaterializeDirectoryLaunchpadResponse,
  sourceInstanceId?: FederationInstanceId,
): Promise<void> {
  const parentThreadId = request.parentThreadId?.trim();
  const parentInstanceId = request.parentThreadInstanceId?.trim();
  if (!parentThreadId || !parentInstanceId) {
    return;
  }
  const runtime = getDesktopFederationRuntime();
  const localInstanceId = (await runtime.health()).instanceId;
  if (!localInstanceId || parentInstanceId === localInstanceId) {
    return;
  }
  const parentBackend = request.parentThreadBackend ?? response.backend;
  const target = {
    scope: "remote" as const,
    instanceId: parentInstanceId,
  };
  const parentSummary = await runtime.remoteThreadSummaries().threadFromPeer({
    target,
    backend: parentBackend,
    threadId: parentThreadId,
  });
  if (!parentSummary && parentInstanceId !== sourceInstanceId) {
    return;
  }
  const fallbackLinkedDirectory = response.linkedDirectory
    ?? (
      request.launchpad?.directoryPath
      && request.launchpad.directoryKind !== "workspace"
        ? {
            id: `federated-parent:${request.launchpad.directoryKey}`,
            label: request.launchpad.directoryLabel,
            path: request.launchpad.directoryPath,
            kind: response.workMode === "worktree"
              ? "worktree" as const
              : "local" as const,
          }
        : undefined
    );
  const fallbackParent: NavigationThreadSummary = {
    source: parentBackend,
    id: parentThreadId,
    title: parentThreadId,
    titleSource: "fallback",
    linkedDirectories: fallbackLinkedDirectory
      ? [fallbackLinkedDirectory]
      : [],
    inbox: { inInbox: false },
  };
  const summary = parentSummary ?? fallbackParent;
  const ref = buildFederatedThreadRef({
    backend: parentBackend,
    instanceId: parentInstanceId,
    threadId: parentThreadId,
  });
  const overlayStore = getDesktopOverlayStore();
  const instanceLabel =
    parentSummary?.federation?.instanceLabel ?? parentInstanceId;
  const existingPins = await overlayStore.listRemoteThreadPins();
  const existingPin = existingPins.find(
    (pin) =>
      pin.ref.backend === ref.backend
      && pin.ref.threadId === ref.threadId
      && isRemoteFederationTarget(pin.ref.target)
      && pin.ref.target.instanceId === parentInstanceId,
  );
  if (existingPin) {
    // Snapshot refreshes must not replace viewer-owned rank or provenance.
    // In particular, creating another child cannot demote an explicit pin to
    // a companion or remove it from the viewer's Pins section.
    await overlayStore.updateRemoteThreadPinSnapshots([{
      ref,
      summary,
      instanceLabel,
    }]);
  } else {
    await overlayStore.addRemoteThreadPin({
      ref,
      summary,
      instanceLabel,
      pinnedVia: "companion",
    });
  }

  const snapshot = await new DesktopMessagingBackendBridge()
    .getNavigationSnapshot({});
  const launchpadDirectoryKey =
    request.launchpad?.directoryKey ?? request.directoryKey;
  const launchpadDirectoryPath = request.launchpad?.directoryPath?.trim();
  const normalizedLaunchpadDirectoryPath = launchpadDirectoryPath
    ? path.resolve(launchpadDirectoryPath)
    : undefined;
  const childDirectory = snapshot.directories.find(
    (directory) => directory.key === launchpadDirectoryKey,
  ) ?? (
    normalizedLaunchpadDirectoryPath
      ? snapshot.directories.find(
          (directory) =>
            directory.path
            && path.resolve(directory.path) === normalizedLaunchpadDirectoryPath,
        )
      : undefined
  );
  const localRanks = await overlayStore.listPinnedThreadOverlayRanks();
  const remotePins = await overlayStore.listRemoteThreadPins();
  const parentPin = remotePins.find(
    (pin) =>
      pin.ref.backend === ref.backend
      && pin.ref.threadId === ref.threadId
      && isRemoteFederationTarget(pin.ref.target)
      && pin.ref.target.instanceId === parentInstanceId,
  );
  const hasPinnedTopLevelThread =
    localRanks.some((entry) => !entry.parentThreadId)
    || remotePins.some(
      (pin) => pin.localPinnedRank && !pin.summary?.parentThreadId,
    );
  if (
    childDirectory?.directoryThreadsCollapsed
    && hasPinnedTopLevelThread
    && !parentPin?.localPinnedRank
  ) {
    await overlayStore.setRemoteThreadLocalPin({
      ref,
      pinnedRank: buildAppendPinRank(
        [
          ...localRanks.map((entry) => entry.pinnedRank),
          ...remotePins.map((pin) => pin.localPinnedRank),
        ],
      ),
    });
  }

  await getDesktopBackendRegistry().publishLocalEvent({
    backend: parentBackend,
    notification: {
      method: "navigation/remoteThreadPins/changed",
      params: {
        instanceId: parentInstanceId,
        threadId: parentThreadId,
        pinned: true,
      },
    },
  });
}

function localBackendOperations(): FederationBackendOperations {
  const messagingBridge = new DesktopMessagingBackendBridge();
  return {
    async getNavigationSnapshot(request = {}): Promise<NavigationSnapshot> {
      return await messagingBridge.getNavigationSnapshot(request);
    },
    async searchNavigationThreads(request) {
      return await messagingBridge.searchNavigationThreads(request);
    },
    async listThreads(
      request: AppServerListThreadsRequest = {},
    ): Promise<AppServerListThreadsResponse> {
      const threads = await getDesktopBackendRegistry().listThreads({
        backend: request.backend,
        archived: request.archived,
        callerReason: "federation-list-threads",
        filter: request.filter,
      });
      return {
        backend: request.backend ?? "all",
        fetchedAt: Date.now(),
        threads,
      };
    },
    async resolveThread(request) {
      const thread = await getDesktopBackendRegistry().resolveThread(request);
      return thread ? { thread } : {};
    },
    async resolveThreadAdmissionState(request) {
      return await new DesktopMessagingBackendBridge()
        .getThreadAdmissionState(request);
    },
    async readThread(
      request: AppServerReadThreadRequest,
    ): Promise<AppServerReadThreadResponse> {
      const backend = request.backend ?? "codex";
      const response = await getDesktopBackendRegistry().readThread({
        backend,
        threadId: request.threadId,
        ...(request.includeTurns !== undefined
          ? { includeTurns: request.includeTurns }
          : {}),
        ...(request.includeAllToolInvocations !== undefined
          ? { includeAllToolInvocations: request.includeAllToolInvocations }
          : {}),
        before: request.before,
        limit: request.limit,
        ...(request.viewOnly !== undefined
          ? { viewOnly: request.viewOnly }
          : {}),
      });
      return rewriteTranscriptImageUrlsForRenderer(response);
    },
    async analyzeThreadToolHistory(
      request: AnalyzeThreadToolHistoryRequest,
    ): Promise<AnalyzeThreadToolHistoryResponse> {
      /* Runs on the instance that owns the transcript — the scan pages the
         thread's own history, which a viewer cannot reach. */
      return await getDesktopBackendRegistry().analyzeThreadToolHistory({
        backend: request.backend,
        threadId: request.threadId,
      });
    },
    async readTranscriptImage(request) {
      return await readTranscriptImageProtocolRequest(request.url);
    },
    async listSkills(
      request: AppServerListSkillsRequest = {},
    ): Promise<AppServerListSkillsResponse> {
      const backend = request.backend ?? "codex";
      const response = await getDesktopBackendRegistry().listSkills({
        backend,
        cwd: request.cwd,
        cwds: request.cwds,
        threadId: request.threadId,
      });
      return {
        backend,
        fetchedAt: Date.now(),
        data: response.data,
      };
    },
    async listBackends(request = {}) {
      return await getDesktopBackendRegistry().listBackends(request);
    },
    async markThreadSeen(
      request: MarkThreadSeenRequest,
    ): Promise<MarkThreadSeenResponse> {
      const backend = request.backend ?? "codex";
      return await getDesktopOverlayStore().markThreadSeen({
        backend,
        seenAt: request.seenAt,
        seenUpdatedAt: request.seenUpdatedAt,
        threadId: request.threadId,
      });
    },
    async setThreadPin(
      request: SetThreadPinRequest,
    ): Promise<SetThreadPinResponse> {
      const backend = request.backend ?? "codex";
      const overlay = await getDesktopOverlayStore().setThreadPin({
        backend,
        threadId: request.threadId,
        pinnedRank: request.pinnedRank,
      });
      // Publish so this instance's own windows AND connected remote
      // viewers converge on the new pin state.
      await getDesktopBackendRegistry().publishLocalEvent({
        backend,
        notification: overlay.pinnedRank
          ? {
              method: "thread/pin/added",
              params: {
                threadId: request.threadId,
                pinnedRank: overlay.pinnedRank,
              },
            }
          : {
              method: "thread/pin/removed",
              params: {
                threadId: request.threadId,
              },
            },
      });
      return {
        backend,
        threadId: request.threadId,
        pinnedRank: overlay.pinnedRank,
      };
    },
    async setThreadReaction(
      request: SetThreadReactionRequest,
    ): Promise<SetThreadReactionResponse> {
      const backend = request.backend ?? "codex";
      const overlay = await getDesktopOverlayStore().setThreadReaction({
        backend,
        threadId: request.threadId,
        emoji: request.emoji,
        present: request.present,
      });
      const reactions = overlay.reactions ?? [];
      await getDesktopBackendRegistry().publishLocalEvent({
        backend,
        notification: {
          method: "thread/reactions/updated",
          params: {
            threadId: request.threadId,
            reactions,
          },
        },
      });
      return {
        backend,
        threadId: request.threadId,
        reactions,
      };
    },
    async readMessagingPlatformStatuses(): Promise<MessagingPlatformStatus[]> {
      // Registered by the messaging IPC layer — messaging-runtime imports
      // this module for event fan-out, so importing it back would be a
      // cycle. An unregistered reader (messaging not wired yet) reads as
      // "no platforms configured", which renders as no MSG chip.
      return await (messagingPlatformStatusReader?.() ?? []);
    },
    async detachThreadPullRequest(
      request: DetachThreadPullRequestRequest,
    ): Promise<DetachThreadPullRequestResponse> {
      // Delegates to the app-server service (PR status registry + dispatch
      // coordinator live there); the resulting thread/pullRequests/updated
      // event fans back out to remote viewers.
      return await getDesktopBackendRegistry().detachThreadPullRequest(request);
    },
    async setThreadPrAutoDispatch(
      request: SetThreadPrAutoDispatchRequest,
    ): Promise<SetThreadPrAutoDispatchResponse> {
      return await getDesktopBackendRegistry().setThreadPrAutoDispatch(request);
    },
    async cancelThreadPrAutoDispatch(
      request: CancelThreadPrAutoDispatchRequest,
    ): Promise<CancelThreadPrAutoDispatchResponse> {
      return await getDesktopBackendRegistry().cancelThreadPrAutoDispatch(
        request,
      );
    },
    async sendThreadPrAutoDispatchNow(
      request: SendThreadPrAutoDispatchNowRequest,
    ): Promise<SendThreadPrAutoDispatchNowResponse> {
      return await getDesktopBackendRegistry().sendThreadPrAutoDispatchNow(
        request,
      );
    },
    async reorderThreadPins(
      request: ReorderThreadPinsRequest,
    ): Promise<ReorderThreadPinsResponse> {
      const pinnedRanks = await getDesktopOverlayStore().reorderThreadPins({
        threadKeys: request.threadKeys,
      });
      // Pin order is global across backends; the backend field is
      // required by publishLocalEvent but irrelevant here (matches the
      // app-server reorder handler).
      await getDesktopBackendRegistry().publishLocalEvent({
        backend: "codex",
        notification: {
          method: "thread/pin/reordered",
          params: {
            pinnedRanks,
          },
        },
      });
      return { pinnedRanks };
    },
    async mountRemoteChild(request) {
      const target = request.ref.target;
      if (!isRemoteFederationTarget(target)) {
        throw new Error("A federated child mount must target a remote instance.");
      }
      await getDesktopOverlayStore().addRemoteThreadPin({
        ref: request.ref,
        summary: request.summary,
        instanceLabel: request.instanceLabel,
        pinnedVia: "child",
      });
      await getDesktopBackendRegistry().publishLocalEvent({
        backend: request.ref.backend,
        notification: {
          method: "navigation/remoteThreadPins/changed",
          params: {
            instanceId: target.instanceId,
            threadId: request.ref.threadId,
            pinned: true,
          },
        },
      });
      return { mounted: true };
    },
    async setThreadParent(
      request: SetThreadParentRequest,
    ) {
      const backend = request.backend ?? "codex";
      const overlay = await getDesktopOverlayStore().setThreadParent({
        backend,
        threadId: request.threadId,
        parentThreadId: request.parentThreadId,
        parentThreadBackend: request.parentThreadBackend,
        parentThreadInstanceId: request.parentThreadInstanceId,
      });
      await getDesktopBackendRegistry().publishLocalEvent({
        backend,
        notification: overlay.parentThreadId
          ? {
              method: "thread/parent/set",
              params: {
                threadId: request.threadId,
                parentThreadId: overlay.parentThreadId,
                parentThreadBackend: overlay.parentThreadBackend,
                parentThreadInstanceId: overlay.parentThreadInstanceId,
              },
            }
          : {
              method: "thread/parent/cleared",
              params: { threadId: request.threadId },
            },
      });
      return {
        backend,
        threadId: request.threadId,
        parentThreadId: overlay.parentThreadId,
        parentThreadBackend: overlay.parentThreadBackend,
        parentThreadInstanceId: overlay.parentThreadInstanceId,
      };
    },
    async updateSubthreadOrder(
      request: UpdateSubthreadOrderRequest,
    ): Promise<UpdateSubthreadOrderResponse> {
      const backend = request.backend ?? "codex";
      const threadIds = await getDesktopOverlayStore().updateSubthreadOrder({
        backend,
        parentThreadId: request.parentThreadId,
        threadIds: request.threadIds,
      });
      await getDesktopBackendRegistry().publishLocalEvent({
        backend,
        notification: {
          method: "thread/subthreadOrder/updated",
          params: {
            parentThreadId: request.parentThreadId,
            threadIds,
          },
        },
      });
      return {
        backend,
        parentThreadId: request.parentThreadId,
        threadIds,
      };
    },
    async setSubthreadsCollapsed(
      request: SetSubthreadsCollapsedRequest,
    ): Promise<SetSubthreadsCollapsedResponse> {
      const backend = request.backend ?? "codex";
      const overlay = await getDesktopOverlayStore().setSubthreadsCollapsed({
        backend,
        parentThreadId: request.parentThreadId,
        collapsed: request.collapsed,
      });
      const collapsed = overlay.subthreadsCollapsed === true;
      await getDesktopBackendRegistry().publishLocalEvent({
        backend,
        notification: {
          method: "thread/subthreadsCollapsed/updated",
          params: {
            parentThreadId: request.parentThreadId,
            collapsed,
          },
        },
      });
      return {
        backend,
        parentThreadId: request.parentThreadId,
        collapsed,
      };
    },
    async archiveThread(request) {
      const response = await getDesktopBackendRegistry().archiveThread(request);
      await getDesktopFederationRuntime().ungroupRemoteChildrenOfArchivedThread({
        backend: response.backend,
        parentThreadId: response.threadId,
      });
      return response;
    },
    async startThread(request: StartThreadRequest): Promise<StartThreadResponse> {
      return await getDesktopBackendRegistry().startThread(request);
    },
    async forkThread(
      request: ForkThreadRequest,
      options?: Pick<
        MaterializeDirectoryLaunchpadOptions,
        "onCodexEnvironmentSetupProgress"
      >,
    ): Promise<ForkThreadResponse> {
      return await getDesktopBackendRegistry().forkThread({
        ...request,
        onCodexEnvironmentSetupProgress:
          options?.onCodexEnvironmentSetupProgress,
      });
    },
    async startTurn(
      request: FederationStartTurnRequest,
    ): Promise<StartTurnResponse> {
      const submitted = await getDesktopBackendRegistry().submitTurn({
        ...request,
        origin: "manual",
      });
      return submitted.status === "started"
        ? {
            backend: submitted.entry.backend,
            threadId: submitted.entry.threadId,
            turnId: submitted.turnId,
            queueStatus: "started",
            queueEntryId: submitted.entry.id,
          }
        : {
            backend: submitted.entry.backend,
            threadId: submitted.entry.threadId,
            turnId: submitted.entry.id,
            queueStatus: "queued",
            queueEntryId: submitted.entry.id,
          };
    },
    async startReview(
      request: StartReviewRequest,
    ): Promise<StartReviewResponse> {
      return await getDesktopBackendRegistry().startReview(request);
    },
    async readQueuedTurn(request: ReadQueuedTurnRequest): Promise<ReadQueuedTurnResponse> {
      return getDesktopBackendRegistry().readQueuedTurn(request, request.forEdit === true);
    },
    async cancelQueuedTurn(
      request: CancelQueuedTurnRequest,
    ): Promise<CancelQueuedTurnResponse> {
      return getDesktopBackendRegistry().cancelQueuedTurnWithDisposition(
        request.queueEntryId,
        "Cancelled from a federated desktop composer.",
        request.expectedContentHash,
      );
    },
    async releaseQueuedTurn(
      request: ReleaseQueuedTurnRequest,
    ): Promise<ReleaseQueuedTurnResponse> {
      return await getDesktopBackendRegistry().releaseQueuedTurnWithDisposition(
        request.queueEntryId,
      );
    },
    async listScheduledThreadActions(
      request: ListScheduledThreadActionsRequest = {},
    ): Promise<ListScheduledThreadActionsResponse> {
      const { getScheduledThreadActionService } = await import(
        "../scheduled-actions/scheduled-thread-action-service.js"
      );
      return getScheduledThreadActionService().list(request);
    },
    async createScheduledThreadAction(
      request: CreateScheduledThreadActionRequest,
    ): Promise<ScheduledThreadActionMutationResponse> {
      const { getScheduledThreadActionService } = await import(
        "../scheduled-actions/scheduled-thread-action-service.js"
      );
      return await getScheduledThreadActionService().create(request);
    },
    async updateScheduledThreadAction(
      request: UpdateScheduledThreadActionRequest,
    ): Promise<ScheduledThreadActionMutationResponse> {
      const { getScheduledThreadActionService } = await import(
        "../scheduled-actions/scheduled-thread-action-service.js"
      );
      return await getScheduledThreadActionService().update(request);
    },
    async cancelScheduledThreadAction(
      request: ScheduledThreadActionIdRequest,
    ): Promise<ScheduledThreadActionMutationResponse> {
      const { getScheduledThreadActionService } = await import(
        "../scheduled-actions/scheduled-thread-action-service.js"
      );
      return await getScheduledThreadActionService().cancel(request);
    },
    async sendScheduledThreadActionNow(
      request: ScheduledThreadActionIdRequest,
    ): Promise<ScheduledThreadActionMutationResponse> {
      const { getScheduledThreadActionService } = await import(
        "../scheduled-actions/scheduled-thread-action-service.js"
      );
      return await getScheduledThreadActionService().sendNow(request);
    },
    async compactThread(
      request: CompactThreadRequest,
    ): Promise<CompactThreadResponse> {
      return await getDesktopBackendRegistry().compactThread(request);
    },
    async listThreadMcpServers(
      request: ListThreadMcpServersRequest,
    ): Promise<ListThreadMcpServersResponse> {
      return await getDesktopBackendRegistry().listThreadMcpServers(request);
    },
    async reloadCodexMcpConfig(
      request: ReloadCodexMcpConfigRequest,
    ): Promise<ReloadCodexMcpConfigResponse> {
      return await getDesktopBackendRegistry().reloadCodexMcpConfig(request);
    },
    async controlActiveTurn(
      request: ControlActiveTurnRequest,
    ): Promise<ControlActiveTurnResponse> {
      return await getDesktopBackendRegistry().controlActiveTurn(request);
    },
    async resolveActiveTurn(
      request: ResolveActiveTurnRequest,
    ): Promise<ResolveActiveTurnResponse> {
      const active = getDesktopBackendRegistry().getActiveTurnForThread(request);
      return {
        backend: request.backend,
        threadId: request.threadId,
        ...(active ? { turnId: active.turnId } : {}),
      };
    },
    async interruptTurn(
      request: InterruptTurnRequest,
    ): Promise<InterruptTurnResponse> {
      return await getDesktopBackendRegistry().interruptTurn(request);
    },
    async stopSubAgent(
      request: StopSubAgentRequest,
    ): Promise<StopSubAgentResponse> {
      return await getDesktopBackendRegistry().stopSubAgent(request);
    },
    async steerTurn(request: SteerTurnRequest): Promise<SteerTurnResponse> {
      const registry = getDesktopBackendRegistry();
      const { admitSteerTurn } = await import(
        "../scheduled-actions/steer-turn-admission.js"
      );
      const { getScheduledThreadActionService } = await import(
        "../scheduled-actions/scheduled-thread-action-service.js"
      );
      return await admitSteerTurn(
        registry,
        getScheduledThreadActionService(registry),
        request,
      );
    },
    async setThreadExecutionMode(
      request: SetThreadExecutionModeRequest,
    ): Promise<SetThreadExecutionModeResponse> {
      return await getDesktopBackendRegistry().setThreadExecutionMode(request);
    },
    async queueThreadExecutionMode(
      request: QueueThreadExecutionModeRequest,
    ): Promise<QueueThreadExecutionModeResponse> {
      return await getDesktopBackendRegistry().queueThreadExecutionMode(request);
    },
    async cancelThreadExecutionModeQueue(
      request: CancelThreadExecutionModeQueueRequest,
    ): Promise<CancelThreadExecutionModeQueueResponse> {
      return await getDesktopBackendRegistry().cancelThreadExecutionModeQueue(request);
    },
    async setAcpSessionRuntimeOption(
      request: SetAcpSessionRuntimeOptionRequest,
    ): Promise<SetAcpSessionRuntimeOptionResponse> {
      return await getDesktopBackendRegistry().setAcpSessionRuntimeOption(request);
    },
    async setThreadModelSettings(
      request: SetThreadModelSettingsRequest,
    ): Promise<SetThreadModelSettingsResponse> {
      return await getDesktopBackendRegistry().setThreadModelSettings(request);
    },
    async checkThreadBranchDrift(
      request: CheckThreadBranchDriftRequest,
    ): Promise<CheckThreadBranchDriftResponse> {
      return await getDesktopBackendRegistry().checkThreadBranchDrift(request);
    },
    async updateThreadExpectedBranch(
      request: UpdateThreadExpectedBranchRequest,
    ): Promise<UpdateThreadExpectedBranchResponse> {
      return await getDesktopBackendRegistry().updateThreadExpectedBranch(request);
    },
    async retainThreadBranchDrift(
      request: RetainThreadBranchDriftRequest,
    ): Promise<RetainThreadBranchDriftResponse> {
      return await getDesktopBackendRegistry().retainThreadBranchDrift(request);
    },
    async submitServerRequest(
      request: SubmitServerRequestRequest,
    ): Promise<SubmitServerRequestResponse> {
      return await getDesktopBackendRegistry().submitServerRequest(request);
    },
    async runCodexEnvironmentAction(
      request: RunCodexEnvironmentActionRequest,
    ): Promise<RunCodexEnvironmentActionResponse> {
      return await getDesktopBackendRegistry().runCodexEnvironmentAction(request);
    },
    async stopCodexEnvironmentAction(
      request: StopCodexEnvironmentActionRequest,
    ): Promise<StopCodexEnvironmentActionResponse> {
      return await getDesktopBackendRegistry().stopCodexEnvironmentAction(request);
    },
    async setCodexThreadEnvironment(
      request: SetCodexThreadEnvironmentRequest,
    ): Promise<SetCodexThreadEnvironmentResponse> {
      return await getDesktopBackendRegistry().setCodexThreadEnvironment(request);
    },
    async refreshDirectoryGitStatuses(
      request: RefreshDirectoryGitStatusesRequest,
    ): Promise<RefreshDirectoryGitStatusesResponse> {
      return await getDesktopBackendRegistry().refreshDirectoryGitStatuses(request);
    },
    async refreshThreadPullRequests(
      request: FederationRefreshThreadPullRequestsRequest,
    ): Promise<RefreshThreadPullRequestsResponse> {
      return await getDesktopBackendRegistry().refreshOwnedThreadPullRequests(request);
    },
    async ensureDirectoryLaunchpad(request: EnsureDirectoryLaunchpadRequest) {
      return await new DesktopMessagingBackendBridge()
        .ensureDirectoryLaunchpad(request);
    },
    async listRecentFileReferences(): Promise<ListRecentFileReferencesResponse> {
      return {
        files: listRecentFileReferencePaths(getAppStateDb()).map((filePath) => ({
          label: path.basename(filePath),
          path: filePath,
        })),
      };
    },
    async recordRecentFileReferences(
      request: RecordRecentFileReferencesRequest,
    ): Promise<void> {
      recordRecentFileReferencePaths(getAppStateDb(), request.paths ?? []);
    },
    async listModelSettingsRecents(
      request: ListModelSettingsRecentsRequest,
    ): Promise<ListModelSettingsRecentsResponse> {
      return {
        recents: listModelSettingsRecents(getAppStateDb(), request.scope),
      };
    },
    async recordModelSettingsRecent(
      request: RecordModelSettingsRecentRequest,
    ): Promise<void> {
      recordModelSettingsRecent(getAppStateDb(), request.scope, request.recent);
    },
    async attachDirectoryToThread(
      request: AttachDirectoryToThreadRequest,
    ): Promise<AttachDirectoryToThreadResponse> {
      const backend = request.backend ?? "codex";
      const bridge = new DesktopMessagingBackendBridge();
      const registered = await registerDirectoryFromDisk(
        {
          path: request.path,
          preferredBackend: request.preferredBackend ?? backend,
        },
        {
          ensureDirectoryLaunchpad: (ensureRequest) =>
            bridge.ensureDirectoryLaunchpad(ensureRequest),
        },
      );
      if (!registered.ok) {
        return {
          ok: false,
          backend,
          threadId: request.threadId,
          reason: registered.reason,
          message: registered.message,
        };
      }
      const directoryPath = path
        .resolve(registered.directoryPath)
        .replace(/\\/g, "/");
      const directory = {
        id: directoryPath,
        kind: "local" as const,
        label: registered.directoryLabel,
        path: directoryPath,
      };
      await getDesktopOverlayStore().addLinkedDirectory({
        backend,
        threadId: request.threadId,
        directory,
      });
      await getDesktopBackendRegistry().publishLocalEvent({
        backend,
        notification: {
          method: "navigation/threadDirectories/updated",
          params: {
            reason: "selected-thread",
            threadIds: [request.threadId],
          },
        },
      });
      return {
        ok: true,
        backend,
        threadId: request.threadId,
        directory,
      };
    },
    async listWorktreeUnpublishedCommits(
      request: ListWorktreeUnpublishedCommitsRequest,
    ): Promise<ListWorktreeUnpublishedCommitsResponse> {
      const context = await resolveFederatedWorktreeGitReadContext(request);
      return await getDesktopBackendRegistry().listWorktreeUnpublishedCommits(
        context.worktreePath,
        {
          acceptedPushedCommitShas: context.acceptedPushedCommitShas,
          maxCommits: request.maxCommits,
          maxFilesPerCommit: request.maxFilesPerCommit,
        },
      );
    },
    async getWorktreeUnpublishedCommitDiff(
      request: GetWorktreeUnpublishedCommitDiffRequest,
    ): Promise<GetWorktreeUnpublishedCommitDiffResponse> {
      const context = await resolveFederatedWorktreeGitReadContext(request);
      return await getDesktopBackendRegistry().getWorktreeUnpublishedCommitDiff(
        context.worktreePath,
        request.commitSha,
        request.path,
        {
          acceptedPushedCommitShas: context.acceptedPushedCommitShas,
          maxBytes: request.maxBytes,
        },
      );
    },
    async materializeDirectoryLaunchpad(
      request: MaterializeDirectoryLaunchpadRequest,
      options?: MaterializeDirectoryLaunchpadOptions & {
        sourceInstanceId?: FederationInstanceId;
      },
    ): Promise<MaterializeDirectoryLaunchpadResponse> {
      const response = await getDesktopBackendRegistry()
        .materializeDirectoryLaunchpad(request, options);
      try {
        await mountRemoteParentForLocalChild(
          request,
          response,
          options?.sourceInstanceId,
        );
      } catch (error) {
        log.warn("failed to mount remote parent for local child", {
          error: error instanceof Error ? error.message : String(error),
          parentInstanceId: request.parentThreadInstanceId,
          parentThreadId: request.parentThreadId,
          threadId: response.threadId,
        });
      }
      return response;
    },
    async handoffThreadWorkspace(
      request: HandoffThreadWorkspaceRequest,
    ): Promise<HandoffThreadWorkspaceResponse> {
      return await getDesktopBackendRegistry().handoffThreadWorkspace(request);
    },
    async renameThread(
      request: RenameThreadRequest,
    ): Promise<RenameThreadResponse> {
      return await getDesktopBackendRegistry().renameThread(request);
    },
    async readApplications(): Promise<DesktopApplicationsSnapshot> {
      return await discoverDesktopApplications();
    },
    async openApplication(
      request: OpenDesktopApplicationRequest,
    ): Promise<OpenDesktopApplicationResponse> {
      return await openDesktopApplication(request);
    },
    async readPwrSnapConnectionStatus(): Promise<PwrSnapConnectionStatus> {
      return await getPwrSnapConnectionService().readStatus();
    },
    async getLoadStatus(): Promise<FederationLoadStatus> {
      return await collectFederationLoadStatus();
    },
    async trustCodexProject(
      request: TrustCodexProjectRequest,
    ): Promise<TrustCodexProjectResponse> {
      return await getDesktopBackendRegistry().trustCodexProject(request);
    },
    async setCelestialIcon(
      request: SetCelestialIconRequest,
    ): Promise<SetCelestialIconResponse> {
      return await getDesktopFederationRuntime().setCelestialIcon(request);
    },
    async starMapIntake(
      request: StarMapIntakeRequest,
    ): Promise<StarMapIntakeResponse> {
      return await dispatchStarMapIntake(request);
    },
  };
}

let runtime: DesktopFederationRuntime | undefined;

export function getDesktopFederationRuntime(): DesktopFederationRuntime {
  runtime ??= new DesktopFederationRuntime();
  return runtime;
}

export async function disposeDesktopFederationRuntime(): Promise<void> {
  await runtime?.stop();
  runtime = undefined;
}
