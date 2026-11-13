import { getOwnerHostServices } from "../owner-host";
import { PROJECT_PAUSED_ERROR_CODE } from "@pwragent/shared";
import { execFile as execFileCallback } from "node:child_process";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";
import {
  type AppServerThreadSummary,
  type PwrAgentThreadOrchestrationErrorCode,
  type PwrAgentThreadOrchestrationResponse,
  type ThreadExecutionMode,
} from "@pwragent/shared";
import { approvalSettingsForMode, localMemberRole } from "../member-containment";
import { executionModeUnavailableMessage } from "../owner-runtime-policy";
import {
  PROVIDER_IDS,
  type ConfigDomainMap,
  type ProviderId,
} from "../settings/config-store/config-domains";
import {
  type ThreadListCallerReason,
} from "./backend-registry-types";
import { EXECUTION_MODE_SUMMARIES } from "./thread-model-options";

export const createReplayClientsFromEnv = () => getOwnerHostServices().replayClients();

// Keep expensive Codex thread-list walks reusable across focus/navigation bursts.
// Thread lifecycle notifications still invalidate this cache when list metadata
// changes, so this window can cover ordinary foreground idle time while
// background polling catches external Codex changes on a slower cadence.
export const THREAD_LIST_REUSE_WINDOW_MS = 5 * 60_000;
// A listing that stood in an empty Codex inventory for a failed read must not
// hide a recovered Codex for the whole window, nor retry on every focus.
export const INCOMPLETE_THREAD_LIST_REUSE_WINDOW_MS = 15_000;
export const CODEX_RATE_LIMIT_BROADCAST_WINDOW_MS = 20_000;
export const THREAD_SEARCH_REUSE_WINDOW_MS = 2_000;
/** Marks the approval cards PwrAgent's own forge tools raise. */
export const FORGE_TOOL_REQUEST_ID_PREFIX = "forge-tool:";
/** A form an upstream MCP server sent during a gateway call; see requestUpstreamMcpForm. */
export const MCP_UPSTREAM_FORM_REQUEST_ID_PREFIX = "mcp-upstream-form:";
/** How long a card waits for its project's name before using owner/repo. */
export const FORGE_PROJECT_LABEL_TIMEOUT_MS = 1_000;
export const FORGE_APPROVAL_WITHDRAWN_TODO_KEY = "forge-approval-withdrawn";

export const PENDING_APPROVAL_GUIDANCE =
  "The operator has not answered these yet. A call waiting on one stays pending until they do. "
  + "If this turn ends first, the request is withdrawn and the waiting call is cancelled. "
  + "Do not ask the operator to approve it after you end the turn; say it was withdrawn and that they can reply to retry.";
export const ACTIVE_TURN_HANDOFF_ERROR =
  "Worktree/local migration is not available while a turn is in progress. Resubmit when the turn completes.";
export const ACTIVE_TURN_WORKSPACE_RECOVERY_ERROR =
  "Wait for the current turn to finish, then try again.";
export const CODEX_WORKSPACE_CWD_SYNC_PENDING_WARNING =
  "Codex workspace CWD synchronization is pending and will retry automatically.";
export const CLAUDE_WORKSPACE_MOVE_FAILED_WARNING =
  "Claude could not switch to the new folder. Move this thread again before you send a message.";
/**
 * Number of consecutive queued-execution-mode flush failures tolerated
 * before the queue is auto-cancelled and an explanatory `cancelled`
 * audit entry is appended. Codex's `thread/resume` is normally
 * idempotent, so repeated failure here implies a deeper protocol
 * problem the user needs visibility into.
 */
export const MAX_QUEUE_FLUSH_ATTEMPTS = 3;
// Upper bound on remembered terminal-notification label reconciliations. Each
// entry is one settled promise that memoizes "this thread's label has already
// been walked for", so they are retained on purpose; the cap keeps a long-lived
// process from holding one per thread it has ever been notified about.
export const NOTIFICATION_CONTEXT_RECONCILIATION_LIMIT = 512;
// An ACP listing resolves linked directories for every row it returns, so its
// rows carry enrichment whether or not the caller requested it.
export const ACP_LISTINGS_ARE_ENRICHED = true;

/**
 * A paused project refused an agent's message from another thread. The
 * message names the project and how the operator lifts it.
 */
export class ProjectPausedThreadMessageError extends Error {
  readonly code = PROJECT_PAUSED_ERROR_CODE;
  constructor(message: string) {
    super(message);
    this.name = "ProjectPausedThreadMessageError";
  }
}
export class ThreadAlreadyActiveError extends Error {}
export const execFile = promisify(execFileCallback);

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

export const TASK_MONITOR_STALE_CHECK_INTERVAL_MS = 15_000;
// An ACP agent keeps an open session's MCP servers running. Close a session
// nothing has touched for this long; its next request reloads it.
export const ACP_SESSION_IDLE_CLOSE_MS = 10 * 60_000;
export const ACP_SESSION_IDLE_CLOSE_CHECK_INTERVAL_MS = 2 * 60_000;
// Codex keeps a subscribed thread loaded, MCP servers and all. Release a
// thread nothing has touched for this long; its next use resumes it.
export const CODEX_THREAD_IDLE_UNSUBSCRIBE_MS = 10 * 60_000;
export const CODEX_THREAD_IDLE_UNSUBSCRIBE_CHECK_INTERVAL_MS = 2 * 60_000;
export const TASK_MONITOR_STALE_GRACE_MS = 15_000;
/** Progress reports a recovery turn is shown. */
export const TASK_MONITOR_RECOVERY_PROGRESS_LIMIT = 5;
/** Transcript items, and characters of each, a recovery turn is shown. */
export const TASK_MONITOR_RECOVERY_ACTIVITY_LIMIT = 6;
export const TASK_MONITOR_RECOVERY_ACTIVITY_CHARS = 1_500;

export function shouldEnrichThreadDirectories(
  callerReason?: ThreadListCallerReason,
): boolean {
  // Ordinary lists serve cached/provider metadata. Archive safety also needs
  // canonical worktree roots for unvisited threads sharing a checkout.
  return callerReason === "directory-relationship-reconcile"
    || callerReason === "archive-cleanup";
}

/**
 * Coalesce workspace synchronization failures into one operator decision.
 */
export const CODEX_MISSING_THREAD_EVALUATION_DELAY_MS = 2_000;

/** Matches a thread-specific rejection, which does not prove durable absence. */
export function isCodexMissingThreadError(error: unknown, threadId: string): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  const normalizedThreadId = threadId.trim().toLowerCase();
  if (!normalizedThreadId || !message.includes(normalizedThreadId)) {
    return false;
  }

  return message.includes("thread not found:");
}

export function isCodexMissingRolloutArchiveError(
  error: unknown,
  threadId: string,
): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  const normalizedThreadId = threadId.trim().toLowerCase();
  if (!normalizedThreadId || !message.includes(normalizedThreadId)) {
    return false;
  }

  return (
    message.includes("no rollout found for thread id")
    || message.includes("failed to locate rollout for thread")
    // `thread not found` reaches the same dead end as a missing rollout:
    // Codex cannot archive what it cannot open, so the archive falls through
    // to the local tombstone that already hides stale `thread/list` rows.
    || message.includes("thread not found:")
  );
}

export function shouldBackfillCodexDirectoryRelationships(
  callerReason?: ThreadListCallerReason,
): boolean {
  return callerReason === "directory-relationship-reconcile";
}

export function threadOrchestrationFailure(
  code: PwrAgentThreadOrchestrationErrorCode,
  message: string,
  data?: unknown,
): PwrAgentThreadOrchestrationResponse {
  return {
    ok: false,
    error: {
      code,
      message,
      ...(data === undefined ? {} : { data }),
    },
  };
}

export function archivedThreadMessageRefusal(thread: Pick<AppServerThreadSummary, "id" | "title">): string {
  return `Thread "${thread.title}" (${thread.id}) is archived; cannot send a message. Restore it with mutate_thread (archive=false) before sending.`;
}

export const THREAD_MAINTENANCE_CONFIRM_QUESTION_ID = "thread_maintenance";
export const THREAD_MAINTENANCE_CONFIRM_APPROVE_LABEL = "Run maintenance";

export class ActiveTurnControlPreconditionError extends Error {
  constructor(
    readonly code: "no_active_turn" | "stale_target",
    message: string,
    readonly activeTurnId?: string,
  ) {
    super(message);
    this.name = "ActiveTurnControlPreconditionError";
  }
}

export const MAX_ACCEPTED_THREAD_CONTROL_REQUESTS = 512;

/**
 * Ceiling on a whole command-discovery probe: spawn, `initialize`,
 * `session/new`, and the wait for `available_commands_update`, together.
 *
 * One budget rather than a per-stage timeout, because the stages trade against
 * each other. Nothing under `startSession` is bounded on a timescale a composer
 * can wait on — `getClient` awaits an unbounded `initialize()`, and
 * `session/new` inherits the ACP stdio transport's ten-minute default request
 * timeout — so the probe needs a hard stop regardless. Splitting that stop into
 * "spawn budget" and "notification budget" only invents an invariant between
 * two constants: set the notification wait too close to the total and the
 * deadline truncates it, reproducing the false-empty this whole path exists to
 * avoid. Letting the wait consume whatever the spawn did not means a fast agent
 * gets nearly the entire budget to advertise, and a slow one still cannot hold
 * `listSkills` past this number.
 *
 * The value is a judgement call, not a measurement: the 5s notification wait
 * this replaced was demonstrably too short for a cold Kimi, but nobody has
 * timed how long these agents actually take. While it runs the `/` menu is
 * usable — PwrAgent's own commands render immediately and provider commands
 * fill in — so overshooting costs a late-arriving section, not a blocked menu.
 */
export const ACP_AVAILABLE_COMMAND_PROBE_BUDGET_MS = 20_000;
/**
 * Backoff after a probe that produced nothing (agent unavailable, auth
 * required, or an agent that simply advertises no commands).
 *
 * This is the *only* backstop against re-probing such an agent — empty results
 * are deliberately never persisted — so it is deliberately long. Whether an
 * agent ships slash commands does not change on a five-minute timescale, and
 * every expiry costs another operator-visible probe. It still lives in memory
 * and resets on restart, so a genuinely changed agent is never more than one
 * relaunch away.
 */
export const ACP_AVAILABLE_COMMAND_PROBE_COOLDOWN_MS = 1_800_000;

/**
 * How long thread creation or a new-thread draft waits for MCP defaults.
 * On a second instance the read crosses the owner broker, whose own timeout
 * is sized for a ten-minute tool call; a wedged owner must cost the thread
 * its defaults, not block creation for that long.
 */
export const MCP_DEFAULTS_READ_BUDGET_MS = 2_000;

export const CODEX_INVALID_ID_RECOVERY_COOLDOWN_MS = 5 * 60 * 1000;

// How long streamed command-output accounting is held in memory before it is
// written. Measured against `codex app-server`: a `find / -xdev` turn produced
// 3,693 fixed 8 KiB `item/commandExecution/outputDelta` notifications over
// 8.3s — ~444/second, 30 MB of output. One sqlite read+write per delta cost
// 50-120ms of blocking main-process time per second of streaming, awaited
// inline in `emit()` before any listener saw the event. Folding into a single
// write per 250ms window (~110 deltas) drops that to under ~12ms/s and takes
// it off the hot path entirely.
export const TOOL_INVOCATION_DELTA_FLUSH_INTERVAL_MS = 250;

// Token-usage updates are cumulative snapshots, so repeated observations for
// one turn replace each other in memory. The window bounds the delay, not the
// global commit rate: terminal, hydration, reconciliation and shutdown paths
// drain it early. Concurrent lines share one transaction; no pending lines
// means no writes. usage-activity-cadence.test.ts budgets busy, sparse, boundary
// and idle protocol replays, including WAL projections at explicit rates.
export const LIVE_THREAD_USAGE_FLUSH_INTERVAL_MS = 1_000;
// A turn owned by another live runtime is left open until it has written no
// usage for this long. Every model response writes usage, so a quiet turn is
// waiting on a person or is dead; a live one still replaces the inferred end.
export const USAGE_TURN_REPAIR_PEER_QUIET_MS = 24 * 60 * 60_000;
// Bounds one startup transaction. A real profile had 1,177 open turns
// (21 ms to select); anything past the limit is repaired at the next start.
export const USAGE_TURN_REPAIR_BATCH_LIMIT = 2_000;
// One deadline for every turn a quit stops. Codex holds an interrupted task
// for at most 100 ms before aborting it, then flushes and answers; a backend
// that has not ended its turn by then is left to the shutdown stamp.
export const RUNNING_TURN_SHUTDOWN_STOP_TIMEOUT_MS = 2_000;

export function isCodexInvalidIdRecoveryCooldownActive(
  attemptedAt: number,
  now: number,
): boolean {
  // Epoch milliseconds are independent of time zones and DST. Treat a clock
  // that moved backwards as still inside the cooldown (the safe direction).
  return now <= attemptedAt
    || now - attemptedAt < CODEX_INVALID_ID_RECOVERY_COOLDOWN_MS;
}

export function buildCodexInvalidIdRecoveryCooldownMessage(
  attemptedAt: number,
): string {
  return (
    "PwrAgent already attempted automatic Codex history recovery for this "
    + `thread at ${new Date(attemptedAt).toISOString()}; refusing another `
    + "attempt within five minutes. The request was not resubmitted."
  );
}

export function readProviderRuntimeFingerprints(
  providers: ConfigDomainMap["providers"],
): Readonly<Record<ProviderId, string>> {
  return Object.fromEntries(
    PROVIDER_IDS.map((provider) => [
      provider,
      providers[provider]?.runtimeFingerprint
        ?? providers[provider]?.dependencyFingerprint
        ?? "",
    ]),
  ) as Record<ProviderId, string>;
}

export function executionModeSettings(mode: ThreadExecutionMode) {
  const original = EXECUTION_MODE_SUMMARIES[mode];
  const policy = getOwnerHostServices().runtimePolicy;
  if (policy && !policy.executionModes.includes(mode)) throw new Error(executionModeUnavailableMessage(mode));
  return {
    ...original,
    ...approvalSettingsForMode(original, { approvals: policy?.approvals, role: localMemberRole() }),
    sandbox: policy?.sandboxByMode[mode] ?? original.sandbox,
  };
}
