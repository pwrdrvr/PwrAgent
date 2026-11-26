import { createHash } from "node:crypto";
import type { AcpSessionNormalizer } from "@pwrdrvr/agent-acp";
import type {
  AppServerThreadActivityEntry,
  AppServerThreadCommandDetail,
  AppServerThreadEntry,
  AppServerThreadImagePart,
  AppServerThreadMessage,
  AppServerThreadMessagePart,
  AppServerThreadPlanEntry,
  AppServerThreadReplay,
  AppServerThreadStatus,
  AppServerThreadTurnStatus,
  AppServerTranscriptPhase,
} from "@pwragent/shared/contracts/normalized-app-server";
import { buildPendingTurnId } from "@pwragent/shared/turn-placeholder";
import {
  commandTitleMatchesInvocation,
  formatCommandLabel,
  formatWebSearchLabel,
} from "@pwragent/shared/command-action-labels";
import { stripAgentMemoryChunk } from "@pwragent/shared/contracts/agent-memory";
import { ACP_WORKSPACE_HISTORY_URI } from "./acp-workspace-history.js";
import { stripManagedReviewContextBlock } from "../../shared/review-command.js";
import { stripAcpAgentInstructionChunk } from "../../shared/agent-instruction-delivery.js";
import {
  type AcpProviderTool,
  isGenericShellToolTitle,
  readAcpCodeSearch,
  readAcpMcpToolLabel,
  readAcpMcpToolName,
  readAcpProviderTool,
  readAcpToolCommand,
  readAcpToolContentCommand,
  readAcpToolDescription,
  readAcpToolInvocation,
  readAcpWebFetchUrl,
  readAcpWebSearch,
  readFirstLocationPath,
} from "./acp-command-extraction.js";
import {
  acpDiffContentIsWholeFile,
  readAcpFileEdit,
  type ReadAcpFileEditOptions,
} from "./acp-file-edit.js";
import {
  type AcpFileRead,
  fileBaseName,
  readAcpFileRead,
} from "./acp-file-read.js";
import { sanitizeAcpToolOutput } from "./acp-tool-output.js";
import { reduceNormalizedThread } from "./normalized-thread-reducer.js";
import { normalizedThreadToReplay, normalizedToolCallToReplayDetail } from "./normalized-thread-to-replay.js";

export type AcpSessionUpdate = {
  sessionId: string;
  update: Record<string, unknown>;
  receivedAt?: number;
  /**
   * Live clients defer Grok's durable replay terminal until session/prompt
   * resolves, which is the point at which another turn may safely start.
   */
  deferTurnCompletion?: boolean;
};

export type AcpReplayPromptIdentity = {
  receivedAt: number;
  textDigest: string;
  turnId: string;
  steerMessageId?: string;
  attachmentParts?: AppServerThreadMessagePart[];
};

export function normalizeAcpReplayPromptText(text: string): string {
  const stripped = stripAcpAgentInstructionChunk(
    stripManagedReviewContextBlock(text),
    false,
  );
  const memory = stripAgentMemoryChunk(stripped.text, undefined, true);
  return memory.text.trim();
}

export function acpReplayPromptTextDigest(text: string): string {
  return createHash("sha256").update(normalizeAcpReplayPromptText(text)).digest("hex");
}

export type AcpSessionReplayNormalizerOptions = ReadAcpFileEditOptions & {
  replayKit?: AcpReplayKit;
  surfaceThoughtsAsMessages?: boolean;
  /** Scope provider message IDs after a handoff, keeping the original segment's IDs intact. */
  workspaceSessionId?: string;
};

export type AcpReplayKit = Pick<typeof import("@pwrdrvr/agent-acp"),
  "AcpSessionNormalizer" | "defaultQuirks" | "toolCallFromUpdate">;

export async function loadAcpReplayKit(): Promise<AcpReplayKit> {
  // Loading the package root also loads the ACP SDK. Keep that graph out of
  // owner startup until a caller initializes an ACP client or reads a replay.
  return await import("@pwrdrvr/agent-acp");
}

export function shouldSurfaceAcpThoughtsAsMessages(backendId: string): boolean {
  return backendId !== "acp:qwen" && backendId !== "acp:grok";
}

/** How to normalize the updates of the agent behind an ACP backend. */
export function acpSessionReplayNormalizerOptions(
  backendId: string,
  cwd?: string,
): AcpSessionReplayNormalizerOptions {
  return {
    surfaceThoughtsAsMessages: shouldSurfaceAcpThoughtsAsMessages(backendId),
    wholeFileDiffContent: acpDiffContentIsWholeFile(backendId),
    antigravity: backendId === "acp:antigravity",
    ...(cwd ? { cwd } : {}),
  };
}

export function isGrokTransientUpdateKind(kind: string | undefined): boolean {
  return (
    kind === "tool_call_delta_chunk"
    || kind === "pending_interaction"
    || kind === "interaction_resolved"
    || kind === "response_completed"
    // Grok publishes this after its canonical `turn_completed` update as
    // session metadata. It is not a second lifecycle event or transcript item.
    || kind === "last_turn_summary"
    // Memory flushes save durable notes before compaction or while idle.
    // They are background bookkeeping, not user turns or transcript items.
    || kind === "memory_flush_started"
    || kind === "memory_flush_completed"
    // Grok also emits lifecycle notifications for background memory dreams.
    // Keep their lifecycle bookkeeping out of live and replay transcripts too.
    || kind === "memory_dream_queued"
    || kind === "memory_dream_started"
    || kind === "memory_dream_completed"
    // A snapshot of every background command, repeated in full each time one
    // changes. The launch, output, and kill are already tool calls.
    || kind === "background_tasks"
  );
}

/**
 * ACP session metadata (`SessionUpdate::SessionInfoUpdate`) carries a session
 * title and an activity timestamp — thread metadata, never transcript content.
 * Grok Build sends it mid-turn, so treating it as an unknown update both
 * littered the transcript and split the assistant message being streamed.
 */
export function isAcpSessionMetadataUpdateKind(
  kind: string | undefined,
): boolean {
  return kind === "session_info_update";
}

/**
 * ACP `SessionUpdate::UsageUpdate` reports how full the context window is
 * (`used` of `size` tokens) and, optionally, the session's cumulative cost.
 * It is session state for the context-usage indicator, never transcript
 * content. Kimi Code 2.0.0 sends one after every turn.
 */
export function isAcpUsageUpdateKind(kind: string | undefined): boolean {
  return kind === "usage_update";
}

/**
 * Grok sends `retry_state` each time it retries a failed model request
 * (`{ type: "retrying", attempt, max_retries, reason, error_type }`) while the
 * turn stays active. One retry run becomes one transcript row.
 */
export function isAcpRetryStateUpdateKind(kind: string | undefined): boolean {
  return kind === "retry_state";
}

export function readAcpToolCallId(
  update: Record<string, unknown>,
): string | undefined {
  return (
    readString(update, "toolCallId")
    ?? readString(update, "tool_call_id")
    ?? readString(update, "id")
    ?? readString(update, "itemId")
    ?? readString(update, "item_id")
  );
}

type InferredAcpTurn = {
  id: string;
  indexes: number[];
  lastEntryAt?: number;
  sawFinalResponse: boolean;
  startedAt?: number;
};

/**
 * ACP session/load history has ordered transcript phases but no turn IDs.
 * Fill only missing metadata: a user message opens a window, while lifecycle
 * metadata, a later user message, or an idle replay boundary closes it.
 * Assistant delivery alone is not a lifecycle boundary.
 */
export function inferAcpReplayTurns(
  replay: AppServerThreadReplay,
): AppServerThreadReplay {
  const entries: AppServerThreadEntry[] = replay.entries.map((entry) => ({
    ...entry,
  }));
  let active: InferredAcpTurn | undefined;

  const applyActiveTurn = (
    status: AppServerThreadTurnStatus,
    completedAt?: number,
  ): void => {
    if (!active) {
      return;
    }
    for (const index of active.indexes) {
      const entry = entries[index];
      if (!entry || entry.turn) {
        continue;
      }
      entries[index] = {
        ...entry,
        turn: {
          id: active.id,
          status,
          ...(active.startedAt !== undefined
            ? { startedAt: active.startedAt }
            : {}),
          ...(completedAt !== undefined ? { completedAt } : {}),
          ...(active.startedAt !== undefined && completedAt !== undefined
            ? { durationMs: Math.max(0, completedAt - active.startedAt) }
            : {}),
        },
      };
    }
  };
  const settleActive = (
    status: Exclude<AppServerThreadTurnStatus, "in_progress">,
    completedAt?: number,
  ): void => {
    applyActiveTurn(status, completedAt);
    active = undefined;
  };
  const settleAtBoundary = (): void => {
    if (!active) {
      return;
    }
    settleActive(
      active.sawFinalResponse ? "completed" : "interrupted",
      active.lastEntryAt,
    );
  };

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) {
      continue;
    }
    const isUserMessage = entry.type === "message" && entry.role === "user";
    if (isUserMessage) {
      const turnId = entry.turn?.id ?? `inferred:${entry.id}`;
      if (active?.id === turnId) {
        if (!entry.turn) {
          active.indexes.push(index);
        }
        active.lastEntryAt = entry.createdAt ?? active.lastEntryAt;
        continue;
      }
      settleAtBoundary();
      active = {
        id: turnId,
        indexes: entry.turn ? [] : [index],
        lastEntryAt: entry.createdAt,
        sawFinalResponse: false,
        startedAt: entry.turn?.startedAt ?? entry.createdAt,
      };
      continue;
    }
    if (!active) {
      continue;
    }
    if (entry.turn && entry.turn.id !== active.id) {
      settleAtBoundary();
      continue;
    }
    if (!entry.turn) {
      active.indexes.push(index);
    }
    active.lastEntryAt = entry.createdAt ?? active.lastEntryAt;
    if (isSettledTurnStatus(entry.turn?.status)) {
      settleActive(
        entry.turn.status,
        entry.turn.completedAt ?? entry.createdAt,
      );
      continue;
    }
    if (
      entry.type === "message"
      && entry.role === "assistant"
      && entry.phase === "final"
    ) {
      active.sawFinalResponse = true;
    }
  }

  if (replay.threadStatus === "idle") {
    settleAtBoundary();
  } else {
    applyActiveTurn("in_progress");
  }
  return {
    ...replay,
    entries,
  };
}

function isSettledTurnStatus(
  status: AppServerThreadTurnStatus | undefined,
): status is Exclude<AppServerThreadTurnStatus, "in_progress"> {
  return Boolean(status && status !== "in_progress");
}

export class AcpSessionReplayNormalizer {
  private readonly kitPlanNormalizer?: AcpSessionNormalizer;
  private entries: AppServerThreadEntry[] = [];
  private messages: AppServerThreadMessage[] = [];
  // Arrays own replay order; indexes refer to slots, not entry objects (turn
  // completion replaces objects). Rebuild only when removing/retyping entries.
  private readonly messageIndexes = new Map<string, number>();
  private readonly entryIndexes = new Map<string, number>();
  private readonly typedEntryIndexes = new Map<string, number>();
  private lastUserMessageIndex?: number;
  private lastAssistantMessageIndex?: number;
  private status: AppServerThreadStatus = "idle";
  private currentTurnId?: string;
  private currentTurnStartedAt?: number;
  private activeAssistantMessageId?: string;
  private activeAssistantMessagePhase?: AppServerTranscriptPhase;
  private assistantMessageSequence = 0;
  private generatedMessageSequence = 0;
  private readonly knownToolCallIds = new Set<string>();
  /**
   * The tool identity each call declared. Grok opens every call with its
   * internal tool name as the title and sends the descriptive title later,
   * on updates that do not always repeat the identity.
   */
  private readonly providerTools = new Map<string, AcpProviderTool>();
  /**
   * The file or directory each read-only call named. Grok's completing update
   * can drop the input that names it, and its title is the absolute path.
   */
  private readonly fileReads = new Map<string, AcpFileRead>();
  /** The retry run whose row is still in progress, if any. */
  private openRetry?: { id: string; attempts: number };
  /** The automatic compaction whose row is still in progress, if any. */
  private openCompactionId?: string;
  private readonly subAgents = new Map<string, AcpSubAgentState>();
  private providerPromptReplay?: {
    prompts: AcpReplayPromptIdentity[];
    steeredTurns: Set<string>;
    nextIndex: number;
    attachmentNextIndex: number;
  };
  /** Filename from a preceding synthetic image-annotation chunk, for a following image chunk. */
  private pendingUserImageAlt?: string;
  /** Queued filenames extracted from mixed text+annotation or multi-annotation chunks. */
  private pendingUserImageAlts: string[] = [];
  /** Message ID of a tentative synthetic filename-annotation bubble that an image chunk can fold. */
  private pendingSyntheticImageAnnotation?: { messageId: string; fileName: string };
  /** Counts provider `data:` image chunks already satisfied by overlay image parts on a message. */
  private readonly absorbedProviderImages = new Map<string, number>();
  /** Overlay-supplied image parts attached to each user message during provider replay. */
  private readonly overlayImageParts = new Map<string, AppServerThreadImagePart[]>();
  /** Counts synthetic filename annotations already matched to each `(messageId, fileName)`. */
  private readonly matchedImageAnnotations = new Map<string, number>();

  /** How this session's edits are read; the workspace can arrive later. */
  private fileEditOptions: ReadAcpFileEditOptions;

  constructor(private readonly options: AcpSessionReplayNormalizerOptions = {}) {
    const kit = options.replayKit;
    this.kitPlanNormalizer = kit ? new kit.AcpSessionNormalizer({ quirks: kit.defaultQuirks() }) : undefined;
    this.fileEditOptions = {
      wholeFileDiffContent: options.wholeFileDiffContent,
      antigravity: options.antigravity,
      cwd: options.cwd,
    };
  }

  /**
   * Names later edits relative to the session's workspace. A live session can
   * receive updates before its metadata, and with it the workspace, is stored.
   */
  setWorkspace(cwd: string): void {
    this.fileEditOptions = { ...this.fileEditOptions, cwd };
  }

  beginProviderPromptReplay(prompts: AcpReplayPromptIdentity[]): void {
    this.providerPromptReplay = {
      prompts,
      steeredTurns: new Set(prompts.filter((prompt) => prompt.steerMessageId).map((prompt) => prompt.turnId)),
      nextIndex: 0,
      attachmentNextIndex: 0,
    };
    this.pendingUserImageAlt = undefined;
    this.pendingUserImageAlts = [];
    this.pendingSyntheticImageAnnotation = undefined;
    this.absorbedProviderImages.clear();
    this.overlayImageParts.clear();
    this.matchedImageAnnotations.clear();
  }

  endProviderPromptReplay(completedAt: number | undefined): void {
    this.providerPromptReplay = undefined;
    this.pendingUserImageAlt = undefined;
    this.pendingUserImageAlts = [];
    this.pendingSyntheticImageAnnotation = undefined;
    this.absorbedProviderImages.clear();
    this.overlayImageParts.clear();
    this.matchedImageAnnotations.clear();
    if (this.currentTurnId && completedAt !== undefined) {
      this.recordTurnFinished(this.currentTurnId, completedAt);
    }
  }

  recordUserPrompt(params: {
    sessionId: string;
    prompt: string;
    parts?: AppServerThreadMessagePart[];
    turnId: string;
    receivedAt?: number;
    waitingForAgent?: boolean;
  }): AppServerThreadReplay {
    const createdAt = params.receivedAt ?? Date.now();
    const id = `user:${params.turnId}`;
    const normalizedPrompt = normalizeUserPrompt(params.prompt, params.parts);
    this.settleOpenRetry("completed");
    this.settleOpenCompaction("cancelled");
    this.currentTurnId = params.turnId;
    this.currentTurnStartedAt = createdAt;
    this.activeAssistantMessageId = undefined;
    this.activeAssistantMessagePhase = undefined;
    this.assistantMessageSequence = 0;
    this.knownToolCallIds.clear();
    // A call's identity matters only while its updates arrive. Keeping every
    // call's for the whole session would grow without bound.
    this.providerTools.clear();
    this.fileReads.clear();
    this.upsertMessage({
      id,
      role: "user",
      text: normalizedPrompt.text,
      ...(normalizedPrompt.parts?.length ? { parts: normalizedPrompt.parts } : {}),
      createdAt,
    });
    if (params.waitingForAgent) {
      this.upsertAgentWaitingActivity(params.turnId, createdAt);
    }
    this.status = "active";
    return this.replay();
  }

  /**
   * Records a mid-turn steer message inside the active turn without replacing
   * the initial prompt (`user:<turnId>`), resetting assistant numbering, or
   * clearing in-flight tool tracking. Closes the open assistant bubble so later
   * chunks start a new message after the operator's steering text.
   */
  recordSteeredUserPrompt(params: {
    sessionId: string;
    messageId: string;
    prompt: string;
    parts?: AppServerThreadMessagePart[];
    turnId?: string;
    receivedAt?: number;
  }): AppServerThreadReplay {
    const createdAt = params.receivedAt ?? Date.now();
    const normalizedPrompt = normalizeUserPrompt(params.prompt, params.parts);
    const activeTurnId = params.turnId ?? this.currentTurnId;
    if (activeTurnId) {
      this.removeAgentWaitingActivity(activeTurnId);
    }
    this.endActiveAssistantMessage();
    this.upsertMessage({
      id: params.messageId,
      role: "user",
      text: normalizedPrompt.text,
      ...(normalizedPrompt.parts?.length ? { parts: normalizedPrompt.parts } : {}),
      createdAt,
    });
    this.status = "active";
    return this.replay();
  }

  recordTurnFinished(
    turnId?: string,
    completedAt = Date.now(),
    status: "completed" | "interrupted" = "completed",
  ): AppServerThreadReplay {
    const completedTurnId = turnId ?? this.currentTurnId;
    const settledStatus = status === "interrupted" ? "cancelled" : "completed";
    this.settleOpenRetry(settledStatus);
    this.settleOpenCompaction(settledStatus);
    if (completedTurnId) {
      this.removeAgentWaitingActivity(completedTurnId);
      this.completeTurnEntries(completedTurnId, status, completedAt);
    } else {
      this.removeCurrentAgentWaitingActivity();
    }
    if (!turnId || this.currentTurnId === turnId) {
      this.currentTurnId = undefined;
      this.currentTurnStartedAt = undefined;
    }
    this.activeAssistantMessageId = undefined;
    this.activeAssistantMessagePhase = undefined;
    this.knownToolCallIds.clear();
    this.status = "idle";
    return this.replay();
  }

  recordTurnFailed(params: {
    sessionId: string;
    turnId: string;
    error: string;
    receivedAt?: number;
  }): AppServerThreadReplay {
    const createdAt = params.receivedAt ?? Date.now();
    this.settleOpenRetry("failed");
    this.settleOpenCompaction("failed");
    this.removeAgentWaitingActivity(params.turnId);
    this.completeTurnEntries(params.turnId, "failed", createdAt);
    if (this.currentTurnId === params.turnId) {
      this.currentTurnId = undefined;
      this.currentTurnStartedAt = undefined;
    }
    this.activeAssistantMessageId = undefined;
    this.activeAssistantMessagePhase = undefined;
    this.knownToolCallIds.clear();
    this.status = "idle";
    this.upsertActivity({
      type: "activity",
      id: `turn-failed:${params.turnId}`,
      createdAt,
      summary: "Turn failed",
      tone: "warning",
      status: "failed",
      turn: {
        id: params.turnId,
        status: "failed",
        completedAt: createdAt,
      },
      details: [
        {
          id: `turn-failed:${params.turnId}:detail`,
          kind: "read",
          label: params.error,
          status: "failed",
        },
      ],
    });
    return this.replay();
  }

  rewindToPromptIndex(
    targetPromptIndex: number,
    options: { missingTarget?: "clear" | "throw" } = {},
  ): AppServerThreadReplay {
    if (!Number.isInteger(targetPromptIndex) || targetPromptIndex < 0) {
      throw new Error("ACP rewind target must be a non-negative prompt index");
    }
    let promptIndex = 0;
    let boundary = this.entries.length;
    for (let index = 0; index < this.entries.length; index += 1) {
      const entry = this.entries[index];
      if (entry?.type !== "message" || entry.role !== "user") {
        continue;
      }
      if (promptIndex === targetPromptIndex) {
        boundary = index;
        break;
      }
      promptIndex += 1;
    }
    if (boundary === this.entries.length && promptIndex <= targetPromptIndex) {
      if (options.missingTarget !== "clear") {
        throw new Error(`ACP rewind target ${targetPromptIndex} was not found`);
      }
      // The provider is authoritative after it accepts an irreversible
      // rewind. If local history was incomplete, retaining any of it would
      // risk showing turns that Grok has already discarded. Clear the replay
      // and let session/load hydrate the provider's retained branch.
      boundary = 0;
    }

    this.entries = this.entries.slice(0, boundary);
    const retainedMessageIds = new Set(
      this.entries
        .filter(
          (entry): entry is AppServerThreadEntry & { type: "message" } =>
            entry.type === "message",
        )
        .map((entry) => entry.id),
    );
    this.messages = this.messages.filter((message) =>
      retainedMessageIds.has(message.id)
    );
    this.rebuildEntryIndexes();
    this.rebuildMessageIndexes();
    this.currentTurnId = undefined;
    this.currentTurnStartedAt = undefined;
    this.activeAssistantMessageId = undefined;
    this.activeAssistantMessagePhase = undefined;
    this.assistantMessageSequence = 0;
    this.knownToolCallIds.clear();
    this.openRetry = undefined;
    this.openCompactionId = undefined;
    this.subAgents.clear();
    this.status = "idle";
    return this.replay();
  }

  apply(update: AcpSessionUpdate): AppServerThreadReplay {
    const kind = readKind(update.update);
    const createdAt =
      readAcpUpdateTimestamp(update.update) ?? update.receivedAt ?? Date.now();
    if (this.openRetry && isAcpModelProgressUpdate(kind, update.update)) {
      // Any output after a retry means the model answered. This runs before
      // the hidden-thought return below: Grok's thoughts are not shown, but
      // they are usually the first sign that a retry succeeded.
      this.settleOpenRetry("completed");
    }
    if (
      kind === "agent_thought_chunk" &&
      this.options.surfaceThoughtsAsMessages === false
    ) {
      return this.replay();
    }
    const isAssistantTextUpdate =
      kind === "agent_message_chunk" || kind === "agent_thought_chunk";

    if (isAssistantTextUpdate || kind === "turn_started" || kind === "turn_completed" || kind === "turn_finished") {
      this.insideAgentInstructionBlock = false;
      this.pendingUserImageAlt = undefined;
      this.pendingUserImageAlts = [];
      this.pendingSyntheticImageAnnotation = undefined;
      if (this.pendingAgentMemoryChunk && !this.agentMemoryChunk?.insideBlock) {
        const pending = this.pendingAgentMemoryChunk;
        this.appendUserMessageText(pending.update, pending.createdAt, this.agentMemoryChunk?.pending ?? "");
      }
      this.pendingAgentMemoryChunk = undefined;
      this.agentMemoryChunk = undefined;
    }
    if (isAssistantTextUpdate) {
      // Consecutive ACP text chunks form one live bubble, but text after a tool
      // call should become a new bubble instead of overwriting earlier text.
      const text =
        readContentText(update.update, "content") ??
        readString(update.update, "text") ??
        "";
      if (text.trim() && !isModeUpdateMarker(text) && this.currentTurnId) {
        this.removeAgentWaitingActivity(this.currentTurnId);
      }
      if (kind === "agent_message_chunk") {
        this.resetAssistantMessageIfPhaseChanged("final");
        this.applyAgentMessageChunk(update, createdAt);
      } else {
        this.resetAssistantMessageIfPhaseChanged("commentary");
        this.applyAgentThoughtChunk(update, createdAt);
      }
    } else if (kind === "user_message_chunk") {
      this.activeAssistantMessageId = undefined;
      this.activeAssistantMessagePhase = undefined;
      if (!this.providerPromptReplay) this.knownToolCallIds.clear();
      this.applyUserMessageChunk(update, createdAt);
    } else if (kind === "available_commands_update") {
      // Command metadata belongs in provider capabilities, not the transcript.
    } else if (
      kind === "config_option_update" ||
      kind === "current_mode_update" ||
      kind === "model_changed"
    ) {
      // Runtime configuration changes belong in ACP session metadata.
    } else if (isGrokTransientUpdateKind(kind)) {
      // Grok emits these transient xAI extension updates in addition to the
      // canonical ACP tool calls and permission requests. They are transport
      // state, not transcript entries, and must not split assistant bubbles.
    } else if (isAcpSessionMetadataUpdateKind(kind)) {
      // Session title/timestamp metadata. The title is consumed by
      // readAcpTopicTitle on the acp-client side.
    } else if (isAcpUsageUpdateKind(kind)) {
      // Context-window fill. The backend adapter turns it into the thread's
      // context usage; it has no place in the transcript.
    } else if (isAcpRetryStateUpdateKind(kind)) {
      // Not a message boundary: the assistant bubble stays open, as it does
      // for an unrecognized kind.
      this.upsertRetryActivity(update, createdAt);
    } else if (kind === "image_dropped") {
      this.upsertActivity(imageDroppedActivity(update, createdAt));
    } else if (
      kind === "auto_compact_started" || kind === "auto_compact_completed"
    ) {
      this.upsertCompactionActivity(update, kind, createdAt);
    } else if (
      kind === "subagent_spawned"
      || kind === "subagent_progress"
      || kind === "subagent_finished"
    ) {
      this.upsertSubAgentActivity(update, kind, createdAt);
    } else if (kind === "turn_completed" || kind === "turn_finished") {
      // Some agents persist a durable replay terminal before the live
      // session/prompt request resolves. The client defers the live idle
      // transition until prompt resolution so queued work cannot overlap.
      if (!update.deferTurnCompletion) {
        this.recordTurnFinished(
          undefined,
          createdAt,
          update.update.stopReason === "cancelled" ? "interrupted" : "completed",
        );
      }
    } else if (readAcpTopicTitle(update.update)) {
      // Topic updates are thread metadata, not transcript entries.
    } else {
      const toolCallId = readAcpToolCallId(update.update);
      // A tool_call is the semantic boundary between assistant messages.
      // Updates for that known call may arrive while the provider is already
      // streaming the next message, so only those preserve the active bubble.
      // A standalone tool_call_update remains a boundary for providers that
      // use it as their only notification for a tool invocation.
      const updatesKnownToolCall =
        kind === "tool_call_update"
        && toolCallId !== undefined
        && this.knownToolCallIds.has(toolCallId);
      if (
        toolCallId
        && (kind === "tool_call" || kind === "tool_call_update")
      ) {
        this.knownToolCallIds.add(toolCallId);
      }
      // Each branch below ends the active assistant bubble only if that update
      // really is a message boundary. Doing it up front instead would also end
      // it for kinds we failed to classify, and not recognizing a kind says
      // nothing about whether the assistant finished speaking.
      if (kind === "plan") {
        this.endActiveAssistantMessage();
        this.removeCurrentAgentWaitingActivity();
        this.upsertPlan(update, createdAt);
      } else if (kind === "tool_call" || kind === "tool_call_update") {
        if (!updatesKnownToolCall) {
          this.endActiveAssistantMessage();
        }
        this.removeCurrentAgentWaitingActivity();
        this.upsertToolActivity(update, kind, createdAt, toolCallId);
      } else if (kind === "file" || kind === "terminal") {
        this.endActiveAssistantMessage();
        this.removeCurrentAgentWaitingActivity();
        this.upsertToolActivity(update, kind, createdAt, toolCallId);
      } else if (kind === "turn_started") {
        this.endActiveAssistantMessage();
        this.knownToolCallIds.clear();
        this.status = "active";
      } else if (kind === "pwragent_turn_failed") {
        this.recordTurnFailed({
          sessionId: update.sessionId,
          turnId: readString(update.update, "turnId") ?? buildPendingTurnId(update.sessionId),
          error: readString(update.update, "error") ?? "Turn failed.",
          receivedAt: createdAt,
        });
      } else if (kind === "pwragent_user_prompt") {
        this.recordUserPrompt({
          sessionId: update.sessionId,
          prompt: readString(update.update, "prompt") ?? "",
          parts: readMessageParts(update.update),
          turnId: readString(update.update, "turnId") ?? buildPendingTurnId(update.sessionId),
          receivedAt: createdAt,
          waitingForAgent: readBoolean(update.update, "waitingForAgent"),
        });
      } else if (kind === "pwragent_steered_user_prompt") {
        const turnId = readString(update.update, "turnId") ?? this.currentTurnId;
        this.recordSteeredUserPrompt({
          sessionId: update.sessionId,
          messageId:
            readString(update.update, "messageId")
            ?? `user:${turnId ?? update.sessionId}:steer:${createdAt}:${this.generatedMessageSequence++}`,
          prompt: readString(update.update, "prompt") ?? "",
          parts: readMessageParts(update.update),
          ...(turnId ? { turnId } : {}),
          receivedAt: createdAt,
        });
      } else if (kind === "pwragent_antigravity_prompt_identity" || kind === "pwragent_prompt_attachments") {
        // Identity and attachment metadata is applied only to matching provider replay rows.
      } else if (kind === "pwragent_rewind_marker") {
        this.rewindToPromptIndex(
          readNumber(update.update, "targetPromptIndex") ?? -1,
          { missingTarget: "clear" },
        );
      } else {
        // An unrecognized kind is worth a breadcrumb — it is how new protocol
        // traffic gets spotted — but it must not be destructive. The bubble
        // stays open, so later chunks append to the existing (earlier) message
        // entry and this activity naturally sorts after the finished message
        // rather than through the middle of it.
        //
        // This trades one failure for a better one. If an unrecognized kind
        // really was a boundary — a provider naming its tool call something we
        // do not enumerate — the text after it merges into the earlier bubble
        // instead of starting a new one. A reply that reads as one paragraph
        // too many beats a reply torn in half around a placeholder, and the fix
        // is to enumerate the kind above, which this breadcrumb is what surfaces.
        this.removeCurrentAgentWaitingActivity();
        this.upsertActivity(unknownActivity(update, kind, createdAt));
      }
    }

    return this.replay();
  }

  replay(): AppServerThreadReplay {
    return {
      entries: this.entries,
      messages: this.messages,
      lastUserMessage: this.lastUserMessageIndex === undefined
        ? undefined : this.messages[this.lastUserMessageIndex]?.text,
      lastAssistantMessage: this.lastAssistantMessageIndex === undefined
        ? undefined : this.messages[this.lastAssistantMessageIndex]?.text,
      pagination: {
        supportsPagination: false,
        hasPreviousPage: false,
      },
      threadStatus: this.status,
    };
  }

  private applyAgentMessageChunk(update: AcpSessionUpdate, createdAt: number): void {
    const text =
      readContentText(update.update, "content") ??
      readString(update.update, "text") ??
      "";
    if (
      !text
      || isModeUpdateMarker(text)
      || (!this.activeAssistantMessageId && !text.trim())
    ) {
      return;
    }
    const id = this.assistantMessageIdForChunk(update);
    this.appendMessageChunk({
      id,
      phase: "final",
      role: "assistant",
      text,
      createdAt,
    });
  }

  /** An echoed Agent instruction block opened in an earlier user chunk. */
  private insideAgentInstructionBlock = false;
  private agentMemoryChunk?: { insideBlock: boolean; pending: string };
  private pendingAgentMemoryChunk?: { update: AcpSessionUpdate; createdAt: number };

  private applyUserMessageChunk(update: AcpSessionUpdate, createdAt: number): void {
    const fallbackAlt = this.pendingUserImageAlt ?? this.pendingUserImageAlts.shift();
    const imagePart = readAcpUserImagePart(update.update.content, fallbackAlt);
    if (imagePart) {
      this.pendingUserImageAlt = undefined;
      if (this.isActiveLocalPromptEcho()) {
        return;
      }
      this.attachReplayedUserImagePart(update, createdAt, imagePart);
      return;
    }
    if (fallbackAlt && !this.pendingUserImageAlt) {
      this.pendingUserImageAlts.unshift(fallbackAlt);
    }
    // PwrAgent prepends the finished managed-review artifact to the next
    // prompt so the agent can reason about it. The transcript already shows
    // that review as its own entry, so strip the block back out of the echo
    // rather than rendering it as something the operator typed.
    // The Agent instruction block PwrAgent puts ahead of a prompt is removed
    // the same way: the operator did not type it.
    // An agent may echo the block in several chunks.
    const stripped = stripAcpAgentInstructionChunk(stripManagedReviewContextBlock(
      readContentText(update.update, "content") ??
        readString(update.update, "text") ??
        "",
    ), this.insideAgentInstructionBlock);
    this.insideAgentInstructionBlock = stripped.insideBlock;
    const memory = stripAgentMemoryChunk(stripped.text, this.agentMemoryChunk, true);
    this.agentMemoryChunk = { insideBlock: memory.insideBlock, pending: memory.pending };
    this.pendingAgentMemoryChunk = memory.pending ? { update, createdAt } : undefined;
    this.appendUserMessageText(update, createdAt, memory.text);
  }

  private isActiveLocalPromptEcho(): boolean {
    return (
      !this.providerPromptReplay
      && Boolean(this.currentTurnId)
      && this.messageIndexes.has(`user:${this.currentTurnId}`)
    );
  }

  private appendUserMessageText(update: AcpSessionUpdate, createdAt: number, text: string): void {
    if (!text) {
      return;
    }
    if (isAcpUserBoilerplateMessage(text)) {
      // Gemini re-emits its <session_context> environment block (date, OS,
      // workspace dir, directory tree) as a user_message_chunk on session/load.
      // ACP agents can also replay synthetic <system-reminder> prompts. These
      // are setup/control text the agent saw, not user-authored turns.
      return;
    }
    if (this.isActiveLocalPromptEcho()) {
      return;
    }
    const extracted = extractAcpSyntheticImageAnnotations(text);
    if (extracted.fileNames.length > 0 && !extracted.text) {
      const unmatched: string[] = [];
      for (const fileName of extracted.fileNames) {
        if (!this.handleSyntheticImageAnnotationChunk(update, createdAt, fileName)) {
          unmatched.push(fileName);
        }
      }
      if (unmatched.length === 0) {
        return;
      }
      const primaryFileName = unmatched[0]!;
      const id =
        readString(update.update, "messageId") ??
        readString(update.update, "id") ??
        `user:${update.sessionId}:${createdAt}:${this.generatedMessageSequence++}`;
      const providerId = this.providerMessageId(id);
      this.appendMessageChunk({
        id: providerId,
        role: "user",
        text,
        createdAt,
      });
      this.pendingUserImageAlt = primaryFileName;
      if (unmatched.length > 1) {
        this.pendingUserImageAlts.push(...unmatched.slice(1));
      }
      this.pendingSyntheticImageAnnotation = { messageId: providerId, fileName: primaryFileName };
      return;
    }
    if (extracted.fileNames.length > 0 && extracted.text) {
      this.pendingUserImageAlt = undefined;
      this.pendingUserImageAlts = [];
      this.pendingSyntheticImageAnnotation = undefined;
      this.appendUserTextBody(update, createdAt, extracted.text);
      for (const fileName of extracted.fileNames) {
        if (!this.handleSyntheticImageAnnotationChunk(update, createdAt, fileName)) {
          this.pendingUserImageAlts.push(fileName);
        }
      }
      if (this.pendingUserImageAlts.length > 0) {
        this.pendingUserImageAlt = undefined;
      }
      return;
    }
    this.pendingUserImageAlt = undefined;
    this.pendingUserImageAlts = [];
    this.pendingSyntheticImageAnnotation = undefined;
    this.appendUserTextBody(update, createdAt, text);
  }

  private appendUserTextBody(update: AcpSessionUpdate, createdAt: number, text: string): void {
    if (this.providerPromptReplay) {
      if (this.foldConsecutiveUserTextChunk(update, createdAt, text)) return;
      if (this.applyProviderPromptIdentity(update, createdAt, text)) return;
      this.knownToolCallIds.clear();
      if (this.currentTurnId) this.recordTurnFinished(this.currentTurnId, createdAt);
    }
    const lastEntry = this.entries[this.entries.length - 1];
    const lastUserMessage = this.lastUserMessageIndex === undefined
      ? undefined : this.messages[this.lastUserMessageIndex];
    if (lastUserMessage?.text.trim() === text.trim()
      && lastEntry?.type === "message"
      && lastEntry.id === lastUserMessage.id
      && (!this.providerPromptReplay || lastUserMessage.createdAt === createdAt)) {
      return;
    }
    const attachmentParts = this.consumeUnnamedAttachmentReplayPartsForText(text);
    const id =
      readString(update.update, "messageId") ??
      readString(update.update, "id") ??
      `user:${update.sessionId}:${createdAt}:${this.generatedMessageSequence++}`;
    const providerId = this.providerMessageId(id);
    const parts = attachmentParts?.length
      ? [{ type: "text" as const, text }, ...attachmentParts]
      : undefined;
    this.appendMessageChunk({
      id: providerId,
      role: "user",
      text,
      ...(parts ? { parts } : {}),
      createdAt,
    });
    if (attachmentParts?.length) {
      this.recordOverlayImageParts(providerId, attachmentParts);
    }
  }

  /**
   * Some ACP prompts send multiple consecutive text blocks which providers
   * replay as separate `user_message_chunk` notifications with no message ID.
   * When combining the new chunk with the immediately preceding user message
   * matches a pending prompt digest in `providerPromptReplay`, fold it back
   * into that message so prompt identity and image attachment matching succeed.
   */
  private foldConsecutiveUserTextChunk(
    update: AcpSessionUpdate,
    createdAt: number,
    text: string,
  ): boolean {
    const replay = this.providerPromptReplay;
    if (!replay) {
      return false;
    }
    const lastEntry = this.entries[this.entries.length - 1];
    if (lastEntry?.type !== "message" || lastEntry.role !== "user" || !lastEntry.text) {
      return false;
    }
    const combinedText = `${lastEntry.text}\n${text}`;
    const combinedDigest = acpReplayPromptTextDigest(combinedText);
    const startIndex = Math.min(replay.nextIndex, replay.attachmentNextIndex);
    const matchesCombined = replay.prompts
      .slice(startIndex)
      .some((prompt) => prompt.textDigest === combinedDigest);
    if (!matchesCombined) {
      return false;
    }
    const messageIndex = this.messageIndexes.get(lastEntry.id);
    const existingMessage = messageIndex !== undefined ? this.messages[messageIndex] : undefined;
    if (!existingMessage) {
      return false;
    }
    existingMessage.text = combinedText;
    lastEntry.text = combinedText;
    if (existingMessage.parts?.length) {
      const updatedParts = existingMessage.parts.map((part, idx) =>
        idx === 0 && part.type === "text" ? { type: "text" as const, text: combinedText } : part,
      );
      existingMessage.parts = updatedParts;
      lastEntry.parts = updatedParts;
    }
    const unnamedAttachments = this.consumeUnnamedAttachmentReplayPartsForText(combinedText);
    if (unnamedAttachments?.length) {
      this.attachPartsToUserMessage(lastEntry.id, unnamedAttachments);
    }
    void update;
    void createdAt;
    return true;
  }

  private handleSyntheticImageAnnotationChunk(
    update: AcpSessionUpdate,
    createdAt: number,
    fileName: string,
  ): boolean {
    const lastEntry = this.entries[this.entries.length - 1];
    if (lastEntry?.type === "message" && lastEntry.role === "user") {
      const matchingImageCount = (lastEntry.parts ?? []).filter(
        (part) => part.type === "image" && (!part.alt || part.alt === fileName),
      ).length;
      const key = `${lastEntry.id}\0${fileName}`;
      const alreadyMatched = this.matchedImageAnnotations.get(key) ?? 0;
      if (matchingImageCount > alreadyMatched) {
        this.matchedImageAnnotations.set(key, alreadyMatched + 1);
        this.pendingUserImageAlt = fileName;
        this.pendingSyntheticImageAnnotation = undefined;
        return true;
      }
      // If the previous user message is an empty-text image-only message that
      // already consumed its overlay image slots, a new annotation belongs to a
      // subsequent image-only turn rather than appending to the earlier bubble.
      if (lastEntry.text || !this.overlayImageParts.has(lastEntry.id)) {
        const matchedParts = this.consumeAttachmentReplayPartsForUserMessage(lastEntry.text, fileName);
        if (matchedParts?.length) {
          this.attachPartsToUserMessage(lastEntry.id, matchedParts);
          this.matchedImageAnnotations.set(key, alreadyMatched + 1);
          this.pendingUserImageAlt = fileName;
          this.pendingSyntheticImageAnnotation = undefined;
          return true;
        }
      }
    }
    const emptyTextAttachments = this.consumeEmptyTextAttachmentReplayParts(fileName);
    if (emptyTextAttachments?.length) {
      const id =
        readString(update.update, "messageId") ??
        readString(update.update, "id") ??
        `user:${update.sessionId}:${createdAt}:${this.generatedMessageSequence++}`;
      const providerId = this.providerMessageId(id);
      this.knownToolCallIds.clear();
      if (this.currentTurnId) this.recordTurnFinished(this.currentTurnId, createdAt);
      this.upsertMessage({
        id: providerId,
        role: "user",
        text: "",
        parts: emptyTextAttachments,
        createdAt,
      });
      this.recordOverlayImageParts(providerId, emptyTextAttachments);
      this.matchedImageAnnotations.set(`${providerId}\0${fileName}`, 1);
      this.pendingUserImageAlt = fileName;
      this.pendingSyntheticImageAnnotation = undefined;
      return true;
    }
    return false;
  }

  private attachReplayedUserImagePart(
    update: AcpSessionUpdate,
    createdAt: number,
    imagePart: AppServerThreadImagePart,
  ): void {
    const pendingAnnotation = this.pendingSyntheticImageAnnotation;
    this.pendingSyntheticImageAnnotation = undefined;
    if (pendingAnnotation) {
      const annotationEntryIndex = this.typedEntryIndexes.get(`message:${pendingAnnotation.messageId}`);
      const annotationEntry = annotationEntryIndex !== undefined
        ? this.entries[annotationEntryIndex]
        : undefined;
      const previousEntry = annotationEntryIndex !== undefined && annotationEntryIndex > 0
        ? this.entries[annotationEntryIndex - 1]
        : undefined;
      if (annotationEntry?.type === "message" && annotationEntry.role === "user") {
        const normalizedImage: AppServerThreadImagePart = imagePart.alt
          ? imagePart
          : { ...imagePart, alt: pendingAnnotation.fileName };
        if (previousEntry?.type === "message" && previousEntry.role === "user") {
          this.removeUserMessageById(pendingAnnotation.messageId);
          this.appendImagePartToUserMessage(previousEntry.id, normalizedImage);
          return;
        }
        this.upsertMessage({
          id: annotationEntry.id,
          role: "user",
          text: "",
          parts: [normalizedImage],
          createdAt: annotationEntry.createdAt ?? createdAt,
        });
        return;
      }
    }
    const lastEntry = this.entries[this.entries.length - 1];
    if (lastEntry?.type === "message" && lastEntry.role === "user") {
      if (imagePart.url.startsWith("data:") && !this.overlayImageParts.has(lastEntry.id)) {
        const localOverlay = this.consumeAttachmentReplayPartsForUserMessage(
          lastEntry.text,
          imagePart.alt,
        );
        if (localOverlay?.length) {
          this.attachPartsToUserMessage(lastEntry.id, localOverlay);
        }
      }
      this.appendImagePartToUserMessage(lastEntry.id, imagePart);
      return;
    }
    const id =
      readString(update.update, "messageId") ??
      readString(update.update, "id") ??
      `user:${update.sessionId}:${createdAt}:${this.generatedMessageSequence++}`;
    const providerId = this.providerMessageId(id);
    const emptyTextOverlay = imagePart.url.startsWith("data:")
      ? this.consumeEmptyTextAttachmentReplayParts(imagePart.alt)
      : undefined;
    if (emptyTextOverlay?.length) {
      this.upsertMessage({
        id: providerId,
        role: "user",
        text: "",
        parts: emptyTextOverlay,
        createdAt,
      });
      this.recordOverlayImageParts(providerId, emptyTextOverlay);
      this.appendImagePartToUserMessage(providerId, imagePart);
      return;
    }
    this.upsertMessage({
      id: providerId,
      role: "user",
      text: "",
      parts: [imagePart],
      createdAt,
    });
  }

  private recordOverlayImageParts(
    messageId: string,
    parts: readonly AppServerThreadMessagePart[] | undefined,
  ): void {
    const images = parts?.filter(
      (part): part is AppServerThreadImagePart => part.type === "image",
    );
    if (!images?.length) {
      return;
    }
    const existing = this.overlayImageParts.get(messageId) ?? [];
    this.overlayImageParts.set(messageId, [...existing, ...images]);
  }

  private attachPartsToUserMessage(
    messageId: string,
    attachmentParts: readonly AppServerThreadMessagePart[],
  ): void {
    const messageIndex = this.messageIndexes.get(messageId);
    const entryIndex = this.typedEntryIndexes.get(`message:${messageId}`);
    const existingMessage = messageIndex !== undefined ? this.messages[messageIndex] : undefined;
    const existingEntry = entryIndex !== undefined ? this.entries[entryIndex] : undefined;
    if (!existingMessage || existingEntry?.type !== "message") {
      return;
    }
    const baseParts: AppServerThreadMessagePart[] = existingMessage.parts?.length
      ? [...existingMessage.parts]
      : (existingMessage.text ? [{ type: "text", text: existingMessage.text }] : []);
    const nextParts = [...baseParts, ...attachmentParts];
    existingMessage.parts = nextParts;
    existingEntry.parts = nextParts;
    this.recordOverlayImageParts(messageId, attachmentParts);
  }

  private appendImagePartToUserMessage(
    messageId: string,
    imagePart: AppServerThreadImagePart,
  ): void {
    const messageIndex = this.messageIndexes.get(messageId);
    const entryIndex = this.typedEntryIndexes.get(`message:${messageId}`);
    const existingMessage = messageIndex !== undefined ? this.messages[messageIndex] : undefined;
    const existingEntry = entryIndex !== undefined ? this.entries[entryIndex] : undefined;
    if (!existingMessage || existingEntry?.type !== "message") {
      return;
    }
    const baseParts: AppServerThreadMessagePart[] = existingMessage.parts?.length
      ? [...existingMessage.parts]
      : (existingMessage.text ? [{ type: "text", text: existingMessage.text }] : []);
    if (imagePart.url.startsWith("data:")) {
      // Absorb an incoming provider base64 image block only when this message
      // still has an unconsumed overlay-supplied image part (durable protocol
      // URL or legacy data: URL) for the same filename or unnamed slot.
      // Distinct provider `data:` images with no overlay remain preserved.
      const overlayImages = this.overlayImageParts.get(messageId) ?? [];
      const overlayMatchingCount = overlayImages.filter(
        (part) => !imagePart.alt || !part.alt || part.alt === imagePart.alt,
      ).length;
      if (overlayMatchingCount > 0) {
        const key = `${messageId}\0${imagePart.alt ?? ""}`;
        const absorbed = this.absorbedProviderImages.get(key) ?? 0;
        if (absorbed < overlayMatchingCount) {
          this.absorbedProviderImages.set(key, absorbed + 1);
          return;
        }
      }
    } else if (baseParts.some((part) => part.type === "image" && part.url === imagePart.url)) {
      return;
    }
    const nextParts = [...baseParts, imagePart];
    existingMessage.parts = nextParts;
    existingEntry.parts = nextParts;
  }

  private removeUserMessageById(messageId: string): void {
    this.entries = this.entries.filter((entry) => !(entry.type === "message" && entry.id === messageId));
    this.messages = this.messages.filter((message) => message.id !== messageId);
    this.rebuildEntryIndexes();
    this.rebuildMessageIndexes();
  }

  /**
   * Advances past matching text-only prompt identities on providers that record
   * every prompt (such as Antigravity), and eagerly attaches only unnamed image
   * attachments that emit no filename-annotation chunk on the wire. Named
   * attachments wait for their matching filename-annotation or image chunk so
   * an earlier text-only turn with the same text cannot steal a later turn's
   * images.
   */
  private consumeUnnamedAttachmentReplayPartsForText(
    text: string,
  ): AppServerThreadMessagePart[] | undefined {
    const replay = this.providerPromptReplay;
    if (!replay || replay.attachmentNextIndex >= replay.prompts.length) {
      return undefined;
    }
    const textDigest = acpReplayPromptTextDigest(text);
    for (let index = replay.attachmentNextIndex; index < replay.prompts.length; index += 1) {
      const candidate = replay.prompts[index]!;
      if (candidate.textDigest !== textDigest) {
        if (candidate.attachmentParts?.length) {
          break;
        }
        continue;
      }
      if (!candidate.attachmentParts?.length) {
        replay.attachmentNextIndex = index + 1;
        return undefined;
      }
      const allImagesUnnamed =
        candidate.attachmentParts.some((part) => part.type === "image")
        && candidate.attachmentParts.every((part) => part.type !== "image" || !part.alt);
      if (!allImagesUnnamed) {
        return undefined;
      }
      replay.attachmentNextIndex = index + 1;
      return candidate.attachmentParts;
    }
    return undefined;
  }

  private consumeAttachmentReplayPartsForUserMessage(
    text: string,
    fileName?: string,
  ): AppServerThreadMessagePart[] | undefined {
    const replay = this.providerPromptReplay;
    if (!replay) {
      return undefined;
    }
    const textDigest = acpReplayPromptTextDigest(text);
    for (let index = replay.attachmentNextIndex; index < replay.prompts.length; index += 1) {
      const prompt = replay.prompts[index]!;
      if (!prompt.attachmentParts?.length || prompt.textDigest !== textDigest) {
        continue;
      }
      if (fileName) {
        const matchesFile = prompt.attachmentParts.some(
          (part) =>
            (part.type === "image" && (!part.alt || part.alt === fileName))
            || (part.type === "file" && part.name === fileName),
        );
        if (!matchesFile) {
          continue;
        }
      }
      replay.attachmentNextIndex = index + 1;
      return prompt.attachmentParts;
    }
    return undefined;
  }

  private consumeEmptyTextAttachmentReplayParts(
    fileName?: string,
  ): AppServerThreadMessagePart[] | undefined {
    const replay = this.providerPromptReplay;
    if (!replay) {
      return undefined;
    }
    const emptyDigest = acpReplayPromptTextDigest("");
    for (let index = replay.attachmentNextIndex; index < replay.prompts.length; index += 1) {
      const prompt = replay.prompts[index]!;
      if (!prompt.attachmentParts?.length || prompt.textDigest !== emptyDigest) {
        continue;
      }
      if (fileName) {
        const matchesFile = prompt.attachmentParts.some(
          (part) =>
            (part.type === "image" && (!part.alt || part.alt === fileName))
            || (part.type === "file" && part.name === fileName),
        );
        if (!matchesFile) {
          continue;
        }
      }
      replay.attachmentNextIndex = index + 1;
      return prompt.attachmentParts;
    }
    return undefined;
  }

  private applyProviderPromptIdentity(update: AcpSessionUpdate, createdAt: number, text: string): boolean {
    const replay = this.providerPromptReplay;
    const timestamped = readAcpUpdateTimestamp(update.update) !== undefined;
    if (!replay || (!timestamped && !this.options.workspaceSessionId)) return false;
    const textDigest = acpReplayPromptTextDigest(text);
    // The same host timestamps both streams. Allow for dispatch/receipt and
    // timestamp rounding, and consume each matching occurrence in wire order.
    const timestampSlopMs = 1_000;
    while (timestamped && replay.nextIndex < replay.prompts.length
      && replay.prompts[replay.nextIndex]!.receivedAt < createdAt - timestampSlopMs) {
      replay.nextIndex += 1;
    }
    let matchIndex = -1;
    for (let index = replay.nextIndex; index < replay.prompts.length; index += 1) {
      const prompt = replay.prompts[index]!;
      if (timestamped && prompt.receivedAt > createdAt + timestampSlopMs) break;
      if (prompt.steerMessageId && prompt.turnId !== this.currentTurnId) continue;
      const distance = Math.abs(prompt.receivedAt - createdAt);
      if ((timestamped && distance > timestampSlopMs) || prompt.textDigest !== textDigest) continue;
      // Consume matching occurrences in wire order. Choosing the smallest
      // timestamp delta instead can jump from an earlier turn to a later turn
      // with identical text when session/load stamps chunks with reload time.
      matchIndex = index;
      break;
    }
    if (matchIndex === -1) return false;
    const identity = replay.prompts[matchIndex]!;
    replay.nextIndex = matchIndex + 1;
    if (!this.options.workspaceSessionId && !replay.steeredTurns.has(identity.turnId)) return false;
    if (matchIndex >= replay.attachmentNextIndex) {
      replay.attachmentNextIndex = matchIndex + 1;
    }
    const parts = identity.attachmentParts?.length
      ? [{ type: "text" as const, text }, ...identity.attachmentParts]
      : undefined;
    const params = {
      sessionId: update.sessionId,
      prompt: text,
      ...(parts ? { parts } : {}),
      turnId: identity.turnId,
      receivedAt: timestamped ? createdAt : identity.receivedAt,
    };
    if (identity.steerMessageId) {
      this.recordSteeredUserPrompt({ ...params, messageId: identity.steerMessageId });
      this.recordOverlayImageParts(identity.steerMessageId, identity.attachmentParts);
    } else {
      if (this.currentTurnId) this.recordTurnFinished(this.currentTurnId, createdAt);
      this.recordUserPrompt(params);
      this.recordOverlayImageParts(`user:${identity.turnId}`, identity.attachmentParts);
    }
    return true;
  }

  private applyAgentThoughtChunk(update: AcpSessionUpdate, createdAt: number): void {
    if (this.options.surfaceThoughtsAsMessages === false) {
      return;
    }
    const text =
      readContentText(update.update, "content") ??
      readString(update.update, "text") ??
      "";
    if (!text || (!this.activeAssistantMessageId && !text.trim())) {
      return;
    }
    const id = this.assistantMessageIdForChunk(update);
    this.appendMessageChunk({
      id,
      phase: "commentary",
      role: "assistant",
      text,
      createdAt,
    });
  }

  /** The live delta stream must use the same message identity as replay. */
  readActiveAssistantMessageId(): string | undefined {
    return this.activeAssistantMessageId;
  }

  private assistantMessageIdForChunk(update: AcpSessionUpdate): string {
    const explicitId =
      readString(update.update, "messageId") ??
      readString(update.update, "message_id");
    if (explicitId) {
      this.activeAssistantMessageId = this.providerMessageId(explicitId);
      return this.activeAssistantMessageId;
    }
    if (!this.activeAssistantMessageId) {
      this.activeAssistantMessageId = this.providerMessageId(
        `assistant:${this.currentTurnId ?? update.sessionId}:${this.assistantMessageSequence++}`,
      );
    }
    return this.activeAssistantMessageId;
  }

  private providerMessageId(id: string): string {
    return this.options.workspaceSessionId
      ? `acp:${encodeURIComponent(this.options.workspaceSessionId)}:${id}`
      : id;
  }

  /**
   * Close the assistant bubble currently being streamed, so the next text
   * chunk starts a new message entry instead of appending to this one. Call
   * this only for updates that are genuinely a message boundary.
   */
  private endActiveAssistantMessage(): void {
    this.activeAssistantMessageId = undefined;
    this.activeAssistantMessagePhase = undefined;
  }

  private resetAssistantMessageIfPhaseChanged(
    phase: AppServerTranscriptPhase
  ): void {
    if (this.activeAssistantMessagePhase === phase) {
      return;
    }
    this.activeAssistantMessageId = undefined;
    this.activeAssistantMessagePhase = phase;
  }

  private upsertPlan(update: AcpSessionUpdate, createdAt: number): void {
    const { sessionId, update: payload } = update;
    if (this.kitPlanNormalizer) {
      const { events } = this.kitPlanNormalizer.apply(payload, {
        threadId: sessionId,
        turnId: this.currentTurnId ?? sessionId,
      });
      const [plan] = normalizedThreadToReplay(reduceNormalizedThread(events, sessionId)).entries;
      if (plan?.type === "plan") {
        this.upsertEntry({ ...plan, createdAt });
        return;
      }
    }
    this.upsertEntry({
      type: "plan",
      id: readString(payload, "planId") ?? `plan:${sessionId}`,
      createdAt,
      explanation: readString(payload, "explanation"),
      markdown: readString(payload, "markdown"),
      steps: readPlanSteps(payload),
    });
  }

  private upsertToolActivity(
    update: AcpSessionUpdate,
    kind: string,
    createdAt: number,
    toolCallId: string | undefined,
  ): void {
    const rawName = readString(update.update, "name");
    const declared =
      readAcpProviderTool(update.update)
      ?? (rawName === "read_file"
        ? { name: rawName, kind: "read" }
        : rawName === "list_dir"
          ? { name: rawName, kind: "list" }
          : this.fileEditOptions.antigravity && (rawName === "write_file" || rawName === "edit_file")
            ? { name: rawName, kind: "edit" }
            : undefined);
    if (toolCallId && declared) {
      this.providerTools.set(toolCallId, {
        ...this.providerTools.get(toolCallId),
        ...declared,
      });
    }
    const providerTool = toolCallId
      ? this.providerTools.get(toolCallId)
      : declared;
    const previousFileRead = toolCallId ? this.fileReads.get(toolCallId) : undefined;
    const fileRead = readAcpFileRead(update.update, providerTool, previousFileRead)
      ?? previousFileRead;
    if (toolCallId && fileRead) {
      this.fileReads.set(toolCallId, fileRead);
    }
    const currentIndex = toolCallId ? this.typedEntryIndexes.get(`activity:${toolCallId}`) : undefined;
    const current = currentIndex !== undefined ? this.entries[currentIndex] : undefined;
    const followsTitleScript = current?.type === "activity"
      && isTitleOnlyAcpScript(current.details[0]?.command);
    const mcpToolName = readAcpMcpToolName(update.update);
    const mcpToolLabel = readAcpMcpToolLabel(update.update);
    const preferredMcpLabel = mcpToolLabel && mcpToolLabel !== mcpToolName
      ? mcpToolLabel
      : undefined;
    this.upsertActivity(
      toolActivity(
        update,
        kind,
        createdAt,
        providerTool,
        fileRead,
        this.fileEditOptions,
        followsTitleScript,
        this.options.replayKit,
      ),
      providerTool
        ? (label) => isProviderToolPlaceholder(label, providerTool)
        : undefined,
      fileRead?.label ?? preferredMcpLabel,
    );
  }

  private upsertActivity(
    activity: AppServerThreadActivityEntry,
    isPlaceholderLabel?: (label: string) => boolean,
    preferredLabel?: string,
  ): void {
    const activityWithTurn = this.withCurrentTurn(activity);
    const index = this.typedEntryIndexes.get(`activity:${activityWithTurn.id}`);
    if (index === undefined) {
      this.appendEntry(activityWithTurn);
      return;
    }
    this.entries[index] = mergeActivity(
      this.entries[index] as AppServerThreadActivityEntry,
      activityWithTurn,
      isPlaceholderLabel,
      preferredLabel,
    );
  }

  private upsertAgentWaitingActivity(turnId: string, createdAt: number): void {
    this.upsertActivity({
      type: "activity",
      id: agentWaitingActivityId(turnId),
      createdAt,
      summary: "Waiting for agent response",
      status: "in_progress",
      turn: {
        id: turnId,
        status: "in_progress",
        startedAt: createdAt,
      },
      details: [
        {
          id: `${agentWaitingActivityId(turnId)}:detail`,
          kind: "read",
          label: "The prompt was sent. Waiting for the agent provider to respond.",
          status: "in_progress",
        },
      ],
    });
  }

  private removeCurrentAgentWaitingActivity(): void {
    if (this.currentTurnId) {
      this.removeAgentWaitingActivity(this.currentTurnId);
    }
  }

  private removeAgentWaitingActivity(turnId: string): void {
    const id = agentWaitingActivityId(turnId);
    if (!this.entryIndexes.has(id)) {
      return;
    }
    this.entries = this.entries.filter((entry) => entry.id !== id);
    this.rebuildEntryIndexes();
  }

  private upsertRetryActivity(update: AcpSessionUpdate, createdAt: number): void {
    const attempt = readNumber(update.update, "attempt");
    const maxRetries =
      readNumber(update.update, "max_retries")
      ?? readNumber(update.update, "maxRetries");
    const reason = readString(update.update, "reason")?.trim();
    if (
      this.openRetry
      && attempt !== undefined
      && attempt <= this.openRetry.attempts
    ) {
      // Grok counts attempts per model request, so a reset means the previous
      // request went through before this one failed.
      this.settleOpenRetry("completed");
    }
    const retry = this.openRetry ?? {
      id: `acp-retry:${update.sessionId}:${createdAt}`,
      attempts: 0,
    };
    this.openRetry = retry;
    retry.attempts = attempt ?? retry.attempts + 1;
    this.removeCurrentAgentWaitingActivity();
    const index = this.typedEntryIndexes.get(`activity:${retry.id}`);
    const existing = index === undefined ? undefined : this.entries[index];
    this.upsertEntry({
      type: "activity",
      id: retry.id,
      createdAt: existing?.createdAt ?? createdAt,
      summary: maxRetries
        ? `Retrying model request · attempt ${retry.attempts} of ${maxRetries}`
        : `Retrying model request · attempt ${retry.attempts}`,
      tone: "warning",
      status: "in_progress",
      details: [
        {
          id: `${retry.id}:reason`,
          kind: "read",
          label: reason || "The agent provider is retrying the model request.",
          status: "in_progress",
        },
      ],
    });
  }

  private upsertCompactionActivity(
    update: AcpSessionUpdate,
    kind: "auto_compact_started" | "auto_compact_completed",
    createdAt: number,
  ): void {
    const id = this.openCompactionId
      ?? `acp-compact:${update.sessionId}:${createdAt}`;
    const index = this.typedEntryIndexes.get(`activity:${id}`);
    const existing = index === undefined ? undefined : this.entries[index];
    let label: string;
    if (kind === "auto_compact_started") {
      this.openCompactionId = id;
      const percentage = readNumber(update.update, "percentage");
      label = readString(update.update, "reason")?.trim()
        || (percentage !== undefined
          ? `Context window ${percentage}% full`
          : "Context window is nearly full");
    } else {
      this.openCompactionId = undefined;
      const before = readNumber(update.update, "tokens_before");
      const after = readNumber(update.update, "tokens_after");
      const elapsedMs = readNumber(update.update, "elapsed_ms");
      label = before !== undefined && after !== undefined
        ? `${formatCount(before)} → ${formatCount(after)} tokens`
        : "Older context was summarized";
      if (elapsedMs !== undefined) {
        label += ` in ${formatDuration(elapsedMs)}`;
      }
    }
    const status = kind === "auto_compact_started" ? "in_progress" : "completed";
    this.upsertEntry({
      type: "activity",
      id,
      createdAt: existing?.createdAt ?? createdAt,
      summary: status === "in_progress" ? "Compacting context" : "Compacted context",
      status,
      details: [{ id: `${id}:detail`, kind: "read", label, status }],
    });
  }

  private upsertSubAgentActivity(
    update: AcpSessionUpdate,
    kind: "subagent_spawned" | "subagent_progress" | "subagent_finished",
    createdAt: number,
  ): void {
    const subAgentId =
      readString(update.update, "subagent_id")
      ?? readString(update.update, "child_session_id")
      ?? "unknown";
    const id = `acp-subagent:${update.sessionId}:${subAgentId}`;
    const state = this.subAgents.get(id) ?? { createdAt };
    this.subAgents.set(id, state);
    state.description =
      readString(update.update, "description")?.trim() || state.description;
    state.type = readString(update.update, "subagent_type") ?? state.type;
    state.model = readString(update.update, "model") ?? state.model;
    state.toolCalls =
      readNumber(update.update, "tool_call_count")
      ?? readNumber(update.update, "tool_calls")
      ?? state.toolCalls;
    state.tokens = readNumber(update.update, "tokens_used") ?? state.tokens;
    state.durationMs = readNumber(update.update, "duration_ms") ?? state.durationMs;
    if (kind === "subagent_finished") {
      state.status =
        readString(update.update, "status") === "completed" ? "completed" : "failed";
    }
    const status = state.status ?? "in_progress";
    const verb = status === "completed"
      ? "Sub-agent finished"
      : status === "failed" ? "Sub-agent failed" : "Sub-agent";
    const label = [
      state.type,
      state.model,
      state.toolCalls !== undefined
        ? `${formatCount(state.toolCalls)} tool ${state.toolCalls === 1 ? "call" : "calls"}`
        : undefined,
      state.tokens !== undefined ? `${formatCount(state.tokens)} tokens` : undefined,
      state.durationMs !== undefined ? formatDuration(state.durationMs) : undefined,
    ].filter(Boolean).join(" · ");
    const index = this.typedEntryIndexes.get(`activity:${id}`);
    const existing = index === undefined ? undefined : this.entries[index];
    this.upsertEntry({
      type: "activity",
      id,
      createdAt: existing?.createdAt ?? state.createdAt,
      summary: state.description ? `${verb}: ${state.description}` : verb,
      status,
      details: [
        {
          id: `${id}:detail`,
          kind: "read",
          label: label || "Running",
          status,
        },
      ],
    });
  }

  private settleOpenCompaction(status: "completed" | "failed" | "cancelled"): void {
    const id = this.openCompactionId;
    if (!id) {
      return;
    }
    this.openCompactionId = undefined;
    const index = this.typedEntryIndexes.get(`activity:${id}`);
    const entry = index === undefined ? undefined : this.entries[index];
    if (index === undefined || entry?.type !== "activity") {
      return;
    }
    this.entries[index] = {
      ...entry,
      summary: status === "failed"
        ? "Context compaction failed"
        : status === "cancelled" ? "Context compaction stopped" : "Compacted context",
      status,
      details: entry.details.map((detail) => ({ ...detail, status })),
    };
  }

  private settleOpenRetry(status: "completed" | "failed" | "cancelled"): void {
    const retry = this.openRetry;
    if (!retry) {
      return;
    }
    this.openRetry = undefined;
    const index = this.typedEntryIndexes.get(`activity:${retry.id}`);
    const entry = index === undefined ? undefined : this.entries[index];
    if (index === undefined || entry?.type !== "activity") {
      return;
    }
    const count = retry.attempts;
    this.entries[index] = {
      ...entry,
      summary: status === "failed"
        ? `Model request failed after ${count} ${count === 1 ? "retry" : "retries"}`
        : status === "cancelled"
          ? `Stopped after ${count} ${count === 1 ? "retry" : "retries"}`
          : `Retried model request ${count} ${count === 1 ? "time" : "times"}`,
      status,
      details: entry.details.map((detail) => ({ ...detail, status })),
    };
  }

  private upsertEntry(entry: AppServerThreadEntry): void {
    const entryWithTurn = this.withCurrentTurn(entry);
    const index = this.entryIndexes.get(entryWithTurn.id);
    if (index === undefined) {
      this.appendEntry(entryWithTurn);
      return;
    }
    const previousType = this.entries[index]?.type;
    this.entries[index] = entryWithTurn;
    if (previousType !== entryWithTurn.type) {
      this.rebuildEntryIndexes();
    }
  }

  private appendEntry(entry: AppServerThreadEntry): void {
    const index = this.entries.length;
    this.entries.push(entry);
    this.indexEntry(entry, index);
  }

  private indexEntry(entry: AppServerThreadEntry, index: number): void {
    // Preserve find/findIndex's first-match semantics even if a provider reuses
    // an ID across message/activity/plan types.
    if (!this.entryIndexes.has(entry.id)) {
      this.entryIndexes.set(entry.id, index);
    }
    const key = `${entry.type}:${entry.id}`;
    if (!this.typedEntryIndexes.has(key)) {
      this.typedEntryIndexes.set(key, index);
    }
  }

  private rebuildEntryIndexes(): void {
    this.entryIndexes.clear();
    this.typedEntryIndexes.clear();
    this.entries.forEach((entry, index) => this.indexEntry(entry, index));
  }

  private appendMessage(message: AppServerThreadMessage): void {
    const index = this.messages.length;
    this.messages.push(message);
    this.messageIndexes.set(message.id, index);
    this.indexLastMessage(message, index);
  }

  private indexLastMessage(message: AppServerThreadMessage, index: number): void {
    if (message.role === "user") {
      this.lastUserMessageIndex = index;
    } else if (message.role === "assistant") {
      this.lastAssistantMessageIndex = index;
    }
  }

  private rebuildMessageIndexes(): void {
    this.messageIndexes.clear();
    this.lastUserMessageIndex = undefined;
    this.lastAssistantMessageIndex = undefined;
    this.messages.forEach((message, index) => {
      this.messageIndexes.set(message.id, index);
      this.indexLastMessage(message, index);
    });
  }

  private upsertMessage(message: AppServerThreadMessage): void {
    const existingMessageIndex = this.messageIndexes.get(message.id);
    if (existingMessageIndex === undefined) {
      this.appendMessage(message);
    } else {
      const previousRole = this.messages[existingMessageIndex]?.role;
      this.messages[existingMessageIndex] = message;
      if (previousRole !== message.role) {
        this.rebuildMessageIndexes();
      }
    }

    this.upsertEntry({
      type: "message",
      id: message.id,
      role: message.role,
      text: message.text,
      ...(message.parts?.length ? { parts: message.parts } : {}),
      createdAt: message.createdAt,
    });
  }

  private appendMessageChunk(params: {
    id: string;
    phase?: AppServerTranscriptPhase;
    role: "assistant" | "user";
    text: string;
    parts?: AppServerThreadMessagePart[];
    createdAt: number;
  }): void {
    const messageIndex = this.messageIndexes.get(params.id);
    const existingMessage = messageIndex === undefined
      ? undefined : this.messages[messageIndex];
    if (existingMessage) {
      existingMessage.text = appendAcpTranscriptChunk(
        existingMessage.text,
        params.text,
        params.phase,
      );
      if (params.parts?.length && !existingMessage.parts?.length) {
        existingMessage.parts = params.parts;
      }
    } else {
      this.appendMessage({
        id: params.id,
        role: params.role,
        text: params.text,
        ...(params.parts?.length ? { parts: params.parts } : {}),
        createdAt: params.createdAt,
      });
    }

    const entryIndex = this.typedEntryIndexes.get(`message:${params.id}`);
    const existingEntry = entryIndex === undefined
      ? undefined : this.entries[entryIndex];
    if (existingEntry?.type === "message") {
      existingEntry.text = appendAcpTranscriptChunk(
        existingEntry.text,
        params.text,
        params.phase,
      );
      if (params.parts?.length && !existingEntry.parts?.length) {
        existingEntry.parts = params.parts;
      }
    } else {
      this.appendEntry(this.withCurrentTurn({
        type: "message",
        id: params.id,
        phase: params.phase,
        role: params.role,
        text: params.text,
        ...(params.parts?.length ? { parts: params.parts } : {}),
        createdAt: params.createdAt,
      }));
    }
  }

  private withCurrentTurn<T extends AppServerThreadEntry>(entry: T): T {
    if (!this.currentTurnId) {
      return entry;
    }
    return {
      ...entry,
      turn: {
        id: this.currentTurnId,
        status: "in_progress",
        ...(this.currentTurnStartedAt !== undefined
          ? { startedAt: this.currentTurnStartedAt }
          : {}),
      },
    };
  }

  private completeTurnEntries(
    turnId: string,
    status: "completed" | "failed" | "interrupted",
    completedAt: number,
  ): void {
    this.entries = this.entries.map((entry) => {
      if (entry.turn?.id !== turnId) {
        return entry;
      }
      const startedAt = entry.turn.startedAt ?? this.currentTurnStartedAt;
      return {
        ...entry,
        turn: {
          ...entry.turn,
          status,
          completedAt,
          ...(startedAt !== undefined
            ? {
                startedAt,
                durationMs: Math.max(0, completedAt - startedAt),
              }
            : {}),
        },
      };
    });
  }
}

function appendAcpTranscriptChunk(
  existing: string,
  next: string,
  phase: AppServerTranscriptPhase | undefined,
): string {
  // Final ACP text is a stream of literal deltas. A chunk can start inside
  // Markdown syntax, so guessing a paragraph boundary can corrupt the reply.
  if (phase === "final" || !existing || !next) {
    return `${existing}${next}`;
  }
  if (shouldSeparateTranscriptChunks(existing, next)) {
    return `${existing}\n\n${next}`;
  }
  return `${existing}${next}`;
}

function shouldSeparateTranscriptChunks(existing: string, next: string): boolean {
  if (/\s$/.test(existing)) {
    return false;
  }
  return /^(?:#{1,6}\s|\*\*[^*]+?\*\*(?:\s|$))/.test(next);
}

/** Updates that prove the model is answering again after a retry. */
export function isAcpModelProgressUpdate(
  kind: string,
  update: Record<string, unknown>,
): boolean {
  if (kind === "agent_message_chunk" || kind === "agent_thought_chunk") {
    const text =
      readContentText(update, "content") ?? readString(update, "text") ?? "";
    return text.trim().length > 0;
  }
  // Only output the model produced counts. Tool updates and terminal output
  // can come from a local command that runs while the model is down, and a
  // turn end says nothing about whether the model answered: a stopped turn
  // did not recover. Turn ends settle retries through their own paths.
  return (
    kind === "tool_call"
    || kind === "plan"
    // Grok's transient marker for a model response that finished.
    || kind === "response_completed"
  );
}

function readKind(update: Record<string, unknown>): string {
  return (
    readString(update, "sessionUpdate") ??
    readString(update, "session_update") ??
    readString(update, "kind") ??
    readString(update, "type") ??
    "unknown"
  );
}

export function readAcpTopicTitle(
  update: Record<string, unknown>,
): string | undefined {
  const sessionUpdate =
    readString(update, "sessionUpdate") ?? readString(update, "session_update");

  // Grok ACP emits a dedicated vendor notification at the end of the first
  // turn carrying the auto-generated session title:
  //   { method: "_x.ai/session_notification",
  //     params: { sessionId, update: { sessionUpdate: "session_summary_generated",
  //                                    session_summary: "<title text>" } } }
  // The acp-client routes that vendor method through the same applySessionUpdate
  // path as standard session/update, so the inner `update` lands here. Extract
  // the summary verbatim — no parsing required, unlike the tool-call path below.
  if (sessionUpdate === "session_summary_generated") {
    const summary = (
      readString(update, "session_summary") ??
      readString(update, "sessionSummary")
    )?.trim();
    return summary || undefined;
  }

  // Standard ACP session metadata:
  //   { sessionUpdate: "session_info_update", title?: string | null,
  //     updatedAt?: string | null }
  // `title` is a tri-state (absent / null-to-clear / string). Only a non-empty
  // string names a topic; the other two carry no title to adopt.
  if (isAcpSessionMetadataUpdateKind(sessionUpdate)) {
    return readString(update, "title")?.trim() || undefined;
  }

  const kind = readString(update, "kind");
  const isToolUpdate =
    sessionUpdate === "tool_call" ||
    sessionUpdate === "tool_call_update" ||
    kind === "tool_call" ||
    kind === "tool_call_update" ||
    kind === "think";
  if (!isToolUpdate) {
    return undefined;
  }

  const title = readString(update, "title")?.trim();
  if (!title) {
    return undefined;
  }
  const quotedMatch = /^Update topic to:\s*["“](.+?)["”]\s*$/iu.exec(title);
  const fallbackMatch = /^Update topic to:\s*(.+)$/iu.exec(title);
  const topic = (quotedMatch?.[1] ?? fallbackMatch?.[1])?.trim();
  return topic || undefined;
}

/**
 * ACP has no required per-update timestamp field, but several providers add
 * one as an extension. Prefer it to local receipt time when it is a real Unix
 * timestamp so a provider's historical session replay keeps its chronology.
 */
export function readAcpUpdateTimestamp(
  update: Record<string, unknown>,
): number | undefined {
  for (const record of [update, asRecord(update._meta)]) {
    if (!record) {
      continue;
    }
    for (const key of [
      "agentTimestampMs",
      "agent_timestamp_ms",
      "createdAt",
      "created_at",
      "occurredAt",
      "occurred_at",
      "timestamp",
    ]) {
      const timestamp = parseAcpUpdateTimestamp(record[key]);
      if (timestamp !== undefined) {
        return timestamp;
      }
    }
  }
  return undefined;
}

function parseAcpUpdateTimestamp(value: unknown): number | undefined {
  if (typeof value === "number") {
    return normalizeAcpUpdateTimestamp(value);
  }
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return normalizeAcpUpdateTimestamp(numeric);
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeAcpUpdateTimestamp(value: number): number | undefined {
  if (!Number.isFinite(value)) {
    return undefined;
  }
  // Seconds are common in CLI extension payloads; internally PwrAgent uses
  // epoch milliseconds. Refuse small counters/durations that are not dates.
  if (value >= 946_684_800 && value < 10_000_000_000) {
    return Math.trunc(value * 1_000);
  }
  return value >= 946_684_800_000 ? Math.trunc(value) : undefined;
}

function readString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readBoolean(
  record: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function agentWaitingActivityId(turnId: string): string {
  return `agent-waiting:${turnId}`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readNumber(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseAcpSyntheticImageAnnotation(text: string): string | undefined {
  const trimmed = text.trim();
  const attachedMatch = /^Attached image filename:\s*(.+)$/u.exec(trimmed);
  if (attachedMatch?.[1]?.trim()) {
    return attachedMatch[1].trim();
  }
  const localMatch = /^\[Local image:\s*(.+)\]$/u.exec(trimmed);
  return localMatch?.[1]?.trim() || undefined;
}

function extractAcpSyntheticImageAnnotations(text: string): {
  text: string;
  fileNames: string[];
} {
  const lines = text.split(/\r?\n/u);
  const remaining: string[] = [];
  const fileNames: string[] = [];
  let insideFence = false;
  for (const line of lines) {
    if (/^\s*```/u.test(line)) {
      insideFence = !insideFence;
      remaining.push(line);
      continue;
    }
    const annotation = !insideFence ? parseAcpSyntheticImageAnnotation(line) : undefined;
    if (annotation) {
      fileNames.push(annotation);
    } else {
      remaining.push(line);
    }
  }
  if (fileNames.length === 0) {
    return { text, fileNames: [] };
  }
  return {
    text: remaining.join("\n").trim(),
    fileNames,
  };
}

function readAcpUserImagePart(
  content: unknown,
  fallbackAlt?: string,
): AppServerThreadImagePart | undefined {
  const block = asRecord(content);
  if (!block || block.type !== "image") {
    return undefined;
  }
  const mimeType = readString(block, "mimeType") ?? readString(block, "mime_type");
  const data = readString(block, "data");
  if (mimeType?.startsWith("image/") && data) {
    return {
      type: "image",
      ...(fallbackAlt ? { alt: fallbackAlt } : {}),
      url: `data:${mimeType};base64,${data}`,
    };
  }
  const uri = readString(block, "uri");
  if (uri && (/^(?:data:image\/|pwragent-image:\/\/|https?:\/\/)/iu.test(uri))) {
    return {
      type: "image",
      ...(fallbackAlt ? { alt: fallbackAlt } : {}),
      url: uri,
    };
  }
  return undefined;
}

export function readAcpMessageParts(
  record: Record<string, unknown>,
  key = "parts",
): AppServerThreadMessagePart[] | undefined {
  const value = record[key];
  if (!Array.isArray(value)) {
    return undefined;
  }
  const parts = value.flatMap((part): AppServerThreadMessagePart[] => {
    const item = asRecord(part);
    if (!item) {
      return [];
    }
    if (item.type === "image") {
      const url = readString(item, "url");
      const alt = readString(item, "alt");
      return url
        ? [
            {
              type: "image",
              url,
              ...(alt ? { alt } : {}),
            } satisfies AppServerThreadImagePart,
          ]
        : [];
    }
    if (item.type === "file") {
      const name = readString(item, "name");
      if (!name) {
        return [];
      }
      const mimeType = readString(item, "mimeType");
      const sizeBytes = readNumber(item, "sizeBytes");
      return [
        {
          type: "file",
          name,
          ...(mimeType ? { mimeType } : {}),
          ...(sizeBytes !== undefined ? { sizeBytes } : {}),
        },
      ];
    }
    if (item.type === "text") {
      const text = readString(item, "text");
      return text ? [{ type: "text", text }] : [];
    }
    return [];
  });
  return parts.length > 0 ? parts : undefined;
}

function readMessageParts(
  record: Record<string, unknown>,
): AppServerThreadMessagePart[] | undefined {
  return readAcpMessageParts(record, "parts");
}

function normalizeUserPrompt(
  prompt: string,
  parts: AppServerThreadMessagePart[] | undefined,
): { text: string; parts?: AppServerThreadMessagePart[] } {
  if (parts?.length) {
    return { text: prompt, parts };
  }

  const images: AppServerThreadImagePart[] = [];
  const text = prompt
    .replace(
      /\s*\[Image:\s*(data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+)\]\s*/giu,
      (_match, url: string) => {
        images.push({ type: "image", url });
        return "\n";
      },
    )
    .trim();

  if (images.length === 0) {
    return { text: prompt };
  }

  return {
    text,
    parts: [
      ...(text ? [{ type: "text" as const, text }] : []),
      ...images,
    ],
  };
}

function readToolOutput(record: Record<string, unknown>): string | undefined {
  const contentText = readContentText(record, "content");
  return sanitizeAcpToolOutput(
    readString(record, "output")
      ?? readString(record, "stdout")
      ?? readString(record, "stderr")
      ?? readString(record, "result")
      ?? (readAcpToolContentCommand(record) ? undefined : contentText),
  );
}

function isModeUpdateMarker(text: string): boolean {
  return /^\[MODE_UPDATE\]\s*[A-Za-z0-9_-]+\s*$/.test(text.trim());
}

function readContentText(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  return readAcpContentText(record[key]);
}

/**
 * Whether a message's text is the Gemini CLI `<session_context>` environment
 * block — the date/OS/workspace/directory-tree preamble Gemini injects (and
 * re-emits as a user_message_chunk on session/load). It is agent boilerplate,
 * not a user turn, so it must never appear in the transcript. Used both to keep
 * it out of the rendered replay and to stop persisting it into the rollout.
 */
export function isAcpSessionContextBoilerplate(text: string | undefined): boolean {
  return text !== undefined && text.trimStart().startsWith("<session_context>");
}

export function isAcpSystemReminderBoilerplate(text: string | undefined): boolean {
  return text !== undefined && text.trimStart().startsWith("<system-reminder>");
}

export function isAcpUserBoilerplateMessage(text: string | undefined): boolean {
  return (
    isAcpSessionContextBoilerplate(text) ||
    isAcpSystemReminderBoilerplate(text) ||
    text?.trimStart().startsWith(`Content of ${ACP_WORKSPACE_HISTORY_URI}:\n`) === true
  );
}

export function readAcpContentText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    const parts = value
      .map((item) => readAcpContentText(item))
      .filter((item): item is string => Boolean(item));
    return parts.length > 0 ? parts.join("\n") : undefined;
  }

  if (!value || typeof value !== "object") {
    return undefined;
  }

  const content = value as Record<string, unknown>;
  if (content.type === "text" && typeof content.text === "string") {
    return content.text;
  }
  return (
    readAcpContentText(content.content) ??
    readAcpContentText(content.text) ??
    readAcpContentText(content.output) ??
    readAcpContentText(content.result)
  );
}

function readPlanSteps(record: Record<string, unknown>): AppServerThreadPlanEntry["steps"] {
  const steps = Array.isArray(record.steps) ? record.steps : [];
  return steps.flatMap((step) => {
    if (typeof step === "string") {
      return [{ step, status: "pending" as const }];
    }
    const stepRecord = asRecord(step);
    if (!stepRecord) {
      return [];
    }
    const text = readString(stepRecord, "step") ?? readString(stepRecord, "content");
    if (!text) {
      return [];
    }
    const status = readString(stepRecord, "status");
    return [{
      step: text,
      status: status === "in_progress" || status === "completed" ? status : "pending",
    }];
  });
}

function toolActivity(
  update: AcpSessionUpdate,
  kind: string,
  createdAt: number,
  providerTool?: AcpProviderTool,
  fileRead?: AcpFileRead,
  fileEditOptions?: ReadAcpFileEditOptions,
  followsTitleScript = false,
  replayKit?: AcpReplayKit,
): AppServerThreadActivityEntry {
  const id =
    readAcpToolCallId(update.update) ??
    `${kind}:${update.sessionId}`;
  // Antigravity's generic live tool starts and file-edit completions both
  // use the call ID. Replay must use the same identity to acknowledge them.
  const detailId = fileEditOptions?.antigravity ? id : `${id}:detail`;
  const webSearch = readAcpWebSearch(update.update);
  if (webSearch) {
    const status = normalizeToolActivityStatus(readString(update.update, "status"));
    const summary = formatWebSearchLabel(status === "in_progress");
    const detailLabel = webSearch.query
      ? `${summary}: ${webSearch.query}`
      : summary;
    return {
      type: "activity",
      id,
      createdAt,
      summary,
      status,
      details:
        webSearch.query || webSearch.sources.length
          ? [
              {
                id: detailId,
                kind: "read",
                label: detailLabel,
                status,
              },
              ...webSearch.sources.slice(0, 5).flatMap((source, index) => {
                const label = source.title ?? source.url;
                return label
                  ? [
                      {
                        id: `${id}:source:${index + 1}`,
                        kind: "read" as const,
                        label,
                        url: source.url,
                      },
                    ]
                  : [];
              }),
            ]
          : [],
    };
  }

  const webFetchUrl = readAcpWebFetchUrl(update.update);
  const codeSearch = readAcpCodeSearch(update.update);
  if (codeSearch) {
    const status = normalizeToolActivityStatus(
      readString(update.update, "status"),
    );
    const summary =
      status === "in_progress" ? "Searching code" : "Searched code";
    const detailLabel = codeSearch.query
      ? `${summary}: ${codeSearch.query}`
      : summary;
    const output = readToolOutput(update.update);
    const exitCode = readNumber(update.update, "exitCode");
    return {
      type: "activity",
      id,
      createdAt,
      summary: detailLabel,
      status,
      details: [
        {
          id: detailId,
          kind: "read",
          label: detailLabel,
          command: {
            displayCommand: codeSearch.invocation,
            source: "tool",
            output,
            exitCode,
          },
        },
      ],
    };
  }
  const fileEdit = readAcpFileEdit(update.update, fileEditOptions, providerTool);
  if (fileEdit) {
    const label = `${fileEdit.verb} ${fileBaseName(fileEdit.path)}`;
    const status = readToolActivityStatus(update.update);
    // A failed edit's text content is the agent's reason.
    const failure = status === "failed"
      ? readToolOutput(update.update)
      : undefined;
    return {
      type: "activity",
      id,
      createdAt,
      summary: label,
      ...(status ? { status } : {}),
      details: [
        {
          id: detailId,
          kind: "write",
          label,
          path: fileEdit.path,
          ...(status ? { status } : {}),
          ...(fileEdit.fileDiff ? { fileDiff: fileEdit.fileDiff } : {}),
          ...(failure
            ? {
                command: {
                  displayCommand: label,
                  source: "tool" as const,
                  output: failure,
                },
              }
            : {}),
        },
      ],
    };
  }
  const rawCommand = readAcpToolCommand(update.update);
  const description = rawCommand
    ? readAcpToolDescription(update.update)
    : undefined;
  const invocation = readAcpToolInvocation(update.update, followsTitleScript);
  const mcpToolName = readAcpMcpToolName(update.update);
  const mcpToolLabel = readAcpMcpToolLabel(update.update);
  const displayCommand = rawCommand ?? invocation;
  const titleCandidate =
    mcpToolLabel ??
    description ??
    readString(update.update, "title") ??
    readString(update.update, "name") ??
    readString(update.update, "kind") ??
    kind.replaceAll("_", " ");
  // An internal tool name is a placeholder; the agent's display name for the
  // tool reads better until a descriptive title arrives.
  const labelCandidate =
    providerTool?.label && sameLabel(titleCandidate, providerTool.name)
      ? providerTool.label
      : titleCandidate;
  const formatAsCommand = !fileRead && !webFetchUrl && displayCommand
    && (
      isGenericShellToolTitle(labelCandidate)
      || (followsTitleScript && isGenericActivityLabel(labelCandidate))
      || commandTitleMatchesInvocation(labelCandidate, displayCommand)
    );
  // PwrAgent still owns provider-specific command extraction and completion
  // merges. Give the kit the explicit shell invocation after title selection.
  const kitShell = replayKit && formatAsCommand && rawCommand
    ? normalizedToolCallToReplayDetail(replayKit.toolCallFromUpdate({
        kind: "execute",
        title: "Bash",
        command: rawCommand,
      }, kind, update.sessionId))
    : undefined;
  const label = fileRead
    ? fileRead.label
    : webFetchUrl
      ? `Fetched ${webFetchUrl}`
      : formatAsCommand
        ? kitShell?.label ?? formatCommandLabel(displayCommand)
        : labelCandidate;
  const status = readToolActivityStatus(update.update);
  const path =
    fileRead?.path
    ?? readString(update.update, "path")
    ?? readFirstLocationPath(update.update);
  const output = readToolOutput(update.update);
  const exitCode = readNumber(update.update, "exitCode");
  const detailKind = rawCommand
    ? "command"
    : webFetchUrl || fileRead
      ? "read"
      : toolDetailKind(readString(update.update, "kind"), path);

  return {
    type: "activity",
    id,
    createdAt,
    summary: label,
    status,
    details: [
      {
        id: detailId,
        kind: detailKind,
        label,
        path,
        command:
          displayCommand || output !== undefined || exitCode !== undefined
            ? {
                displayCommand: kitShell?.command?.displayCommand ?? displayCommand ?? label,
                rawCommand: kitShell?.command?.rawCommand ?? rawCommand ?? mcpToolName,
                ...(invocation && !rawCommand ? { source: "tool" as const } : {}),
                output,
                exitCode,
              }
            : undefined,
      },
    ],
  };
}

/** The status an update reports, or undefined when it reports none. */
function readToolActivityStatus(
  record: Record<string, unknown>,
): AppServerThreadActivityEntry["status"] {
  const status = readString(record, "status");
  return status === "completed"
    || status === "failed"
    || status === "cancelled"
    || status === "in_progress"
    ? status
    : status === "pending"
      ? "in_progress"
      : undefined;
}

function sameLabel(value: string, other: string | undefined): boolean {
  return other !== undefined && value.toLowerCase() === other.toLowerCase();
}

/**
 * Whether a label only names the tool, by its internal name or its display
 * name, so that any descriptive title an update brings should replace it.
 */
function isProviderToolPlaceholder(
  label: string,
  providerTool: AcpProviderTool,
): boolean {
  return sameLabel(label, providerTool.name) || sameLabel(label, providerTool.label);
}

function normalizeToolActivityStatus(
  status: string | undefined,
): AppServerThreadActivityEntry["status"] {
  return status === "completed"
    || status === "failed"
    || status === "cancelled"
    || status === "in_progress"
    ? status
    : "in_progress";
}

function mergeActivity(
  existing: AppServerThreadActivityEntry,
  incoming: AppServerThreadActivityEntry,
  isPlaceholderLabel: (label: string) => boolean = () => false,
  preferredLabel?: string,
): AppServerThreadActivityEntry {
  const status = incoming.status ?? existing.status;
  const fileEditGainedPath = incoming.details[0]?.kind === "write"
    && Boolean(incoming.details[0].path) && !existing.details[0]?.path;
  const updatedScript = readUpdatedAcpScript(existing.details[0]?.command, incoming.details[0]?.command);
  const details = mergeActivityEntryDetails(
    existing.details,
    incoming.details,
    isPlaceholderLabel,
    preferredLabel,
  )
    .map((detail) => ({
      ...detail,
      label: settledSearchLabel(detail.label, status),
      ...(detail.kind === "write" && detail.path && status ? { status } : {}),
    }));
  return {
    ...existing,
    createdAt: existing.createdAt ?? incoming.createdAt,
    summary: settledSearchLabel(
      fileEditGainedPath || updatedScript || incoming.summary === preferredLabel
        ? incoming.summary
        : preferSpecificLabel(existing.summary, incoming.summary, isPlaceholderLabel),
      status,
    ),
    status,
    details,
  };
}

function settledSearchLabel(
  label: string,
  status: AppServerThreadActivityEntry["status"],
): string {
  if (status === "in_progress" || status === undefined) {
    return label;
  }
  return label
    .replace(/^Searching code\b/u, "Searched code")
    .replace(/^Searching Web\b/u, "Searched Web");
}

function mergeActivityEntryDetails(
  existing: AppServerThreadActivityEntry["details"],
  incoming: AppServerThreadActivityEntry["details"],
  isPlaceholderLabel: (label: string) => boolean,
  preferredLabel?: string,
): AppServerThreadActivityEntry["details"] {
  const merged = [...existing];
  for (const incomingDetail of incoming) {
    const existingIndex = merged.findIndex(
      (detail) => detail.id === incomingDetail.id,
    );
    if (existingIndex < 0) {
      merged.push(incomingDetail);
      continue;
    }
    const existingDetail = merged[existingIndex];
    if (!existingDetail) {
      continue;
    }
    if (incomingDetail.kind === "write" && incomingDetail.path && !existingDetail.path) {
      merged[existingIndex] = incomingDetail;
      continue;
    }
    const existingCommand = existingDetail.command;
    const incomingCommand = incomingDetail.command;
    const updatedScript = readUpdatedAcpScript(existingCommand, incomingCommand);
    const expandedToolInvocation = readExpandedToolInvocation(existingCommand, incomingCommand);
    merged[existingIndex] = {
      ...existingDetail,
      ...incomingDetail,
      kind:
        isWeakLabel(incomingDetail.label, isPlaceholderLabel)
        && !isWeakLabel(existingDetail.label, isPlaceholderLabel)
          ? existingDetail.kind
          : incomingDetail.kind,
      label: updatedScript || incomingDetail.label === preferredLabel
        ? incomingDetail.label
        : preferSpecificLabel(existingDetail.label, incomingDetail.label, isPlaceholderLabel),
      path: incomingDetail.path ?? existingDetail.path,
      command:
        existingCommand || incomingCommand
          ? {
              displayCommand:
                updatedScript?.displayCommand
                ?? expandedToolInvocation
                ?? preferSpecificCommand(
                  existingCommand?.displayCommand,
                  incomingCommand?.displayCommand,
                )
                ?? preferSpecificLabel(existingDetail.label, incomingDetail.label),
              rawCommand:
                preferSpecificCommand(
                  existingCommand?.rawCommand,
                  incomingCommand?.rawCommand,
                ),
              source:
                incomingCommand?.source !== "tool"
                && incomingCommand?.rawCommand
                && existingCommand?.source === "tool"
                  ? "shell"
                  : incomingCommand?.source ?? existingCommand?.source,
              output:
                incomingCommand?.output ?? existingCommand?.output,
              exitCode:
                incomingCommand?.exitCode ?? existingCommand?.exitCode,
              durationMs:
                incomingCommand?.durationMs ?? existingCommand?.durationMs,
              cwd:
                incomingCommand?.cwd ?? existingCommand?.cwd,
            }
          : undefined,
      fileDiff: incomingDetail.fileDiff ?? existingDetail.fileDiff,
    };
  }
  return merged;
}

function preferSpecificLabel(
  existing: string,
  incoming: string,
  isPlaceholderLabel: (label: string) => boolean = () => false,
): string {
  if (
    existing.toLowerCase().startsWith("searching web")
    && incoming.toLowerCase().startsWith("searched web")
  ) {
    return incoming;
  }
  if (!isWeakLabel(existing, isPlaceholderLabel) || !incoming) {
    return existing || incoming;
  }
  // A weak label gives way to a descriptive title, never to another
  // placeholder or generic word such as "tool call update".
  return isWeakLabel(incoming, isPlaceholderLabel)
    ? existing
    : incoming;
}

function isWeakLabel(
  value: string,
  isPlaceholderLabel: (label: string) => boolean,
): boolean {
  return isGenericActivityLabel(value) || isPlaceholderLabel(value);
}

function isGenericActivityLabel(value: string): boolean {
  const lower = value.toLowerCase();
  if (
    /^run\s+mcp_[a-z0-9_-]+$/u.test(lower)
    || lower === "mcp_pwragent_call_pwragent_tool"
    || lower === "mcp_pwragent_call_mcp_tool"
  ) {
    return true;
  }
  return new Set([
    "bash",
    "shell",
    "sh",
    "zsh",
    "execute",
    "read",
    "read_file",
    "write",
    "search",
    "web_search",
    "x_search",
    "list",
    "list_dir",
    "tool call",
    "tool_call",
    "use_tool",
    "tool call update",
    "tool_call_update",
    "searching web",
  ]).has(lower);
}

function readExpandedToolInvocation(
  existing: AppServerThreadCommandDetail | undefined,
  incoming: AppServerThreadCommandDetail | undefined,
): string | undefined {
  if (
    existing?.source === "tool"
    && incoming?.source === "tool"
    && existing.rawCommand
    && existing.displayCommand === existing.rawCommand
    && incoming.displayCommand.startsWith(`${existing.rawCommand}\n`)
  ) {
    return incoming.displayCommand;
  }
  return undefined;
}

function isTitleOnlyAcpScript(command: AppServerThreadCommandDetail | undefined): boolean {
  return command?.source === "tool" && !command.rawCommand && /[\r\n]/.test(command.displayCommand);
}

function readUpdatedAcpScript(
  existing: AppServerThreadCommandDetail | undefined,
  incoming: AppServerThreadCommandDetail | undefined,
): AppServerThreadCommandDetail | undefined {
  // An output-only update has a fallback display label, with neither a command nor an invocation.
  return isTitleOnlyAcpScript(existing) && (incoming?.source === "tool" || incoming?.rawCommand)
    ? incoming
    : undefined;
}

function preferSpecificCommand(
  existing: string | undefined,
  incoming: string | undefined,
): string | undefined {
  if (!existing || isGenericShellToolTitle(existing)) {
    return incoming ?? existing;
  }
  return existing;
}

function toolDetailKind(
  toolKind: string | undefined,
  path: string | undefined,
): AppServerThreadActivityEntry["details"][number]["kind"] {
  if (toolKind === "write" || toolKind === "edit") {
    return "write";
  }
  if (toolKind === "execute" || toolKind === "exec" || toolKind === "shell") {
    return "command";
  }
  if (toolKind === "read" || toolKind === "search" || toolKind === "list") {
    return "read";
  }
  return path ? "read" : "command";
}

type AcpSubAgentState = {
  createdAt: number;
  description?: string;
  type?: string;
  model?: string;
  toolCalls?: number;
  tokens?: number;
  durationMs?: number;
  status?: "completed" | "failed";
};

function imageDroppedActivity(
  update: AcpSessionUpdate,
  createdAt: number,
): AppServerThreadActivityEntry {
  const notes = Array.isArray(update.update.notes)
    ? update.update.notes.filter(
      (note): note is string => typeof note === "string" && note.trim() !== "",
    )
    : [];
  // Two reports in one millisecond must not merge, but re-applying the same
  // update must still land on its own row.
  const eventId = readString(asRecord(update.update._meta) ?? {}, "eventId");
  const id = `acp-image-dropped:${update.sessionId}:${createdAt}:${
    eventId ?? JSON.stringify(notes)
  }`;
  return {
    type: "activity",
    id,
    createdAt,
    summary: notes.length > 1 ? "Images not sent" : "Image not sent",
    tone: "warning",
    details: (notes.length ? notes : ["The agent provider dropped an image."])
      .map((note, index) => ({
        id: `${id}:${index}`,
        kind: "read" as const,
        label: note,
      })),
  };
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function unknownActivity(
  update: AcpSessionUpdate,
  kind: string,
  createdAt: number,
): AppServerThreadActivityEntry {
  // The kind is part of the identity, not just the summary. Two different
  // unrecognized kinds in the same millisecond used to collide on this id, and
  // upsertActivity merges rather than appends — so the second kind's name was
  // dropped and the breadcrumb reported only the first. Re-applying the same
  // update still dedupes, which is what the id is for.
  const id = `unknown:${update.sessionId}:${createdAt}:${kind}`;
  return {
    type: "activity",
    id,
    createdAt,
    summary: `ACP update: ${kind}`,
    details: [
      {
        id: `${id}:detail`,
        kind: "read",
        label: "Unknown ACP session update",
      },
    ],
  };
}
