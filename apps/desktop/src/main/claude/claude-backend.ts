import { createHash, randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  getSessionInfo, getSessionMessages, query, type AccountInfo, type McpServerStatus, type Options, type Query, type SDKMessage,
  type SDKResultMessage, type SDKUserMessage, type SlashCommand,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentEvent, AppServerAvailableCommandSummary, AppServerBackgroundTask, AppServerCollaborationModeRequest,
  AppServerPendingRequestNotification, AppServerReviewContext,
  AppServerThreadActivityEntry, AppServerThreadEntry, AppServerThreadMessageEntry, AppServerThreadMessagePart, AppServerThreadPlanEntry,
  AppServerThreadPlanStep, AppServerThreadReplay, AppServerThreadReviewEntry, AppServerThreadSummary,
  AppServerTurnInputItem, BackendModelOption, LinkedDirectorySummary, BackendRateLimitSummary, BackendSummary, ThreadExecutionMode,
  CodexMcpServerSummary, PreviewThreadRewindResponse, SteerTurnDelivery, ThreadRewindMode, ThreadRewindTarget, UsageLimitObservation,
} from "@pwragent/shared";
import { getMainLogger } from "../log";
import { resolveActiveProfilePath } from "../profile";
import { toTranscriptImageProtocolUrl } from "../transcript-image-protocol";
import { CLAUDE_SETUP_INSTRUCTIONS, claudeEnvironment, inspectClaudeInstallation, type ClaudeInstallation } from "./claude-executable";
import { CLAUDE_EXIT_PLAN_TOOL, createClaudePermissionHandler, claudePermissionMode } from "./claude-permissions";
import { createClaudeElicitationHandler } from "./claude-elicitation";
import { claudeHarnessOptions, discoverClaudeModels, readClaudeMcpServerStatus, readClaudeMetadata } from "./claude-models";
import { CLAUDE_TERMINAL_COMMANDS_SEED, claudeCommandSummaries } from "./claude-commands";
import {
  claudeRateLimits, claudeStreamRateLimits, claudeTelemetry, claudeTurnUsage, liveClaudeRateLimits,
  mergeClaudeStreamRateLimits, nextClaudeRateLimitReset,
} from "./claude-usage";
import { claudeCommandActivity, groupClaudeActivities } from "./claude-activity";
import { backUpRewindFiles, recordRewoundFiles, restoreRewindFiles } from "./claude-rewind-backup";
import { ClaudeSessionStore, type ClaudeSession } from "./claude-session-store";
import { ClaudeTaskTracker, claudeTaskRow, type ClaudeTaskSettlement } from "./claude-tasks";
import { CLAUDE_TODO_TOOL, claudeFileDiff, claudeTodoSteps, claudeToolDetail, claudeTurnDiff } from "./claude-tool-activity";
import { normalizeClaudeTitle, requestClaudeTitle, type ClaudeTitleQuery } from "./claude-titles";
import {
  CLAUDE_REPORT_FINDINGS_TOOL, claudeReportFindingsHooks, claudeReviewOutput, isClaudeOutcomeReport, matchClaudeFindingOutcomes,
  parseClaudeCodeReviewPullRequests, parseClaudeFindingsReport, type ClaudeFindingsReport,
} from "./claude-review-findings";
import type { NamedReviewPullRequest } from "../../shared/review-command";
import { formatReviewOutputText, reviewEntryFindings } from "../../shared/review-output";

export type ClaudeBackendOptions = {
  store?: ClaudeSessionStore;
  query?: typeof query;
  getSessionInfo?: typeof getSessionInfo;
  getSessionMessages?: typeof getSessionMessages;
  inspectInstallation?: typeof inspectClaudeInstallation;
  discoverModels?: typeof discoverClaudeModels;
  readCommands?: (params: { executable: string; env: NodeJS.ProcessEnv; cwd: string }) => Promise<SlashCommand[]>;
  readMcpServers?: (params: { executable: string; env: NodeJS.ProcessEnv; cwd: string }) => Promise<McpServerStatus[]>;
  resolveEnv?: () => Promise<NodeJS.ProcessEnv>;
  emit: (event: AgentEvent) => Promise<void>;
  request: (request: AppServerPendingRequestNotification, signal: AbortSignal) => Promise<unknown>;
  cancelRequest: (threadId: string, turnId: string, requestId: string) => Promise<void>;
  /** Overrides CLAUDE_TASK_FOLLOW_UP_GRACE_MS. */
  taskFollowUpGraceMs?: number;
  /** Overrides CLAUDE_INTERRUPT_GRACE_MS. */
  interruptGraceMs?: number;
  /** Overrides CLAUDE_REWIND_PREVIEW_TIMEOUT_MS. */
  rewindPreviewTimeoutMs?: number;
  /** Workspace, branch, and pull request for a review card. Never fails a review. */
  /** `pullRequests` are the targets the turn's `/code-review` named, when it named any. */
  resolveReviewContext?: (params: {
    threadId: string; cwd: string; pullRequests?: NamedReviewPullRequest[];
  }) => Promise<AppServerReviewContext | undefined>;
};

const claudeBackendLog = getMainLogger("pwragent:claude-backend");

/** setTimeout's longest delay; a later reset re-arms on wake. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MAX_TURN_STDERR_LENGTH = 4_096;

/** Error subtypes are authoritative even when the producer leaves is_error false. */
function claudeResultFailure(message: SDKResultMessage): string | undefined {
  if (message.subtype === "success" && !message.is_error) return undefined;
  const detail = message.subtype === "success" ? message.result : message.errors.join("\n");
  if (detail.trim()) return detail;
  switch (message.subtype) {
    case "error_max_turns": return "Claude reached the maximum number of turns.";
    case "error_max_budget_usd": return "Claude reached the configured spending limit.";
    case "error_max_structured_output_retries": return "Claude could not produce the required structured output.";
    default: return `Claude reported an error without details (${message.subtype}).`;
  }
}

function claudeExceptionMessage(error: unknown, stderr: string): string {
  return (error instanceof Error ? error.message : String(error)).trim()
    || stderr.trim()
    || "Claude failed without providing error details.";
}

/**
 * How long a settled task may go unanswered before the session closes without
 * its follow-up. Claude normally answers a task notification with a native turn
 * of its own; this bounds the wait when it does not.
 */
const CLAUDE_TASK_FOLLOW_UP_GRACE_MS = 5_000;

/**
 * How long Stop waits for Claude to end an interrupted turn before ending it
 * locally. The process stays up either way, for the tasks it runs.
 */
const CLAUDE_INTERRUPT_GRACE_MS = 5_000;

/**
 * How long the confirmation waits for Claude's file dry run. The confirm
 * button waits on it, so a CLI that never answers must not hold it forever.
 */
const CLAUDE_REWIND_PREVIEW_TIMEOUT_MS = 30_000;

/** The CLI drops queued messages along with the interrupted turn. */
const CLAUDE_INTERRUPT_CANCEL_QUEUED = "interrupt_cancel_queued_v1";

/** The SDK sends cancelQueued, which its declared signature omits. */
type ClaudeInterruptQuery = Query & {
  interrupt(options?: { cancelQueued?: boolean }): ReturnType<Query["interrupt"]>;
};

const CLAUDE_WAKE = Symbol("claude-wake");

/** The system messages that start, change, or end a Claude task. */
const CLAUDE_TASK_SUBTYPES = new Set<string>([
  "task_started", "task_updated", "task_progress", "task_notification", "background_tasks_changed",
]);

/** Whether cumulative model totals record any work. */
function claudeHasModelUsage(modelUsage: SDKResultMessage["modelUsage"] | undefined): modelUsage is SDKResultMessage["modelUsage"] {
  return Boolean(modelUsage) && Object.values(modelUsage!).some((value) =>
    value.inputTokens + value.outputTokens + value.cacheReadInputTokens + value.cacheCreationInputTokens > 0);
}

/** A promise settled from outside; `settled` says whether it has been. */
type ClaudeDeferred = { promise: Promise<void>; resolve: () => void; settled: boolean };

function claudeDeferred(): ClaudeDeferred {
  let settle!: () => void;
  const deferred: ClaudeDeferred = {
    promise: new Promise<void>((resolve) => { settle = resolve; }),
    resolve: () => { deferred.settled = true; settle(); },
    settled: false,
  };
  return deferred;
}

function claudeWakeSignal(): { promise: Promise<typeof CLAUDE_WAKE>; wake: () => void } {
  let wake!: () => void;
  const promise = new Promise<typeof CLAUDE_WAKE>((resolve) => { wake = () => resolve(CLAUDE_WAKE); });
  return { promise, wake };
}

/** Signed out, or billed outside a Claude subscription: no plan limit applies. */
function claudeHasNoPlanLimits({ authStatus, authMethod }: ClaudeInstallation): boolean {
  return authStatus === "sign-in-required" || authMethod === "api-key" || authMethod === "external";
}

/** Tells accounts apart without keeping their identifiers. */
/**
 * How long a turn's account waits for its session's first init to name the
 * account. The wait also ends at the turn's result, failure, or session close.
 */
const ACCOUNT_CHECK_WAIT_MS = 10_000;

function settledSignal(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => { resolve = settle; });
  return { promise, resolve };
}

function claudeAccountKey(info: AccountInfo): string {
  return createHash("sha256")
    .update(JSON.stringify([info.apiProvider ?? "", info.organization ?? "", info.email ?? ""]))
    .digest("hex").slice(0, 16);
}

/** One desktop turn: what the operator sees start and end. */
type RunningTurn = {
  turnId: string;
  /** Claude turn ids are UUIDv4 and carry no time, so report the start. */
  startedAt: number;
  entries: Map<string, AppServerThreadEntry>;
  started?: boolean;
  /** Claude began this turn itself, answering a settled task. */
  followUp?: boolean;
  /**
   * Input UUIDs no result has acknowledged yet: steers, and the prompt of a
   * turn sent into a live session.
   */
  pendingSteers: Set<string>;
  /** The SDK emits one assistant message per content block, sharing an id. */
  completedMessageText: Map<string, string>;
  /** ReportFindings calls the CLI has not yet accepted, by tool-use id. */
  pendingReports: Map<string, { report: ClaudeFindingsReport; model?: string; input: unknown }>;
  /** Some successful tools update existing state without adding transcript entries. */
  hasCompletedToolActivity: boolean;
  /** Each successful file edit's diff, in order: the turn's live diff. */
  fileDiffs: string[];
  ending?: boolean;
  titlePrompt?: string;
  /** Owned by the turn, but never awaited by the streaming message pump. */
  titleUpdate?: Promise<boolean>;
  /** The latest native result; the turn reports it when it ends. */
  lastResult?: SDKResultMessage;
  lastResultSeq: number;
  resultSummary?: Record<string, unknown>;
  /** Why Claude says the turn failed, from a result or an assistant API error. */
  resultFailure?: string;
  /** Cumulative model totals when the turn began; the turn bills the rest. */
  usageBaseline?: ClaudeSession["modelUsage"];
  /** An old session with no baseline cannot attribute its first totals. */
  needsUsageBaseline: boolean;
  /** Stop interrupted Claude rather than ending the query, so the turn ends cancelled. */
  interrupted?: boolean;
  /** Claude did not answer the interrupt in time; the turn ends without it. */
  abandoned?: boolean;
  /** Settles once the turn has reported its end. */
  ended: ClaudeDeferred;
};

/** What a live session was launched with, compared when a turn reuses it. */
type ClaudeSessionConfig = {
  model?: string;
  effort?: Options["effort"];
  permissionMode: NonNullable<Options["permissionMode"]>;
  instructions?: string;
  mcpServers?: Options["mcpServers"];
  mcpKey: string;
  /** The thread's other linked directories, fixed when the process starts. */
  additionalDirectories: string[];
  /** The thread environment's captured toolchain variables. */
  shellEnvironment?: Record<string, string>;
  shellEnvironmentKey: string;
};

/**
 * One SDK query and CLI process per thread. A desktop turn ends at Claude's
 * native result, but closing the query kills every background task, so the
 * session stays open while a task runs and carries the turns that follow.
 */
type LiveSession = {
  session: ClaudeSession;
  controller: AbortController;
  query?: Query;
  done?: Promise<void>;
  input: ClaudeInputStream;
  inputWrites: Promise<void>;
  config: ClaudeSessionConfig;
  /** The desktop turn now open, if any. */
  turn?: RunningTurn;
  /** The latest desktop turn; a request between turns belongs to it. */
  lastTurnId: string;
  /** Released when the session closes, such as the turns' MCP grants. */
  onClosed: (() => void)[];
  closing?: boolean;
  closed?: boolean;
  contextWindow?: ClaudeSession["contextWindow"];
  /** One background context probe at a time; a request while it runs reruns it once. */
  contextRefresh?: { promise: Promise<void>; again: boolean };
  titleEnv?: NodeJS.ProcessEnv;
  /** Shell commands and sub-agents this process runs. */
  tasks: ClaudeTaskTracker;
  /** The rows last published through `thread/backgroundTasks/updated`. */
  publishedTasks: AppServerBackgroundTask[];
  publishedTaskKey: string;
  /** Tool rows a task may still settle, with the desktop turn that shows them. */
  toolRows: Map<string, { entry: AppServerThreadActivityEntry; turnId: string }>;
  /** Tool calls answered with a background placeholder and not yet settled. */
  launchedToolUseIds: Set<string>;
  /** Set at the first native init; a follow-up turn's init repeats it. */
  initialized?: boolean;
  /** Settles once the first init has confirmed the signed-in account, or the session closed. */
  accountChecked: { promise: Promise<void>; resolve: () => void };
  /** Message counters that order a result against task notifications. */
  messageSeq: number;
  lastResultSeq: number;
  lastActivitySeq: number;
  lastNotificationSeq: number;
  /** Claude's own session state, when the CLI reports one. */
  sessionState?: "idle" | "running" | "requires_action";
  /** Wakes the message pump while it waits for the next message. */
  wake: ReturnType<typeof claudeWakeSignal>;
  followUpTimer?: ReturnType<typeof setTimeout>;
  /** The message counter at which the follow-up grace expired. */
  followUpWaivedAt?: number;
  /** Keep only a bounded tail; emit it only when a turn fails. */
  stderr: string;
  /** Protocol features the CLI advertised at init. */
  capabilities?: string[];
};

/** A turn is already open for the thread, so the message must wait in the queue. */
export class ClaudeTurnActiveError extends Error {}

type ClaudeTurnParams = {
  threadId: string; input: AppServerTurnInputItem[]; model?: string; reasoningEffort?: string;
  executionMode?: ThreadExecutionMode; instructions?: string;
  mcpServers?: Options["mcpServers"];
  /** Plan runs this turn in Claude's read-only plan mode. */
  collaborationMode?: AppServerCollaborationModeRequest;
  /** Directories attached to the thread after it was created. */
  attachedDirectories?: readonly LinkedDirectorySummary[];
  /** Variables the thread environment's setup captured, such as PATH. */
  shellEnvironment?: Record<string, string>;
};

type ClaudeTurnStart = { backend: "claude"; threadId: string; turnId: string };

const CLAUDE_EFFORTS = new Set<string>(["low", "medium", "high", "xhigh", "max"]);

/** Every directory linked to the thread except its working directory, in a stable order. */
function claudeAdditionalDirectories(session: ClaudeSession, attached: readonly LinkedDirectorySummary[] = []): string[] {
  const paths = [...session.thread.linkedDirectories, ...attached].flatMap((directory) => {
    const activePath = directory.kind === "worktree" ? directory.worktreePath ?? directory.path : directory.path;
    return activePath ? [activePath] : [];
  });
  const cwd = path.resolve(session.cwd);
  return [...new Set(paths.map((directory) => path.resolve(directory)))]
    .filter((directory) => directory !== cwd).sort();
}

function claudeSessionConfig(params: ClaudeTurnParams, session: ClaudeSession): ClaudeSessionConfig {
  return {
    model: params.model ?? session.thread.model,
    effort: CLAUDE_EFFORTS.has(params.reasoningEffort ?? "") ? params.reasoningEffort as Options["effort"] : undefined,
    permissionMode: params.collaborationMode?.mode === "plan"
      ? "plan" : claudePermissionMode(params.executionMode ?? session.thread.executionMode ?? "default"),
    instructions: params.instructions,
    mcpServers: params.mcpServers,
    mcpKey: JSON.stringify(params.mcpServers ?? {}),
    additionalDirectories: claudeAdditionalDirectories(session, params.attachedDirectories),
    shellEnvironment: params.shellEnvironment,
    shellEnvironmentKey: JSON.stringify(
      Object.entries(params.shellEnvironment ?? {}).sort(([a], [b]) => a.localeCompare(b)),
    ),
  };
}

/** A turn's id is a v4 UUID, and doubles as its prompt's SDK UUID. */
function claudePromptUuid(turn: RunningTurn): NonNullable<SDKUserMessage["uuid"]> {
  return turn.turnId as NonNullable<SDKUserMessage["uuid"]>;
}

/** A session read before the turn has no baseline yet; the caller sets it. */
function claudeTurn(session?: ClaudeSession, followUp = false): RunningTurn {
  return {
    ended: claudeDeferred(),
    turnId: randomUUID(), startedAt: Date.now(), entries: new Map(), pendingSteers: new Set(),
    completedMessageText: new Map(), pendingReports: new Map(), hasCompletedToolActivity: false, fileDiffs: [], lastResultSeq: 0,
    usageBaseline: session?.modelUsage, needsUsageBaseline: Boolean(session?.sdkSessionId) && !session?.modelUsage,
    ...(followUp ? { followUp, started: true } : {}),
  };
}

/** One input pump owns the SDK's stdin until the live session closes. */
class ClaudeInputStream {
  private readonly messages: SDKUserMessage[] = [];
  private wake?: () => void;
  private closed = false;

  push(message: SDKUserMessage): void {
    if (this.closed) throw new Error("Claude input is closed.");
    this.messages.push(message);
    this.wake?.();
  }

  close(): void {
    this.closed = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (!this.closed) {
      const message = this.messages.shift();
      if (message) yield message;
      else await new Promise<void>((resolve) => { this.wake = resolve; });
    }
  }
}

export class ClaudeBackend {
  private readonly store: ClaudeSessionStore;
  private readonly sessions = new Map<string, LiveSession>();
  /** Threads whose first turn is reading its session, before a query exists. */
  private readonly starting = new Map<string, AbortController>();
  /** Threads a rewind is changing; a message for one waits in the queue. */
  private readonly rewinding = new Set<string>();
  /**
   * Control queries a rewind runs against a thread's session. A turn waits
   * for them to close, so two CLI processes never resume one session.
   */
  private readonly rewindQueries = new Map<string, Promise<void>>();
  /**
   * Releases a relaunched session hands to its successor: the turn that
   * relaunched it registered the thread's MCP grants again, sharing them.
   */
  private readonly carriedReleases = new Map<string, (() => void)[]>();
  private installation: ClaudeInstallation = { authStatus: "unknown", message: CLAUDE_SETUP_INSTRUCTIONS };
  private discovery?: { models: boolean; promise: Promise<void> };
  private modelDiscovery?: Promise<void>;
  private nextModelRefreshAt = 0;
  private models?: BackendModelOption[];
  // Account-wide, so one thread's turn must never clear another's view.
  private rateLimits: BackendSummary["rateLimits"];
  private rateLimitsLoad?: Promise<void>;
  private rateLimitWrites = Promise.resolve();
  /** The account the limits describe, as `claudeAccountKey`. */
  private rateLimitAccount?: string;
  /** When Claude last reported the limits, changed or not. */
  private rateLimitsObservedAt?: number;
  /** The account's subscription, as Claude reports it (`max`, `pro`). */
  private rateLimitPlan?: string;
  private rateLimitExpiry?: ReturnType<typeof setTimeout>;
  // Last command list Claude reported per working directory. Project
  // commands and skills differ by folder, so the folder is the key.
  private readonly commandsByCwd = new Map<string, AppServerAvailableCommandSummary[]>();
  private readonly commandProbes = new Map<string, Promise<AppServerAvailableCommandSummary[]>>();
  private readonly mcpServerProbes = new Map<string, Promise<McpServerStatus[]>>();
  private readonly commandProbeRetryAt = new Map<string, number>();
  private terminalCommands = new Set(CLAUDE_TERMINAL_COMMANDS_SEED);

  constructor(private readonly options: ClaudeBackendOptions) {
    this.store = options.store ?? new ClaudeSessionStore(path.join(resolveActiveProfilePath("state"), "claude"));
  }

  async discover(options: { models?: boolean } = {}): Promise<void> {
    const models = options.models !== false;
    const inFlight = this.discovery;
    // An installation-only check cannot answer a request for the model catalog.
    if (inFlight && (inFlight.models || !models)) return await inFlight.promise;
    if (inFlight) await inFlight.promise.catch(() => {});
    const discovery = {
      models,
      promise: (async () => {
        const env = claudeEnvironment(await this.options.resolveEnv?.() ?? process.env);
        this.installation = await (this.options.inspectInstallation ?? inspectClaudeInstallation)({ env });
        if (models && this.installation.executable && this.installation.authStatus !== "sign-in-required") {
          await this.refreshModelCatalog(env);
        }
        if (claudeHasNoPlanLimits(this.installation)) {
          this.setRateLimits([]);
        } else {
          await this.loadRateLimits();
        }
      })(),
    };
    this.discovery = discovery;
    try { await discovery.promise; } finally { if (this.discovery === discovery) this.discovery = undefined; }
  }

  summary(): BackendSummary {
    const available = this.available();
    return {
      kind: "claude", source: "builtin", label: "Claude", available,
      claude: { ...this.installation },
      rateLimits: this.shownRateLimits(),
      unavailableReason: available ? undefined : this.installation.message,
      methods: [],
      capabilities: {
        listThreads: true, createThread: true, forkThread: true, resumeThread: true, renameThread: true,
        readThread: true, startTurn: true, interruptTurn: true, steerTurn: true,
        interruptSteerTurn: true,
        archiveThread: true, restoreThread: true, archiveWorktree: false,
        transcriptPagination: false, toolUse: true, approvalRequests: true,
        multiDirectoryThreads: true,
        // Claude runs no reviews itself, but this owner accepts a run mode
        // for a Claude thread whose review runs on another provider.
        reviewRunMode: true,
        // File checkpoints restore what Edit, Write, and NotebookEdit changed.
        threadRewind: { files: true, undo: true },
      },
      executionModes: [
        { mode: "default", label: "Default", available: true, isDefault: true },
        { mode: "auto", label: "Auto", available: true },
        { mode: "full-access", label: "Full Access", available: true },
      ],
      // Stable aliases remain usable until global discovery reports models.
      launchpadOptions: { models: this.models ?? [
        { id: "sonnet", label: "Sonnet", supportsImage: true },
        { id: "opus", label: "Opus", supportsImage: true },
        { id: "haiku", label: "Haiku", supportsImage: true },
      ] },
    };
  }

  private async requireInstallation(): Promise<string> {
    // Inspection spawns the CLI three times. Reuse a usable result; an explicit
    // Settings check or startup refresh re-inspects through discover().
    if (this.installation.executable && this.installation.authStatus !== "sign-in-required") {
      return this.installation.executable;
    }
    await this.discover({ models: false });
    if (!this.installation.executable || this.installation.authStatus === "sign-in-required") {
      throw new Error(this.installation.message ?? CLAUDE_SETUP_INSTRUCTIONS);
    }
    return this.installation.executable;
  }

  async startThread(params: {
    cwd: string; model?: string; executionMode: ThreadExecutionMode;
    linkedDirectories?: AppServerThreadSummary["linkedDirectories"];
  }): Promise<{ threadId: string }> {
    await this.requireInstallation();
    const id = randomUUID();
    const now = Date.now();
    await this.store.save({
      cwd: params.cwd,
      thread: {
        id, source: "claude", title: "Untitled thread", titleSource: "fallback",
        createdAt: now, updatedAt: now, model: params.model, executionMode: params.executionMode,
        linkedDirectories: params.linkedDirectories ?? [{ id: params.cwd, kind: "local", label: path.basename(params.cwd), path: params.cwd }],
      },
    });
    return { threadId: id };
  }

  /**
   * A new thread that continues another's conversation. It copies the
   * source's history, and its first message resumes the source's Claude
   * session with `forkSession`, in the fork's own workspace.
   */
  async forkThread(params: {
    sourceThreadId: string; cwd: string; model?: string; executionMode: ThreadExecutionMode;
    linkedDirectories?: AppServerThreadSummary["linkedDirectories"];
  }): Promise<{ threadId: string }> {
    await this.requireInstallation();
    // A running turn's entries are unfinished, and would stay so in the fork.
    const live = this.sessions.get(params.sourceThreadId);
    if (live?.turn || (!live && this.starting.has(params.sourceThreadId))) {
      throw new Error("Wait for the active Claude turn to finish before forking.");
    }
    const source = await this.store.read(params.sourceThreadId);
    // A fork that has not sent a message yet still continues its source's session.
    const forkFromSdkSessionId = source.sdkSessionId ?? source.forkFromSdkSessionId;
    if (!forkFromSdkSessionId) throw new Error("This Claude thread has no conversation to fork yet.");
    const id = randomUUID();
    const now = Date.now();
    await this.store.save({
      cwd: params.cwd,
      thread: {
        id, source: "claude", title: `${source.thread.title} (fork)`, titleSource: "derived",
        createdAt: now, updatedAt: now, model: params.model ?? source.thread.model, executionMode: params.executionMode,
        linkedDirectories: params.linkedDirectories ?? [{ id: params.cwd, kind: "local", label: path.basename(params.cwd), path: params.cwd }],
      },
      forkFromSdkSessionId,
      // A pending rewind point is where the source's conversation continues.
      ...(source.resumeSessionAt ? { resumeSessionAt: source.resumeSessionAt } : {}),
      ...(source.contextWindow ? { contextWindow: source.contextWindow } : {}),
      // The fork keeps the source's name; it never asks Claude for another.
      titleGenerationAttempted: true,
    });
    await this.store.append(id, await this.store.entries(params.sourceThreadId));
    return { threadId: id };
  }

  async executionMode(threadId: string): Promise<ThreadExecutionMode> {
    return (await this.store.read(threadId)).thread.executionMode ?? "default";
  }

  async listThreads(params: { archived?: boolean; filter?: string } = {}): Promise<AppServerThreadSummary[]> {
    const filter = params.filter?.toLowerCase();
    // Metadata from builds that could not move a Claude thread still carries
    // their refusal; this build can, so drop it.
    return (await this.store.list()).map(({ thread: { workspaceHandoff: _refusal, ...thread } }) => ({
      ...thread, threadStatus: this.sessions.get(thread.id)?.turn ? "active" as const : "idle" as const,
    })).filter((thread) => Boolean(thread.archivedAt) === Boolean(params.archived)
      && (!filter || thread.title.toLowerCase().includes(filter) || thread.id.includes(filter)));
  }

  async readThread(threadId: string): Promise<AppServerThreadReplay> {
    const session = await this.store.read(threadId);
    const entries = new Map((await this.store.entries(threadId)).map((entry) => [entry.id, entry]));
    const live = this.sessions.get(threadId);
    for (const entry of live?.turn?.entries.values() ?? []) entries.set(entry.id, entry);
    // A task row that outlived its turn changes after that turn was saved.
    for (const { entry } of live?.toolRows.values() ?? []) entries.set(entry.id, entry);
    const ordered = groupClaudeActivities([...entries.values()]);
    const messages = ordered.filter((entry): entry is AppServerThreadMessageEntry => entry.type === "message");
    return {
      entries: ordered, messages,
      contextWindow: live?.contextWindow ?? session.contextWindow,
      lastUserMessage: messages.findLast((entry) => entry.role === "user")?.text,
      lastAssistantMessage: messages.findLast((entry) => entry.role === "assistant")?.text,
      pagination: { supportsPagination: false, hasPreviousPage: false },
      threadStatus: live?.turn ? "active" : "idle",
    };
  }

  async renameThread(threadId: string, name: string): Promise<{ threadId: string }> {
    const session = await this.store.read(threadId);
    session.thread.title = name.trim();
    session.thread.titleSource = "explicit";
    await this.store.save(session);
    return { threadId };
  }

  async setArchived(threadId: string, archived: boolean): Promise<void> {
    const live = this.sessions.get(threadId);
    if (live?.turn) throw new Error("Interrupt the active Claude turn before archiving.");
    if (live) throw new Error("Stop Claude's background tasks before archiving.");
    const session = await this.store.read(threadId);
    session.thread.archivedAt = archived ? Date.now() : undefined;
    await this.store.save(session);
  }

  /**
   * Throws when the thread cannot change folders now. A move relaunches
   * Claude in the new folder, and closing the old process ends its tasks.
   * Check before moving any files, so a refusal leaves everything in place.
   */
  assertWorkspaceMovable(threadId: string): void {
    if (this.rewinding.has(threadId) || this.rewindQueries.has(threadId)) {
      throw new Error("Claude is rewinding this thread. Try again when it finishes.");
    }
    const live = this.sessions.get(threadId);
    if (live?.turn || (!live && this.starting.has(threadId))) {
      throw new Error("Wait for the active Claude turn to finish before moving this thread.");
    }
    if (live && live.tasks.active().length > 0) {
      throw new Error("Stop Claude's background tasks before moving this thread.");
    }
  }

  /**
   * Continue the thread in another folder. The next turn resumes the same
   * Claude session there: the conversation carries over, and Claude's tools
   * and environment use the new folder. Claude keeps the session file under
   * the folder that first wrote it; session reads fall back to every folder.
   */
  async moveWorkspace(params: {
    threadId: string; cwd: string; linkedDirectory: LinkedDirectorySummary;
  }): Promise<void> {
    this.assertWorkspaceMovable(params.threadId);
    const live = this.sessions.get(params.threadId);
    // An idle process keeps its launch folder; the next turn relaunches.
    if (live) await this.closeSession(live);
    const session = await this.store.read(params.threadId);
    const previous = path.resolve(session.cwd);
    // Replace the directory the thread worked in; keep its other links.
    const others = session.thread.linkedDirectories.filter((directory) => {
      const activePath = directory.kind === "worktree" ? directory.worktreePath ?? directory.path : directory.path;
      return !activePath || path.resolve(activePath) !== previous;
    });
    session.cwd = params.cwd;
    session.thread.linkedDirectories = [params.linkedDirectory, ...others];
    session.thread.updatedAt = Date.now();
    await this.store.save(session);
  }

  async setExecutionMode(threadId: string, mode: ThreadExecutionMode): Promise<void> {
    // Relaunching at the next turn applies the mode through the SDK. During a
    // live turn use its control API and wait for acknowledgement before saving.
    const live = this.sessions.get(threadId);
    if (live && !live.query) throw new Error("Claude is starting. Wait for the turn to start before changing permissions.");
    if (live?.query) {
      const permissionMode = claudePermissionMode(mode);
      await live.query.setPermissionMode(permissionMode);
      live.config.permissionMode = permissionMode;
    }
    const session = await this.store.read(threadId);
    session.thread.executionMode = mode;
    await this.store.save(session);
  }

  async startTurn(params: ClaudeTurnParams & {
    /**
     * Runs when the session the turn joins closes, which can be turns later.
     * Always consumed, including when the turn does not start.
     */
    onSessionClosed?: () => void;
  }): Promise<ClaudeTurnStart> {
    const { onSessionClosed, ...turnParams } = params;
    try {
      return await this.startTurnInSession(turnParams);
    } finally {
      // A live session uses the thread's MCP grants, so it keeps them too.
      if (onSessionClosed) this.releaseWithSession(params.threadId, onSessionClosed);
      const carried = this.carriedReleases.get(params.threadId);
      this.carriedReleases.delete(params.threadId);
      for (const release of carried ?? []) this.releaseWithSession(params.threadId, release);
    }
  }

  private releaseWithSession(threadId: string, release: () => void): void {
    const live = this.sessions.get(threadId);
    if (live && !live.closed) live.onClosed.push(release);
    else release();
  }

  private async startTurnInSession(params: ClaudeTurnParams): Promise<ClaudeTurnStart> {
    for (;;) {
      if (this.rewinding.has(params.threadId)) {
        throw new ClaudeTurnActiveError("Claude is rewinding this thread.");
      }
      const control = this.rewindQueries.get(params.threadId);
      if (control) {
        await control;
        continue;
      }
      const live = this.sessions.get(params.threadId);
      if (live?.turn || (!live && this.starting.has(params.threadId))) {
        throw new ClaudeTurnActiveError("A Claude turn is already active for this thread.");
      }
      if (!live) return await this.startSession(params);
      if (live.closing) {
        await live.done;
        continue;
      }
      const started = await this.continueSession(live, params);
      if (started) return started;
    }
  }

  /** Launch a query for the thread, with this turn's message as its prompt. */
  private async startSession(params: ClaudeTurnParams): Promise<ClaudeTurnStart> {
    const { threadId } = params;
    const controller = new AbortController();
    this.starting.set(threadId, controller);
    const turn = claudeTurn();
    let live: LiveSession | undefined;
    try {
      const executable = await this.requireInstallation();
      const session = await this.store.read(threadId);
      if (session.thread.archivedAt) throw new Error("Restore this Claude thread before sending a message.");
      const content = await claudeInput(params.input);
      controller.signal.throwIfAborted();
      const current: LiveSession = live = {
        session, controller, input: new ClaudeInputStream(), inputWrites: Promise.resolve(),
        config: claudeSessionConfig(params, session), turn, lastTurnId: turn.turnId, onClosed: [],
        tasks: new ClaudeTaskTracker(), publishedTasks: [], publishedTaskKey: "[]", toolRows: new Map(), launchedToolUseIds: new Set(),
        messageSeq: 0, lastResultSeq: 0, lastActivitySeq: 0, lastNotificationSeq: 0, wake: claudeWakeSignal(), stderr: "",
        accountChecked: settledSignal(),
      };
      this.starting.delete(threadId);
      this.sessions.set(threadId, current);
      await this.beginTurn(current, turn, session, params.input);
      const { config } = current;
      // The environment's toolchain (PATH, NVM_DIR, …) reaches every command
      // Claude runs, as it does for Codex and ACP threads.
      const env = claudeEnvironment({
        ...(await this.options.resolveEnv?.() ?? process.env),
        ...config.shellEnvironment,
      });
      controller.signal.throwIfAborted();
      current.titleEnv = env;
      // The thread id names its first SDK session. A rewind past the first
      // prompt leaves the thread with no session to resume, and that id is
      // taken, so the next session gets its own.
      const freshSdkSessionId = session.rewinds?.length ? randomUUID() : threadId;
      const sdkOptions: Options = {
        ...claudeHarnessOptions(executable, env),
        cwd: session.cwd,
        ...(session.sdkSessionId ?? session.forkFromSdkSessionId
          ? {
            resume: session.sdkSessionId ?? session.forkFromSdkSessionId,
            ...(session.resumeSessionAt ? { resumeSessionAt: session.resumeSessionAt } : {}),
            // A fork continues the source's conversation in a session of its own.
            ...(session.sdkSessionId ? {} : { forkSession: true }),
          }
          : { sessionId: freshSdkSessionId }),
        // Checkpoints each prompt's files, so a rewind can restore them.
        enableFileCheckpointing: true,
        systemPrompt: { type: "preset", preset: "claude_code", ...(config.instructions ? { append: config.instructions } : {}) },
        persistSession: true,
        ...(session.thread.titleSource === "explicit" ? { title: session.thread.title } : {}),
        includePartialMessages: true,
        permissionMode: config.permissionMode,
        // Enables an explicit Full Access selection through setPermissionMode;
        // the current permissionMode still governs every tool invocation.
        allowDangerouslySkipPermissions: true,
        model: config.model,
        ...(config.effort ? { effort: config.effort } : {}),
        abortController: controller,
        stderr: (data) => { current.stderr = (current.stderr + data).slice(-MAX_TURN_STDERR_LENGTH); },
        mcpServers: config.mcpServers,
        ...(config.additionalDirectories.length ? { additionalDirectories: config.additionalDirectories } : {}),
        canUseTool: createClaudePermissionHandler({
          threadId, turnId: () => current.turn?.turnId ?? current.lastTurnId,
          planTurn: () => current.config.permissionMode === "plan",
          request: this.options.request,
          cancelRequest: (requestId, turnId) => this.options.cancelRequest(threadId, turnId, requestId),
        }),
        onElicitation: createClaudeElicitationHandler({
          threadId, turnId: () => current.turn?.turnId ?? current.lastTurnId,
          request: this.options.request,
          cancelRequest: (requestId, turnId) => this.options.cancelRequest(threadId, turnId, requestId),
        }),
        // A findings report that leaves findings skipped tells the agent they are still open.
        hooks: claudeReportFindingsHooks(),
      };
      let releasePrompt!: () => void;
      const promptReady = new Promise<void>((resolve) => { releasePrompt = resolve; });
      const input = current.input;
      async function* prompt(): AsyncIterable<SDKUserMessage> {
        await promptReady;
        // The turn id doubles as the prompt's UUID, which a rewind targets.
        yield { type: "user", uuid: claudePromptUuid(turn), parent_tool_use_id: null,
          session_id: session.sdkSessionId ?? session.forkFromSdkSessionId ?? freshSdkSessionId,
          message: { role: "user", content } };
        yield* input;
      }
      current.query = (this.options.query ?? query)({ prompt: prompt(), options: sdkOptions });
      // Older PwrAgent metadata has no cost baseline. Read the official
      // session totals before releasing the prompt, so this turn cannot race
      // its own baseline. If unavailable, the first result seeds the next turn.
      try {
        // A fork's totals start from its source's, so it reads them too.
        if ((session.sdkSessionId ?? session.forkFromSdkSessionId) && !session.modelUsage) {
          const usage = await claudeTelemetry(() => current.query!.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }));
          if (usage?.session?.model_usage) session.modelUsage = usage.session.model_usage;
        }
      } finally { releasePrompt(); }
      turn.usageBaseline = session.modelUsage;
      turn.needsUsageBaseline = Boolean(session.sdkSessionId ?? session.forkFromSdkSessionId) && !session.modelUsage;
      current.done = this.consume(current);
      // consume owns every error after launch, including terminal notification.
      void current.done.catch(() => {});
      return { backend: "claude", threadId, turnId: turn.turnId };
    } catch (error) {
      const failure = claudeExceptionMessage(error, live?.stderr ?? "");
      claudeBackendLog.warn("Claude turn failed during startup", {
        threadId, turnId: turn.turnId, error: failure, stderr: live?.stderr.slice(-320),
      });
      turn.ending = true;
      if (live) {
        live.closing = true;
        live.input.close();
        // A steer accepted during startup writes its own row; let it land
        // before the failed status, so the failed status is final.
        await this.settleInputWrites(live);
        if (this.sessions.get(threadId) === live) this.sessions.delete(threadId);
        this.runSessionClosed(live);
      }
      if (turn.started) await this.failTurn(threadId, turn, failure);
      throw new Error(failure, { cause: error });
    } finally {
      if (this.starting.get(threadId) === controller) this.starting.delete(threadId);
    }
  }

  /**
   * Send the turn's message into the thread's live session, so its tasks keep
   * running. Returns undefined when the session must be relaunched first.
   */
  private async continueSession(live: LiveSession, params: ClaudeTurnParams): Promise<ClaudeTurnStart | undefined> {
    const { threadId } = params;
    const session = await this.store.read(threadId);
    if (session.thread.archivedAt) throw new Error("Restore this Claude thread before sending a message.");
    const content = await claudeInput(params.input);
    // A message that cannot be sent must not change the session's settings.
    if (live.turn) throw new ClaudeTurnActiveError("A Claude turn is already active for this thread.");
    if (!live.closing && !await this.reconfigure(live, claudeSessionConfig(params, session))) {
      // Only a new process takes this setting, and this one runs no task.
      claudeBackendLog.info("Relaunching Claude to apply the turn's settings", { threadId });
      // This turn registered the thread's MCP grants again; the new session uses them.
      this.carriedReleases.set(threadId, [...this.carriedReleases.get(threadId) ?? [], ...live.onClosed.splice(0)]);
      await this.closeSession(live);
      return undefined;
    }
    if (live.turn) throw new ClaudeTurnActiveError("A Claude turn is already active for this thread.");
    if (live.closing || this.sessions.get(threadId) !== live) return undefined;
    const turn = claudeTurn(live.session);
    live.turn = turn;
    live.lastTurnId = turn.turnId;
    if (live.followUpTimer) clearTimeout(live.followUpTimer);
    live.followUpTimer = undefined;
    // A steer for this turn must follow its prompt into the input stream.
    const prompted = claudeDeferred();
    live.inputWrites = live.inputWrites.then(() => prompted.promise);
    try {
      await this.beginTurn(live, turn, session, params.input);
      // The session closed while the turn opened; its prompt was never sent.
      if (live.closing) throw new Error("Claude stopped before the message was sent.");
      // The turn id doubles as the prompt's UUID, which a rewind targets.
      const uuid = claudePromptUuid(turn);
      turn.pendingSteers.add(uuid);
      live.input.push({ type: "user", uuid, priority: "next", parent_tool_use_id: null, message: { role: "user", content } });
    } catch (error) {
      turn.ending = true;
      if (live.turn === turn) live.turn = undefined;
      const failure = claudeExceptionMessage(error, "");
      claudeBackendLog.warn("Claude turn failed to start in a live session", { threadId, turnId: turn.turnId, error: failure });
      // A session that closed meanwhile has already ended a started turn.
      if (turn.started && !turn.ended.settled) await this.failTurn(threadId, turn, failure);
      throw error;
    } finally {
      prompted.resolve();
    }
    return { backend: "claude", threadId, turnId: turn.turnId };
  }

  /**
   * Apply a turn's settings to a live session; false when it must relaunch.
   * A relaunch stops the session's tasks, so with tasks running a setting
   * only a new process takes waits for one, and a rejected change fails the
   * turn instead.
   */
  private async reconfigure(live: LiveSession, config: ClaudeSessionConfig): Promise<boolean> {
    const query = live.query;
    if (!query) return false;
    const keepTasks = live.tasks.active().length > 0;
    // The system prompt and the process environment are fixed when the
    // process starts.
    if (config.instructions !== live.config.instructions) {
      if (!keepTasks) return false;
      claudeBackendLog.info("Deferring new Claude instructions until the session relaunches", {
        threadId: live.session.thread.id, taskCount: live.tasks.active().length,
      });
    }
    if (config.additionalDirectories.join("\n") !== live.config.additionalDirectories.join("\n")) {
      if (!keepTasks) return false;
      claudeBackendLog.info("Deferring new Claude directories until the session relaunches", {
        threadId: live.session.thread.id, taskCount: live.tasks.active().length,
      });
    }
    if (config.shellEnvironmentKey !== live.config.shellEnvironmentKey) {
      if (!keepTasks) return false;
      claudeBackendLog.info("Deferring a new Claude environment until the session relaunches", {
        threadId: live.session.thread.id, taskCount: live.tasks.active().length,
      });
    }
    try {
      if (config.model !== live.config.model) {
        await query.setModel(config.model);
        live.config.model = config.model;
      }
      if (config.effort !== live.config.effort) {
        // null returns the session to the model's default effort.
        await query.applyFlagSettings({ effortLevel: config.effort ?? null });
        live.config.effort = config.effort;
      }
      if (config.permissionMode !== live.config.permissionMode) {
        await query.setPermissionMode(config.permissionMode);
        live.config.permissionMode = config.permissionMode;
      }
      if (config.mcpKey !== live.config.mcpKey) {
        await query.setMcpServers(config.mcpServers ?? {});
        live.config.mcpServers = config.mcpServers;
        live.config.mcpKey = config.mcpKey;
      }
      return true;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      claudeBackendLog.warn("Could not apply turn settings to the live Claude session", {
        threadId: live.session.thread.id, keepTasks, error: detail,
      });
      if (!keepTasks) return false;
      throw new Error(`Claude could not apply this message's settings while its background tasks run: ${detail}`, { cause: error });
    }
  }

  /** Show the operator's message and open the desktop turn. */
  private async beginTurn(live: LiveSession, turn: RunningTurn, session: ClaudeSession, input: AppServerTurnInputItem[]): Promise<void> {
    const threadId = session.thread.id;
    const parts = claudeUserMessageParts(input);
    const user: AppServerThreadMessageEntry = {
      type: "message", id: `user:${turn.turnId}`, role: "user",
      text: parts.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n"),
      parts,
      createdAt: Date.now(), turn: { id: turn.turnId, status: "in_progress", startedAt: turn.startedAt },
    };
    const firstPrompt = input.find((item) => item.type === "text" && item.text.trim());
    turn.titlePrompt = firstPrompt?.type === "text" ? firstPrompt.text : undefined;
    if (session.thread.titleSource === "fallback" && firstPrompt?.type === "text") {
      session.thread.title = firstPrompt.text.replace(/\s+/g, " ").trim().slice(0, 80);
      session.thread.titleSource = "derived";
      await this.store.save(session);
      if (live.session !== session) Object.assign(live.session.thread, { title: session.thread.title, titleSource: "derived" });
      await this.emit({ method: "thread/name/updated", params: {
        threadId, threadName: session.thread.title, titleSource: "derived",
      } });
    }
    turn.entries.set(user.id, user);
    await this.store.append(threadId, [user]);
    turn.started = true;
    await this.emit({ method: "turn/started", params: {
      threadId, turn: { id: turn.turnId, status: "in_progress", startedAt: turn.startedAt },
    } });
    await this.emit({ method: "item/completed", params: {
      threadId, turnId: turn.turnId,
      item: { id: user.id, type: "userMessage", text: user.text, content: parts },
    } });
  }

  /** Fail a turn that never reached its query. */
  private async failTurn(threadId: string, turn: RunningTurn, failure: string): Promise<void> {
    this.sessions.get(threadId)?.accountChecked.resolve();
    for (const entry of turn.entries.values()) {
      entry.turn = { id: turn.turnId, status: "failed", startedAt: turn.startedAt };
    }
    try {
      await this.store.append(threadId, [...turn.entries.values()]);
      await this.emit({ method: "turn/failed", params: {
        threadId, turnId: turn.turnId,
        turn: { id: turn.turnId, status: "failed", startedAt: turn.startedAt, error: { message: failure } },
      } });
    } finally {
      turn.ended.resolve();
    }
  }

  private async emit(notification: AgentEvent["notification"]): Promise<void> {
    await this.options.emit({ backend: "claude", notification });
  }

  private async publishModels(models: BackendModelOption[]): Promise<void> {
    if (models.length === 0) return;
    const changed = JSON.stringify(this.models) !== JSON.stringify(models);
    this.models = models;
    if (changed) await this.emit({ method: "backend/providerStatus/updated", params: { backend: "claude" } });
  }

  private refreshModelCatalog(env: NodeJS.ProcessEnv): Promise<void> {
    if (this.modelDiscovery) return this.modelDiscovery;
    const { executable, version } = this.installation;
    if (!executable) return Promise.resolve();
    this.modelDiscovery = (async () => {
      const models = await (this.options.discoverModels ?? discoverClaudeModels)({
        executable, env, ...(version ? { cliVersion: version } : {}),
      });
      this.nextModelRefreshAt = Date.now() + 60_000;
      await this.publishModels(models);
    })().finally(() => { this.modelDiscovery = undefined; });
    return this.modelDiscovery;
  }

  private async refreshGlobalModels(): Promise<void> {
    if (Date.now() < this.nextModelRefreshAt) return;
    // A new turn can recover missing/stale metadata, but never spawns more
    // than one global probe per minute or waits for it to consume the stream.
    this.nextModelRefreshAt = Date.now() + 60_000;
    const env = claudeEnvironment(await this.options.resolveEnv?.() ?? process.env);
    await this.refreshModelCatalog(env);
  }

  private async consume(live: LiveSession): Promise<void> {
    const session = live.session;
    const threadId = session.thread.id;
    let messageId = "";
    let failure: string | undefined;
    const iterator = live.query![Symbol.asyncIterator]();
    try {
      for (;;) {
        const pending = iterator.next();
        // A wake can close the session while this read waits. Closing the
        // query then rejects it, which nothing else observes.
        pending.catch(() => {});
        let step: IteratorResult<SDKMessage, void> | typeof CLAUDE_WAKE;
        while ((step = await Promise.race([pending, live.wake.promise])) === CLAUDE_WAKE) {
          live.wake = claudeWakeSignal();
          // Claude did not answer a Stop in time. End the turn here; the
          // session stays up for its tasks.
          if (live.turn?.abandoned) await this.endTurn(live, live.turn);
          if (!live.turn && this.sessionSettled(live)) break;
        }
        if (step === CLAUDE_WAKE || step.done) break;
        const message = step.value;
        live.messageSeq += 1;
        const topLevel = (message.type === "assistant" || message.type === "stream_event") && !message.parent_tool_use_id;
        // Claude answers a settled task with a native turn of its own. With no
        // desktop turn open, that native turn gets one.
        if (!live.turn && (topLevel || (message.type === "system"
          && (message.subtype === "init" || message.subtype === "local_command_output")))) {
          await this.startFollowUpTurn(live);
        }
        const turn = live.turn;
        if (turn && message.type === "assistant" && !message.parent_tool_use_id && message.error) {
          const detail = message.message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
          turn.resultFailure = detail.trim() || `Claude reported an API error (${message.error}).`;
        }
        if (message.type === "system" && message.subtype === "init") {
          live.lastActivitySeq = live.messageSeq;
          // Never publish this query's project-scoped supportedModels() to
          // the backend-wide picker. Recover through separate global discovery.
          void this.refreshGlobalModels().catch(() => {});
          // Each native turn starts with init, including Claude's follow-up to
          // a settled task. Only the first needs the session's metadata.
          const firstInit = !live.initialized;
          live.initialized = true;
          if (firstInit || session.sdkSessionId !== message.session_id) {
            session.sdkSessionId = message.session_id;
            // The query resumed at a rewind's point; later resumes follow
            // the branch it now writes.
            session.resumeSessionAt = undefined;
            session.forkFromSdkSessionId = undefined;
            const current = await this.store.read(threadId);
            current.sdkSessionId = message.session_id;
            delete current.resumeSessionAt;
            delete current.forkFromSdkSessionId;
            await this.store.save(current);
            // A new turn ends every rewind's undo; drop the files kept for one.
            if (current.rewinds?.some((rewind) => rewind.fileBackup)) {
              void rm(this.store.rewindBackupDirectory(threadId), { recursive: true, force: true }).catch(() => {});
            }
          }
          // The native control request returns Claude's stored/in-flight title
          // while inference continues. Waiting for result leaves long first
          // turns named after the raw prompt for their entire duration.
          if (turn) turn.titleUpdate ??= this.updateTitle(live, turn);
          if (message.terminal_slash_commands) this.terminalCommands = new Set(message.terminal_slash_commands);
          live.capabilities = message.capabilities ?? [];
          if (firstInit) await Promise.all([
            // A probe that finds no windows keeps the last reading, so the
            // account must be confirmed first.
            this.checkAccount(live).finally(() => live.accountChecked.resolve()).then(() => this.refreshUsage(live)),
            this.refreshContext(live),
            claudeTelemetry(() => live.query!.supportedCommands())
              .then((commands) => commands && this.publishCommands(session, commands)),
          ]);
        }
        if (message.type === "system" && message.subtype === "commands_changed") {
          await this.publishCommands(session, message.commands);
        }
        if (message.type === "system" && message.subtype === "session_state_changed") {
          live.sessionState = message.state;
          if (message.state !== "idle") live.lastActivitySeq = live.messageSeq;
        }
        if (topLevel) live.lastActivitySeq = live.messageSeq;
        if (turn && message.type === "stream_event" && !message.parent_tool_use_id) {
          const event = message.event;
          if (event.type === "message_start") messageId = event.message.id;
          if (event.type === "content_block_delta" && event.delta.type === "text_delta" && messageId) {
            const previous = turn.entries.get(messageId);
            const entry: AppServerThreadMessageEntry = {
              type: "message", id: messageId, role: "assistant",
              text: (previous?.type === "message" ? previous.text : "") + event.delta.text,
              turn: { id: turn.turnId, status: "in_progress" },
            };
            turn.entries.set(messageId, entry);
            await this.emit({ method: "item/agentMessage/delta", params: {
              threadId, turnId: turn.turnId, itemId: messageId, delta: event.delta.text,
            } });
          }
        }
        if (message.type === "rate_limit_event") {
          const update = claudeStreamRateLimits(message.rate_limit_info);
          const merged = mergeClaudeStreamRateLimits(this.rateLimits ?? [], update, Date.now());
          // Only an update naming every window is a reading of all of them.
          const reported = new Set(update.map((limit) => limit.limitId));
          if (this.setRateLimits(merged, merged.every((limit) => reported.has(limit.limitId)))) {
            await this.emit({ method: "backend/providerStatus/updated", params: { backend: "claude" } });
          }
        }
        const taskMessage = message.type === "system" && CLAUDE_TASK_SUBTYPES.has(message.subtype);
        if (taskMessage) await this.consumeTaskMessage(message, live);
        // A result means the init's account check ran or never will; a
        // turn's account must not wait past its own end.
        if (message.type === "result") live.accountChecked.resolve();
        if (turn) await this.consumeCompleteMessage(message, live, turn);
        await this.consumeNotice(message, live, turn);
        // The probe is a control round-trip that can wait 1.5s; never hold
        // the stream for it. The result boundary below reads it in order.
        if (turn && message.type === "assistant" && !message.parent_tool_use_id) {
          this.scheduleContextRefresh(live);
        }
        if (message.type === "result") {
          live.lastResultSeq = live.messageSeq;
          if (turn) {
            // A message arriving near a result boundary may become another
            // native turn. Keep the turn open until a result acknowledges
            // every accepted input UUID; the first result alone must not
            // discard input.
            await this.settleInputWrites(live);
            for (const id of message.user_message_uuids ?? []) turn.pendingSteers.delete(id);
            if (message.user_message_uuid) turn.pendingSteers.delete(message.user_message_uuid);
            turn.resultFailure ??= claudeResultFailure(message);
            // The totals are cumulative. A turn stopped after this result must
            // not bill its spend to the next turn.
            if (claudeHasModelUsage(message.modelUsage)) session.modelUsage = message.modelUsage;
            turn.lastResult = message;
            turn.lastResultSeq = live.messageSeq;
            turn.resultSummary = {
              subtype: message.subtype, isError: message.is_error, numTurns: message.num_turns,
              stopReason: message.stop_reason,
              errorCount: message.subtype === "success" ? 0 : message.errors.length,
              resultLength: message.subtype === "success" ? message.result?.length : undefined,
            };
          }
          live.tasks.settleForeground();
        }
        if (taskMessage || message.type === "user" || message.type === "result") await this.publishTasks(live);
        if (live.turn) {
          if (this.turnSettled(live, live.turn)) {
            // Nothing left to keep the process for: end the turn with it.
            if (this.sessionSettled(live, true)) break;
            await this.endTurn(live, live.turn);
          }
        } else if (this.sessionSettled(live)) break;
        this.armFollowUpGrace(live);
      }
      const turn = live.turn;
      if (turn?.started && !live.controller.signal.aborted) failure = await this.turnFailure(live, turn);
    } catch (error) {
      failure ??= claudeExceptionMessage(error, live.stderr);
    } finally {
      await this.finishSession(live, failure);
    }
  }

  /** Claude answers a settled task on its own; the desktop shows that as a turn. */
  private async startFollowUpTurn(live: LiveSession): Promise<void> {
    const turn = claudeTurn(live.session, true);
    live.turn = turn;
    live.lastTurnId = turn.turnId;
    if (live.followUpTimer) clearTimeout(live.followUpTimer);
    live.followUpTimer = undefined;
    await this.emit({ method: "turn/started", params: {
      threadId: live.session.thread.id, turn: { id: turn.turnId, status: "in_progress", startedAt: turn.startedAt },
    } });
  }

  /**
   * A desktop turn can span several native results, one per steer that raced
   * a boundary. It ends at a result that acknowledges every steer, once Claude
   * is idle. A running background task does not hold it open.
   */
  private turnSettled(live: LiveSession, turn: RunningTurn): boolean {
    if (!turn.lastResult) return false;
    // A failed result ends the turn, even before it acknowledges a steer.
    if (turn.resultFailure !== undefined) return true;
    if (turn.pendingSteers.size > 0) return false;
    // The CLI goes idle after its own background-agent loop. A CLI that does
    // not report session state is idle once it reports a result.
    if (live.sessionState !== undefined && live.sessionState !== "idle") return false;
    return live.lastActivitySeq <= turn.lastResultSeq;
  }

  /**
   * The session, and the process with it, ends once no task runs, Claude is
   * idle, and Claude has answered the last task notification.
   */
  private sessionSettled(live: LiveSession, ignoreTurn = false): boolean {
    if (live.turn && !ignoreTurn) return false;
    if (live.tasks.active().length > 0) return false;
    if (live.sessionState !== undefined && live.sessionState !== "idle") return false;
    return live.lastNotificationSeq < live.lastResultSeq || live.followUpWaivedAt === live.messageSeq;
  }

  /** Bound the wait for a follow-up Claude may not run. */
  private armFollowUpGrace(live: LiveSession): void {
    if (live.followUpTimer) clearTimeout(live.followUpTimer);
    live.followUpTimer = undefined;
    if (live.turn || live.tasks.active().length > 0) return;
    if (live.lastNotificationSeq < live.lastResultSeq) return;
    if (live.sessionState !== undefined && live.sessionState !== "idle") return;
    const armedAt = live.messageSeq;
    live.followUpTimer = setTimeout(() => {
      live.followUpTimer = undefined;
      // Any message since arming answers for itself.
      if (live.messageSeq !== armedAt) return;
      live.followUpWaivedAt = armedAt;
      live.wake.wake();
    }, this.options.taskFollowUpGraceMs ?? CLAUDE_TASK_FOLLOW_UP_GRACE_MS);
    live.followUpTimer.unref?.();
  }

  /** Why the turn failed, or undefined; records its usage either way. */
  private async turnFailure(live: LiveSession, turn: RunningTurn): Promise<string | undefined> {
    const result = turn.lastResult;
    // An error result already says why the turn ended; keep its text.
    if (result && (turn.resultFailure !== undefined || turn.pendingSteers.size === 0)) {
      return await this.finishResult(live, turn, result);
    }
    return turn.resultFailure ?? "Claude exited before completing the turn.";
  }

  /** End the desktop turn; the session stays open for the tasks it runs. */
  private async endTurn(live: LiveSession, turn: RunningTurn): Promise<void> {
    let failure: string | undefined;
    try {
      failure = await this.turnFailure(live, turn);
    } catch (error) {
      failure = claudeExceptionMessage(error, live.stderr);
    }
    turn.ending = true;
    await this.settleInputWrites(live);
    await live.contextRefresh?.promise;
    await turn.titleUpdate;
    await this.completeTurn(live, turn, { failure, cancelled: false });
  }

  /** Close the query, and with it the CLI process and every task it runs. */
  private async finishSession(live: LiveSession, failure: string | undefined): Promise<void> {
    const threadId = live.session.thread.id;
    live.closing = true;
    if (live.followUpTimer) clearTimeout(live.followUpTimer);
    // A turn still opening in a live session is failed by its own start.
    const turn = live.turn?.started ? live.turn : undefined;
    if (turn) turn.ending = true;
    live.input.close();
    await this.settleInputWrites(live);
    await live.contextRefresh?.promise;
    // Join metadata reads and title persistence before closing the query or
    // releasing the workspace, including failed and interrupted turns.
    await turn?.titleUpdate;
    try { live.query?.close(); }
    catch (error) { failure ??= claudeExceptionMessage(error, live.stderr); }
    const cancelled = live.controller.signal.aborted;
    await this.closeOrphanedTaskRows(live, cancelled);
    const release = async () => {
      if (this.sessions.get(threadId) === live) this.sessions.delete(threadId);
      if (live.publishedTasks.length > 0) {
        live.publishedTasks = [];
        live.publishedTaskKey = "[]";
        await this.emit({ method: "thread/backgroundTasks/updated", params: { threadId, tasks: [] } });
      }
    };
    try {
      if (turn) {
        await this.completeTurn(live, turn, { failure, cancelled }, release);
      } else {
        try { await this.saveSessionMetadata(live); }
        catch (error) { claudeBackendLog.warn("Could not save Claude session metadata", { threadId, error }); }
        await release();
        if (failure && !cancelled) claudeBackendLog.warn("Claude session failed between turns", { threadId, error: failure, stderr: live.stderr.slice(-320) });
      }
    } finally {
      claudeBackendLog.info("Claude session closed", { threadId, cancelled });
      this.runSessionClosed(live);
    }
  }

  private runSessionClosed(live: LiveSession): void {
    live.closed = true;
    live.accountChecked.resolve();
    for (const release of live.onClosed.splice(0)) {
      try { release(); }
      catch (error) { claudeBackendLog.warn("Could not release a Claude session resource", error); }
    }
  }

  /** A task the query took down with it did not complete. */
  private async closeOrphanedTaskRows(live: LiveSession, cancelled: boolean): Promise<void> {
    const threadId = live.session.thread.id;
    for (const id of new Set([...live.tasks.runningToolUseIds(), ...live.launchedToolUseIds])) {
      const row = live.toolRows.get(id);
      if (!row || row.entry.status !== "in_progress") continue;
      row.entry.status = cancelled ? "cancelled" : "failed";
      // The open turn saves its own rows as it ends.
      if (row.turnId === live.turn?.turnId) continue;
      try {
        await this.store.append(threadId, [row.entry]);
        await this.emit({ method: "item/completed", params: { threadId, turnId: row.turnId, item: claudeActivityItem(row.entry) } });
      } catch (error) {
        claudeBackendLog.warn("Could not close a Claude task row", { threadId, itemId: id, error });
      }
    }
  }

  /** Save the turn, then report its end. `release` runs between the two. */
  private async completeTurn(
    live: LiveSession, turn: RunningTurn, outcome: { failure?: string; cancelled: boolean },
    release?: () => Promise<void>,
  ): Promise<void> {
    const threadId = live.session.thread.id;
    const { turnId } = turn;
    const cancelled = outcome.cancelled || turn.interrupted === true;
    let { failure } = outcome;
    const status = cancelled ? "cancelled" : failure ? "failed" : "completed";
    for (const entry of turn.entries.values()) {
      entry.turn = { id: turnId, status, startedAt: turn.startedAt, completedAt: Date.now() };
    }
    try {
      await this.store.append(threadId, [...turn.entries.values()]);
      await this.saveSessionMetadata(live);
    } catch (error) {
      failure = `Could not save Claude history: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (live.turn === turn) live.turn = undefined;
    // A task row outlives its turn only while its task runs.
    const running = new Set([...live.tasks.runningToolUseIds(), ...live.launchedToolUseIds]);
    for (const id of live.toolRows.keys()) if (!running.has(id)) live.toolRows.delete(id);
    try {
      await release?.();
      const diagnostics = {
        threadId, turnId, status: cancelled ? "cancelled" : failure ? "failed" : "completed",
        receivedResult: Boolean(turn.lastResult), ...turn.resultSummary, pendingSteerCount: turn.pendingSteers.size,
        followUp: turn.followUp === true, runningTaskCount: live.tasks.active().length,
        assistantMessageCount: [...turn.entries.values()].filter((entry) => entry.type === "message" && entry.role === "assistant").length,
      };
      if (failure && !cancelled) claudeBackendLog.warn("Claude turn failed", { ...diagnostics, error: failure, stderr: live.stderr.slice(-320) });
      else claudeBackendLog.info("Claude turn finished", diagnostics);
      if (cancelled) {
        await this.emit({ method: "turn/cancelled", params: { threadId, turnId, turn: {
          id: turnId, status: "cancelled", startedAt: turn.startedAt,
        } } });
      } else if (failure) {
        await this.emit({ method: "turn/failed", params: { threadId, turnId, turn: {
          id: turnId, status: "failed", startedAt: turn.startedAt, error: { message: failure },
        } } });
      } else {
        await this.emit({ method: "turn/completed", params: { threadId, turnId, turn: {
          id: turnId, status: "completed", startedAt: turn.startedAt,
          output: [...turn.entries.values()].flatMap((entry) => entry.type === "message" && entry.role === "assistant" ? [{ type: "text" as const, text: entry.text }] : []),
        } } });
      }
    } finally {
      // Stop waits on this, so it settles even when a report fails.
      turn.ended.resolve();
    }
  }

  /** Re-read metadata so a live rename/mode change cannot be overwritten. */
  private async saveSessionMetadata(live: LiveSession): Promise<void> {
    const { session } = live;
    const current = await this.store.read(session.thread.id);
    current.sdkSessionId = session.sdkSessionId;
    current.modelUsage = session.modelUsage;
    current.contextWindow = session.contextWindow;
    current.thread.updatedAt = Date.now();
    await this.store.save(current);
  }

  /** Record the result that ends the desktop turn; returns why it failed. */
  private async finishResult(live: LiveSession, turn: RunningTurn, message: SDKResultMessage): Promise<string | undefined> {
    const { session } = live;
    const threadId = session.thread.id;
    const turnId = turn.turnId;
    turn.ending = true;
    let failure = turn.resultFailure;
    // A normal send with no visible work must not silently look answered.
    // Local slash commands can legitimately finish without model output, and
    // a follow-up Claude starts itself has no send to answer.
    const hasResponse = turn.hasCompletedToolActivity || [...turn.entries.values()].some((entry) =>
      entry.type !== "message" || (entry.role === "assistant" && entry.text.trim()));
    if (!failure && !turn.followUp && message.subtype === "success" && message.result?.trim() === ""
      && !hasResponse && !turn.titlePrompt?.trimStart().startsWith("/")) {
      failure = "Claude completed without a response or any tool activity. Try sending the message again.";
    }
    // Even a failed turn may already have requested its title at init;
    // join it before taking the final usage snapshot as well.
    if (!turn.titleUpdate && !failure && !live.controller.signal.aborted) {
      turn.titleUpdate = this.updateTitle(live, turn);
    }
    const requestedTitle = await turn.titleUpdate ?? false;
    if (!failure && !live.controller.signal.aborted) {
      // A native request can time out before Claude persists its title.
      // Keep the result-boundary adoption, without another model request.
      await this.updateTitle(live, turn, false);
    }
    await live.contextRefresh?.promise;
    const [, usage] = await Promise.all([this.refreshContext(live), this.refreshUsage(live)]);
    // Native title generation shares this session's account and model
    // totals. Its request can land after the result's usage snapshot.
    const modelUsage = requestedTitle ? usage?.session?.model_usage ?? message.modelUsage : message.modelUsage;
    if (claudeHasModelUsage(modelUsage)) {
      // The totals are cumulative across every turn the session carried.
      const tokenUsage = claudeTurnUsage(modelUsage, turn.usageBaseline);
      session.modelUsage = modelUsage;
      // Without an old session's baseline, cumulative spend cannot be
      // attributed to this turn. Save it for the next turn, do not bill
      // the pre-existing transcript as new work.
      if (!turn.needsUsageBaseline) {
        await this.emit({ method: "thread/tokenUsage/updated", params: { threadId, turnId, model: tokenUsage.model, tokenUsage } });
      }
    }
    return failure;
  }

  /** Track Claude's tasks and settle the tool calls that started them. */
  private async consumeTaskMessage(message: SDKMessage, live: LiveSession): Promise<void> {
    if (message.type !== "system") return;
    const before = live.tasks.active();
    const { settled } = live.tasks.apply(message);
    // Claude answers a task that ends with a native turn. Its terminal
    // task_updated arrives before the notification, and either can be first.
    const active = new Set(live.tasks.active().map((task) => task.taskId));
    if (before.some((task) => !active.has(task.taskId)) || (settled && !settled.task.ambient)) {
      live.lastNotificationSeq = live.messageSeq;
    }
    if (settled) await this.settleTaskToolCall(live, settled);
  }

  private async publishTasks(live: LiveSession): Promise<void> {
    const tasks = this.taskRows(live);
    const key = JSON.stringify(tasks);
    if (key === live.publishedTaskKey) return;
    live.publishedTasks = tasks;
    live.publishedTaskKey = key;
    await this.emit({ method: "thread/backgroundTasks/updated", params: { threadId: live.session.thread.id, tasks } });
  }

  private taskRows(live: LiveSession): AppServerBackgroundTask[] {
    return live.tasks.active().map((task) => {
      const row = task.toolUseId ? live.toolRows.get(task.toolUseId) : undefined;
      const command = row?.entry.details[0]?.command?.rawCommand;
      return claudeTaskRow(task, { cwd: live.session.cwd, ...(command !== undefined ? { command } : {}) });
    });
  }

  /**
   * A background Bash or Agent call answers at once with a placeholder; its
   * tool row stays running until the task's notification settles it, which
   * can be after the turn that made the call has ended.
   */
  private async settleTaskToolCall(live: LiveSession, { task, summary }: ClaudeTaskSettlement): Promise<void> {
    if (task.toolUseId) live.launchedToolUseIds.delete(task.toolUseId);
    const row = task.toolUseId ? live.toolRows.get(task.toolUseId) : undefined;
    if (!row || row.entry.status !== "in_progress") return;
    const { entry } = row;
    const threadId = live.session.thread.id;
    entry.status = task.status === "completed" ? "completed" : task.status === "stopped" ? "cancelled" : "failed";
    const command = entry.details[0].command?.rawCommand;
    const outputId = `${entry.id}:output`;
    const previous = command !== undefined
      ? entry.details[0].command?.output
      : entry.details.find((detail) => detail.id === outputId)?.markdown;
    const output = [previous, summary].filter(Boolean).join("\n\n");
    if (command !== undefined) {
      entry.details = claudeCommandActivity({ id: entry.id, command, status: entry.status, output }).details;
    } else {
      entry.details = [...entry.details.filter((detail) => detail.id !== outputId), {
        id: outputId, kind: entry.details[0].kind, label: `${entry.summary} output`, markdown: output, status: entry.status,
      }];
    }
    if (row.turnId !== live.turn?.turnId) live.toolRows.delete(entry.id);
    await this.store.append(threadId, [entry]);
    await this.emit({ method: "item/completed", params: { threadId, turnId: row.turnId, item: claudeActivityItem(entry, output) } });
  }

  /** Commands and sub-agents Claude is running for the thread. */
  listBackgroundTasks(threadId: string): { supported: true; terminals: AppServerBackgroundTask[] } {
    return { supported: true, terminals: this.sessions.get(threadId)?.publishedTasks ?? [] };
  }

  /** Stops one task. Claude reports the stop through the task's notification. */
  async stopBackgroundTask(threadId: string, taskId: string): Promise<boolean> {
    const live = this.sessions.get(threadId);
    if (!live?.query || !live.tasks.active().some((task) => task.taskId === taskId)) {
      throw new Error("Claude is not running that task.");
    }
    await live.query.stopTask(taskId);
    return true;
  }

  /**
   * Threads whose Claude process is still open. Between turns it runs only
   * background tasks, which the quit prompt and archive guards count as work.
   */
  liveSessionThreadIds(): string[] {
    return [...this.sessions.keys()];
  }

  hasLiveSession(threadId: string): boolean {
    return this.sessions.has(threadId);
  }

  /**
   * Threads with published background tasks. Each change to that set emits
   * `thread/backgroundTasks/updated`, including the clear when the session
   * closes, so navigation can follow it without polling.
   */
  backgroundTaskThreadIds(): string[] {
    return [...this.sessions]
      .filter(([, live]) => live.publishedTasks.length > 0)
      .map(([threadId]) => threadId);
  }

  /** Retrieve Claude's native title without holding up the active turn. */
  private async updateTitle(live: LiveSession, turn: RunningTurn, allowRequest = true): Promise<boolean> {
    const { session } = live;
    const threadId = session.thread.id;
    try {
      let current = await this.store.read(threadId);
      if (current.thread.titleSource === "explicit" || !session.sdkSessionId || live.controller.signal.aborted) return false;
      // getSessionInfo uses the SDK host's config directory, not Options.env.
      // Do not inspect a different account's session store.
      // The SDK may spawn Git in this workspace (with its own timeout).
      // Unlike query telemetry, this read cannot be cancelled by closing the
      // query. Keep it owned by the turn so shutdown cannot release the
      // workspace while an abandoned read still holds its directory open.
      let title: string | undefined;
      if (live.titleEnv?.CLAUDE_CONFIG_DIR === process.env.CLAUDE_CONFIG_DIR) {
        try {
          const read = this.options.getSessionInfo ?? getSessionInfo;
          // A moved thread's session file stays under the folder that wrote
          // it; search every project folder when the current one lacks it.
          const info = await read(session.sdkSessionId, { dir: session.cwd })
            ?? await read(session.sdkSessionId);
          title = normalizeClaudeTitle(info?.customTitle);
        } catch {
          // Missing/unreadable metadata must not disable the query's native
          // title control, which always uses the correct session and account.
        }
      }
      current = await this.store.read(threadId);
      if (current.thread.titleSource === "explicit") return false;
      const query = live.query as ClaudeTitleQuery;
      const disabled = ["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "CLAUDE_CODE_DISABLE_TERMINAL_TITLE"]
        .some((key) => ["1", "true", "yes", "on"].includes(live.titleEnv?.[key]?.trim().toLowerCase() ?? ""));
      const canRequest = allowRequest && !title && !current.titleGenerationAttempted && !disabled && typeof query.generateSessionTitle === "function"
        && Boolean(turn.titlePrompt?.trim()) && !live.controller.signal.aborted;
      if (!title && !canRequest) return false;
      // Persist the attempt before spending quota so failure/restart cannot
      // create a title request on every turn.
      if (!current.titleGenerationAttempted) {
        current.titleGenerationAttempted = true;
        await this.store.save(current);
      }
      if (canRequest) title = await requestClaudeTitle(query, turn.titlePrompt!, live.controller.signal);
      if (title && !live.controller.signal.aborted) {
        current = await this.store.read(threadId);
        if (current.thread.titleSource !== "explicit" && current.thread.title !== title) {
          current.thread.title = title;
          current.thread.titleSource = "derived";
          await this.store.save(current);
          await this.emit({ method: "thread/name/updated", params: { threadId, threadName: title, titleSource: "derived" } });
        }
      }
      return canRequest;
    } catch {
      // Naming must not fail the actual turn. The local prompt name remains usable.
      return false;
    }
  }

  private async refreshUsage(live: LiveSession) {
    const usage = await claudeTelemetry(() => live.query!.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }));
    // The snapshot is complete, so it replaces every window. A probe that
    // timed out or returned nothing keeps the last good reading. Only an
    // account Claude does not meter by subscription clears it.
    const limits = usage?.rate_limits_available && usage.rate_limits ? claudeRateLimits(usage) : [];
    if (limits.length > 0) this.setRateLimits(limits);
    else if (usage && !usage.rate_limits_available && claudeHasNoPlanLimits(this.installation)) {
      this.setRateLimits([]);
    }
    // Emitted after every probe, changed or not: it marks the turn's provider
    // refresh as settled for listeners.
    await this.emit({ method: "backend/providerStatus/updated", params: { backend: "claude" } });
    return usage;
  }

  /**
   * Installation checks are cached for the session, so a sign-in to another
   * account shows up here first. Limits from a different account are cleared.
   */
  private async checkAccount(live: LiveSession): Promise<void> {
    const info = await claudeTelemetry(() => live.query!.accountInfo());
    if (!info) return;
    const account = claudeAccountKey(info);
    const plan = info.subscriptionType?.trim() || undefined;
    await this.loadRateLimits();
    if (account === this.rateLimitAccount) {
      if (plan === this.rateLimitPlan) return;
      this.rateLimitPlan = plan;
      this.saveRateLimits();
      return;
    }
    const previous = this.rateLimitAccount;
    this.rateLimitAccount = account;
    this.rateLimitPlan = plan;
    // A file from before accounts were recorded is adopted, not discarded.
    if (previous !== undefined) this.setRateLimits([]);
    else this.saveRateLimits();
  }

  private async loadRateLimits(): Promise<void> {
    this.rateLimitsLoad ??= this.store.readRateLimits().then(({ limits, account, observedAt, plan }) => {
      // A reading taken since launch is newer than the file.
      if (this.rateLimits !== undefined) return;
      this.rateLimits = liveClaudeRateLimits(limits, Date.now());
      this.rateLimitAccount ??= account;
      this.rateLimitPlan ??= plan;
      this.rateLimitsObservedAt ??= observedAt;
      this.scheduleRateLimitExpiry();
    });
    await this.rateLimitsLoad;
  }

  private available(): boolean {
    return Boolean(this.installation.executable) && this.installation.authStatus !== "sign-in-required";
  }

  /** Remembered limits describe a usable install; hide them while Claude is unavailable. */
  private shownRateLimits(): BackendRateLimitSummary[] | undefined {
    return this.rateLimits && (this.available() ? liveClaudeRateLimits(this.rateLimits, Date.now()) : []);
  }

  /**
   * Returns whether the reading changed; a change is also written for the next
   * launch. `observed` is false for a sparse stream update merged into older
   * windows, which must not date those windows as read now.
   */
  private setRateLimits(limits: BackendRateLimitSummary[], observed = true): boolean {
    // An unchanged reading is still a newer one; only a change is written.
    if (limits.length === 0) this.rateLimitsObservedAt = undefined;
    else if (observed || this.rateLimitsObservedAt === undefined) this.rateLimitsObservedAt = Date.now();
    if (this.rateLimits && JSON.stringify(limits) === JSON.stringify(this.rateLimits)) return false;
    this.rateLimits = limits;
    this.saveRateLimits();
    this.scheduleRateLimitExpiry();
    return true;
  }

  private saveRateLimits(): void {
    const limits = this.rateLimits ?? [];
    const account = this.rateLimitAccount;
    const reading = { observedAt: this.rateLimitsObservedAt, plan: this.rateLimitPlan };
    this.rateLimitWrites = this.rateLimitWrites
      .then(() => this.store.saveRateLimits(limits, account, reading))
      .catch((error: unknown) => {
        claudeBackendLog.warn("Could not save Claude usage limits", error);
      });
  }

  /**
   * The account Claude's limits describe, as an opaque hash. Turns record it,
   * so a reading only ever joins the history of the account that ran them.
   * A new session reports its turn before Claude names the signed-in
   * account, so a thread's session is given a bounded wait for that check:
   * a sign-in to another account must not lend its first turn to the last.
   */
  async usageAccountKey(threadId?: string): Promise<string | undefined> {
    const live = threadId ? this.sessions.get(threadId) : undefined;
    if (live && !live.closed) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([live.accountChecked.promise, new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ACCOUNT_CHECK_WAIT_MS);
        timer.unref?.();
      })]);
      if (timer) clearTimeout(timer);
    }
    await this.loadRateLimits().catch(() => undefined);
    return this.rateLimitAccount;
  }

  /** The limits summary() shows, as a Usage Activity reading. */
  limitObservation(): UsageLimitObservation | undefined {
    const observedAt = this.rateLimitsObservedAt;
    const limits = this.shownRateLimits() ?? [];
    if (observedAt === undefined || limits.length === 0) return undefined;
    return {
      observedAt,
      provider: "anthropic",
      accountKey: this.rateLimitAccount,
      planType: this.rateLimitPlan,
      limits: limits.map((limit) => ({
        name: limit.name, limitId: limit.limitId, usedPercent: limit.usedPercent,
        resetAt: limit.resetAt, windowMinutes: limit.windowMinutes,
        ...(limit.expires ? { expires: true } : {}),
      })),
    };
  }

  /**
   * summary() hides a window once it resets. Tell listeners when that
   * happens, so a surface that refreshes only on events drops the row.
   */
  private scheduleRateLimitExpiry(): void {
    if (this.rateLimitExpiry) clearTimeout(this.rateLimitExpiry);
    this.rateLimitExpiry = undefined;
    const next = nextClaudeRateLimitReset(this.rateLimits ?? [], Date.now());
    if (next === undefined) return;
    this.rateLimitExpiry = setTimeout(() => {
      this.rateLimitExpiry = undefined;
      this.scheduleRateLimitExpiry();
      if (next > Date.now()) return;
      this.emit({ method: "backend/providerStatus/updated", params: { backend: "claude" } }).catch((error: unknown) => {
        claudeBackendLog.warn("Could not report an expired Claude usage limit", error);
      });
    }, Math.min(next - Date.now() + 1, MAX_TIMER_DELAY_MS));
    this.rateLimitExpiry.unref?.();
  }

  private scheduleContextRefresh(live: LiveSession): void {
    if (live.contextRefresh) {
      live.contextRefresh.again = true;
      return;
    }
    const refresh = { again: false, promise: Promise.resolve() };
    refresh.promise = (async () => {
      try {
        do {
          refresh.again = false;
          await this.refreshContext(live);
        } while (refresh.again && !live.closing);
      } catch {
        // A meter update must never fail the turn.
      } finally {
        live.contextRefresh = undefined;
      }
    })();
    live.contextRefresh = refresh;
  }

  private async refreshContext(live: LiveSession): Promise<void> {
    const { session } = live;
    const context = await claudeTelemetry(() => live.query!.getContextUsage({ detail: "summary" }));
    if (!context || !Number.isFinite(context.totalTokens) || !(context.totalTokens >= 0)
      || !Number.isFinite(context.maxTokens) || !(context.maxTokens > 0)) return;
    session.contextWindow = { usedTokens: context.totalTokens, modelContextWindow: context.maxTokens };
    live.contextWindow = session.contextWindow;
    await this.emit({ method: "thread/contextWindow/updated", params: {
      threadId: session.thread.id, turnId: live.turn?.turnId ?? live.lastTurnId, ...session.contextWindow,
    } });
  }

  private async publishCommands(session: ClaudeSession, commands: readonly SlashCommand[]): Promise<void> {
    const summaries = claudeCommandSummaries(commands, this.terminalCommands);
    if (summaries.length === 0) return;
    this.commandsByCwd.set(session.cwd, summaries);
    await this.emit({ method: "thread/availableCommands/updated", params: { threadId: session.thread.id, commands: summaries } });
  }

  /**
   * Slash commands for a thread or a launchpad folder. A folder Claude has not
   * reported for yet is asked once, through a session that receives no prompt.
   * A failed probe waits a minute before the next try, so a `/` typed while the
   * CLI is broken cannot spawn a process per keystroke.
   */
  async listCommands(params: { threadId?: string; cwd?: string }): Promise<AppServerAvailableCommandSummary[]> {
    const cwd = (params.threadId ? await this.store.read(params.threadId).then((session) => session.cwd, () => undefined) : undefined)
      ?? params.cwd;
    if (!cwd) return [];
    const known = this.commandsByCwd.get(cwd);
    if (known) return known;
    const inFlight = this.commandProbes.get(cwd);
    if (inFlight) return await inFlight;
    if (Date.now() < (this.commandProbeRetryAt.get(cwd) ?? 0)) return [];
    const probe = (async () => {
      try {
        const executable = await this.requireInstallation();
        const env = claudeEnvironment(await this.options.resolveEnv?.() ?? process.env);
        const commands = await (this.options.readCommands ?? ((probeParams) => readClaudeMetadata({
          ...probeParams,
          read: (session) => session.supportedCommands(),
          timeoutMessage: "Claude command discovery timed out.",
        })))({ executable, env, cwd });
        const summaries = claudeCommandSummaries(commands, this.terminalCommands);
        // A live turn may have reported while the probe ran; it is fresher.
        if (summaries.length > 0 && !this.commandsByCwd.has(cwd)) this.commandsByCwd.set(cwd, summaries);
        if (summaries.length === 0) this.commandProbeRetryAt.set(cwd, Date.now() + 60_000);
        return this.commandsByCwd.get(cwd) ?? summaries;
      } catch {
        this.commandProbeRetryAt.set(cwd, Date.now() + 60_000);
        return [];
      } finally {
        this.commandProbes.delete(cwd);
      }
    })();
    this.commandProbes.set(cwd, probe);
    return await probe;
  }

  /**
   * The thread's MCP servers. A running turn answers from its own session,
   * which also holds the PwrAgent servers the turn added. An idle thread has
   * no session, so Claude Code is asked once for its own config's servers.
   */
  async listMcpServers(threadId: string): Promise<CodexMcpServerSummary[]> {
    const query = this.sessions.get(threadId)?.query;
    let servers: McpServerStatus[];
    if (query) {
      servers = await query.mcpServerStatus();
    } else {
      // Share a probe already in flight, so reopening the panel does not
      // start another Claude Code process and another set of MCP servers.
      let probe = this.mcpServerProbes.get(threadId);
      if (!probe) {
        probe = (async () => {
          try {
            const { cwd } = await this.store.read(threadId);
            const executable = await this.requireInstallation();
            const env = claudeEnvironment(await this.options.resolveEnv?.() ?? process.env);
            return await (this.options.readMcpServers ?? readClaudeMcpServerStatus)({ executable, env, cwd });
          } finally {
            this.mcpServerProbes.delete(threadId);
          }
        })();
        this.mcpServerProbes.set(threadId, probe);
      }
      servers = await probe;
    }
    return servers.map((server) => ({
      name: server.name,
      authStatus: server.status === "needs-auth" ? "notLoggedIn" as const : "unsupported" as const,
      startupStatus: server.status === "connected" ? "ready" as const : server.status === "pending" ? "starting" as const : "failed" as const,
      startupError: server.error,
      tools: server.tools?.map((tool) => tool.name) ?? [],
    }));
  }

  private async consumeCompleteMessage(message: SDKMessage, live: LiveSession, turn: RunningTurn): Promise<void> {
    const threadId = live.session.thread.id;
    const turnId = turn.turnId;
    if (message.type === "system" && message.subtype === "local_command_output") {
      const entry: AppServerThreadMessageEntry = {
        type: "message", id: message.uuid, role: "assistant", text: message.content, turn: { id: turnId },
      };
      turn.entries.set(entry.id, entry);
      await this.store.append(threadId, [entry]);
      await this.emit({ method: "item/completed", params: {
        threadId, turnId, item: { id: entry.id, type: "agentMessage", text: entry.text },
      } });
    }
    if (message.type === "assistant" && !message.parent_tool_use_id) {
      const text = message.message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
      if (text) {
        // A later text block of the same message must extend, not replace,
        // the text an earlier block completed.
        // Streamed deltas already include the current block. Only completed
        // blocks may contribute to the prefix when its final frame arrives.
        const completed = turn.completedMessageText.get(message.message.id);
        const prior = completed ? `${completed}\n` : "";
        turn.completedMessageText.set(message.message.id, prior + text);
        const entry: AppServerThreadMessageEntry = { type: "message", id: message.message.id, role: "assistant", text: prior + text, turn: { id: turnId } };
        turn.entries.set(entry.id, entry);
        await this.store.append(threadId, [entry]);
        await this.emit({ method: "item/completed", params: { threadId, turnId, item: { id: entry.id, type: "agentMessage", text: entry.text } } });
      }
      for (const block of message.message.content) {
        if (block.type !== "tool_use") continue;
        const report = block.name === CLAUDE_REPORT_FINDINGS_TOOL ? parseClaudeFindingsReport(block.input) : undefined;
        if (report) {
          // The CLI validates the call before it runs it, and the model retries
          // a rejected one. The card waits for the result, so a retry is not a
          // second review.
          turn.pendingReports.set(block.id, { report, model: message.message.model, input: block.input });
          continue;
        }
        // The checklist is the turn's plan, which the transcript and the
        // live work rail show as one card. An emptied list keeps a tool row.
        const steps = block.name === CLAUDE_TODO_TOOL ? claudeTodoSteps(block.input) : undefined;
        if (steps?.length) {
          await this.publishPlan(live, turn, steps);
          continue;
        }
        // A plan turn's proposal is a plan card, like Codex's, not a tool row.
        const proposal = block.name === CLAUDE_EXIT_PLAN_TOOL ? (block.input as { plan?: unknown }).plan : undefined;
        if (typeof proposal === "string" && proposal.trim()) {
          await this.publishProposedPlan(live, turn, block.id, proposal.trim());
          continue;
        }
        const input = block.input as Record<string, unknown>;
        const command = block.name === "Bash" && typeof input.command === "string" ? input.command : undefined;
        const detail = command === undefined
          ? claudeToolDetail({ id: block.id, name: block.name, input, status: "in_progress" }) : undefined;
        const activity: AppServerThreadActivityEntry = {
          ...(command !== undefined
            ? claudeCommandActivity({ id: block.id, command, status: "in_progress" })
            : detail
              ? { type: "activity" as const, id: block.id, summary: detail.label, status: "in_progress" as const, details: [detail] }
              : {
                type: "activity" as const, id: block.id, summary: block.name, status: "in_progress" as const,
                details: [{ id: block.id, kind: "read" as const, label: block.name, markdown: JSON.stringify(input) }],
              }),
          createdAt: Date.now(), turn: { id: turnId },
        };
        turn.entries.set(block.id, activity);
        // A task this call starts can outlive the turn.
        live.toolRows.set(block.id, { entry: activity, turnId });
        await this.store.append(threadId, [activity]);
        const item = {
          id: block.id, status: "in_progress",
          ...(command !== undefined ? { type: "commandExecution", command }
            : { type: "dynamicToolCall", toolName: block.name, arguments: input }),
        };
        await this.emit({ method: "item/started", params: { threadId, turnId, item } });
      }
    }
    if (message.type === "user" && Array.isArray(message.message.content)) {
      for (const block of message.message.content) {
        if (block.type !== "tool_result") continue;
        const pendingReport = turn.pendingReports.get(block.tool_use_id);
        if (pendingReport) {
          turn.pendingReports.delete(block.tool_use_id);
          if (!block.is_error) {
            await this.reportFindings({
              threadId, turnId, turn, toolUseId: block.tool_use_id,
              report: pendingReport.report, model: pendingReport.model,
            });
            turn.hasCompletedToolActivity = true;
            continue;
          }
          // A rejected report stays visible as the failed tool call it was.
          turn.entries.set(block.tool_use_id, {
            type: "activity", id: block.tool_use_id, summary: CLAUDE_REPORT_FINDINGS_TOOL, status: "in_progress",
            details: [{
              id: block.tool_use_id, kind: "read", label: CLAUDE_REPORT_FINDINGS_TOOL,
              markdown: JSON.stringify(pendingReport.input),
            }],
            createdAt: Date.now(), turn: { id: turnId },
          });
        }
        const entry = turn.entries.get(block.tool_use_id);
        if (entry?.type !== "activity") continue;
        // A background launch answers with a placeholder. The task's
        // notification completes the row.
        const launchedTask = !block.is_error
          && (live.tasks.isBackgroundToolUse(block.tool_use_id) || claudeBackgroundLaunch(message.tool_use_result));
        if (launchedTask) live.launchedToolUseIds.add(block.tool_use_id);
        else live.tasks.settleForeground(block.tool_use_id);
        entry.status = block.is_error ? "failed" : launchedTask ? "in_progress" : "completed";
        const output = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
        const command = entry.details[0].command?.rawCommand;
        // A successful edit shows its diff instead of the tool's acknowledgement.
        const edit = entry.details[0].kind === "write" && !block.is_error
          ? claudeFileDiff(message.tool_use_result, live.session.cwd) : undefined;
        if (command !== undefined) {
          entry.details = claudeCommandActivity({ id: entry.id, command, status: entry.status, output }).details;
        } else if (edit) {
          entry.details = [{ ...entry.details[0], status: entry.status, fileDiff: edit.fileDiff }];
          if (edit.diff) {
            turn.fileDiffs.push(edit.diff);
            await this.emit({ method: "turn/diff/updated", params: { threadId, turnId, diff: claudeTurnDiff(turn.fileDiffs) } });
          }
        } else {
          // Keep the invocation when updating generic tools, too.
          const outputId = `${entry.id}:output`;
          entry.details = [...entry.details.filter((detail) => detail.id !== outputId), {
            id: outputId, kind: entry.details[0].kind, label: `${entry.summary} output`, markdown: output, status: entry.status,
          }];
        }
        await this.store.append(threadId, [entry]);
        turn.hasCompletedToolActivity = true;
        if (launchedTask) continue;
        const item = {
          id: entry.id, status: entry.status,
          ...(command !== undefined ? { type: "commandExecution", command, aggregatedOutput: output }
            : { type: "dynamicToolCall", toolName: entry.summary,
              contentItems: [{ type: "inputText", text: output }] }),
        };
        await this.emit({ method: "item/completed", params: { threadId, turnId, item } });
      }
    }
  }

  /** Each TodoWrite call replaces the turn's plan. */
  private async publishPlan(live: LiveSession, turn: RunningTurn, steps: AppServerThreadPlanStep[]): Promise<void> {
    const threadId = live.session.thread.id;
    const id = `plan:${turn.turnId}`;
    const previous = turn.entries.get(id);
    const entry: AppServerThreadPlanEntry = {
      type: "plan", id, createdAt: previous?.createdAt ?? Date.now(), steps, turn: { id: turn.turnId },
    };
    turn.entries.set(id, entry);
    await this.store.append(threadId, [entry]);
    await this.emit({ method: "turn/plan/updated", params: { threadId, turnId: turn.turnId, plan: { steps } } });
  }

  /** The plan a plan-mode turn proposes, shown for the operator to accept by replying. */
  private async publishProposedPlan(live: LiveSession, turn: RunningTurn, id: string, markdown: string): Promise<void> {
    const threadId = live.session.thread.id;
    const entry: AppServerThreadPlanEntry = {
      type: "plan", id, createdAt: Date.now(), markdown, steps: [], turn: { id: turn.turnId },
    };
    turn.entries.set(id, entry);
    await this.store.append(threadId, [entry]);
    await this.emit({ method: "item/completed", params: {
      threadId, turnId: turn.turnId, item: { id, type: "plan", text: markdown },
    } });
  }

  /**
   * Claude's own notices: compaction, retries, refusals, and denials. Each
   * shows in the transcript without a toast; compaction and a refusal also
   * stay in the thread's history.
   */
  private async consumeNotice(message: SDKMessage, live: LiveSession, turn: RunningTurn | undefined): Promise<void> {
    if (message.type !== "system") return;
    const threadId = live.session.thread.id;
    const warn = async (text: string) => {
      await this.emit({ method: "warning", params: { threadId, message: text, presentation: "activity-only" } });
    };
    const record = async (summary: string, label: string, tone?: "warning") => {
      if (!turn) return;
      const id = `notice:${message.uuid}`;
      const entry: AppServerThreadActivityEntry = {
        type: "activity", id, summary, status: "completed", ...(tone ? { tone } : {}),
        details: [{ id: `${id}:detail`, kind: "read", label, status: "completed" }],
        createdAt: Date.now(), turn: { id: turn.turnId },
      };
      turn.entries.set(id, entry);
      await this.store.append(threadId, [entry]);
    };
    switch (message.subtype) {
      case "compact_boundary": {
        const { trigger, pre_tokens: before, post_tokens: after } = message.compact_metadata;
        const tokens = after !== undefined
          ? `${before.toLocaleString()} → ${after.toLocaleString()} tokens`
          : `${before.toLocaleString()} tokens summarized`;
        await record("Compacted context", trigger === "auto" ? `${tokens}, automatically` : tokens);
        await this.emit({ method: "thread/compacted", params: { threadId, itemId: message.uuid } });
        return;
      }
      case "status":
        if (message.status === "compacting") await warn("Claude is compacting the conversation.");
        return;
      case "api_retry": {
        const status = message.error_status ? ` (HTTP ${message.error_status})` : "";
        const delay = Math.max(1, Math.round(message.retry_delay_ms / 1000));
        await warn(`A Claude API request failed${status}. Retrying in ${delay}s, attempt ${message.attempt} of ${message.max_retries}.`);
        return;
      }
      case "permission_denied":
        // decision_reason is written for people; message is the model's tool result.
        await warn(`Claude could not use ${message.tool_name}: ${message.decision_reason?.trim() || message.message}`);
        return;
      case "model_refusal_fallback": {
        const text = message.content.trim()
          || `${message.original_model} declined the request; Claude used ${message.fallback_model} instead.`;
        await record(`Switched to ${message.fallback_model}`, text, "warning");
        await warn(text);
        return;
      }
      case "model_refusal_no_fallback": {
        const text = message.content.trim() || `${message.original_model} declined the request.`;
        await record("Model declined the request", text, "warning");
        await warn(text);
        return;
      }
      case "notification":
        if (message.priority !== "low" && message.text.trim()) await warn(message.text.trim());
        return;
      default:
        return;
    }
  }

  /**
   * A findings report is the review card, not a tool row. Its tool result is
   * a count, which nothing renders. A re-report after fixes updates the
   * review it repeats; one that repeats no earlier review is a new review.
   */
  private async reportFindings(params: {
    threadId: string; turnId: string; turn: RunningTurn; toolUseId: string;
    report: ClaudeFindingsReport; model?: string;
  }): Promise<void> {
    const { threadId, turnId, turn, report } = params;
    const session = await this.store.read(threadId);
    if (isClaudeOutcomeReport(report)) {
      const entries = [...(await this.store.entries(threadId)), ...turn.entries.values()];
      const previous = entries.findLast((entry): entry is AppServerThreadReviewEntry =>
        entry.type === "review" && entry.reviewer?.backend === "claude" && entry.output !== undefined
        && entry.id !== params.toolUseId);
      // A re-report in the review's own turn repeats it; a later one must
      // also name one of its findings' locations.
      const outcomes = previous ? matchClaudeFindingOutcomes(reviewEntryFindings(previous), report, session.cwd, {
        trustPosition: previous.turn?.id === turnId,
      }) : [];
      if (previous && outcomes.length > 0) {
        await this.emit({ method: "thread/review/outcomesReported", params: {
          threadId, turnId, reviewId: previous.id, outcomes,
        } });
        return;
      }
    }
    const output = claudeReviewOutput(report, session.cwd);
    let context: AppServerReviewContext | undefined;
    try {
      // Claude's report names no pull request, so the prompt says which it covered.
      const pullRequests = parseClaudeCodeReviewPullRequests(turn.titlePrompt);
      context = await this.options.resolveReviewContext?.({
        threadId, cwd: session.cwd, ...(pullRequests.length > 0 ? { pullRequests } : {}),
      });
    } catch (error) {
      claudeBackendLog.warn("could not resolve review context", { error: error instanceof Error ? error.message : String(error) });
    }
    const model = params.model ?? session.thread.model;
    const reviewer: NonNullable<AppServerThreadReviewEntry["reviewer"]> = {
      backend: "claude",
      ...(model ? { model } : {}),
      // The review's own effort level, which can differ from the thread's.
      ...(report.level ? { reasoningEffort: report.level } : {}),
    };
    const entry: AppServerThreadReviewEntry = {
      type: "review", id: params.toolUseId, createdAt: Date.now(),
      review: formatReviewOutputText(output), output, reviewer,
      ...(context ? { context } : {}),
      turn: { id: turnId },
    };
    turn.entries.set(entry.id, entry);
    await this.store.append(threadId, [entry]);
    await this.emit({ method: "item/completed", params: { threadId, turnId, item: {
      id: entry.id, type: "exitedReviewMode", review: entry.review, createdAt: entry.createdAt,
      data: { reviewOutput: output, reviewer, ...(context ? { context } : {}) },
    } } });
    // A first report that already says what was fixed records both at once.
    if (isClaudeOutcomeReport(report)) {
      await this.emit({ method: "thread/review/outcomesReported", params: {
        threadId, turnId, reviewId: entry.id,
        outcomes: report.findings.flatMap((finding, index) => finding.outcome ? [{ index, outcome: finding.outcome }] : []),
      } });
    }
  }

  /** `keepTasks: false` ends the query even when tasks run, as quitting does. */
  /**
   * What rewinding to before a prompt would restore, without changing
   * anything. The file dry run needs a query: Claude's checkpoints belong to
   * its session, not to this process.
   */
  async previewRewind(threadId: string, target: ThreadRewindTarget): Promise<
    Pick<PreviewThreadRewindResponse, "files" | "filesUnavailableReason" | "unavailableReason">
  > {
    let session: ClaudeSession;
    let point: ClaudeRewindPoint;
    try {
      this.assertRewindable(threadId);
      session = await this.store.read(threadId);
      point = await this.rewindPoint(session, target);
    } catch (error) {
      return { unavailableReason: error instanceof Error ? error.message : String(error) };
    }
    try {
      // An idle session kept for a task's follow-up already runs Claude.
      const live = this.sessions.get(threadId);
      const dryRun = (control: Query) => claudeWithin(
        control.rewindFiles(point.promptUuid, { dryRun: true }),
        this.options.rewindPreviewTimeoutMs ?? CLAUDE_REWIND_PREVIEW_TIMEOUT_MS,
        "Claude did not answer which files it can restore.",
      );
      const result = live?.query && !live.closing
        ? await dryRun(live.query)
        : await this.withRewindQuery(session, dryRun);
      if (!result.canRewind) return { filesUnavailableReason: claudeFilesUnavailableReason(result.error) };
      return { files: { paths: result.filesChanged ?? [], insertions: result.insertions ?? 0, deletions: result.deletions ?? 0 } };
    } catch (error) {
      claudeBackendLog.warn("Could not preview a Claude file rewind", { threadId, error });
      return { filesUnavailableReason: claudeFilesUnavailableReason(error instanceof Error ? error.message : undefined) };
    }
  }

  /**
   * Rewind the thread to before a prompt: that prompt's turn and every later
   * one leave the conversation, and with files, Claude restores what its
   * edit tools changed since. Claude keeps the removed turns in its session
   * file as another branch; the record names where it ends, so the rewind
   * can be undone until the next turn starts.
   */
  async rewindThread(params: {
    threadId: string; target: ThreadRewindTarget; mode: ThreadRewindMode; rewindId?: string;
  }): Promise<{
    promptText?: string; restoredFileCount?: number; undoable: boolean; updatedAt: number;
  }> {
    const { threadId, target, rewindId } = params;
    this.assertRewindable(threadId);
    this.rewinding.add(threadId);
    try {
      const session = await this.store.read(threadId);
      const point = await this.rewindPoint(session, target);
      // An idle session stays up a moment for a task's follow-up. Close it,
      // once the rewind is known to go ahead, so the next turn resumes at
      // the rewind point.
      const live = this.sessions.get(threadId);
      if (live) await this.closeSession(live);
      const promptEntry = (await this.store.entries(threadId)).find((entry) => entry.id === target.messageId);
      let restoredFiles: string[] | undefined;
      let fileBackup = false;
      if (params.mode === "conversation-and-files") {
        // Files first: a refusal leaves the conversation as it was.
        const backup = rewindId ? this.store.rewindBackupDirectory(threadId, rewindId) : undefined;
        let result: Awaited<ReturnType<Query["rewindFiles"]>>;
        try {
          result = await this.withRewindQuery(session, async (control) => {
            // Keep what the rewind is about to overwrite, so it can be undone.
            if (backup) {
              const dryRun = await control.rewindFiles(point.promptUuid, { dryRun: true });
              fileBackup = dryRun.canRewind
                && await backUpRewindFiles(backup, (dryRun.filesChanged ?? []).map((file) => path.resolve(session.cwd, file)));
            }
            return await control.rewindFiles(point.promptUuid);
          });
          if (!result.canRewind) throw new Error(claudeFilesUnavailableReason(result.error));
        } catch (error) {
          if (backup) await rm(backup, { recursive: true, force: true });
          throw error;
        }
        restoredFiles = result.filesChanged ?? [];
        if (backup && fileBackup) {
          fileBackup = await recordRewoundFiles(backup, restoredFiles.map((file) => path.resolve(session.cwd, file)))
            .catch(() => false);
          if (!fileBackup) await rm(backup, { recursive: true, force: true });
        }
      }
      const current = await this.store.read(threadId);
      const fromSdkSessionId = current.sdkSessionId!;
      const before = {
        ...(current.resumeSessionAt ? { resumeSessionAt: current.resumeSessionAt } : {}),
        ...(current.modelUsage ? { modelUsage: current.modelUsage } : {}),
        ...(current.contextWindow ? { contextWindow: current.contextWindow } : {}),
      };
      const undoable = Boolean(rewindId) && (params.mode === "conversation" || fileBackup);
      if (point.keptUuid) {
        current.resumeSessionAt = point.keptUuid;
      } else {
        // Nothing before the first prompt to resume at: the next turn starts
        // a new session, and the old one keeps the removed turns.
        delete current.sdkSessionId;
        delete current.resumeSessionAt;
      }
      // Totals and occupancy describe the removed turns.
      delete current.modelUsage;
      delete current.contextWindow;
      current.thread.updatedAt = Date.now();
      const truncationId = await this.store.truncate(threadId, target.messageId);
      current.rewinds = [...current.rewinds ?? [], {
        ...(rewindId ? { id: rewindId } : {}),
        at: current.thread.updatedAt, beforeTurnId: target.turnId ?? point.promptUuid, sdkSessionId: fromSdkSessionId,
        ...(point.leafUuid ? { removedLeafUuid: point.leafUuid } : {}),
        ...(restoredFiles ? { restoredFiles } : {}),
        ...(undoable ? {
          truncationId,
          after: {
            ...(current.sdkSessionId ? { sdkSessionId: current.sdkSessionId } : {}),
            ...(current.resumeSessionAt ? { resumeSessionAt: current.resumeSessionAt } : {}),
          },
          before,
          ...(fileBackup ? { fileBackup: true } : {}),
        } : {}),
      }];
      await this.store.save(current);
      return {
        ...(promptEntry?.type === "message" ? { promptText: promptEntry.text } : {}),
        ...(restoredFiles ? { restoredFileCount: restoredFiles.length } : {}),
        undoable,
        updatedAt: current.thread.updatedAt,
      };
    } finally {
      this.rewinding.delete(threadId);
    }
  }

  /**
   * Undo the thread's latest rewind: the conversation resumes on the branch
   * Claude kept, the removed entries return, and the restored files go back
   * to what they were. Claude continues the kept branch only until a new
   * turn starts on the rewound one.
   */
  async undoRewind(params: { threadId: string; rewindId: string }): Promise<{ updatedAt: number }> {
    const { threadId, rewindId } = params;
    this.assertRewindable(threadId);
    this.rewinding.add(threadId);
    try {
      const session = await this.store.read(threadId);
      const record = session.rewinds?.filter((rewind) => rewind.undoneAt === undefined).at(-1);
      const unavailable = "This rewind can no longer be undone.";
      if (!record || record.id !== rewindId || !record.after || !record.truncationId) {
        throw new Error(unavailable);
      }
      if (
        session.sdkSessionId !== record.after.sdkSessionId
        || session.resumeSessionAt !== record.after.resumeSessionAt
        || !await this.store.canUndoTruncation(threadId, record.truncationId)
      ) {
        throw new Error(`${unavailable} Claude has continued the conversation since.`);
      }
      const live = this.sessions.get(threadId);
      if (live) await this.closeSession(live);
      const backup = this.store.rewindBackupDirectory(threadId, rewindId);
      if (record.fileBackup) await restoreRewindFiles(backup);
      await this.store.undoTruncation(threadId, record.truncationId);
      const current = await this.store.read(threadId);
      current.sdkSessionId = record.sdkSessionId;
      // Resume at the removed branch's end, the conversation as it was.
      if (record.removedLeafUuid) current.resumeSessionAt = record.removedLeafUuid;
      else delete current.resumeSessionAt;
      if (record.before?.modelUsage) current.modelUsage = record.before.modelUsage;
      if (record.before?.contextWindow) current.contextWindow = record.before.contextWindow;
      current.thread.updatedAt = Date.now();
      current.rewinds = current.rewinds?.map((rewind) =>
        rewind.id === rewindId ? { ...rewind, undoneAt: current.thread.updatedAt } : rewind);
      await this.store.save(current);
      await rm(backup, { recursive: true, force: true });
      return { updatedAt: current.thread.updatedAt };
    } finally {
      this.rewinding.delete(threadId);
    }
  }

  private assertRewindable(threadId: string): void {
    if (this.rewinding.has(threadId)) throw new Error("Claude is already rewinding this thread.");
    const live = this.sessions.get(threadId);
    if (live?.turn || (!live && this.starting.has(threadId))) {
      throw new Error("Wait for the active Claude turn to finish before rewinding.");
    }
    if (live && live.tasks.active().length > 0) throw new Error("Stop Claude's background tasks before rewinding.");
  }

  /**
   * Where Claude's conversation holds the prompt. A prompt's SDK UUID is its
   * turn id (`user:<turnId>`); a prompt sent before PwrAgent supplied one, or
   * one Claude compacted away, is not in the conversation it would resume.
   */
  private async rewindPoint(session: ClaudeSession, target: ThreadRewindTarget): Promise<ClaudeRewindPoint> {
    if (!session.sdkSessionId) throw new Error("Claude has no conversation to rewind yet.");
    const promptUuid = target.messageId.startsWith("user:") ? target.messageId.slice("user:".length) : undefined;
    const read = this.options.getSessionMessages ?? getSessionMessages;
    // A moved thread's session file stays under the folder that wrote it;
    // search every project folder when the current one lacks it.
    const local = await read(session.sdkSessionId, { dir: session.cwd });
    const messages = (local.length > 0 ? local : await read(session.sdkSessionId))
      .filter((message) => message.parent_tool_use_id === null);
    const index = promptUuid ? messages.findIndex((message) => message.uuid === promptUuid && message.type === "user") : -1;
    // A pending rewind already dropped the entries after its point.
    const resumeIndex = session.resumeSessionAt
      ? messages.findIndex((message) => message.uuid === session.resumeSessionAt)
      : messages.length;
    if (!promptUuid || index < 0 || (resumeIndex >= 0 && index > resumeIndex)) {
      throw new Error("Claude's conversation does not have this prompt, so it cannot rewind to before it. "
        + "Prompts sent before rewind support, or before Claude compacted the conversation, cannot be rewound.");
    }
    return {
      promptUuid,
      keptUuid: messages[index - 1]?.uuid,
      // A pending rewind already ends the conversation at its point.
      leafUuid: session.resumeSessionAt ?? messages.at(-1)?.uuid,
    };
  }

  /**
   * Run control requests against the thread's Claude session. No prompt is
   * sent, so the query writes nothing to the conversation.
   */
  private async withRewindQuery<T>(session: ClaudeSession, run: (control: Query) => Promise<T>): Promise<T> {
    if (!session.sdkSessionId) throw new Error("Claude has no conversation to rewind yet.");
    const threadId = session.thread.id;
    // One control query per thread at a time, and a turn waits for it.
    for (let running = this.rewindQueries.get(threadId); running; running = this.rewindQueries.get(threadId)) {
      await running;
    }
    const closed = claudeDeferred();
    this.rewindQueries.set(threadId, closed.promise);
    try {
      // A turn that started before this query claimed the thread has its own
      // process on the session.
      if (this.sessions.has(threadId) || this.starting.has(threadId)) {
        throw new Error("Wait for the active Claude turn to finish before rewinding.");
      }
      return await this.runRewindQuery(session, run);
    } finally {
      if (this.rewindQueries.get(threadId) === closed.promise) this.rewindQueries.delete(threadId);
      closed.resolve();
    }
  }

  private async runRewindQuery<T>(session: ClaudeSession, run: (control: Query) => Promise<T>): Promise<T> {
    const executable = await this.requireInstallation();
    const env = claudeEnvironment(await this.options.resolveEnv?.() ?? process.env);
    const input = new ClaudeInputStream();
    const control = (this.options.query ?? query)({
      prompt: input,
      options: {
        ...claudeHarnessOptions(executable, env),
        cwd: session.cwd,
        resume: session.sdkSessionId!,
        enableFileCheckpointing: true,
        abortController: new AbortController(),
      },
    });
    try {
      return await run(control);
    } finally {
      input.close();
      control.close();
    }
  }

  async interruptTurn(params: { threadId: string; turnId: string }, options: { keepTasks?: boolean } = {}): Promise<typeof params> {
    const live = this.sessions.get(params.threadId);
    const turn = live?.turn;
    if (turn && turn.turnId !== params.turnId) throw new Error("The active Claude turn has changed.");
    if (!live || !turn) return params;
    // Without tasks to keep, ending the query is the surest stop.
    if (options.keepTasks === false || !await this.interruptKeepingTasks(live, turn)) await this.closeSession(live);
    return params;
  }

  /**
   * Stop the turn but keep the process, and the background tasks it runs.
   * Returns false when only ending the query can stop the turn.
   */
  private async interruptKeepingTasks(live: LiveSession, turn: RunningTurn): Promise<boolean> {
    // A CLI that cannot drop queued messages would run the steers being stopped.
    if (!live.query || live.closing || live.tasks.active().length === 0
      || !live.capabilities?.includes(CLAUDE_INTERRUPT_CANCEL_QUEUED)) return false;
    turn.interrupted = true;
    let cancelledPrompt = false;
    try {
      const receipt = await (live.query as ClaudeInterruptQuery).interrupt({ cancelQueued: true });
      for (const uuid of receipt?.cancelled ?? []) cancelledPrompt = turn.pendingSteers.delete(uuid) || cancelledPrompt;
    } catch (error) {
      claudeBackendLog.warn("Claude rejected an interrupt; ending its session", {
        threadId: live.session.thread.id, error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
    // Claude had not started on the turn's input, so no result will answer.
    if (cancelledPrompt && turn.pendingSteers.size === 0 && live.sessionState === "idle" && live.turn === turn) {
      turn.abandoned = true;
      live.wake.wake();
      await turn.ended.promise;
      return true;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const answered = await Promise.race([
      turn.ended.promise.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), this.options.interruptGraceMs ?? CLAUDE_INTERRUPT_GRACE_MS);
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (!answered && live.turn === turn) {
      turn.abandoned = true;
      live.wake.wake();
    }
    await turn.ended.promise;
    return true;
  }

  /** Close the query, and with it the CLI process and every task it runs. */
  private async closeSession(live: LiveSession): Promise<void> {
    if (live.turn) live.turn.ending = true;
    live.input.close();
    live.controller.abort();
    live.query?.close();
    await live.done;
  }

  async steerTurn(params: {
    threadId: string; expectedTurnId: string; input: AppServerTurnInputItem[]; delivery?: SteerTurnDelivery;
  }): Promise<{
    threadId: string; turnId: string; messageId: string;
  }> {
    const live = this.sessions.get(params.threadId);
    const turn = live?.turn;
    if (!live || !turn) throw new Error("Claude has no active turn. Queue the message instead.");
    const assertActive = () => {
      if (this.sessions.get(params.threadId) !== live || live.turn !== turn || turn.ending
        || live.closing || live.controller.signal.aborted) {
        throw new Error("Claude has no active turn. Queue the message instead.");
      }
      if (turn.turnId !== params.expectedTurnId) throw new Error("Claude expected active turn id has changed.");
      // Before the query launches, the input stream buffers the steer; the
      // prompt generator sends it right after the first prompt.
    };
    assertActive();
    const content = await claudeInput(params.input);
    const uuid = randomUUID();
    const messageId = `user:${uuid}`;
    const operation = live.inputWrites.then(async () => {
      assertActive();
      // Native result receipts retain at most 64 consumed UUIDs, including
      // the original prompt. Never accept more than we can acknowledge.
      if (turn.pendingSteers.size >= 63) throw new Error("Claude has too many pending steer messages. Queue this message instead.");
      const parts = claudeUserMessageParts(params.input);
      const entry: AppServerThreadMessageEntry = {
        type: "message", id: messageId, role: "user", parts,
        text: parts.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n"),
        createdAt: Date.now(), turn: { id: turn.turnId, status: "in_progress" },
      };
      // Hand the message to Claude before any await: the turn can end while
      // history is written, and a rejected steer must leave no transcript row.
      turn.entries.set(messageId, entry);
      turn.pendingSteers.add(uuid);
      // "next" joins the running turn at its next boundary. "now" aborts the
      // in-flight response: Claude ends it with a success result whose
      // terminal_reason is "aborted_streaming" (or "aborted_tools", when a
      // running tool finishes first and the next model call is skipped). That
      // result acknowledges only the earlier input, so pendingSteers keeps the
      // turn open until the result that answers this message. Measured on CLI
      // 0.3.301; a running tool is not killed.
      live.input.push({ type: "user", uuid, priority: params.delivery === "now" ? "now" : "next", parent_tool_use_id: null,
        message: { role: "user", content } });
      // The message is already sent; turn completion persists every entry,
      // so an early-write failure must not report the steer as rejected.
      await this.store.append(params.threadId, [entry]).catch(() => {});
      await this.emit({ method: "item/completed", params: {
        threadId: params.threadId, turnId: turn.turnId,
        item: { id: messageId, type: "userMessage", text: entry.text, content: parts },
      } });
    });
    live.inputWrites = operation.catch(() => {});
    await operation;
    return { threadId: params.threadId, turnId: turn.turnId, messageId };
  }

  private async settleInputWrites(live: LiveSession): Promise<void> {
    let writes: Promise<void>;
    do {
      writes = live.inputWrites;
      await writes;
    } while (writes !== live.inputWrites);
  }

  async close(): Promise<void> {
    if (this.rateLimitExpiry) clearTimeout(this.rateLimitExpiry);
    this.rateLimitExpiry = undefined;
    for (const controller of this.starting.values()) controller.abort();
    await Promise.all([...this.sessions.values()].map((live) => this.closeSession(live)));
  }
}

type ClaudeRewindPoint = {
  /** The prompt's SDK UUID: its checkpoint, and the first entry removed. */
  promptUuid: string;
  /** The entry just before the prompt, where the next query resumes. */
  keptUuid?: string;
  /** The conversation's last entry: the end of the branch the rewind removes. */
  leafUuid?: string;
};

/** Settles with `promise`, or rejects with `message` after `ms`. */
async function claudeWithin<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Claude's dry run says why, or the prompt predates file checkpointing. */
function claudeFilesUnavailableReason(detail: string | undefined): string {
  return detail?.trim()
    || "Claude has no file checkpoint for this prompt. Prompts sent before PwrAgent enabled checkpoints cannot restore files.";
}

/** The item event for a Claude tool row. */
function claudeActivityItem(entry: AppServerThreadActivityEntry, output?: string) {
  const command = entry.details[0]?.command?.rawCommand;
  return {
    id: entry.id, status: entry.status,
    ...(command !== undefined
      ? { type: "commandExecution", command, ...(output !== undefined ? { aggregatedOutput: output } : {}) }
      : { type: "dynamicToolCall", toolName: entry.summary,
        ...(output !== undefined ? { contentItems: [{ type: "inputText", text: output }] } : {}) }),
  };
}

/** Whether a tool result is the placeholder of a task launched in the background. */
function claudeBackgroundLaunch(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const value = result as { backgroundTaskId?: unknown; status?: unknown };
  return typeof value.backgroundTaskId === "string" || value.status === "async_launched";
}

function claudeUserMessageParts(input: AppServerTurnInputItem[]): AppServerThreadMessagePart[] {
  return input.flatMap((item): AppServerThreadMessagePart[] => {
    if (item.type === "text") return [{ type: "text", text: item.text }];
    if (item.type === "image") return [{ type: "image", url: item.url, alt: item.name }];
    if (item.type === "localImage") return [{
      type: "image",
      url: toTranscriptImageProtocolUrl(pathToFileURL(item.path).toString()),
      alt: item.name ?? path.basename(item.path),
    }];
    if (item.type === "localFile") return [{
      type: "file", name: item.name ?? path.basename(item.path),
      mimeType: item.mimeType, sizeBytes: item.sizeBytes,
    }];
    return [];
  });
}

const LOCAL_IMAGE_TYPES: Record<string, string> = {
  ".png": "png", ".jpg": "jpeg", ".jpeg": "jpeg", ".gif": "gif", ".webp": "webp",
};

async function claudeInput(input: AppServerTurnInputItem[]): Promise<SDKUserMessage["message"]["content"]> {
  const content: Exclude<SDKUserMessage["message"]["content"], string> = [];
  for (const item of input) {
    if (item.type === "text") content.push({ type: "text", text: item.text });
    else if (item.type === "localFile") content.push({ type: "text", text: `Attached file: ${item.path}${item.textPreview ? `\n${item.textPreview}` : ""}` });
    else if (item.type === "image" || item.type === "localImage") {
      // The API rejects a media type that does not match the bytes, so an
      // unknown extension must fail here rather than be labelled PNG.
      const localType = item.type === "localImage" ? LOCAL_IMAGE_TYPES[path.extname(item.path).toLowerCase()] : undefined;
      if (item.type === "localImage" && !localType) throw new Error("Claude image input must be a PNG, JPEG, GIF, or WebP attachment.");
      const url = item.type === "image" ? item.url : `data:image/${localType};base64,${(await readFile(item.path)).toString("base64")}`;
      const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(url);
      if (!match) throw new Error("Claude image input must be a PNG, JPEG, GIF, or WebP attachment.");
      content.push({ type: "image", source: { type: "base64", media_type: match[1] as "image/png", data: match[2] } });
    } else {
      throw new Error(`Claude does not support ${item.type} input.`);
    }
  }
  return content;
}
