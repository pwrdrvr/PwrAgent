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
  EnsureDirectoryLaunchpadRequest,
  EnsureDirectoryLaunchpadResponse,
  GetNavigationSnapshotRequest,
  HandoffThreadWorkspaceRequest,
  HandoffThreadWorkspaceResponse,
  InterruptTurnRequest,
  InterruptTurnResponse,
  ListBackendsRequest,
  ListBackendsResponse,
  MaterializeDirectoryLaunchpadOptions,
  MaterializeDirectoryLaunchpadRequest,
  MaterializeDirectoryLaunchpadResponse,
  NavigationSnapshot,
  SetAcpSessionRuntimeOptionRequest,
  SetAcpSessionRuntimeOptionResponse,
  SetThreadExecutionModeRequest,
  SetThreadExecutionModeResponse,
  SetThreadModelSettingsRequest,
  SetThreadModelSettingsResponse,
  StartTurnRequest,
  StartTurnResponse,
  SteerTurnRequest,
  SteerTurnResponse,
  StartThreadRequest,
  StartThreadResponse,
  StartReviewRequest,
  SubmitServerRequestRequest,
  SubmitServerRequestResponse,
  ThreadMessagingBindingTransition,
  UpdateDirectoryLaunchpadRequest,
  UpdateDirectoryLaunchpadResponse,
} from "@pwragent/shared";
import type { MessagingImagePart } from "@pwragent/messaging-interface";
import type {
  MessagingBackendBridge,
  MessagingLastAssistantReply,
} from "./core/messaging-adapter";
import type { DesktopBackendRegistry } from "../app-server/backend-registry";
import { getDesktopBackendRegistry } from "../app-server/backend-registry";
import { getDesktopOverlayStore } from "../app-server/desktop-overlay-store";
import { resolveScratchProjectsRoots } from "../app-server/scratch-projects";
import { buildMessagingBindingsByThreadKey } from "./messaging-bindings-snapshot";
import { materializeTranscriptMessageImagesForMessaging } from "../transcript-image-protocol";

export class DesktopMessagingBackendBridge implements MessagingBackendBridge {
  private readonly assistantImageResolutions = new Map<
    string,
    Promise<MessagingImagePart[]>
  >();

  constructor(
    private readonly registry: DesktopBackendRegistry = getDesktopBackendRegistry(),
  ) {}

  async getNavigationSnapshot(
    request: GetNavigationSnapshotRequest = {},
  ): Promise<NavigationSnapshot> {
    const backend = request.backend ?? "all";
    const threads = await this.registry.listThreads({
      backend: backend === "all" ? undefined : backend,
      callerReason: "messaging-navigation-snapshot",
      filter: request.filter,
      forceRefresh: request.forceRefresh,
      limit: request.refreshMode === "active-recent" ? 50 : undefined,
      maxPages: request.refreshMode === "active-recent" ? 1 : undefined,
      skipArchivedMetadataRefresh: request.refreshMode === "active-recent",
    });
    const messagingBindingsByThreadKey = await buildMessagingBindingsByThreadKey(threads);
    const queuedExecutionModesByThreadKey =
      this.registry.getQueuedExecutionModesSnapshot();
    const snapshot = await getDesktopOverlayStore().reconcileNavigationSnapshot({
      backend,
      fetchedAt: Date.now(),
      messagingBindingsByThreadKey,
      queuedExecutionModesByThreadKey,
      threads,
      workspaceRoots: resolveScratchProjectsRoots(),
    });
    if (
      backend === "all"
      && !request.filter?.trim()
      && request.refreshMode !== "active-recent"
    ) {
      this.registry.rememberCompleteNavigationSnapshot(snapshot);
    }
    const directoryStatuses = await this.registry.readDirectoryStatuses(
      snapshot.directories,
    );

    return {
      ...snapshot,
      directories: snapshot.directories.map((directory) => ({
        ...directory,
        gitStatus: directoryStatuses[directory.key],
      })),
    };
  }

  async readThreadStatus(request: {
    backend: AppServerBackendKind;
    threadId: string;
  }): Promise<AppServerThreadStatus | undefined> {
    const response = await this.registry.readThread({
      backend: request.backend,
      includeTurns: false,
      limit: 0,
      threadId: request.threadId,
    });
    return response.threadStatus ?? response.replay.threadStatus;
  }

  async readActiveTurn(request: {
    backend: AppServerBackendKind;
    threadId: string;
  }): Promise<
    | {
        backend: AppServerBackendKind;
        threadId: string;
        turnId: string;
      }
    | undefined
  > {
    return this.registry.getActiveTurnForThread(request);
  }

  async readThreadLastAssistantMessage(request: {
    backend: AppServerBackendKind;
    threadId: string;
  }): Promise<string | undefined> {
    return (await this.readThreadLastAssistantReply(request))?.text;
  }

  async readThreadLastAssistantReply(request: {
    backend: AppServerBackendKind;
    threadId: string;
  }): Promise<MessagingLastAssistantReply | undefined> {
    const response = await this.registry.readThread({
      backend: request.backend,
      limit: 20,
      threadId: request.threadId,
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
    const message = findAssistantMessageForText(response.replay, request.text) ?? {
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
    return await this.registry.handoffThreadWorkspace(request);
  }

  async ensureDirectoryLaunchpad(
    request: EnsureDirectoryLaunchpadRequest,
  ): Promise<EnsureDirectoryLaunchpadResponse> {
    return await this.registry.ensureDirectoryLaunchpad(request);
  }

  async materializeDirectoryLaunchpad(
    request: MaterializeDirectoryLaunchpadRequest,
    options?: MaterializeDirectoryLaunchpadOptions,
  ): Promise<MaterializeDirectoryLaunchpadResponse> {
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
    return await this.registry.submitReview(request);
  }

  async steerTurn(
    request: SteerTurnRequest & { messageOrigin?: AppServerThreadMessageOrigin },
  ): Promise<SteerTurnResponse> {
    return await this.registry.steerTurn(
      request,
      request.messageOrigin ?? { kind: "messaging" },
    );
  }

  async startThread(request: StartThreadRequest): Promise<StartThreadResponse> {
    return await this.registry.startThread(request);
  }

  async compactThread(request: CompactThreadRequest): Promise<CompactThreadResponse> {
    return await this.registry.compactThread(request);
  }

  async interruptTurn(request: InterruptTurnRequest): Promise<InterruptTurnResponse> {
    return await this.registry.interruptTurn(request);
  }

  async listSkills(
    request: AppServerListSkillsRequest = {},
  ): Promise<Pick<AppServerListSkillsResponse, "data">> {
    return await this.registry.listSkills(request);
  }

  async listBackends(request: ListBackendsRequest = {}): Promise<ListBackendsResponse> {
    return await this.registry.listBackends(request);
  }

  async setThreadExecutionMode(
    request: SetThreadExecutionModeRequest,
  ): Promise<SetThreadExecutionModeResponse> {
    return await this.registry.setThreadExecutionMode(request);
  }

  async setAcpSessionRuntimeOption(
    request: SetAcpSessionRuntimeOptionRequest,
  ): Promise<SetAcpSessionRuntimeOptionResponse> {
    return await this.registry.setAcpSessionRuntimeOption(request);
  }

  async cancelThreadExecutionModeQueue(
    request: CancelThreadExecutionModeQueueRequest,
  ): Promise<CancelThreadExecutionModeQueueResponse> {
    return await this.registry.cancelThreadExecutionModeQueue(request);
  }

  async setThreadModelSettings(
    request: SetThreadModelSettingsRequest,
  ): Promise<SetThreadModelSettingsResponse> {
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
    return await this.registry.submitServerRequest(request);
  }

  onEvent(listener: (event: AgentEvent) => void | Promise<void>): () => void {
    return this.registry.onEvent(listener);
  }
}

function findAssistantMessageForText(
  replay: AppServerThreadReplay,
  text: string,
): AppServerThreadMessage | undefined {
  const expected = text.trim();
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
