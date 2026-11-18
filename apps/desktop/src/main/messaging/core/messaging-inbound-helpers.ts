import { type NewThreadOptionsSummary, type MessagingFullAccessControls } from "./messaging-callback-helpers";
import { isThreadLockRefusal } from "@pwragent/shared";
import { type MessagingLaunchpadDirectory, type MessagingNewThreadNavigation } from "./messaging-launchpad-context";
import { buildFederatedThreadRef, buildThreadIdentityKey } from "@pwragent/shared";
import type { AppServerBackendKind, CodexEnvironmentSetupProgressEvent, BackendAcpSessionRuntimeState, LinkedDirectorySummary, LaunchpadWorkMode, MaterializedDirectoryLaunchpadThread, NavigationLaunchpadDraft, NavigationLaunchpadConfiguration, NavigationThreadSummary, ThreadExecutionMode, ThreadIdentifier } from "@pwragent/shared";
import type { MessagingBindingRecord, MessagingBrowseSessionRecord, MessagingInboundEvent, MessagingAdapterState } from "@pwragent/messaging-interface";
import { matchMessagingCommandVerb } from "./messaging-command-catalog.js";
import { isNewAgentThreadLaunchAction, selectProjectFromValue } from "./messaging-resume-browser.js";
import { type MessagingThreadContext } from "./messaging-thread-state.js";
import { type MessagingAttachmentRejection } from "./messaging-attachment-processor.js";
import { MessagingOriginalAttachmentStore } from "./messaging-original-attachment-store.js";
import { type MessagingTurnInputEvent } from "./messaging-turn-admission.js";

export function parseTextCommand(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return undefined;
  }

  return trimmed.slice(1).split(/\s+/, 1)[0]?.toLowerCase();
}

export function parseTextCommandArgs(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return [];
  }

  return trimmed.slice(1).split(/\s+/).slice(1).filter(Boolean);
}

export function parseMentionCommand(
  text: string,
): { command: string; args: string[] } | undefined {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  // Keep mention commands deliberately unambiguous. A bare known verb such
  // as `@bot new` is a convenient control shortcut, but addressed prose such
  // as `@bot new phone who dis?` belongs to the bound/default Agent. Commands
  // with arguments remain available through their explicit slash form.
  if (tokens.length !== 1) {
    return undefined;
  }
  const command = matchMessagingCommandVerb(tokens[0] ?? "");
  return command ? { command, args: [] } : undefined;
}

export function bindingWithInboundRoutingState(
  binding: MessagingBindingRecord | undefined,
  routingState: MessagingAdapterState | undefined,
): MessagingBindingRecord | undefined {
  // Metadata persistence is intentionally off-path, but this event's delivery
  // state is already authoritative for replies and typing activity on the same
  // route. Use it immediately without waiting for the merge-safe store update.
  return binding && routingState
    ? { ...binding, routingState }
    : binding;
}

export function isToolsFallbackText(text: string): boolean {
  return text.trim().toLowerCase() === "tools";
}

export function isStreamFallbackText(text: string): boolean {
  return text.trim().toLowerCase() === "stream";
}

export type MessagingHandledToRoutedSubspan =
  | "handledAutomationInboundMs"
  | "handledBindingLookupMs"
  | "handledDefaultAgentAssignmentsMs"
  | "handledDefaultAgentBackendValidationMs"
  | "handledDefaultAgentRevocationsMs"
  | "handledDefaultAgentTargetValidationMs"
  | "handledPendingIntentReadMs"
  | "handledPendingNewThreadReadMs"
  | "handledPrivateContinuationExpirationMs"
  | "handledRemoteScopeMs"
  | "handledRequirePermissionMs"
  | "handledResponseModeMs"
  | "handledSharedMessagePolicyMs"
  | "handledTextParsingMs"
  | "finalAdmissionAppendAwaitMs";

export type MessagingAdmissionTimingRecord = {
  marks: Partial<Record<MessagingAdmissionStage, number>>;
  subspans: Partial<Record<
    MessagingHandledToRoutedSubspan | MessagingInputPreparationSpan,
    number
  >>;
};

/**
 * Stage marks for one inbound message's trip from receipt to `startTurn`.
 *
 * `pwragentReceivedToStartTurnIssueMs` already measures that whole trip, which
 * is enough to see that it is slow and not enough to see where. A slow trip is
 * ambiguous between work this process chooses to do (resolving the route,
 * preparing the input, reading admission state, enforcing policy) and a wait it
 * merely schedules (the input debounce). These marks separate them, so one log
 * line says which stage owns the latency instead of requiring a bisect.
 *
 * Marks are keyed by inbound event id, not by the event object: the command and
 * media paths re-spread the event into a new object, so object identity does
 * not survive the trip and a `WeakMap` would silently record nothing.
 */
export type MessagingAdmissionStage =
  | "handled"
  | "routed"
  | "bundleReady"
  | "inputPrepared"
  | "admissionStateResolved"
  | "queued"
  | "occupancyResolved"
  | "originBuilt"
  | "policyResolved";

export type MessagingInputPreparationSpan =
  | "inputPrepPendingSkillBindingReloadMs"
  | "inputPrepPdfHandlingResolutionMs"
  | "inputPrepPdfAnalysisPolicyMs"
  | "inputPrepPdfToolSupportProbeMs"
  | "inputPrepPrivateResponseMs"
  | "inputPrepTextConstructionMs"
  | "inputPrepAttachmentProcessingMs";

// Upper bound on retained admission stage marks. A turn that is queued behind a
// busy thread, or that fails before `startTurn`, never reaches the log that
// consumes its marks, so the ceiling cannot depend on the happy path. Oldest
// entry is evicted first; each holds one fixed, bounded set of stage/subspan
// numbers.
export const ADMISSION_STAGE_MARK_LIMIT = 256;

export function bindingWithoutPendingSkillSelection(
  binding: MessagingBindingRecord,
): MessagingBindingRecord {
  const { pendingSkillSelection: _pendingSkillSelection, ...rest } = binding;
  return rest;
}

export const DEFAULT_INPUT_DEBOUNCE_MS = 500;

export const PRIVATE_REPLY_COMPLETION_INSTRUCTION =
  "PwrAgent is completing a one-shot private reply requested by this Agent. "
  + "Treat the user's following message as the private response to your earlier request. "
  + "Your final answer will be delivered to the originating messaging surface, not this private thread. "
  + "Do not quote or expose private reply content there unless the initiating instructions explicitly require it. "
  + "Do not emit commentary, working updates, or partial answers containing the private reply. "
  + "If the private exchange is not complete, call send_private_response again with awaitReply and new replyInstructions; otherwise answer finally to complete the callback on the originating surface.";

export function requestsExplicitPrivateResponse(
  event: MessagingInboundEvent | MessagingTurnInputEvent,
): boolean {
  if (!("text" in event) || typeof event.text !== "string") {
    return false;
  }
  const text = event.text.trim();
  if (!text) {
    return false;
  }
  const request = EXPLICIT_PRIVATE_RESPONSE_REQUEST_PATTERN.exec(text);
  if (!request) {
    return false;
  }
  const prefix = text.slice(0, request.index);
  const clauseStart = Math.max(
    prefix.lastIndexOf("."),
    prefix.lastIndexOf("!"),
    prefix.lastIndexOf("?"),
    prefix.lastIndexOf(";"),
    prefix.lastIndexOf(","),
    prefix.lastIndexOf("\n"),
  );
  return !NEGATED_PRIVATE_RESPONSE_PREFIX_PATTERN.test(
    prefix.slice(clauseStart + 1),
  );
}

export const EXPLICIT_PRIVATE_RESPONSE_REQUEST_PATTERN = new RegExp(
  [
    "\\b(?:dm|direct[\\s-]+message|private[\\s-]+message)\\s+me\\b",
    "\\bsend\\s+me(?:\\s+\\S+){0,3}\\s+(?:dm|direct[\\s-]+message|private[\\s-]+message)\\b",
    "\\b(?:send|reply|respond)(?:\\s+\\S+){0,6}\\s+privately\\b",
    "\\bsend(?:\\s+\\S+){0,6}\\s+(?:only|just)\\s+to\\s+me\\b",
  ].join("|"),
  "i",
);

export const NEGATED_PRIVATE_RESPONSE_PREFIX_PATTERN = new RegExp(
  [
    "\\b(?:(?:do\\s+not|don't|dont|never)(?:\\s+\\w+){0,8}(?:\\s+to)?",
    "|not(?:\\s+(?:asking|requesting|telling|wanting|going|trying|supposed|allowed|permitted|send|reply|respond|dm)){1,8}(?:\\s+to)?)\\s*$",
  ].join(""),
  "i",
);

export const PRIVATE_RESPONSE_FALLBACK_INSTRUCTION =
  "PwrAgent detected an explicit request for a private terminal response. "
  + "Do not include sensitive response content in commentary or working updates. "
  + "Use send_private_response if it is available. If that tool is unavailable, "
  + "put the intended private content only in your final answer; PwrAgent will "
  + "deliver that final privately and suppress it on the source surface.";

export function originalAttachmentActorKey(event: MessagingInboundEvent): string {
  return MessagingOriginalAttachmentStore.actorKey(
    [event.channel.channel, event.channel.conversation.id, event.channel.conversation.workspaceId],
    event.actor.platformUserId,
  );
}

export function formatAttachmentRejections(
  rejections: MessagingAttachmentRejection[],
): string {
  return rejections
    .map((rejection) => `${rejection.name}: ${rejection.reason}`)
    .join("\n");
}

export function agentMessagingThreadKey(
  backend: AppServerBackendKind,
  threadId: ThreadIdentifier,
): string {
  return buildThreadIdentityKey(backend, threadId);
}

export function resolveExecutionModeForThread(
  binding: MessagingBindingRecord,
  thread: NavigationThreadSummary | undefined,
): ExecutionModeResolution {
  if (thread?.executionMode) {
    return { mode: thread.executionMode, source: "thread" };
  }
  if (binding.preferences?.executionMode) {
    return { mode: binding.preferences.executionMode, source: "binding-preferences" };
  }
  if (binding.preferences?.permissionsMode === "full-access") {
    return { mode: "full-access", source: "permissions-mode" };
  }
  if (binding.preferences?.permissionsMode === "default") {
    return { mode: "default", source: "permissions-mode" };
  }
  return { mode: undefined, source: "unset" };
}

export type ExecutionModeResolution = {
  mode: ThreadExecutionMode | undefined;
  source: "thread" | "binding-preferences" | "permissions-mode" | "unset";
};

export function turnSettingsForThread(
  binding: MessagingBindingRecord,
  thread: NavigationThreadSummary | undefined,
  executionResolution: ExecutionModeResolution,
): {
  executionMode?: ThreadExecutionMode;
  fastMode?: boolean;
  model?: string;
  reasoningEffort?: string;
  serviceTier?: string;
} {
  return {
    executionMode: executionResolution.mode,
    fastMode: thread?.fastMode ?? binding.preferences?.fastMode,
    model: thread?.model ?? binding.preferences?.model,
    reasoningEffort: thread?.reasoningEffort ?? binding.preferences?.reasoningEffort,
    serviceTier: thread?.fastMode !== undefined
      ? thread.serviceTier
      : thread?.serviceTier ?? binding.preferences?.serviceTier,
  };
}

export function isPromiseLike<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  return typeof (value as PromiseLike<T>)?.then === "function";
}

export function isTurnInProgressStartError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  // A lock's note is free text, so "repair in progress" must not read as busy
  // and quietly queue a message the lock will refuse.
  return !isThreadLockRefusal(message)
    && /\b(active turn|turn already|already active|in progress)\b/i.test(message);
}

export function isMissingTurnTargetStartError(
  error: unknown,
  binding: MessagingBindingRecord,
): boolean {
  const message = (error instanceof Error ? error.message : String(error))
    .toLowerCase();
  const threadId = binding.threadId.trim().toLowerCase();
  if (!threadId || !message.includes(threadId)) {
    return false;
  }
  return (
    message.includes("thread not found")
    || message.includes("thread does not exist")
    || message.includes("thread was deleted")
    || message.includes("thread has been deleted")
    || message.includes("deleted thread")
    || message.includes("unknown thread")
  );
}

export function buildMessagingStartedThreadContext(params: {
  acpRuntime?: BackendAcpSessionRuntimeState;
  agent?: ReturnType<typeof agentForNewThreadSession>;
  backend: AppServerBackendKind;
  codexEnvironmentRuntime?: NavigationThreadSummary["codexEnvironmentRuntime"];
  directory?: MessagingLaunchpadDirectory;
  executionMode?: ThreadExecutionMode;
  linkedDirectory?: LinkedDirectorySummary;
  fastMode?: boolean;
  model?: string;
  navigation: MessagingNewThreadNavigation;
  now: number;
  preferences?: MessagingBrowseSessionRecord["preferences"];
  project: NonNullable<ReturnType<typeof selectProjectFromValue>>;
  reasoningEffort?: string;
  serviceTier?: string;
  threadId: ThreadIdentifier;
  worktreePath?: string;
  workMode: LaunchpadWorkMode;
}): MessagingThreadContext {
  const directoryPath = params.directory?.path ?? params.project.path;
  const linkedDirectory: LinkedDirectorySummary | undefined = directoryPath
    ? params.linkedDirectory ?? {
        id: params.directory?.key ?? directoryPath,
        kind: params.workMode === "worktree" && params.worktreePath ? "worktree" : "local",
        label: params.directory?.label ?? params.project.label,
        path: directoryPath,
        ...(params.worktreePath ? { worktreePath: params.worktreePath } : {}),
      }
    : undefined;

  return {
    kind: "thread",
    defaults: params.navigation.launchpadDefaults,
    directory: params.directory,
    thread: {
      id: params.threadId,
      source: params.backend,
      ...(params.project.federationTarget?.scope === "remote" ? { federation: {
        instanceLabel: params.project.federationTarget.instanceId,
        ref: buildFederatedThreadRef({ backend: params.backend, threadId: params.threadId, instanceId: params.project.federationTarget.instanceId }) } } : {}),
      title: params.threadId,
      titleSource: "fallback",
      projectKey: directoryPath,
      createdAt: params.now,
      updatedAt: params.now,
      executionMode: params.executionMode,
      acpRuntime: params.acpRuntime,
      codexEnvironmentRuntime: params.codexEnvironmentRuntime,
      agent: params.agent
        ? {
            ...params.agent,
            instructionLineCount: params.agent.instructions
              ? params.agent.instructions.split(/\r?\n/).length
              : 0,
            instructionsTooLong: false,
            updatedAt: params.now,
          }
        : undefined,
      model: params.model,
      reasoningEffort: params.reasoningEffort,
      serviceTier: params.serviceTier,
      fastMode: params.fastMode,
      linkedDirectories: linkedDirectory ? [linkedDirectory] : [],
      inbox: {
        inInbox: true,
        reason: "new-thread",
      },
    },
  };
}

export function agentForNewThreadSession(
  session: MessagingBrowseSessionRecord,
): { name: string; instructions?: string } | undefined {
  if (!isNewAgentThreadLaunchAction(session.launchAction)) {
    return undefined;
  }
  return {
    name: DEFAULT_MESSAGING_AGENT_NAME,
    instructions: DEFAULT_MESSAGING_AGENT_INSTRUCTIONS,
  };
}

export const DEFAULT_MESSAGING_AGENT_NAME = "Messaging Agent";

export const DEFAULT_MESSAGING_AGENT_INSTRUCTIONS =
  "You are an Agent thread created from messaging. Keep shared context for the attached messaging surfaces and use available Agent tools when they are relevant.";

export function launchpadForMessagingProject(params: {
  acpRuntime?: BackendAcpSessionRuntimeState;
  backend: AppServerBackendKind;
  branchName: string;
  directory?: MessagingLaunchpadDirectory;
  navigation: MessagingNewThreadNavigation;
  now: number;
  options: NewThreadOptionsSummary;
  preferences?: MessagingBrowseSessionRecord["preferences"];
  project: NonNullable<ReturnType<typeof selectProjectFromValue>>;
  workMode: LaunchpadWorkMode;
}): NavigationLaunchpadDraft {
  const defaults = params.navigation.launchpadDefaults;
  const directoryPath = params.directory?.path ?? params.project.path;
  const base: NavigationLaunchpadConfiguration = params.directory?.launchpad ?? {
    directoryKey:
      params.directory?.key ??
      params.project.directoryKey ??
      params.project.path ??
      params.project.label,
    directoryKind: params.directory?.kind ?? "directory",
    directoryLabel: params.directory?.label ?? params.project.label,
    directoryPath,
    backend: params.backend,
    executionMode: defaults.executionMode,
    model: defaults.model,
    reasoningEffort: defaults.reasoningEffort,
    serviceTier: defaults.serviceTier,
    fastMode: defaults.fastMode,
    workMode: params.workMode,
    branchName: params.branchName,
    createdAt: params.now,
    updatedAt: params.now,
  };

  return {
    ...base,
    backend: params.backend,
    acpRuntime: params.acpRuntime ?? params.options.acpRuntime,
    codexEnvironmentId:
      params.preferences?.codexEnvironmentId === null
        ? undefined
        : params.options.codexEnvironmentId ?? undefined,
    codexEnvironmentExecutionTarget:
      params.preferences?.codexEnvironmentId === null
        ? undefined
        : params.options.codexEnvironmentExecutionTarget,
    codexEnvironmentActionId:
      params.preferences?.codexEnvironmentId === null
        ? undefined
        : params.preferences?.codexEnvironmentActionId === null
          ? undefined
          : params.options.codexEnvironmentActionId ?? undefined,
    executionMode: params.options.executionMode,
    model: params.options.supportsModel ? params.options.model : undefined,
    reasoningEffort: params.options.supportsReasoning
      ? params.options.reasoningEffort
      : undefined,
    serviceTier: params.options.serviceTier,
    fastMode: params.options.supportsFast ? params.options.fastMode : undefined,
    prompt: "",
    workMode: params.workMode,
    branchName: params.branchName,
    codexEnvironmentOptions: base.codexEnvironmentOptions,
    updatedAt: params.now,
  };
}

export function messagingLaunchpadMaterializationKey(
  session: MessagingBrowseSessionRecord,
): string {
  return `messaging:${session.id}`;
}

export function buildMessagingEnvironmentSetupProgressBody(
  event: CodexEnvironmentSetupProgressEvent,
): string {
  const chunk = event.chunk?.trim();
  return [
    `Environment: ${event.environmentName}`,
    event.command ? `Command: ${event.command}` : undefined,
    event.cwd ? `Directory: ${event.cwd}` : undefined,
    chunk ? `Latest output: ${truncateText(chunk, 500)}` : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

export function truncateText(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, Math.max(0, limit - 3))}...`;
}

export function isTerminalCodexEnvironmentSetupProgress(
  event: CodexEnvironmentSetupProgressEvent,
): boolean {
  return event.phase === "completed" || event.phase === "failed";
}

export const MESSAGING_ENVIRONMENT_SETUP_PROGRESS_INTERVAL_MS = 15_000;

export function buildMessagingEnvironmentSetupFailureBody(
  runtime: MaterializedDirectoryLaunchpadThread["codexEnvironmentRuntime"],
  message: string,
): string {
  return [
    runtime?.environmentName ? `Environment: ${runtime.environmentName}` : undefined,
    runtime?.setupCommand ? `Command: ${runtime.setupCommand}` : undefined,
    message,
    "The thread was created and your first message will still be submitted.",
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

export function buildMessagingEnvironmentSetupSuccessBody(
  runtime: MaterializedDirectoryLaunchpadThread["codexEnvironmentRuntime"],
): string {
  const duration = formatDurationMs(runtime?.setupDurationMs);
  return [
    runtime?.environmentName ? `Environment: ${runtime.environmentName}` : undefined,
    runtime?.setupCommand ? `Command: ${runtime.setupCommand}` : undefined,
    duration ? `Duration: ${duration}` : undefined,
    "Your first message will be submitted now.",
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

export function formatDurationMs(durationMs: number | undefined): string | undefined {
  if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) {
    return undefined;
  }
  if (durationMs < 1_000) {
    return `${Math.round(durationMs)}ms`;
  }
  return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)}s`;
}

export type MessagingFullAccessControlsResolver =
  | MessagingFullAccessControls
  | MessagingFullAccessControlsResolverFn;

export type MessagingFullAccessControlsResolverFn = () =>
  | MessagingFullAccessControls
  | undefined
  | Promise<MessagingFullAccessControls | undefined>;

export type FullAccessRiskPresentationMode = "surface" | "message";
