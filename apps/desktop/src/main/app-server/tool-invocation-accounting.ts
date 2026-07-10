import type {
  AppServerBackendKind,
  AppServerNotification,
  ThreadToolInvocationAlert,
  ThreadToolInvocationCategory,
  ThreadToolInvocationRecord,
  ThreadToolInvocationStatus,
} from "@pwragent/shared";

const OUTPUT_TOKEN_CHAR_RATIO = 4;
const NOISY_POLL_LOOKBACK_MS = 5 * 60 * 1000;
const NOISY_POLL_MIN_INVOCATIONS = 3;
const NOISY_POLL_MIN_OUTPUT_CHARS = 20_000;
const NOISY_POLL_MIN_INTERVAL_MS = 15_000;
const NOISY_POLL_MAX_INTERVAL_MS = 75_000;

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
  invocationIds: string[];
  lookbackSince: number;
};

export function toolInvocationFromNotification(params: {
  backend: AppServerBackendKind;
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
  if (readString(item, "type") !== "commandExecution") {
    return undefined;
  }

  const itemId = readString(item, "id") ?? `tool:${now}`;
  const args = readToolArguments(item);
  const toolName =
    readString(item, "toolName") ??
    readString(item, "tool_name") ??
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
  const normalized = normalizeToolInvocationCommand({
    args,
    command,
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
    readString(item, "sessionId") ??
    readString(item, "session_id");
  const status = normalizeToolInvocationStatus(
    readString(item, "status"),
    params.notification.method,
  );

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
    ...readExitCode(item),
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

export function normalizeToolInvocationCommand(params: {
  args?: Record<string, unknown>;
  command?: string;
  toolName: string;
}): NormalizedToolCommand {
  const toolName = params.toolName.trim() || "unknown";
  if (toolName === "write_stdin") {
    const sessionId = readString(params.args, "session_id") ??
      readString(params.args, "sessionId");
    const chars = readString(params.args, "chars");
    return {
      category: "polling",
      normalizedCommand:
        chars === undefined || chars.length === 0
          ? `poll session ${sessionId ?? "unknown"}`
          : `write stdin session ${sessionId ?? "unknown"}`,
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
  if (
    current.toolName !== "write_stdin" ||
    current.category !== "polling" ||
    (!current.sessionId && !current.processId)
  ) {
    return undefined;
  }

  const now = params.now ?? current.observedAt;
  const lookbackSince = now - NOISY_POLL_LOOKBACK_MS;
  const records = [
    current,
    ...params.recent.filter((record) => record.invocationId !== current.invocationId),
  ]
    .filter(
      (record) =>
        record.toolName === current.toolName &&
        record.category === "polling" &&
        record.observedAt >= lookbackSince &&
        (!current.sessionId || record.sessionId === current.sessionId) &&
        (!current.processId || record.processId === current.processId),
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
  if (
    pollLikeIntervals.length < NOISY_POLL_MIN_INVOCATIONS - 1 ||
    totalOutputChars < NOISY_POLL_MIN_OUTPUT_CHARS
  ) {
    return undefined;
  }

  const averageIntervalMs = Math.round(
    intervals.reduce((sum, interval) => sum + interval, 0) / intervals.length,
  );
  const estimatedOutputTokens = Math.ceil(totalOutputChars / OUTPUT_TOKEN_CHAR_RATIO);
  const sessionLabel = current.sessionId
    ? `session ${current.sessionId}`
    : `process ${current.processId}`;
  const message =
    `Repeated write_stdin polling on ${sessionLabel} produced ${totalOutputChars.toLocaleString()} chars (~${estimatedOutputTokens.toLocaleString()} output tokens) across ${records.length.toLocaleString()} checks.`;
  const suggestedPrompt = [
    "Stop polling this long-running process in the main thread.",
    "Use PwrAgent's create_monitor_delegation tool with the durable command, cwd, log/status files, poll cadence, and terminal success/failure criteria.",
    "Continue unrelated work here, and let the monitor report completion back to this thread.",
  ].join(" ");

  return {
    alert: {
      alertId: [
        "noisy-polling",
        current.backend,
        current.threadId,
        current.toolName,
        current.sessionId ?? current.processId ?? "unknown",
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
      toolName: current.toolName,
      totalOutputChars,
      updatedAt: now,
    },
    invocationIds: records.map((record) => record.invocationId),
    lookbackSince,
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

function normalizeToolInvocationStatus(
  status: string | undefined,
  method: "item/started" | "item/completed",
): ThreadToolInvocationStatus {
  if (method === "item/started") {
    return "in_progress";
  }
  if (status === "failed" || status === "cancelled" || status === "completed") {
    return status;
  }
  return "completed";
}

function normalizeShellCommand(command: string | undefined): string | undefined {
  const trimmed = command?.replace(/\s+/g, " ").trim();
  if (!trimmed) {
    return undefined;
  }
  const shellMatch = trimmed.match(/^\/?(?:bin\/)?(?:ba|z|)sh\s+-lc\s+['"](.+)['"]$/);
  return shellMatch?.[1]?.trim() || trimmed;
}

function categoryForToolName(toolName: string): ThreadToolInvocationCategory {
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
  const text =
    readString(data, "output") ??
    readString(data, "text") ??
    readString(data, "result") ??
    readString(item, "output") ??
    readString(item, "stdout") ??
    readString(item, "stderr");
  const truncated =
    readBoolean(data, "outputTruncated") ??
    readBoolean(data, "output_truncated") ??
    readBoolean(data, "truncated") ??
    readBoolean(item, "outputTruncated") ??
    readBoolean(item, "output_truncated") ??
    readBoolean(item, "truncated");
  return { text, truncated };
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
