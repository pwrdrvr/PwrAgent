import { type ForgeRepository } from "../pr-status/forge-tool-contract";
import {
  type ForgePrToolArgs,
  type ForgePrToolOperation,
  type ForgeReviewComment,
} from "../pr-status/forge-pr-tool-contract";
import {
  findAcpPermissionModeConfigOption,
  finalTurnOutputText,
} from "@pwragent/shared";
import type { CodexBackgroundTerminal } from "@pwragent/shared";
import path from "node:path";
import type {
  MessagingApprovalDecision,
} from "@pwragent/messaging-interface";
import {
  type AppServerNotification,
  type AppServerPendingRequestNotification,
  type AppServerToolRequestUserInputResponse,
  type AppServerThreadStatus,
  type AppServerTurnInputItem,
  type AppServerBackendKind,
  type BackendAcpRuntimeCapabilities,
  type BackendAcpSessionRuntimeState,
  type ThreadQuestionnaireActivity,
  type StartReviewRequest,
  type ThreadExecutionMode,
  type PendingRequestDecision,
  type PendingRequestApprovalContext,
  normalizeFileChangeApprovalDiff,
  type AgentToolCatalogId,
  type MessagingDynamicToolCategory,
} from "@pwragent/shared";
import { type ThreadTurnQueueEntry } from "@pwragent/owner-core/thread-turn-queue";
import {
  type ForgeWriteApprovalNotes,
} from "./backend-registry-types";
import {
  readNonEmptyRawString,
  readNonEmptyString,
  readOptionalString,
  readRecord,
} from "./backend-registry-notification-values";


export function withForgeApprovalNotes(result: unknown, notes: ForgeWriteApprovalNotes | undefined): unknown {
  if (!notes || (!notes.approval && !notes.rememberedRule)) return result;
  const record = readRecord(result);
  if (!record) return result;
  return {
    ...record,
    ...(notes.approval ? { approval: notes.approval } : {}),
    ...(notes.rememberedRule ? { rememberedRule: notes.rememberedRule } : {}),
  };
}
export const ATTENTION_NOTIFICATION_METHODS = new Set([
  "turn/requestApproval",
  "review/requestApproval",
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
  "applyPatchApproval",
  "execCommandApproval",
]);

export function readNotificationProjectLabel(
  thread: Record<string, unknown> | undefined,
): string | undefined {
  if (!thread) {
    return undefined;
  }
  const linkedDirectories = Array.isArray(thread.linkedDirectories)
    ? thread.linkedDirectories
    : [];
  for (const directory of linkedDirectories) {
    if (!directory || typeof directory !== "object" || Array.isArray(directory)) {
      continue;
    }
    const record = directory as Record<string, unknown>;
    const label = readNonEmptyString(record.label);
    if (label) {
      return label;
    }
    const directoryPath = readNonEmptyString(record.path);
    if (directoryPath) {
      return path.basename(directoryPath);
    }
  }
  const projectKey = readNonEmptyString(thread.projectKey);
  return projectKey ? path.basename(projectKey) : undefined;
}

export function readFileChangeApprovalFile(
  value: unknown,
): NonNullable<PendingRequestApprovalContext["files"]>[number] | undefined {
  const record = readRecord(value);
  const filePath = readNonEmptyString(record?.path);
  if (!record || !filePath) {
    return undefined;
  }
  const kind = readRecord(record.kind);
  const action =
    readNonEmptyString(kind?.type) ??
    readNonEmptyString(record.kind) ??
    readNonEmptyString(record.action);
  const directDiff =
    readNonEmptyRawString(kind?.unified_diff) ??
    readNonEmptyRawString(kind?.unifiedDiff) ??
    readFileChangeApprovalDiff(record) ??
    readFileChangeApprovalDiff(kind);
  const content =
    readOptionalString(kind?.content) ?? readOptionalString(record.content);
  const diff = normalizeFileChangeApprovalDiff({
    action,
    content,
    directDiff,
    path: filePath,
  });
  return {
    ...(action ? { action } : {}),
    ...(diff ? { diff } : {}),
    displayPath: filePath,
    path: filePath,
  };
}

export function readFileChangeApprovalDiff(
  record: Record<string, unknown> | undefined,
): string | undefined {
  if (!record) {
    return undefined;
  }
  const direct =
    readNonEmptyRawString(record.unified_diff) ??
    readNonEmptyRawString(record.unifiedDiff) ??
    readNonEmptyRawString(record.patch) ??
    readNonEmptyRawString(record.diff);
  if (direct) {
    return direct;
  }
  return readFileChangeApprovalDiff(readRecord(record.diff));
}

export function fileChangeApprovalContextKey(params: {
  backend: AppServerBackendKind;
  itemId?: string;
  threadId: string;
  turnId?: string;
}): string {
  return [
    params.backend,
    params.threadId,
    params.turnId ?? "",
    params.itemId ?? "__latest__",
  ].join(":");
}

export function isAcpPermissionRequest(
  request: AppServerPendingRequestNotification,
): boolean {
  return (
    request.method === "item/commandExecution/requestApproval" &&
    request.params.acpMethod === "session/request_permission"
  );
}

export function pendingRequestDecisionFromMessagingApproval(
  decision: MessagingApprovalDecision,
): PendingRequestDecision {
  switch (decision) {
    case "accept":
    case "accept_for_session":
    case "accept_with_execpolicy_amendment":
    case "apply_network_policy_amendment":
      return "approve";
    case "decline":
      return "decline";
    case "cancel":
      return "cancel";
  }
}

export function acpRuntimeHasExecutionModeSelection(params: {
  registryId?: string;
  runtime?: BackendAcpSessionRuntimeState;
  runtimeCapabilities?: BackendAcpRuntimeCapabilities;
}): boolean {
  const { runtime, runtimeCapabilities } = params;
  if (!runtime) {
    return false;
  }
  if (params.registryId === "grok") {
    const permissionOption = findAcpPermissionModeConfigOption(runtimeCapabilities);
    return Boolean(permissionOption && runtime.configValues?.[permissionOption.id]);
  }
  if (runtime.currentModeId) {
    return true;
  }

  const configValues = runtime.configValues ?? {};
  const modeOptionIds = new Set(
    runtimeCapabilities?.configOptions
      ?.filter((option) => option.category === "mode")
      .map((option) => option.id) ?? [],
  );
  for (const key of ["mode", "approval-mode", "approval_mode"]) {
    modeOptionIds.add(key);
  }

  return [...modeOptionIds].some((optionId) => configValues[optionId]);
}

export function formatExecutionModeForError(mode: ThreadExecutionMode): string {
  return mode === "auto" ? "Auto" : mode === "full-access" ? "Full Access" : "Default Access";
}

export function reviewTaskLabel(target: StartReviewRequest["target"]): string {
  switch (target.type) {
    case "pullRequest":
      return `Review ${target.url}${target.snapshot ? ` at ${target.snapshot.headCommit.slice(0, 10)}` : ""}`;
    case "baseBranch":
      return `Review changes against ${target.branch}`;
    case "commit":
      return `Review commit ${target.sha.slice(0, 7)}`;
    case "custom":
      return target.instructions.trim() || "Review changes";
    case "uncommittedChanges":
      return "Review current changes";
  }
}

/**
 * A thread launched straight from `/review` never runs a user turn, so the
 * title generator has no prompt to name it from and the thread keeps its
 * backend fallback ("ACP session", "New thread") forever. Synthesize the
 * prompt from what the launch already knows — the review target plus the
 * repository and branch it runs against — so the generated name reads like
 * "Review remote thread homing against main" rather than a generic placeholder.
 */
export function reviewThreadTitlePrompt(params: {
  branchName?: string;
  directoryLabel?: string;
  target: StartReviewRequest["target"];
}): string {
  const target = params.target;
  const lines = [
    `Starting a code review: ${
      target.type === "commit"
        ? `Review commit ${target.sha}${target.title ? ` (${target.title})` : ""}`
        : reviewTaskLabel(target)
    }.`,
  ];
  const repository = params.directoryLabel?.trim();
  if (repository) {
    lines.push(`Repository: ${repository}.`);
  }
  const branch = params.branchName?.trim();
  if (branch) {
    lines.push(`Working branch: ${branch}.`);
  }
  return lines.join(" ");
}

export function prependAutomationRuntimeContext(params: {
  approvalPolicy: string;
  executionMode: ThreadExecutionMode;
  input: AppServerTurnInputItem[];
  label: string;
  sandbox: string;
}): AppServerTurnInputItem[] {
  const accessNote =
    params.executionMode === "auto"
      ? "Shell commands run in the workspace-write sandbox. Eligible permission requests are reviewed automatically by Codex. Human approval prompts are unavailable in this automation; report actions that require a person."
      : params.sandbox === "danger-full-access"
      ? "Shell commands may run with Full Access. Permission prompts are unavailable; do not ask the user for approval."
      : "Shell commands run in the Default Access workspace-write sandbox. Shell network access is unavailable, and permission prompts are unavailable; do not ask the user for approval or wait for one. Use built-in hosted tools such as web search when available, or return a concise failure explaining that the automation needs Full Access.";

  return [
    {
      type: "text",
      text: [
        "Automation runtime context:",
        `Access mode: ${params.label} (${params.executionMode}).`,
        `Approval policy: ${params.approvalPolicy}.`,
        `Sandbox: ${params.sandbox}.`,
        accessNote,
      ].join("\n"),
    },
    ...params.input,
  ];
}

export function buildHeadlessAutomationRequestCancelResponse(
  request: AppServerPendingRequestNotification,
): Record<string, unknown> {
  if (request.method === "mcpServer/elicitation/request") {
    return {
      action: "cancel",
      content: null,
      _meta: null,
    };
  }

  if (request.method === "item/tool/requestUserInput") {
    return {
      answers: {},
    };
  }

  return { decision: "cancel" };
}

export function questionnaireAnswerHasValue(answer: unknown): boolean {
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) {
    return false;
  }

  const values = (answer as { answers?: unknown }).answers;
  return (
    Array.isArray(values) &&
    values.some((value) => typeof value === "string" && value.trim().length > 0)
  );
}

export function sanitizeQuestionnaireResponseForOverlay(params: {
  activity: ThreadQuestionnaireActivity;
  response: unknown;
}): AppServerToolRequestUserInputResponse["answers"] {
  if (
    !params.response ||
    typeof params.response !== "object" ||
    Array.isArray(params.response)
  ) {
    return {};
  }
  const rawAnswers = (params.response as { answers?: unknown }).answers;
  if (!rawAnswers || typeof rawAnswers !== "object" || Array.isArray(rawAnswers)) {
    return {};
  }

  const secretQuestionIds = new Set(
    params.activity.questions
      .filter((question) => question.isSecret === true)
      .map((question) => question.id),
  );
  const sanitized: AppServerToolRequestUserInputResponse["answers"] = {};
  for (const [questionId, rawAnswer] of Object.entries(
    rawAnswers as Record<string, unknown>,
  )) {
    if (!rawAnswer || typeof rawAnswer !== "object" || Array.isArray(rawAnswer)) {
      sanitized[questionId] = undefined;
      continue;
    }
    const values = (rawAnswer as { answers?: unknown }).answers;
    if (!Array.isArray(values)) {
      sanitized[questionId] = undefined;
      continue;
    }
    const answers = values
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    sanitized[questionId] = {
      answers:
        secretQuestionIds.has(questionId) && answers.length > 0
          ? ["[REDACTED]"]
          : answers,
    };
  }
  return sanitized;
}

export function readStatusType(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || !("type" in value)) {
    return undefined;
  }

  const type = value.type;
  return typeof type === "string" ? type : undefined;
}

export function isAppServerThreadStatus(
  value: string | undefined,
): value is AppServerThreadStatus {
  return (
    value === "active"
    || value === "idle"
    || value === "notLoaded"
    || value === "unknown"
  );
}

export function readNotificationItemType(notification: AppServerNotification): string | undefined {
  if (
    notification.method !== "item/started" &&
    notification.method !== "item/completed"
  ) {
    return undefined;
  }
  const params = readRecord(notification.params);
  const item = readRecord(params?.item);
  const type = item?.type;
  return typeof type === "string" ? type : undefined;
}

export function readTurnStatus(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || !("status" in value)) {
    return undefined;
  }

  const status = value.status;
  return typeof status === "string" ? status : undefined;
}

export function turnIdFromStartedNotification(
  notification: {
    params: {
      turnId?: string;
      turn: {
        id: string;
      };
    };
  },
): string {
  return notification.params.turnId ?? notification.params.turn.id;
}

/** Usage figures change on every read; only identities make a membership. */
export function backgroundTerminalMembership(terminals: CodexBackgroundTerminal[]): string {
  return terminals.map((terminal) => `${terminal.itemId}\u0000${terminal.processId}`).sort().join("\n");
}

export function turnIdFromTerminalNotification(
  notification: {
    params: {
      turnId?: string | null;
      turn?: {
        id?: string | null;
      };
    };
  },
): string | undefined {
  return notification.params.turnId ?? notification.params.turn?.id ?? undefined;
}

export function normalizeNotificationTimestamp(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  return value < 1_000_000_000_000 ? value * 1_000 : value;
}

export function completedAtFromTerminalNotification(
  notification: AppServerNotification,
): number | undefined {
  if (
    notification.method !== "turn/completed" &&
    notification.method !== "turn/failed" &&
    notification.method !== "turn/cancelled"
  ) {
    return undefined;
  }

  return normalizeNotificationTimestamp(
    readRecord(notification.params.turn)?.completedAt ??
      readRecord(notification.params.turn)?.completed_at,
  );
}

export function finalTextFromTerminalNotification(
  notification: AppServerNotification,
): string | undefined {
  if (notification.method !== "turn/completed") {
    return undefined;
  }
  const completed = notification as Extract<
    AppServerNotification,
    { method: "turn/completed" }
  >;
  return finalTurnOutputText(completed.params.turn.output);
}

export function textFragmentsFromCodexNotification(
  notification: AppServerNotification,
): string[] {
  const fragments: string[] = [];
  const terminalText = finalTextFromTerminalNotification(notification);
  if (terminalText) {
    fragments.push(terminalText);
  }

  if (notification.method === "item/agentMessage/delta") {
    const delta = readOptionalString(readRecord(notification.params), ["delta"]);
    if (delta) {
      fragments.push(delta);
    }
  }

  if (
    notification.method === "item/started" ||
    notification.method === "item/completed"
  ) {
    const params = readRecord(notification.params);
    const item = readRecord(params?.item);
    const itemText =
      readOptionalString(item, ["text", "content", "message", "summary"]) ??
      readOptionalString(readRecord(item?.data), [
        "text",
        "content",
        "message",
        "summary",
      ]);
    if (itemText) {
      fragments.push(itemText);
    }
  }

  return fragments;
}

export function errorMessageFromTerminalNotification(
  notification: AppServerNotification,
): string | undefined {
  if (notification.method !== "turn/failed") {
    return undefined;
  }
  const failed = notification as Extract<
    AppServerNotification,
    { method: "turn/failed" }
  >;
  return failed.params.turn.error.message;
}

/**
 * The pause fields every queued-entry read and event carries: the flag only
 * when set, and the revision once the entry has ever been paused.
 */
export function queuedTurnPauseParams(entry: ThreadTurnQueueEntry): { paused?: true; pauseRevision?: number } {
  return {
    ...(entry.paused ? { paused: true } : {}),
    ...(entry.pauseRevision ? { pauseRevision: entry.pauseRevision } : {}),
  };
}

/** First text of a queued turn's input, truncated for chip display. */
export function queuedTurnDisplayText(input: AppServerTurnInputItem[]): string {
  const text = input
    .filter(
      (item): item is Extract<AppServerTurnInputItem, { type: "text" }> =>
        item.type === "text",
    )
    .map((item) => item.text)
    .join("\n")
    .trim();
  return text.length > 200 ? `${text.slice(0, 200)}\u2026` : text;
}

/** The card's title, in the provider's own words: GitLab says merge request and !number. */
export function forgeToolApprovalMessage(operation: ForgePrToolOperation, args: ForgePrToolArgs, provider: ForgeRepository["provider"]): string {
  const gitlab = provider === "gitlab";
  const forge = gitlab ? "GitLab" : "GitHub";
  const request = gitlab ? "merge request" : "pull request";
  const pr = args.number ? ` ${gitlab ? "!" : "#"}${args.number}` : "";
  const issue = args.number ? ` #${args.number}` : "";
  const commentTarget = gitlab && args.kind === "pr" ? pr : issue;
  switch (operation) {
    case "rerun_failed_ci_jobs": return gitlab
      ? `Allow the agent to retry failed and canceled jobs in GitLab pipeline ${args.runId}?`
      : `Allow the agent to rerun failed jobs and their dependents in GitHub Actions run ${args.runId}?`;
    case "create_pull_request": return `Allow the agent to open a ${request} on ${forge}?`;
    case "update_pull_request": return `Allow the agent to edit ${request}${pr} on ${forge}?`;
    case "merge_pull_request": switch (args.method) {
      // Every surface that shows the request reads which merge it is.
      case "squash": return `Allow the agent to squash and merge ${request}${pr} on ${forge}?`;
      case "rebase": return `Allow the agent to rebase and merge ${request}${pr} on ${forge}?`;
      case "merge": return `Allow the agent to merge ${request}${pr} on ${forge} with a merge commit?`;
      default: return `Allow the agent to merge ${request}${pr} on ${forge}?`;
    }
    case "submit_pull_request_review": {
      const verb = args.event === "APPROVE" ? "approve" : args.event === "REQUEST_CHANGES" ? "request changes on" : "review";
      return `Allow the agent to ${verb} ${request}${pr} on ${forge}?`;
    }
    case "reply_to_review_comment": return `Allow the agent to reply to a review comment on${pr || ` ${forge}`}?`;
    case "resolve_review_thread": return `Allow the agent to ${args.resolved ? "resolve" : "reopen"} a review thread on ${forge}?`;
    case "add_issue_comment": return `Allow the agent to comment on${commentTarget || ` ${forge}`}?`;
    case "create_issue": return `Allow the agent to open an issue on ${forge}?`;
    case "update_issue": return `Allow the agent to edit issue${issue} on ${forge}?`;
    default: return `Allow the agent to run ${operation} on ${forge}?`;
  }
}

/**
 * The card's argument rows. Text goes out whole, because the operator is
 * approving exactly what gets posted; the contract already caps a body at
 * FORGE_BODY_MAX_CHARS. A body the forge renders as Markdown says so, and each
 * inline review comment is its own row keyed by its location.
 */
export function forgeToolParamsDisplay(args: ForgePrToolArgs): Array<{ name: string; value: string; format?: "markdown"; location?: string }> {
  const rows: Array<{ name: string; value: string; format?: "markdown"; location?: string }> = [];
  for (const [name, value] of Object.entries(args)) {
    // The question and the card's merge button both name the method.
    if (value === undefined || name === "repository" || name === "method") continue;
    if (name === "body") {
      rows.push({ name, value: String(value), format: "markdown" });
    } else if (name === "commitMessage") {
      rows.push({ name, value: String(value) });
    } else if (name === "attachments" && Array.isArray(value)) {
      rows.push({ name, value: value.map((item) => String((item as { path?: unknown }).path ?? "").split("/").pop()).join(", ") });
    } else if (name === "comments" && Array.isArray(value)) {
      for (const comment of value as ForgeReviewComment[]) {
        const lines = comment.startLine && comment.startLine !== comment.line ? `${comment.startLine}–${comment.line}` : String(comment.line);
        // The card shows the location in the key column. It travels apart
        // from the name, because the secret-name checks read the name and
        // label, and a file such as password-reset.ts is not a credential.
        rows.push({ name: "comment", location: `${comment.path}:${lines}`, value: String(comment.body ?? ""), format: "markdown" });
      }
    } else {
      rows.push({ name, value: typeof value === "string" ? value : JSON.stringify(value) });
    }
  }
  return rows;
}

export function messagingDynamicToolCategoryForCatalog(
  catalogId: AgentToolCatalogId | undefined,
): MessagingDynamicToolCategory | undefined {
  switch (catalogId) {
    case "automation_inspection":
    case "app_management":
    case "thread_inspection":
    case "forge":
    case "thread_orchestration":
    case "messaging_context":
    case "star_map":
      return catalogId;
    default:
      return undefined;
  }
}
