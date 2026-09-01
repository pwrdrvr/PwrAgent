import { createHash } from "node:crypto";
import type {
  AgentEvent,
  AppServerBackendKind,
  AppServerThreadMessageOrigin,
  AppServerThreadMessage,
  AppServerThreadReplay,
  AppServerListSkillsRequest,
  AppServerListSkillsResponse,
  AppServerThreadStatus,
  CancelThreadExecutionModeQueueRequest,
  CancelThreadExecutionModeQueueResponse,
  CompactThreadRequest,
  CompactThreadResponse,
  CreateScheduledThreadActionRequest,
  EnsureDirectoryLaunchpadRequest,
  EnsureDirectoryLaunchpadResponse,
  FederationCapability,
  FederationEventSubscription,
  FederationHealthStatus,
  FederationInstanceId,
  FederationRemoteTarget,
  FederationTarget,
  FederationThreadSelection,
  GetNavigationSnapshotRequest,
  HandoffThreadWorkspaceRequest,
  HandoffThreadWorkspaceResponse,
  InterruptTurnRequest,
  InterruptTurnResponse,
  ListBackendsRequest,
  ListBackendsResponse,
  ListScheduledThreadActionsRequest,
  ListScheduledThreadActionsResponse,
  MaterializeDirectoryLaunchpadOptions,
  MaterializeDirectoryLaunchpadRequest,
  MaterializeDirectoryLaunchpadResponse,
  NavigationSnapshot,
  NavigationThreadSummary,
  SetAcpSessionRuntimeOptionRequest,
  SetAcpSessionRuntimeOptionResponse,
  SetThreadExecutionModeRequest,
  SetThreadExecutionModeResponse,
  SetThreadModelSettingsRequest,
  SetThreadModelSettingsResponse,
  StartTurnRequest,
  StartTurnResponse,
  ScheduledThreadActionIdRequest,
  ScheduledThreadActionMutationResponse,
  SteerTurnRequest,
  SteerTurnResponse,
  StartThreadRequest,
  StartThreadResponse,
  StartReviewRequest,
  SubmitServerRequestRequest,
  SubmitServerRequestResponse,
  ThreadAgentMetadata,
  ThreadMessagingBindingTransition,
  ThreadOverlayState,
  UpdateScheduledThreadActionRequest,
  UpdateDirectoryLaunchpadRequest,
  UpdateDirectoryLaunchpadResponse,
} from "@pwragent/shared";
import type { MessagingImagePart } from "@pwragent/messaging-interface";
import {
  buildThreadIdentityKey,
  buildFederatedThreadRef,
  isRemoteFederationTarget,
} from "@pwragent/shared";
import type {
  MessagingBackendBridge,
  MessagingLastAssistantReply,
  MessagingThreadAdmissionState,
} from "./core/messaging-adapter";
import { MessagingFederatedThreadTargetError } from "./core/messaging-adapter";
import type { DesktopBackendRegistry } from "../app-server/backend-registry";
import { getDesktopBackendRegistry } from "../app-server/backend-registry";
import { getDesktopOverlayStore } from "../app-server/desktop-overlay-store";
import { resolveScratchProjectsRoots } from "../app-server/scratch-projects";
import { buildMessagingBindingsByThreadKey } from "./messaging-bindings-snapshot";
import { hydrateLaunchpadCodexEnvironmentOptions } from "../app-server/codex-environment-config";
import { materializeTranscriptMessageImagesForMessaging } from "../transcript-image-protocol";
import type { FederationBackendOperations } from "../federation/federation-backend-bridge";
import {
  FederatedThreadTargetError,
  resolveFederatedThreadTarget,
} from "../federation/federated-thread-target-service";
import { getScheduledThreadActionService } from "../scheduled-actions/scheduled-thread-action-service";
import { selectStaleDirectoryGitStatusKeys } from "../app-server/directory-git-status-refresh-policy";

export type DesktopMessagingFederationBridge = {
  connectedPeerTargets(): Array<{
    target: FederationRemoteTarget;
    label: string;
    capabilities: FederationCapability[];
  }>;
  health(): Promise<FederationHealthStatus>;
  onRemoteBackendEvent(
    listener: (event: AgentEvent) => void | Promise<void>,
  ): () => void;
  setEventSubscriptions?(
    consumerId: string,
    subscriptions: readonly FederationEventSubscription[],
  ): FederationEventSubscription[];
  remoteBackend(target: FederationRemoteTarget): FederationBackendOperations;
  remoteNavigationSnapshot(
    target: FederationRemoteTarget,
    request: GetNavigationSnapshotRequest,
    selectionOverride?: FederationThreadSelection,
  ): Promise<NavigationSnapshot>;
};

export class DesktopMessagingBackendBridge implements MessagingBackendBridge {
  private readonly assistantImageResolutions = new Map<
    string,
    Promise<MessagingImagePart[]>
  >();

  constructor(
    private readonly registry: DesktopBackendRegistry = getDesktopBackendRegistry(),
    private readonly federation?: DesktopMessagingFederationBridge,
  ) {}

  getLocalFilePrivateStorageRoots(): readonly string[] {
    return this.registry.getLocalFilePrivateStorageRoots();
  }

  async getThreadAdmissionState(request: {
    backend: AppServerBackendKind;
    federationTarget?: FederationTarget;
    threadId: string;
  }): Promise<MessagingThreadAdmissionState> {
    const remote = this.remoteBackend(request.federationTarget);
    if (remote) {
      const target = request.federationTarget;
      if (!target || !isRemoteFederationTarget(target) || !this.federation) {
        throw new Error(
          "Remote messaging admission requires a federation target.",
        );
      }
      let state: MessagingThreadAdmissionState;
      if (!remote.resolveThreadAdmissionState) {
        state = await this.readLegacyRemoteThreadAdmissionState(
          target,
          request,
        );
      } else {
        try {
          state = await remote.resolveThreadAdmissionState({
            backend: request.backend,
            threadId: request.threadId,
          });
        } catch (error) {
          if (!isFederationMethodNotFoundError(error)) {
            throw error;
          }
          state = await this.readLegacyRemoteThreadAdmissionState(
            target,
            request,
          );
        }
      }
      const instanceLabel = this.federation.connectedPeerTargets().find(
        (peer) => peer.target.instanceId === target.instanceId,
      )?.label ?? target.instanceId;
      return {
        ...state,
        ...(state.thread
          ? {
              thread: {
                ...state.thread,
                federation: {
                  instanceLabel,
                  ref: buildFederatedThreadRef({
                    backend: request.backend,
                    instanceId: target.instanceId,
                    threadId: request.threadId,
                  }),
                },
              },
            }
          : {}),
      };
    }

    const store = getDesktopOverlayStore();
    const [overlay, cached] = await Promise.all([
      store.getThreadOverlayState({
        backend: request.backend,
        threadId: request.threadId,
      }),
      Promise.resolve(this.registry.getCachedThreadSummary({
        backend: request.backend,
        threadId: request.threadId,
      })),
    ]);
    const activeTurn = this.registry.getActiveTurnForThread(request);
    const threadStatus = this.registry.isThreadTurnOccupied(request)
      ? "active"
      : "idle";
    const threadKey = buildThreadIdentityKey(request.backend, request.threadId);
    const queuedExecutionMode =
      this.registry.getQueuedExecutionModesSnapshot()[threadKey];
    const queuedTurns = this.registry.getQueuedTurnsSnapshot()[threadKey];
    const thread = cached || overlay
      ? buildAdmissionThreadSummary({
          overlay,
          queuedExecutionMode,
          queuedTurns,
          summary: cached ?? {
            id: request.threadId,
            title: request.threadId,
            titleSource: "fallback",
            source: request.backend,
            linkedDirectories: overlay?.extraLinkedDirectories ?? [],
          },
        })
      : undefined;
    return {
      ...(activeTurn ? { activeTurn } : {}),
      ...(thread ? { thread } : {}),
      threadStatus,
    };
  }

  private async readLegacyRemoteThreadAdmissionState(
    target: FederationRemoteTarget,
    request: {
      backend: AppServerBackendKind;
      federationTarget?: FederationTarget;
      threadId: string;
    },
  ): Promise<MessagingThreadAdmissionState> {
    if (!this.federation) {
      throw new Error("Remote messaging admission requires federation.");
    }
    const navigation = await this.federation.remoteNavigationSnapshot(
      target,
      {
        backend: request.backend,
        federationTarget: target,
      },
      {
        kind: "threads",
        threads: [{ backend: request.backend, threadId: request.threadId }],
      },
    );
    const thread = navigation.threads.find(
      (candidate) => candidate.source === request.backend
        && candidate.id === request.threadId,
    );
    return {
      ...(thread ? { thread } : {}),
      ...(thread?.threadStatus ? { threadStatus: thread.threadStatus } : {}),
    };
  }

  async getNavigationSnapshot(
    request: GetNavigationSnapshotRequest = {},
  ): Promise<NavigationSnapshot> {
    if (
      request.federationTarget &&
      isRemoteFederationTarget(request.federationTarget) &&
      this.federation
    ) {
      return await this.federation.remoteNavigationSnapshot(
        request.federationTarget,
        request,
      );
    }
    const backend = request.backend ?? "all";
    const listedThreads = await this.registry.listThreads({
      backend: backend === "all" ? undefined : backend,
      callerReason: "messaging-navigation-snapshot",
      filter: request.filter,
      forceRefresh: request.forceRefresh,
      limit: request.refreshMode === "active-recent" ? 50 : undefined,
      maxPages: request.refreshMode === "active-recent" ? 1 : undefined,
      skipArchivedMetadataRefresh: request.refreshMode === "active-recent",
    });
    const messagingBindingsByThreadKey = await buildMessagingBindingsByThreadKey(
      listedThreads,
    );
    const queuedExecutionModesByThreadKey =
      this.registry.getQueuedExecutionModesSnapshot();
    const queuedTurnsByThreadKey = this.registry.getQueuedTurnsSnapshot();
    const snapshot = await getDesktopOverlayStore().reconcileNavigationSnapshot({
      backend,
      fetchedAt: Date.now(),
      messagingBindingsByThreadKey,
      queuedExecutionModesByThreadKey,
      queuedTurnsByThreadKey,
      threads: listedThreads,
      workspaceRoots: resolveScratchProjectsRoots(),
    });
    // The overlay's stored PR rows carry whatever status was persisted
    // when the attachment list was last rewritten; the background poller
    // keeps the canonical status in the PR status registry instead. The
    // renderer's local snapshot path canonicalizes before serving, and
    // this bridge — the serving path for federation remote viewers and
    // messaging browse — has to do the same or viewers get stale chips
    // that never converge.
    const canonicalThreads =
      await this.registry.canonicalizeNavigationThreadPullRequests(
        snapshot.threads,
      );
    const threads = await this.registry.hydrateThreadGitWorkingStates(
      canonicalThreads,
      { probeMissing: true },
    );
    const hydratedSnapshot = {
      ...snapshot,
      threads,
    };
    if (
      backend === "all"
      && !request.filter?.trim()
      && request.refreshMode !== "active-recent"
    ) {
      this.registry.rememberCompleteNavigationSnapshot(hydratedSnapshot);
    }
    const directoryStatusCache =
      await getDesktopOverlayStore().readDirectoryGitStatusCache();
    const staleDirectoryKeys = selectStaleDirectoryGitStatusKeys({
      cache: directoryStatusCache,
      directories: hydratedSnapshot.directories,
    });
    if (
      staleDirectoryKeys.length > 0
      && typeof this.registry.refreshDirectoryGitStatuses === "function"
    ) {
      void this.registry.refreshDirectoryGitStatuses({
        directoryKeys: staleDirectoryKeys,
        force: false,
      }).catch(() => {
        // Directory status is optional navigation context. The registry logs
        // probe failures and publishes successful per-directory updates.
      });
    }

    // The renderer's local snapshot path (ipc/app-server.ts) hydrates
    // each directory launchpad's Codex environment options. This bridge
    // is the serving path for federation remote viewers (and messaging
    // browse) — without the same hydration, a remote window's launchpad
    // renders with no Environment picker even though thread creation and
    // post-birth environment control are fully federation-routed.
    const directoriesWithLaunchpads = await Promise.all(
      hydratedSnapshot.directories.map(async (directory) => {
        const withStatus = {
          ...directory,
          gitStatus: directoryStatusCache[directory.key]?.gitStatus,
        };
        if (!withStatus.launchpad) {
          return withStatus;
        }
        try {
          return {
            ...withStatus,
            launchpad: await hydrateLaunchpadCodexEnvironmentOptions(
              withStatus.launchpad,
            ),
          };
        } catch {
          // Options are an enhancement; a hydration failure must not
          // block the snapshot.
          return withStatus;
        }
      }),
    );

    const localSnapshot: NavigationSnapshot = {
      ...hydratedSnapshot,
      directories: directoriesWithLaunchpads,
    };
    if (!this.federation) {
      return localSnapshot;
    }
    const remoteSnapshots = await Promise.allSettled(
      this.federation
        .connectedPeerTargets()
        // messaging_route is the peer's opt-in for messaging surfaces to
        // browse and drive its threads — skip peers that don't grant it.
        .filter(({ capabilities }) => capabilities.includes("messaging_route"))
        .map(({ target }) =>
          this.federation!.remoteNavigationSnapshot(
            target,
            request,
            { kind: "all" },
          )
        ),
    );
    const availableRemoteSnapshots = remoteSnapshots.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : []
    );
    return {
      ...localSnapshot,
      fetchedAt: Math.max(
        localSnapshot.fetchedAt,
        ...availableRemoteSnapshots.map((remote) => remote.fetchedAt),
      ),
      unchanged: false,
      threads: [
        ...localSnapshot.threads,
        ...availableRemoteSnapshots.flatMap((remote) => remote.threads),
      ],
      inboxThreadKeys: [
        ...localSnapshot.inboxThreadKeys,
        ...availableRemoteSnapshots.flatMap((remote) => remote.inboxThreadKeys),
      ],
    };
  }

  async resolveThreadTarget(request: {
    backend: AppServerBackendKind;
    threadId: string;
    instanceId?: FederationInstanceId;
    includeRemote?: boolean;
  }) {
    if (!request.instanceId) {
      const localThreads = await this.registry.listThreads({
        backend: request.backend,
        archived: false,
        callerReason: "messaging-attach-thread-target",
      });
      const localThread = localThreads.find(
        (thread) => thread.id === request.threadId,
      );
      if (localThread) {
        const navigation = await this.getNavigationSnapshot({
          backend: request.backend,
        });
        const thread = navigation.threads.find(
          (candidate) =>
            candidate.source === request.backend
            && candidate.id === request.threadId,
        );
        if (thread) {
          return { navigation, thread };
        }
      }
    }
    if (request.includeRemote === false || !this.federation) {
      return undefined;
    }

    try {
      const match = await resolveFederatedThreadTarget({
        runtime: this.federation,
        targetStore: getDesktopOverlayStore(),
        request,
      });
      if (!match) {
        return undefined;
      }
      if (!match.peer.capabilities.includes("messaging_route")) {
        throw new Error(
          `Federation instance ${match.peer.label} owns thread ${request.threadId} but does not grant messaging_route.`,
        );
      }
      const federationTarget = match.peer.target;
      const navigation = await this.federation.remoteNavigationSnapshot(
        federationTarget,
        {
          backend: request.backend,
          federationTarget,
        },
        { kind: "all" },
      );
      const thread = navigation.threads.find(
        (candidate) =>
          candidate.source === request.backend
          && candidate.id === request.threadId,
      );
      if (!thread) {
        return undefined;
      }
      return {
        navigation,
        thread,
        federatedThread: buildFederatedThreadRef({
          backend: request.backend,
          threadId: request.threadId,
          instanceId: federationTarget.instanceId,
        }),
      };
    } catch (error) {
      if (error instanceof FederatedThreadTargetError) {
        throw new MessagingFederatedThreadTargetError(
          error.code,
          error.message,
        );
      }
      throw error;
    }
  }

  async readThreadAgentMetadata(request: {
    backend: AppServerBackendKind;
    threadId: string;
  }): Promise<ThreadAgentMetadata | undefined> {
    return await this.registry.getThreadAgentMetadata(request);
  }

  async readThreadStatus(request: {
    backend: AppServerBackendKind;
    federationTarget?: FederationTarget;
    threadId: string;
  }): Promise<AppServerThreadStatus | undefined> {
    const response = await this.readThread({
      ...request,
      includeTurns: false,
      limit: 0,
    });
    return response.threadStatus ?? response.replay.threadStatus;
  }

  async readActiveTurn(request: {
    backend: AppServerBackendKind;
    federationTarget?: FederationTarget;
    threadId: string;
  }): Promise<
    | {
        backend: AppServerBackendKind;
        threadId: string;
        turnId: string;
      }
    | undefined
  > {
    if (this.remoteBackend(request.federationTarget)) {
      const response = await this.readThread({
        ...request,
        includeTurns: true,
        limit: 20,
      });
      const status = response.threadStatus ?? response.replay.threadStatus;
      if (status !== "active") return undefined;
      const entry = [...response.replay.entries]
        .reverse()
        .find((candidate) => candidate.turn?.id);
      return entry?.turn?.id
        ? {
            backend: request.backend,
            threadId: request.threadId,
            turnId: entry.turn.id,
          }
        : undefined;
    }
    return this.registry.getActiveTurnForThread(request);
  }

  async readThreadLastAssistantMessage(request: {
    backend: AppServerBackendKind;
    federationTarget?: FederationTarget;
    threadId: string;
  }): Promise<string | undefined> {
    return (await this.readThreadLastAssistantReply(request))?.text;
  }

  async readThreadLastAssistantReply(request: {
    backend: AppServerBackendKind;
    federationTarget?: FederationTarget;
    threadId: string;
  }): Promise<MessagingLastAssistantReply | undefined> {
    const response = await this.readThread({
      ...request,
      limit: 20,
    });
    const entryReply = findLastAssistantEntryReply(response.replay);
    const messageReply = findLastAssistantMessageReply(response.replay);
    if (entryReply && messageReply) {
      if (isReplyNewer(messageReply, entryReply)) {
        return messageReply;
      }
      return entryReply;
    }
    if (entryReply) {
      return entryReply;
    }
    if (messageReply) {
      return messageReply;
    }
    const fallbackText = response.replay.lastAssistantMessage?.trim();
    if (fallbackText) {
      const createdAt = findLastAssistantEntryCreatedAt(
        response.replay,
        fallbackText,
      );
      return {
        text: fallbackText,
        ...(createdAt ? { createdAt } : {}),
      };
    }
    return undefined;
  }

  async resolveAssistantMessageImages(request: {
    backend: AppServerBackendKind;
    itemId?: string;
    text: string;
    threadId: string;
    turnId?: string;
  }): Promise<MessagingImagePart[]> {
    const key = [
      request.backend,
      request.threadId,
      request.turnId ?? "",
      request.itemId ?? "",
      createHash("sha256").update(request.text).digest("base64url"),
    ].join("\0");
    const existing = this.assistantImageResolutions.get(key);
    if (existing) {
      return await existing;
    }

    const resolution = this.resolveAssistantMessageImagesOnce(request);
    this.assistantImageResolutions.set(key, resolution);
    const expiry = setTimeout(() => {
      if (this.assistantImageResolutions.get(key) === resolution) {
        this.assistantImageResolutions.delete(key);
      }
    }, 5_000);
    expiry.unref?.();
    while (this.assistantImageResolutions.size > 64) {
      const oldest = this.assistantImageResolutions.keys().next().value;
      if (typeof oldest !== "string") {
        break;
      }
      this.assistantImageResolutions.delete(oldest);
    }
    return await resolution;
  }

  private async resolveAssistantMessageImagesOnce(request: {
    backend: AppServerBackendKind;
    itemId?: string;
    text: string;
    threadId: string;
    turnId?: string;
  }): Promise<MessagingImagePart[]> {
    const response = await this.registry.readThread({
      backend: request.backend,
      limit: 20,
      threadId: request.threadId,
    });
    const message = findAssistantMessageForText(
      response.replay,
      request.text,
      request.itemId,
      request.turnId,
    ) ?? {
      id: request.itemId ?? `turn:${request.turnId ?? "unknown"}:assistant`,
      role: "assistant" as const,
      text: request.text,
    };
    const roots = await this.registry.getThreadTranscriptImageRoots({
      backend: request.backend,
      threadId: request.threadId,
    });
    const parts = await materializeTranscriptMessageImagesForMessaging(
      response,
      message,
      {},
      {
        approvedLocalImageRoots: roots,
        includeTemporaryImageRoots: true,
      },
    );
    return parts.map((part) => ({
      ...part,
      source: "assistant" as const,
    }));
  }

  async handoffThreadWorkspace(
    request: HandoffThreadWorkspaceRequest,
  ): Promise<HandoffThreadWorkspaceResponse> {
    const remote = this.remoteBackend(request.federationTarget);
    if (remote) {
      return await remote.handoffThreadWorkspace(
        stripFederationTarget(request),
      );
    }
    return await this.registry.handoffThreadWorkspace(request);
  }

  async ensureDirectoryLaunchpad(
    request: EnsureDirectoryLaunchpadRequest,
  ): Promise<EnsureDirectoryLaunchpadResponse> {
    const remote = this.remoteBackend(request.federationTarget);
    if (remote) {
      return await remote.ensureDirectoryLaunchpad(
        stripFederationTarget(request),
      );
    }

    const statusPath =
      request.gitStatusSourcePath?.trim() || request.directoryPath?.trim();
    let gitStatus: EnsureDirectoryLaunchpadResponse["gitStatus"];
    if (statusPath) {
      for await (const entry of this.registry.readDirectoryStatusEntries([{
        key: request.directoryKey,
        kind: request.directoryKind,
        label: request.directoryLabel,
        path: statusPath,
        threadKeys: [],
        needsAttentionCount: 0,
      }])) {
        gitStatus = entry.gitStatus ?? null;
        break;
      }
    }
    const response = await this.registry.ensureDirectoryLaunchpad({
      ...request,
      ...(gitStatus?.currentBranch
        ? { currentBranch: gitStatus.currentBranch }
        : {}),
    });
    return {
      ...response,
      ...(gitStatus !== undefined ? { gitStatus } : {}),
    };
  }

  async materializeDirectoryLaunchpad(
    request: MaterializeDirectoryLaunchpadRequest,
    options?: MaterializeDirectoryLaunchpadOptions,
  ): Promise<MaterializeDirectoryLaunchpadResponse> {
    const remote = this.remoteBackend(request.federationTarget);
    if (remote) {
      return await remote.materializeDirectoryLaunchpad(
        stripFederationTarget(request),
      );
    }
    return await this.registry.materializeDirectoryLaunchpad(request, options);
  }

  async updateDirectoryLaunchpad(
    request: UpdateDirectoryLaunchpadRequest,
  ): Promise<UpdateDirectoryLaunchpadResponse> {
    return await this.registry.updateDirectoryLaunchpad(request);
  }

  async startTurn(
    request: StartTurnRequest & { messageOrigin?: AppServerThreadMessageOrigin },
  ): Promise<StartTurnResponse> {
    const remote = this.remoteBackend(request.federationTarget);
    if (remote) {
      return await remote.startTurn(stripFederationTarget(request));
    }
    const submitted = await this.registry.submitTurn({
      ...request,
      origin: "messaging",
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
  }

  async listScheduledThreadActions(
    request: ListScheduledThreadActionsRequest = {},
  ): Promise<ListScheduledThreadActionsResponse> {
    const remote = this.remoteBackend(request.federationTarget);
    if (remote) {
      return await remote.listScheduledThreadActions(
        stripFederationTarget(request),
      );
    }
    return getScheduledThreadActionService().list(request);
  }

  async createScheduledThreadAction(
    request: CreateScheduledThreadActionRequest,
  ): Promise<ScheduledThreadActionMutationResponse> {
    const remote = this.remoteBackend(request.federationTarget);
    if (remote) {
      return await remote.createScheduledThreadAction(
        stripFederationTarget(request),
      );
    }
    return await getScheduledThreadActionService().create(request);
  }

  async updateScheduledThreadAction(
    request: UpdateScheduledThreadActionRequest,
  ): Promise<ScheduledThreadActionMutationResponse> {
    const remote = this.remoteBackend(request.federationTarget);
    if (remote) {
      return await remote.updateScheduledThreadAction(
        stripFederationTarget(request),
      );
    }
    return await getScheduledThreadActionService().update(request);
  }

  async cancelScheduledThreadAction(
    request: ScheduledThreadActionIdRequest,
  ): Promise<ScheduledThreadActionMutationResponse> {
    const remote = this.remoteBackend(request.federationTarget);
    if (remote) {
      return await remote.cancelScheduledThreadAction(
        stripFederationTarget(request),
      );
    }
    return await getScheduledThreadActionService().cancel(request);
  }

  async sendScheduledThreadActionNow(
    request: ScheduledThreadActionIdRequest,
  ): Promise<ScheduledThreadActionMutationResponse> {
    const remote = this.remoteBackend(request.federationTarget);
    if (remote) {
      return await remote.sendScheduledThreadActionNow(
        stripFederationTarget(request),
      );
    }
    return await getScheduledThreadActionService().sendNow(request);
  }

  async submitReview(request: StartReviewRequest): Promise<
    | {
        status: "started";
        response: Awaited<ReturnType<DesktopBackendRegistry["startReview"]>>;
      }
    | {
        status: "scheduled";
        pendingReviewId: string;
        invokingTurnId: string;
      }
  > {
    const remote = this.remoteBackend(request.federationTarget);
    if (remote) {
      return {
        status: "started",
        response: await remote.startReview(stripFederationTarget(request)),
      };
    }
    return await this.registry.submitReview(request);
  }

  async steerTurn(
    request: SteerTurnRequest & { messageOrigin?: AppServerThreadMessageOrigin },
  ): Promise<SteerTurnResponse> {
    const remote = this.remoteBackend(request.federationTarget);
    if (remote) {
      return await remote.steerTurn(stripFederationTarget(request));
    }
    return await this.registry.steerTurn(
      request,
      request.messageOrigin ?? { kind: "messaging" },
    );
  }

  async startThread(request: StartThreadRequest): Promise<StartThreadResponse> {
    const remote = this.remoteBackend(request.federationTarget);
    if (remote) {
      return await remote.startThread(stripFederationTarget(request));
    }
    return await this.registry.startThread(request);
  }

  async compactThread(request: CompactThreadRequest): Promise<CompactThreadResponse> {
    const remote = this.remoteBackend(request.federationTarget);
    if (remote) {
      return await remote.compactThread(stripFederationTarget(request));
    }
    return await this.registry.compactThread(request);
  }

  async interruptTurn(request: InterruptTurnRequest): Promise<InterruptTurnResponse> {
    const remote = this.remoteBackend(request.federationTarget);
    if (remote) {
      return await remote.interruptTurn(stripFederationTarget(request));
    }
    return await this.registry.interruptTurn(request);
  }

  async listSkills(
    request: AppServerListSkillsRequest = {},
  ): Promise<Pick<AppServerListSkillsResponse, "data">> {
    const remote = this.remoteBackend(request.federationTarget);
    if (remote) {
      return await remote.listSkills(stripFederationTarget(request));
    }
    return await this.registry.listSkills(request);
  }

  async listBackends(request: ListBackendsRequest = {}): Promise<ListBackendsResponse> {
    const remote = this.remoteBackend(request.federationTarget);
    if (remote) {
      return await remote.listBackends(stripFederationTarget(request));
    }
    return await this.registry.listBackends(request);
  }

  async setThreadExecutionMode(
    request: SetThreadExecutionModeRequest,
  ): Promise<SetThreadExecutionModeResponse> {
    const remote = this.remoteBackend(request.federationTarget);
    if (remote) {
      return await remote.setThreadExecutionMode(
        stripFederationTarget(request),
      );
    }
    return await this.registry.setThreadExecutionMode(request);
  }

  async setAcpSessionRuntimeOption(
    request: SetAcpSessionRuntimeOptionRequest,
  ): Promise<SetAcpSessionRuntimeOptionResponse> {
    const remote = this.remoteBackend(request.federationTarget);
    if (remote) {
      return await remote.setAcpSessionRuntimeOption(
        stripFederationTarget(request),
      );
    }
    return await this.registry.setAcpSessionRuntimeOption(request);
  }

  async cancelThreadExecutionModeQueue(
    request: CancelThreadExecutionModeQueueRequest,
  ): Promise<CancelThreadExecutionModeQueueResponse> {
    const remote = this.remoteBackend(request.federationTarget);
    if (remote) {
      return await remote.cancelThreadExecutionModeQueue(
        stripFederationTarget(request),
      );
    }
    return await this.registry.cancelThreadExecutionModeQueue(request);
  }

  async setThreadModelSettings(
    request: SetThreadModelSettingsRequest,
  ): Promise<SetThreadModelSettingsResponse> {
    const remote = this.remoteBackend(request.federationTarget);
    if (remote) {
      return await remote.setThreadModelSettings(
        stripFederationTarget(request),
      );
    }
    return await this.registry.setThreadModelSettings(request);
  }

  async recordMessagingBindingTransition(request: {
    backend: AppServerBackendKind;
    threadId: string;
    transition: ThreadMessagingBindingTransition;
  }): Promise<void> {
    await getDesktopOverlayStore().appendMessagingBindingTransition(request);
  }

  async submitServerRequest(
    request: SubmitServerRequestRequest,
  ): Promise<SubmitServerRequestResponse> {
    const remote = this.remoteBackend(request.federationTarget);
    if (remote) {
      return await remote.submitServerRequest(
        stripFederationTarget(request),
      );
    }
    return await this.registry.submitServerRequest(request);
  }

  onEvent(listener: (event: AgentEvent) => void | Promise<void>): () => void {
    const unsubscribeLocal = this.registry.onEvent(listener);
    const unsubscribeRemote = this.federation?.onRemoteBackendEvent(listener);
    return () => {
      unsubscribeLocal();
      unsubscribeRemote?.();
    };
  }

  setRemoteEventSubscriptions(
    subscriptions: readonly FederationEventSubscription[],
  ): void {
    this.federation?.setEventSubscriptions?.("messaging", subscriptions);
  }

  private remoteBackend(
    target: FederationTarget | undefined,
  ): FederationBackendOperations | undefined {
    if (!target || !isRemoteFederationTarget(target) || !this.federation) {
      return undefined;
    }
    // messaging_route gates messaging-originated remote control (plan
    // KTD3): a connected peer that doesn't advertise it must not be
    // reachable from chat surfaces, even though remote windows may
    // still drive it via turn_control.
    const peer = this.federation
      .connectedPeerTargets()
      .find((candidate) => candidate.target.instanceId === target.instanceId);
    if (peer && !peer.capabilities.includes("messaging_route")) {
      throw new Error(
        `Federation peer ${peer.label} does not allow messaging routing.`,
      );
    }
    return this.federation.remoteBackend(target);
  }

  private async readThread(request: {
    backend: AppServerBackendKind;
    federationTarget?: FederationTarget;
    threadId: string;
    includeTurns?: boolean;
    limit?: number;
  }) {
    const remote = this.remoteBackend(request.federationTarget);
    if (remote) {
      return await remote.readThread(stripFederationTarget(request));
    }
    return await this.registry.readThread(request);
  }
}

function stripFederationTarget<T extends { federationTarget?: FederationTarget }>(
  request: T,
): Omit<T, "federationTarget"> {
  const { federationTarget: _federationTarget, ...localRequest } = request;
  return localRequest;
}

function findAssistantMessageForText(
  replay: AppServerThreadReplay,
  text: string,
  itemId?: string,
  turnId?: string,
): AppServerThreadMessage | undefined {
  if (itemId) {
    for (let index = replay.messages.length - 1; index >= 0; index -= 1) {
      const message = replay.messages[index];
      if (message?.role === "assistant" && message.id === itemId) {
        return message;
      }
    }
    for (let index = replay.entries.length - 1; index >= 0; index -= 1) {
      const entry = replay.entries[index];
      if (
        entry?.type === "message"
        && entry.role === "assistant"
        && entry.id === itemId
      ) {
        return entry;
      }
    }
  }
  const expected = text.trim();
  if (turnId) {
    for (let index = replay.entries.length - 1; index >= 0; index -= 1) {
      const entry = replay.entries[index];
      if (
        entry?.type === "message"
        && entry.role === "assistant"
        && entry.turn?.id === turnId
        && entry.text.trim() === expected
      ) {
        return entry;
      }
    }
  }
  // Empty assistant messages need an item or turn identity. Falling back to a
  // text-only match here could pick an unrelated image-only result from an
  // earlier turn when the current terminal event produced no assistant output.
  if (!expected && (itemId || turnId)) {
    return undefined;
  }
  for (let index = replay.messages.length - 1; index >= 0; index -= 1) {
    const message = replay.messages[index];
    if (message?.role === "assistant" && message.text.trim() === expected) {
      return message;
    }
  }
  for (let index = replay.entries.length - 1; index >= 0; index -= 1) {
    const entry = replay.entries[index];
    if (
      entry?.type === "message"
      && entry.role === "assistant"
      && entry.text.trim() === expected
    ) {
      return entry;
    }
  }
  return undefined;
}

function findLastAssistantMessageReply(
  replay: AppServerThreadReplay,
): MessagingLastAssistantReply | undefined {
  for (let index = replay.messages.length - 1; index >= 0; index -= 1) {
    const message = replay.messages[index];
    if (message?.role !== "assistant") {
      continue;
    }
    const text = message.text.trim();
    if (!text) {
      continue;
    }
    const createdAt =
      message.createdAt ?? findLastAssistantEntryCreatedAt(replay, text);
    return {
      text,
      ...(createdAt ? { createdAt } : {}),
    };
  }
  return undefined;
}

function buildAdmissionThreadSummary(params: {
  federation?: NonNullable<NavigationThreadSummary["federation"]>;
  overlay?: ThreadOverlayState;
  queuedExecutionMode?: {
    mode: NonNullable<NavigationThreadSummary["queuedExecutionMode"]>;
    queuedAt: number;
  };
  queuedTurns?: NavigationThreadSummary["queuedTurns"];
  summary: Omit<NavigationThreadSummary, "inbox"> | NavigationThreadSummary;
}): NavigationThreadSummary {
  const { overlay, summary } = params;
  return {
    ...summary,
    inbox: "inbox" in summary ? summary.inbox : { inInbox: false },
    executionMode: overlay?.executionMode ?? summary.executionMode,
    fastMode: overlay?.fastMode ?? summary.fastMode,
    gitBranch: overlay?.gitBranch ?? summary.gitBranch,
    linkedDirectories:
      summary.linkedDirectories.length > 0
        ? summary.linkedDirectories
        : overlay?.extraLinkedDirectories ?? [],
    model: overlay?.model ?? summary.model,
    observedGitBranch:
      overlay?.observedGitBranch ?? summary.observedGitBranch,
    reasoningEffort: overlay?.reasoningEffort ?? summary.reasoningEffort,
    serviceTier: overlay?.serviceTier ?? summary.serviceTier,
    ...(overlay?.agent ? { agent: overlay.agent } : {}),
    ...(overlay?.handoffOrigin ? { handoffOrigin: overlay.handoffOrigin } : {}),
    ...(params.federation ? { federation: params.federation } : {}),
    ...(params.queuedExecutionMode
      ? {
          queuedExecutionMode: params.queuedExecutionMode.mode,
          queuedExecutionModeAt: params.queuedExecutionMode.queuedAt,
        }
      : {}),
    ...(params.queuedTurns ? { queuedTurns: params.queuedTurns } : {}),
  };
}

function isFederationMethodNotFoundError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "method_not_found";
}

function findLastAssistantEntryReply(
  replay: AppServerThreadReplay,
): MessagingLastAssistantReply | undefined {
  for (let index = replay.entries.length - 1; index >= 0; index -= 1) {
    const entry = replay.entries[index];
    if (entry?.type !== "message" || entry.role !== "assistant") {
      continue;
    }
    const text = entry.text.trim();
    if (!text) {
      continue;
    }
    return {
      text,
      ...(entry.createdAt ? { createdAt: entry.createdAt } : {}),
    };
  }
  return undefined;
}

function findLastAssistantEntryCreatedAt(
  replay: AppServerThreadReplay,
  text: string,
): number | undefined {
  for (let index = replay.entries.length - 1; index >= 0; index -= 1) {
    const entry = replay.entries[index];
    if (
      entry?.type === "message" &&
      entry.role === "assistant" &&
      entry.text.trim() === text
    ) {
      return entry.createdAt;
    }
  }
  return undefined;
}

function isReplyNewer(
  candidate: MessagingLastAssistantReply,
  current: MessagingLastAssistantReply,
): boolean {
  return (
    typeof candidate.createdAt === "number" &&
    Number.isFinite(candidate.createdAt) &&
    typeof current.createdAt === "number" &&
    Number.isFinite(current.createdAt) &&
    candidate.createdAt > current.createdAt
  );
}
