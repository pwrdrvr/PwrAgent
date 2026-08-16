import type {
  AppServerBackendKind,
  AppServerNotification,
  DesktopToolOutputAlertPolicy,
  ThreadToolInvocationAlert,
  ThreadToolInvocationCategory,
  ThreadToolInvocationRecord,
  ThreadToolInvocationStatus,
} from "@pwragent/shared";
import {
  buildThreadToolIncidentPrompt,
  DESKTOP_TOOL_OUTPUT_ALERT_POLICY_DEFAULT,
  TOOL_OUTPUT_CAP_CHARS,
  TOOL_OUTPUT_TOKEN_CHAR_RATIO,
  TOOL_OUTPUT_WARNING_CHARS,
  toolOutputWarningChars,
} from "@pwragent/shared";
import { redactCommandText } from "../util/redact-command-text";

/* Shared with the incident explorer so its meters are drawn against the same
   cap this detector reasons about. */
const OUTPUT_TOKEN_CHAR_RATIO = TOOL_OUTPUT_TOKEN_CHAR_RATIO;
const NOISY_POLL_LOOKBACK_MS = 5 * 60 * 1000;
const NOISY_POLL_MIN_INVOCATIONS = 5;
const NOISY_POLL_MIN_INTERVAL_MS = 15_000;
const NOISY_POLL_MAX_INTERVAL_MS = 75_000;
const LARGE_OUTPUT_WARNING_CHARS = TOOL_OUTPUT_WARNING_CHARS;
const LARGE_OUTPUT_CRITICAL_CHARS = TOOL_OUTPUT_CAP_CHARS;
const ACCOUNTED_TOOL_ITEM_TYPES = new Set([
  "commandExecution",
  "dynamicToolCall",
  "functionCall",
  "mcpToolCall",
  "toolCall",
]);

export type ToolInvocationOutputMetrics = {
  debugLines: number;
  errorLines: number;
  estimatedOutputTokens: number;
  infoLines: number;
  outputChars: number;
  outputLines: number;
  outputTruncated: boolean;
  warningLines: number;
};

export type NormalizedToolCommand = {
  category: ThreadToolInvocationCategory;
  normalizedCommand?: string;
};

export type NoisyPollingDetection = {
  alert: ThreadToolInvocationAlert;
  cases: Record<string, { outputChars: number }>;
  invocationIds: string[];
  lookbackSince: number;
};

export type LargeToolOutputDetection = {
  alert: ThreadToolInvocationAlert;
  cases: Record<string, { outputChars: number }>;
  invocationIds: string[];
};

export type ToolOutputIncidentAggregate = {
  alert: ThreadToolInvocationAlert;
  cases: Record<string, {
    outputChars: number;
    severity: ThreadToolInvocationAlert["severity"];
  }>;
};

export function mergeLargeToolOutputIncident(params: {
  current?: ToolOutputIncidentAggregate;
  detection: LargeToolOutputDetection | NoisyPollingDetection;
  minimumWarningInvocationCount?: number;
}): {
  aggregate: ToolOutputIncidentAggregate;
  shouldNotify: boolean;
} {
  const incoming = params.detection.alert;
  const previousCases = params.current?.cases ?? {};
  const newInvocationIds = params.detection.invocationIds.filter(
    (invocationId) => !previousCases[invocationId],
  );
  const escalated = params.detection.invocationIds.some((invocationId) =>
    previousCases[invocationId]?.severity === "warning"
    && incoming.severity === "critical"
  );
  const cases = { ...previousCases };
  for (const invocationId of params.detection.invocationIds) {
    const incidentCase = params.detection.cases[invocationId];
    cases[invocationId] = {
      outputChars: incidentCase?.outputChars ?? 0,
      severity: incoming.severity,
    };
  }
  const entries = Object.entries(cases);
  const totalOutputChars = entries.reduce(
    (sum, [, incidentCase]) => sum + incidentCase.outputChars,
    0,
  );
  const [worstInvocationId, worstCase] = entries.reduce(
    (worst, entry) => entry[1].outputChars > worst[1].outputChars ? entry : worst,
  );
  const severity = entries.some(([, incidentCase]) => incidentCase.severity === "critical")
    ? "critical" as const
    : "warning" as const;
  const estimatedOutputTokens = Math.ceil(totalOutputChars / OUTPUT_TOKEN_CHAR_RATIO);
  const caseCount = entries.length;
  const previousCaseCount = Object.keys(previousCases).length;
  const minimumWarningInvocationCount =
    params.minimumWarningInvocationCount ?? 1;
  const subject = incoming.kind === "noisy-polling"
    ? `repeated queued check${caseCount === 1 ? "" : "s"}`
    : `noisy tool-output case${caseCount === 1 ? "" : "s"}`;
  const message = `${caseCount.toLocaleString()} ${subject} in this turn produced ${totalOutputChars.toLocaleString()} characters (~${estimatedOutputTokens.toLocaleString()} tokens). The worst case produced ${worstCase.outputChars.toLocaleString()} characters.`;
  const alert: ThreadToolInvocationAlert = {
    ...(params.current?.alert ?? incoming),
    alertId: incoming.alertId,
    estimatedOutputTokens,
    firstObservedAt: Math.min(
      params.current?.alert.firstObservedAt ?? incoming.firstObservedAt,
      incoming.firstObservedAt,
    ),
    invocationCount: caseCount,
    invocationIds: entries.map(([id]) => id),
    lastObservedAt: Math.max(
      params.current?.alert.lastObservedAt ?? incoming.lastObservedAt,
      incoming.lastObservedAt,
    ),
    message,
    severity,
    suggestedPrompt: incoming.suggestedPrompt,
    totalOutputChars,
    updatedAt: incoming.updatedAt,
    worstInvocationId,
    worstOutputChars: worstCase.outputChars,
  };
  return {
    aggregate: { alert, cases },
    shouldNotify:
      severity === "critical"
        ? newInvocationIds.length > 0 || escalated
        : caseCount >= minimumWarningInvocationCount
          && (
            previousCaseCount < minimumWarningInvocationCount
            || newInvocationIds.length > 0
          ),
  };
}

export function buildToolInvocationSteeringPrompt(params: {
  invocation: ThreadToolInvocationRecord;
  reason: string;
}): string {
  return buildThreadToolIncidentPrompt(params);
}

export function toolInvocationFromNotification(params: {
  backend: AppServerBackendKind;
  largeOutputThresholdChars?: number;
  notification: AppServerNotification;
  now?: number;
}): ThreadToolInvocationRecord | undefined {
  const now = params.now ?? Date.now();
  if (
    params.notification.method !== "item/started" &&
    params.notification.method !== "item/completed" &&
    params.notification.method !== "item/commandExecution/outputDelta"
  ) {
    return undefined;
  }

  if (params.notification.method === "item/commandExecution/outputDelta") {
    const notificationParams = params.notification.params as {
      delta: string;
      itemId: string;
      threadId: string;
      turnId?: string;
    };
    const metrics = buildToolOutputMetrics(notificationParams.delta);
    return {
      ...emptyInvocationMetrics(metrics),
      backend: params.backend,
      category: "shell",
      invocationId: buildToolInvocationId({
        backend: params.backend,
        itemId: notificationParams.itemId,
        threadId: notificationParams.threadId,
        turnId: notificationParams.turnId,
      }),
      itemId: notificationParams.itemId,
      observedAt: now,
      outputTruncated: metrics.outputTruncated,
      status: "in_progress",
      threadId: notificationParams.threadId,
      toolName: "commandExecution",
      ...(notificationParams.turnId
        ? { turnId: notificationParams.turnId }
        : {}),
      updatedAt: now,
    };
  }

  const notificationParams = params.notification.params as {
    item: Record<string, unknown>;
    threadId: string;
    turnId?: string;
  };
  const item = readRecord(notificationParams.item);
  if (!item) {
    return undefined;
  }
  const itemType = readString(item, "type");
  if (!itemType || !ACCOUNTED_TOOL_ITEM_TYPES.has(itemType)) {
    return undefined;
  }
  if (
    itemType !== "commandExecution"
    && params.notification.method === "item/started"
  ) {
    return undefined;
  }

  const itemId = readString(item, "id") ?? `tool:${now}`;
  const args = readToolArguments(item);
  const toolName =
    readString(item, "toolName") ??
    readString(item, "tool_name") ??
    readString(item, "tool") ??
    readString(item, "name") ??
    readString(item, "type") ??
    "commandExecution";
  const command =
    readString(item, "command") ??
    readString(args, "cmd") ??
    readString(args, "command");
  const output = readToolOutput(item);
  const metrics = buildToolOutputMetrics(output.text, {
    outputTruncated: output.truncated,
  });
  if (
    itemType !== "commandExecution"
    && toolName !== "wait"
    && toolName !== "write_stdin"
    && metrics.outputChars
      < (params.largeOutputThresholdChars ?? LARGE_OUTPUT_WARNING_CHARS)
  ) {
    // Function, dynamic, and MCP calls are a much broader stream than the
    // original command accounting surface. Persist only polling signals and
    // genuinely large results; otherwise enabling this detector would add one
    // sqlite commit for every ordinary local tool call.
    return undefined;
  }
  const normalized = normalizeToolInvocationCommand({
    args,
    command,
    itemType,
    ...(readString(item, "server") ? { server: readString(item, "server") } : {}),
    toolName,
  });
  const processId =
    readString(item, "processId") ??
    readString(item, "process_id") ??
    readString(item, "pid") ??
    readString(readRecord(item.data), "processId") ??
    readString(readRecord(item.data), "process_id") ??
    readString(readRecord(item.data), "pid");
  const sessionId =
    readString(args, "session_id") ??
    readString(args, "sessionId") ??
    readString(args, "cell_id") ??
    readString(args, "cellId") ??
    readString(item, "sessionId") ??
    readString(item, "session_id");
  const exitCode = readExitCode(item);
  const status = normalizeToolInvocationStatus({
    exitCode: exitCode.exitCode,
    method: params.notification.method,
    status: readString(item, "status"),
    success: readToolSuccess(item),
  });

  return {
    ...emptyInvocationMetrics(metrics),
    backend: params.backend,
    category: normalized.category,
    invocationId: buildToolInvocationId({
      backend: params.backend,
      itemId,
      threadId: notificationParams.threadId,
      turnId: notificationParams.turnId,
    }),
    itemId,
    observedAt: now,
    outputTruncated: metrics.outputTruncated,
    status,
    threadId: notificationParams.threadId,
    toolName,
    updatedAt: now,
    ...(status === "in_progress" ? { startedAt: now } : {}),
    ...(status === "completed" || status === "failed" || status === "cancelled"
      ? { completedAt: now }
      : {}),
    ...(notificationParams.turnId
      ? { turnId: notificationParams.turnId }
      : {}),
    ...(normalized.normalizedCommand
      ? { normalizedCommand: normalized.normalizedCommand }
      : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(processId ? { processId } : {}),
    ...exitCode,
  };
}

export function buildToolOutputMetrics(
  output: string | undefined,
  options?: { outputTruncated?: boolean },
): ToolInvocationOutputMetrics {
  const text = output ?? "";
  const lines = splitOutputLines(text);
  let debugLines = 0;
  let errorLines = 0;
  let infoLines = 0;
  let warningLines = 0;
  for (const line of lines) {
    if (/\[(?:warn|warning)\]|\bwarn(?:ing)?\b/i.test(line)) {
      warningLines += 1;
    }
    if (/\[error\]|\berror\b|\bfailed\b|\bfailure\b|\bexception\b/i.test(line)) {
      errorLines += 1;
    }
    if (/\[debug\]|\bdebug\b|\btrace\b/i.test(line)) {
      debugLines += 1;
    }
    if (/\[info\]|\binfo\b|\bnotice\b/i.test(line)) {
      infoLines += 1;
    }
  }

  return {
    debugLines,
    errorLines,
    estimatedOutputTokens: Math.ceil(text.length / OUTPUT_TOKEN_CHAR_RATIO),
    infoLines,
    outputChars: text.length,
    outputLines: lines.length,
    outputTruncated:
      Boolean(options?.outputTruncated) ||
      /\btruncated\b|additional lines omitted|output clipped/i.test(text),
    warningLines,
  };
}

/**
 * Fold one streamed `item/commandExecution/outputDelta` record into the
 * running accumulator for the same invocation.
 *
 * Codex emits fixed 8 KiB output deltas — a `find /` style command measured at
 * ~444 deltas/second — and each one used to become its own sqlite read+write
 * on the main process, inline in the event pipeline. Accumulating in memory
 * and writing once per flush window keeps the totals identical while turning
 * thousands of writes into a handful.
 *
 * The summing rules mirror `mergeThreadToolInvocationForUpsert` in
 * `overlay-store-sqlite.ts` for the in-progress case, so a coalesced record
 * merges onto the stored row exactly as the individual deltas would have.
 *
 * BOTH arguments must come from the `item/commandExecution/outputDelta` branch
 * of `toolInvocationFromNotification`, and `incoming` must be the newer of the
 * two. Only counters are combined; every other field is taken from `incoming`,
 * so passing a lifecycle record here would drop the other one's `exitCode`,
 * `completedAt`, `normalizedCommand`, and `sessionId`. Delta records carry
 * none of those, which is what makes the wholesale take safe.
 */
export function mergeStreamedToolInvocationDeltas(
  accumulated: ThreadToolInvocationRecord,
  incoming: ThreadToolInvocationRecord,
): ThreadToolInvocationRecord {
  const outputChars = accumulated.outputChars + incoming.outputChars;
  return {
    ...incoming,
    debugLines: accumulated.debugLines + incoming.debugLines,
    errorLines: accumulated.errorLines + incoming.errorLines,
    estimatedOutputTokens: Math.ceil(outputChars / OUTPUT_TOKEN_CHAR_RATIO),
    infoLines: accumulated.infoLines + incoming.infoLines,
    observedAt: Math.max(accumulated.observedAt, incoming.observedAt),
    outputChars,
    outputLines: accumulated.outputLines + incoming.outputLines,
    outputTruncated: accumulated.outputTruncated || incoming.outputTruncated,
    updatedAt: Math.max(accumulated.updatedAt, incoming.updatedAt),
    warningLines: accumulated.warningLines + incoming.warningLines,
  };
}

export function mergeToolInvocationLifecycleWithStreamedOutput(
  lifecycle: ThreadToolInvocationRecord,
  streamed: ThreadToolInvocationRecord | undefined,
): ThreadToolInvocationRecord {
  if (!streamed) {
    return lifecycle;
  }
  const outputChars = Math.max(lifecycle.outputChars, streamed.outputChars);
  return {
    ...lifecycle,
    debugLines: Math.max(lifecycle.debugLines, streamed.debugLines),
    errorLines: Math.max(lifecycle.errorLines, streamed.errorLines),
    estimatedOutputTokens: Math.ceil(outputChars / OUTPUT_TOKEN_CHAR_RATIO),
    infoLines: Math.max(lifecycle.infoLines, streamed.infoLines),
    observedAt: Math.max(lifecycle.observedAt, streamed.observedAt),
    outputChars,
    outputLines: Math.max(lifecycle.outputLines, streamed.outputLines),
    outputTruncated: lifecycle.outputTruncated || streamed.outputTruncated,
    startedAt: Math.min(
      lifecycle.startedAt ?? lifecycle.observedAt,
      streamed.startedAt ?? streamed.observedAt,
    ),
    updatedAt: Math.max(lifecycle.updatedAt, streamed.updatedAt),
    warningLines: Math.max(lifecycle.warningLines, streamed.warningLines),
  };
}

export function normalizeToolInvocationCommand(params: {
  args?: Record<string, unknown>;
  command?: string;
  itemType?: string;
  server?: string;
  toolName: string;
}): NormalizedToolCommand {
  const toolName = params.toolName.trim() || "unknown";
  /* MCP is declared by the protocol item, not inferred from the name. The
     name-substring fallback below filed Context7's `query-docs` under
     unknown while `list_mcp_resources` matched by luck. The server joins the
     stored identity so surfaces can split cost per MCP. */
  if (params.itemType === "mcpToolCall" || params.server) {
    return {
      category: "mcp",
      normalizedCommand: params.server
        ? `${params.server}/${toolName}`
        : toolName,
    };
  }
  if (toolName === "write_stdin") {
    const sessionId = readString(params.args, "session_id") ??
      readString(params.args, "sessionId");
    const chars = readString(params.args, "chars");
    const isPollingRead = chars === undefined || chars.length === 0;
    return {
      category: isPollingRead ? "polling" : "shell",
      normalizedCommand:
        isPollingRead
          ? `poll session ${sessionId ?? "unknown"}`
          : `write stdin session ${sessionId ?? "unknown"}`,
    };
  }

  if (toolName === "wait") {
    const cellId =
      readString(params.args, "cell_id")
      ?? readString(params.args, "cellId");
    return {
      category: "polling",
      normalizedCommand: `wait cell ${cellId ?? "unknown"}`,
    };
  }

  if (
    toolName === "create_monitor_delegation" ||
    toolName === "spawn_agent" ||
    toolName === "handoff_task"
  ) {
    return {
      category: "sub-agent",
      normalizedCommand: toolName,
    };
  }

  const command = normalizeShellCommand(params.command ?? readString(params.args, "cmd"));
  if (!command) {
    return {
      category: categoryForToolName(toolName),
      normalizedCommand: toolName,
    };
  }

  return {
    category: categoryForCommand(command),
    normalizedCommand: command,
  };
}

export function detectNoisyPolling(params: {
  current: ThreadToolInvocationRecord;
  recent: ThreadToolInvocationRecord[];
  now?: number;
}): NoisyPollingDetection | undefined {
  const current = params.current;
  const isDeferredWait = current.toolName === "wait";
  const isShellDelay =
    current.category === "polling"
    && current.normalizedCommand?.startsWith("sleep ") === true;
  const isTurnScopedPolling = isDeferredWait || isShellDelay;
  if (
    (current.toolName !== "write_stdin" && !isTurnScopedPolling) ||
    current.category !== "polling" ||
    (isTurnScopedPolling
      ? !current.turnId
      : (!current.sessionId && !current.processId))
  ) {
    return undefined;
  }

  const now = params.now ?? current.observedAt;
  const lookbackSince = now - NOISY_POLL_LOOKBACK_MS;
  const uniqueRecords = new Map<string, ThreadToolInvocationRecord>();
  for (const record of [...params.recent, current]) {
    uniqueRecords.set(record.invocationId, record);
  }
  const records = [...uniqueRecords.values()]
    .filter(
      (record) =>
        record.toolName === current.toolName &&
        record.category === "polling" &&
        record.observedAt >= lookbackSince &&
        (isTurnScopedPolling
          ? record.turnId === current.turnId
          : (
              (!current.sessionId || record.sessionId === current.sessionId) &&
              (!current.processId || record.processId === current.processId)
            )),
    )
    .sort((left, right) => left.observedAt - right.observedAt);

  if (records.length < NOISY_POLL_MIN_INVOCATIONS) {
    return undefined;
  }

  const intervals = records
    .slice(1)
    .map((record, index) => record.observedAt - records[index]!.observedAt);
  const pollLikeIntervals = intervals.filter(
    (interval) =>
      interval >= NOISY_POLL_MIN_INTERVAL_MS &&
      interval <= NOISY_POLL_MAX_INTERVAL_MS,
  );
  const totalOutputChars = records.reduce(
    (sum, record) => sum + record.outputChars,
    0,
  );
  if (pollLikeIntervals.length < NOISY_POLL_MIN_INVOCATIONS - 1) {
    return undefined;
  }

  const averageIntervalMs = Math.round(
    intervals.reduce((sum, interval) => sum + interval, 0) / intervals.length,
  );
  const estimatedOutputTokens = Math.ceil(totalOutputChars / OUTPUT_TOKEN_CHAR_RATIO);
  const sessionLabel = isTurnScopedPolling
    ? "the current turn"
    : current.sessionId
      ? `session ${current.sessionId}`
      : `process ${current.processId}`;
  const message =
    `${records.length.toLocaleString()} queued checks on ${sessionLabel} are repeatedly waking the model and replaying its accumulated context. The checks returned ${totalOutputChars.toLocaleString()} chars (~${estimatedOutputTokens.toLocaleString()} output tokens), but replay cost applies even when they return little or nothing.`;
  const suggestedPrompt = buildToolInvocationSteeringPrompt({
    invocation: current,
    reason: "repeated queued checks are waking the model and replaying accumulated context",
  });

  return {
    alert: {
      alertId: [
        "noisy-polling",
        current.backend,
        current.threadId,
        current.turnId ?? "no-turn",
      ].join(":"),
      averageIntervalMs,
      backend: current.backend,
      createdAt: now,
      estimatedOutputTokens,
      firstObservedAt: records[0]!.observedAt,
      invocationCount: records.length,
      kind: "noisy-polling",
      lastObservedAt: records[records.length - 1]!.observedAt,
      message,
      ...(current.processId ? { processId: current.processId } : {}),
      ...(current.sessionId ? { sessionId: current.sessionId } : {}),
      severity: "warning",
      suggestedPrompt,
      threadId: current.threadId,
      ...(current.turnId ? { turnId: current.turnId } : {}),
      toolName: current.toolName,
      totalOutputChars,
      updatedAt: now,
    },
    cases: Object.fromEntries(records.map((record) => [
      record.invocationId,
      { outputChars: record.outputChars },
    ])),
    invocationIds: records.map((record) => record.invocationId),
    lookbackSince,
  };
}

export function detectLargeToolOutput(params: {
  current: ThreadToolInvocationRecord;
  policy?: DesktopToolOutputAlertPolicy;
  previousOutputChars?: number;
  now?: number;
}): LargeToolOutputDetection | undefined {
  const current = params.current;
  const policy = params.policy ?? DESKTOP_TOOL_OUTPUT_ALERT_POLICY_DEFAULT;
  const warningOutputChars = toolOutputWarningChars(
    policy.repeatedLargeOutputMinimumPercent,
  );
  const previousOutputChars = params.previousOutputChars ?? 0;
  const crossedWarning =
    previousOutputChars < warningOutputChars
    && current.outputChars >= warningOutputChars;
  const crossedCritical =
    previousOutputChars < LARGE_OUTPUT_CRITICAL_CHARS
    && current.outputChars >= LARGE_OUTPUT_CRITICAL_CHARS;
  const warningEligible =
    policy.repeatedLargeOutputsEnabled
    && current.outputChars >= warningOutputChars;
  const criticalEligible =
    policy.outputCapHitsEnabled
    && current.outputChars >= LARGE_OUTPUT_CRITICAL_CHARS;
  const terminal = current.status !== "in_progress";
  if (
    (!warningEligible && !criticalEligible)
    || (
      !(policy.repeatedLargeOutputsEnabled && crossedWarning)
      && !(policy.outputCapHitsEnabled && crossedCritical)
      && !terminal
    )
  ) {
    return undefined;
  }

  const now = params.now ?? current.observedAt;
  const critical = criticalEligible;
  const estimatedCapPercentage = Math.max(
    1,
    Math.round(current.outputChars / LARGE_OUTPUT_CRITICAL_CHARS * 100),
  );
  const message = critical
    ? `This tool produced ${current.outputChars.toLocaleString()} characters (~${current.estimatedOutputTokens.toLocaleString()} tokens), reaching or exceeding the observed model-visible output cap. The retained portion will replay on subsequent inference items.`
    : `This tool has produced ${current.outputChars.toLocaleString()} characters (~${current.estimatedOutputTokens.toLocaleString()} tokens), about ${estimatedCapPercentage.toLocaleString()}% of the observed model-visible output cap. Continuing unfiltered will enlarge every later context replay.`;
  const noisyReason = critical
    ? "output reached or exceeded the observed model-visible cap"
    : "large output will be replayed on later inference items";
  const suggestedPrompt = buildToolInvocationSteeringPrompt({
    invocation: {
      ...current,
      outputState: current.outputTruncated ? "truncated" : "available",
    },
    reason: noisyReason,
  });

  return {
    alert: {
      alertId: [
        "large-output",
        current.backend,
        current.threadId,
        current.turnId ?? "no-turn",
      ].join(":"),
      backend: current.backend,
      createdAt: now,
      estimatedOutputTokens: current.estimatedOutputTokens,
      firstObservedAt: current.startedAt ?? current.observedAt,
      invocationCount: 1,
      kind: "large-output",
      lastObservedAt: current.observedAt,
      message,
      ...(current.processId ? { processId: current.processId } : {}),
      ...(current.sessionId ? { sessionId: current.sessionId } : {}),
      severity: critical ? "critical" : "warning",
      suggestedPrompt,
      threadId: current.threadId,
      ...(current.turnId ? { turnId: current.turnId } : {}),
      toolName: current.toolName,
      totalOutputChars: current.outputChars,
      updatedAt: now,
    },
    cases: {
      [current.invocationId]: { outputChars: current.outputChars },
    },
    invocationIds: [current.invocationId],
  };
}

export function toolAccountingLookbackSince(now: number): number {
  return now - NOISY_POLL_LOOKBACK_MS;
}

function emptyInvocationMetrics(
  metrics: ToolInvocationOutputMetrics,
): Pick<
  ThreadToolInvocationRecord,
  | "debugLines"
  | "errorLines"
  | "estimatedOutputTokens"
  | "infoLines"
  | "noisy"
  | "outputChars"
  | "outputLines"
  | "warningLines"
> {
  return {
    debugLines: metrics.debugLines,
    errorLines: metrics.errorLines,
    estimatedOutputTokens: metrics.estimatedOutputTokens,
    infoLines: metrics.infoLines,
    noisy: false,
    outputChars: metrics.outputChars,
    outputLines: metrics.outputLines,
    warningLines: metrics.warningLines,
  };
}

function buildToolInvocationId(params: {
  backend: string;
  threadId: string;
  turnId?: string;
  itemId: string;
}): string {
  return [
    "tool",
    params.backend,
    params.threadId,
    params.turnId ?? "no-turn",
    params.itemId,
  ].join(":");
}

function normalizeToolInvocationStatus(params: {
  exitCode?: number;
  method: "item/started" | "item/completed";
  status: string | undefined;
  success?: boolean;
}): ThreadToolInvocationStatus {
  if (params.method === "item/started") {
    return "in_progress";
  }
  if (params.status === "failed" || params.success === false) {
    return "failed";
  }
  if (params.exitCode !== undefined && params.exitCode !== 0) {
    return "failed";
  }
  if (params.status === "cancelled" || params.status === "completed") {
    return params.status;
  }
  return "completed";
}

function normalizeShellCommand(command: string | undefined): string | undefined {
  const trimmed = command?.replace(/\s+/g, " ").trim();
  if (!trimmed) {
    return undefined;
  }
  const shellMatch = trimmed.match(/^\/?(?:bin\/)?(?:ba|z|)sh\s+-lc\s+['"](.+)['"]$/);
  return redactCommandText(shellMatch?.[1]?.trim() || trimmed);
}

function categoryForToolName(toolName: string): ThreadToolInvocationCategory {
  if (/^mcp(?:__|ToolCall$)/i.test(toolName) || toolName.includes("mcp")) {
    return "mcp";
  }
  if (
    toolName === "read_file" ||
    toolName === "list_files" ||
    toolName === "edit_file" ||
    toolName === "write_file"
  ) {
    return "file-io";
  }
  if (toolName === "search_code" || toolName === "grep") {
    return "search";
  }
  if (toolName === "exec_command" || toolName === "commandExecution") {
    return "shell";
  }
  return "unknown";
}

function categoryForCommand(command: string): ThreadToolInvocationCategory {
  const lower = command.toLowerCase();
  const first = lower.split(/\s+/)[0] ?? "";
  if (first === "sleep") {
    return "polling";
  }
  if (first === "git") {
    return "git";
  }
  if (["rg", "grep", "find"].includes(first)) {
    return "search";
  }
  if (["cat", "head", "tail", "sed", "awk", "ls", "wc"].includes(first)) {
    return "file-io";
  }
  if (["npm", "pnpm", "yarn", "bun", "npx"].includes(first)) {
    return "package-manager";
  }
  if (
    first === "sbt" ||
    first === "mvn" ||
    first === "gradle" ||
    lower.includes(" test") ||
    lower.includes(" vitest") ||
    lower.includes(" jest")
  ) {
    return "build-test";
  }
  return "shell";
}

function splitOutputLines(text: string): string[] {
  if (!text) {
    return [];
  }
  const lines = text.split(/\r\n|\r|\n/);
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

function readToolArguments(
  item: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const args = item?.arguments;
  if (!args) {
    return undefined;
  }
  if (typeof args === "string") {
    try {
      const parsed = JSON.parse(args) as unknown;
      return readRecord(parsed);
    } catch {
      return undefined;
    }
  }
  return readRecord(args);
}

function readToolOutput(
  item: Record<string, unknown> | undefined,
): { text?: string; truncated?: boolean } {
  const data = readRecord(item?.data);
  const value = [
    item?.aggregatedOutput,
    item?.aggregated_output,
    item?.functionCallOutput,
    data?.aggregatedOutput,
    data?.aggregated_output,
    data?.output,
    data?.text,
    data?.result,
    item?.result,
    item?.output,
    item?.stdout,
    item?.stderr,
  ].find((candidate) => candidate !== undefined && candidate !== null);
  const text = serializeToolOutputValue(value);
  const truncated =
    readBoolean(data, "outputTruncated") ??
    readBoolean(data, "output_truncated") ??
    readBoolean(data, "truncated") ??
    readBoolean(item, "outputTruncated") ??
    readBoolean(item, "output_truncated") ??
    readBoolean(item, "truncated");
  return { text, truncated };
}

function serializeToolOutputValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (value === undefined || value === null) {
    return undefined;
  }
  try {
    return JSON.stringify(value);
  } catch {
    // App-server notifications are JSON, so this is defensive only. If a
    // malformed in-process test double supplies a cyclic or otherwise
    // unserializable result, skip accounting instead of breaking event fanout.
    return undefined;
  }
}

function readExitCode(
  item: Record<string, unknown> | undefined,
): Pick<ThreadToolInvocationRecord, "exitCode"> {
  const data = readRecord(item?.data);
  const value =
    readNumber(item, "exitCode") ??
    readNumber(item, "exit_code") ??
    readNumber(data, "exitCode") ??
    readNumber(data, "exit_code");
  return value === undefined ? {} : { exitCode: value };
}

function readToolSuccess(
  item: Record<string, unknown> | undefined,
): boolean | undefined {
  const data = readRecord(item?.data);
  return (
    readBoolean(item, "success") ??
    readBoolean(item, "ok") ??
    readBoolean(data, "success") ??
    readBoolean(data, "ok")
  );
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readString(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

function readNumber(
  record: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value)
    ? Math.floor(value)
    : undefined;
}

function readBoolean(
  record: Record<string, unknown> | undefined,
  key: string,
): boolean | undefined {
  const value = record?.[key];
  return typeof value === "boolean" ? value : undefined;
}
