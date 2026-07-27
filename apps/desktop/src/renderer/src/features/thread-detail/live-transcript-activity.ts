import {
  estimateOpenAiTokenUsageCost,
  formatSearchCommandActionLabel,
  formatTokenUsagePriceFactor,
  formatTokenUsageStandardRateSuffix,
  formatTokenUsageUsd,
  formatTokenUsageUsdPerMillion,
  resolveOpenAiPricingServiceTier,
  truncateRendererPayloadString,
  type AppServerSource,
  type AppServerThreadActivityDetail,
  type AppServerThreadActivityEntry,
  type AppServerThreadCommandDetail,
  type AppServerThreadTurnMetadata,
} from "@pwragent/shared";

export const RENDERER_SEQUENCE_KEY = "__rendererSequence" as const;

export function readRendererSequence(entry: object | undefined): number | undefined {
  if (!entry) {
    return undefined;
  }
  const value = (entry as Record<string, unknown>)[RENDERER_SEQUENCE_KEY];
  return typeof value === "number" ? value : undefined;
}

export function withRendererSequence<T extends object>(entry: T, sequence: number): T {
  return { ...entry, [RENDERER_SEQUENCE_KEY]: sequence } as T;
}

export function getNotificationItem(
  params: Record<string, unknown>
): Record<string, unknown> | undefined {
  return typeof params.item === "object" && params.item !== null && !Array.isArray(params.item)
    ? params.item as Record<string, unknown>
    : undefined;
}

function readString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNumber(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readFiniteNumber(
  record: Record<string, unknown> | undefined,
  keys: string[],
): number | undefined {
  for (const key of keys) {
    const value = readNumber(record, key);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function findFirstNestedValue(
  value: unknown,
  keys: string[],
): unknown {
  const record = readRecord(value);
  if (!record) {
    return undefined;
  }

  for (const key of keys) {
    if (record[key] !== undefined) {
      return record[key];
    }
  }

  for (const child of Object.values(record)) {
    const nested = findFirstNestedValue(child, keys);
    if (nested !== undefined) {
      return nested;
    }
  }

  return undefined;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
    : [];
}

function normalizeTimestamp(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return value < 1_000_000_000_000 ? value * 1_000 : value;
}

function readToolArgument(item: Record<string, unknown>, key: string): string | undefined {
  const argumentsRecord =
    readRecord(item.arguments) ?? readRecord(item.input);
  return readString(argumentsRecord, key);
}

function readToolOutputText(item: Record<string, unknown>): string | undefined {
  const toolName = readString(item, "toolName") ?? readString(item, "tool_name");
  const data = readRecord(item.data);
  const output =
    readString(data, "output") ??
    readString(data, "text") ??
    readString(data, "result") ??
    readString(item, "text");
  return output && output !== toolName ? output : undefined;
}

function readCommandOutputText(item: Record<string, unknown>): string | undefined {
  const data = readRecord(item.data);
  return (
    readString(item, "aggregatedOutput") ??
    readString(item, "aggregated_output") ??
    readString(item, "output") ??
    readString(data, "aggregatedOutput") ??
    readString(data, "aggregated_output") ??
    readString(data, "output")
  );
}

function readExitCode(item: Record<string, unknown>): number | undefined {
  const data = readRecord(item.data);
  return readNumber(item, "exitCode") ?? readNumber(item, "exit_code") ??
    readNumber(data, "exitCode") ?? readNumber(data, "exit_code");
}

function readElapsedMs(item: Record<string, unknown>): number | undefined {
  const data = readRecord(item.data);
  const direct =
    readNumber(item, "durationMs") ??
    readNumber(item, "elapsedMs") ??
    readNumber(data, "durationMs") ??
    readNumber(data, "elapsedMs");
  if (typeof direct === "number") {
    return direct;
  }

  const startedAt = normalizeTimestamp(item.startedAt);
  const completedAt = normalizeTimestamp(item.completedAt);
  return typeof startedAt === "number" &&
    typeof completedAt === "number" &&
    completedAt >= startedAt
    ? completedAt - startedAt
    : undefined;
}

function formatElapsedMs(elapsedMs: number): string {
  if (elapsedMs < 1_000) {
    return `${elapsedMs}ms`;
  }
  const seconds = elapsedMs / 1_000;
  return seconds >= 10 ? `${seconds.toFixed(0)}s` : `${seconds.toFixed(1)}s`;
}

// Strip a leading shell-interpreter wrapper so we show the command the agent
// actually ran rather than the interpreter's full path. Handles POSIX login
// shells (`/bin/sh -lc <cmd>`, `bash -lc <cmd>`) and Windows interpreters
// (`"C:\...\powershell.exe" -Command <cmd>`, `cmd.exe /c <cmd>`,
// `bash.exe -lc <cmd>`). The full, unmodified command is preserved separately
// as `rawCommand` for the expanded details view.
//
// The Windows branch matches the interpreter path in two forms: quoted
// (`"[^"]*…\.exe"`, which permits spaces — e.g. `"C:\Program Files\Git\bin\
// bash.exe"`) and unquoted (`[^\s"]*…\.exe`, no spaces). A single
// `[^\s"]*` couldn't span a spaced path inside quotes, so a quoted Git-bash
// invocation under "Program Files" would otherwise show the full path.
function stripShellWrapper(command: string): string {
  return command
    .trim()
    .replace(/^(?:\/\S+\/)?(?:ba|z)?sh\s+-lc\s+/i, "")
    .replace(
      /^(?:"[^"]*(?:powershell|pwsh|cmd|bash)\.exe"|[^\s"]*(?:powershell|pwsh|cmd|bash)\.exe)\s+(?:-Command|-lc|-c|\/d\s+\/s\s+\/c|\/c)\s+/i,
      "",
    )
    .trim();
}

function normalizeCommandText(command: string): string {
  return stripShellWrapper(command)
    .replace(/^['"]|['"]$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function formatCommandLabel(command: string | undefined): string {
  if (!command) {
    return "Ran command";
  }
  const collapsed = normalizeCommandText(command);
  if (!collapsed) {
    return "Ran command";
  }

  return collapsed.length > 72 ? `${collapsed.slice(0, 69)}...` : collapsed;
}

function readDisplayCommand(command: string | undefined): string | undefined {
  if (!command) {
    return undefined;
  }
  return normalizeCommandText(command) || undefined;
}

function buildLiveCommandDetail(
  item: Record<string, unknown>,
  command: string | undefined,
  elapsedMs: number | undefined
): AppServerThreadCommandDetail | undefined {
  const displayCommand = readDisplayCommand(command);
  if (!displayCommand) {
    return undefined;
  }

  const output = readCommandOutputText(item);
  const source = readString(item, "commandSource");
  const exitCode = readExitCode(item);
  const cwd = readString(item, "cwd") ??
    readString(item, "workingDirectory") ??
    readString(item, "working_directory");
  return {
    displayCommand,
    ...(source === "tool"
      ? { source: "tool" as const }
      : { rawCommand: command }),
    ...(cwd ? { cwd } : {}),
    ...(output ? { output } : {}),
    ...(typeof exitCode === "number" ? { exitCode } : {}),
    ...(typeof elapsedMs === "number" ? { durationMs: elapsedMs } : {}),
  };
}

type TokenUsageBreakdown = {
  cachedInputTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  totalTokens?: number;
};

type TokenUsageScope = "latest-request" | "total";

type NormalizedTokenUsage = {
  scope: TokenUsageScope;
  tokens: TokenUsageBreakdown;
};

export function buildTokenUsageActivityEntry(params: {
  fastMode?: boolean;
  id: string;
  model?: string;
  serviceTier?: string;
  summaryPrefix?: string;
  tokenUsage: unknown;
  turn?: AppServerThreadTurnMetadata;
}): AppServerThreadActivityEntry | undefined {
  const normalized = normalizeTokenUsage(params.tokenUsage);
  if (!normalized) {
    return undefined;
  }

  const { scope, tokens } = normalized;
  const cachedInputTokens = Math.max(0, tokens.cachedInputTokens ?? 0);
  const inputTokens = Math.max(0, tokens.inputTokens ?? 0);
  const uncachedInputTokens = Math.max(0, inputTokens - cachedInputTokens);
  const outputTokens = Math.max(0, tokens.outputTokens ?? 0);
  const reasoningOutputTokens = Math.max(0, tokens.reasoningOutputTokens ?? 0);
  const billedOutputTokens = outputTokens + reasoningOutputTokens;
  const cost = estimateOpenAiTokenUsageCost({
    cachedInputTokens,
    fastMode: params.fastMode,
    model: params.model,
    outputTokens,
    reasoningOutputTokens,
    serviceTier: params.serviceTier,
    uncachedInputTokens,
  });
  const summaryParts = [
    `${formatTokenCount(uncachedInputTokens)} uncached in`,
    `${formatTokenCount(cachedInputTokens)} cached`,
    reasoningOutputTokens > 0
      ? `${formatTokenCount(outputTokens)} out (${formatTokenCount(reasoningOutputTokens)} reasoning)`
      : `${formatTokenCount(outputTokens)} out`,
    cost ? `${formatTokenUsageUsd(cost.totalUsd)} list price` : undefined,
  ].filter((part): part is string => Boolean(part));
  const summaryPrefix =
    params.summaryPrefix ??
    (scope === "latest-request" ? "Latest request usage" : "Usage");

  const details: AppServerThreadActivityDetail[] = [
    {
      id: `${params.id}-input`,
      kind: "read",
      label: `Input: ${formatTokenCount(inputTokens)} tokens (${formatTokenCount(
        uncachedInputTokens,
      )} uncached, ${formatTokenCount(cachedInputTokens)} cached)`,
      status: "completed",
    },
    {
      id: `${params.id}-output`,
      kind: "read",
      label: `Output: ${formatTokenCount(outputTokens)} tokens${
        reasoningOutputTokens > 0
          ? `, including ${formatTokenCount(reasoningOutputTokens)} reasoning`
          : ""
      }`,
      status: "completed",
    },
  ];
  if (cost) {
    details.push(
      {
        id: `${params.id}-uncached-input-cost`,
        kind: "read",
        label: `Uncached input cost: ${formatTokenCount(
          uncachedInputTokens,
        )} tokens at ${formatTokenUsageUsdPerMillion(
          cost.inputUsdPerMillion,
        )}/M${formatTokenUsageStandardRateSuffix(
          cost.standardInputRateMultiplier,
        )} = ${formatTokenUsageUsd(cost.uncachedInputUsd)}`,
        status: "completed",
      },
      {
        id: `${params.id}-cached-input-cost`,
        kind: "read",
        label: `Cached input cost: ${formatTokenCount(
          cachedInputTokens,
        )} tokens at ${formatTokenUsageUsdPerMillion(
          cost.cachedInputUsdPerMillion,
        )}/M (${formatTokenUsagePriceFactor(
          cost.cachedInputUsdPerMillion,
          cost.inputUsdPerMillion,
        )} uncached${formatTokenUsageStandardRateSuffix(
          cost.standardCachedInputRateMultiplier,
          ", ",
        )}) = ${formatTokenUsageUsd(cost.cachedInputUsd)}`,
        status: "completed",
      },
      {
        id: `${params.id}-output-cost`,
        kind: "read",
        label: `Output cost: ${formatTokenCount(billedOutputTokens)} tokens at ${formatTokenUsageUsdPerMillion(
          cost.outputUsdPerMillion,
        )}/M${formatTokenUsageStandardRateSuffix(
          cost.standardOutputRateMultiplier,
        )} = ${formatTokenUsageUsd(cost.outputUsd)}`,
        status: "completed",
      },
    );
    details.push({
      id: `${params.id}-cost`,
      kind: "read",
      label: `Cost: ${formatTokenUsageUsd(cost.totalUsd)} list price for ${cost.displayName}`,
      status: "completed",
    });
  } else if (params.model) {
    details.push({
      id: `${params.id}-cost-unavailable`,
      kind: "read",
      label: `Cost unavailable: no local pricing entry for ${formatUnpricedModelName({
        fastMode: params.fastMode,
        model: params.model,
        serviceTier: params.serviceTier,
      })}`,
      status: "completed",
    });
  }

  return {
    type: "activity",
    id: params.id,
    createdAt: Date.now(),
    summary: `${summaryPrefix}: ${summaryParts.join(" · ")}`,
    status: "completed",
    details,
    ...(params.turn ? { turn: params.turn } : {}),
  };
}

export function buildTaskMonitorUsageActivityEntry(params: {
  id: string;
  item: Record<string, unknown>;
  turn?: AppServerThreadTurnMetadata;
}): AppServerThreadActivityEntry | undefined {
  const data = readRecord(params.item.data);
  const monitorUsage =
    readRecord(data?.monitorUsage) ??
    readRecord(params.item.monitorUsage);
  if (!monitorUsage) {
    return undefined;
  }

  const tokenUsage = readRecord(monitorUsage.tokenUsage);
  if (!tokenUsage) {
    return undefined;
  }

  const phase = readString(monitorUsage, "phase");
  const model = readString(monitorUsage, "model");
  return buildTokenUsageActivityEntry({
    id: params.id,
    model,
    summaryPrefix: phase === "completion" ? "Monitor usage" : "Monitor usage so far",
    tokenUsage: { total: tokenUsage },
    turn: params.turn,
  });
}

function normalizeTokenUsage(tokenUsage: unknown): NormalizedTokenUsage | undefined {
  const root =
    readRecord(findFirstNestedValue(tokenUsage, ["tokenUsage", "token_usage", "info"])) ??
    readRecord(tokenUsage);
  if (!root) {
    return undefined;
  }

  const latestUsageRecord =
    readRecord(findFirstNestedValue(root, ["last", "last_token_usage"])) ??
    readRecord(root.last) ??
    readRecord(root.last_token_usage);
  const totalUsageRecord =
    readRecord(findFirstNestedValue(root, ["total", "total_token_usage"])) ??
    readRecord(root.total) ??
    readRecord(root.total_token_usage);
  const currentUsageRecord = latestUsageRecord ?? totalUsageRecord ?? root;
  const tokens = readTokenBreakdown(currentUsageRecord);
  if (!tokens) {
    return undefined;
  }

  return {
    scope: latestUsageRecord ? "latest-request" : "total",
    tokens,
  };
}

function readTokenBreakdown(record: Record<string, unknown>): TokenUsageBreakdown | undefined {
  const explicitTotal = readFiniteNumber(record, ["totalTokens", "total_tokens"]);
  const inputTokens = readFiniteNumber(record, ["inputTokens", "input_tokens"]);
  const cachedInputTokens = readFiniteNumber(record, [
    "cachedInputTokens",
    "cached_input_tokens",
  ]);
  const outputTokens = readFiniteNumber(record, ["outputTokens", "output_tokens"]);
  const reasoningOutputTokens = readFiniteNumber(record, [
    "reasoningOutputTokens",
    "reasoning_output_tokens",
  ]);
  const derivedTotal =
    (inputTokens ?? 0) + (outputTokens ?? 0) + (reasoningOutputTokens ?? 0);
  const totalTokens = explicitTotal ?? (derivedTotal > 0 ? derivedTotal : undefined);

  if (
    totalTokens === undefined &&
    inputTokens === undefined &&
    cachedInputTokens === undefined &&
    outputTokens === undefined &&
    reasoningOutputTokens === undefined
  ) {
    return undefined;
  }

  return {
    cachedInputTokens,
    inputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens,
  };
}

function formatTokenCount(value: number): string {
  return Math.round(value).toLocaleString();
}

function formatUnpricedModelName(params: {
  fastMode?: boolean;
  model: string;
  serviceTier?: string;
}): string {
  const serviceTier = resolveOpenAiPricingServiceTier(params);
  return [
    params.model,
    serviceTier === "priority" ? "Fast/Priority" : undefined,
    serviceTier === undefined && params.serviceTier
      ? `service tier ${params.serviceTier}`
      : undefined,
  ]
    .filter(Boolean)
    .join(" ");
}

function readCommandActionLabel(item: Record<string, unknown>): string | undefined {
  const actions = Array.isArray(item.commandActions) ? item.commandActions : [];
  for (const action of actions) {
    const record = readRecord(action);
    if (!record) {
      continue;
    }

    const actionType = readString(record, "type");
    const actionPath = readString(record, "path");
    const actionQuery = readString(record, "query");
    const fallbackName = readString(record, "name");
    if (actionType === "read" && actionPath) {
      return `Read ${actionPath.split("/").filter(Boolean).pop() ?? actionPath}`;
    }
    if (actionType === "listFiles") {
      return "Listed files";
    }
    if (actionType === "search") {
      return formatSearchCommandActionLabel({
        path: actionPath,
        query: actionQuery,
      });
    }
    if (fallbackName) {
      return fallbackName;
    }
  }

  return undefined;
}

function readCommandActivityKind(
  item: Record<string, unknown>
): AppServerThreadActivityDetail["kind"] {
  const actions = Array.isArray(item.commandActions) ? item.commandActions : [];
  for (const action of actions) {
    const record = readRecord(action);
    if (!record) {
      continue;
    }
    const actionType = readString(record, "type");
    if (actionType === "read" || actionType === "search" || actionType === "listFiles") {
      return "read";
    }
  }

  return "command";
}

function readItemSources(item: Record<string, unknown>): AppServerSource[] {
  const data = readRecord(item.data);
  const rawSources = Array.isArray(item.sources)
    ? item.sources
    : Array.isArray(data?.sources)
      ? data.sources
      : [];

  return rawSources.flatMap((source): AppServerSource[] => {
    const record = readRecord(source);
    if (!record) {
      return [];
    }
    const title = readString(record, "title");
    const url = readString(record, "url");
    if (!title && !url) {
      return [];
    }
    return [{ title, url }];
  });
}

function normalizeItemStatus(value: unknown): AppServerThreadActivityDetail["status"] {
  if (value === "inProgress") {
    return "in_progress";
  }
  return value === "completed" ||
    value === "failed" ||
    value === "cancelled" ||
    value === "in_progress"
    ? value
    : "in_progress";
}

function summarizeToolOutput(text: string | undefined): string | undefined {
  const normalized = text
    ?.replace(/[#*_`>[\]()]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) {
    return undefined;
  }
  return normalized.length > 180 ? `${normalized.slice(0, 177)}...` : normalized;
}

function summarizeJsonValue(value: unknown): string | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value === "string") {
    return summarizeToolOutput(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return summarizeToolOutput(JSON.stringify(value));
  } catch {
    return undefined;
  }
}

function formatLiveToolName(
  toolName: string,
  status: AppServerThreadActivityDetail["status"]
): string {
  if (toolName === "search_web") {
    return status === "in_progress" ? "Searching Web" : "Searched Web";
  }
  if (toolName === "search_x") {
    return status === "in_progress" ? "Searching X" : "Searched X";
  }
  if (toolName === "shell_command") {
    return "Ran command";
  }
  return toolName.replace(/_/g, " ");
}

function formatMcpToolName(
  serverName: string | undefined,
  toolName: string,
  status: AppServerThreadActivityDetail["status"]
): string {
  const action = status === "in_progress" ? "Using MCP" : "Used MCP";
  return `${action} ${serverName ? `${serverName}/` : ""}${toolName}`;
}

function buildLiveToolLabel(
  item: Record<string, unknown>,
  itemType: string,
  status: AppServerThreadActivityDetail["status"],
  toolName: string
): string {
  if (itemType === "collabagenttoolcall") {
    return formatCollabAgentToolLabel({
      receiverThreadIds: readStringArray(item.receiverThreadIds),
      status,
      tool: toolName,
    });
  }

  if (itemType === "commandexecution") {
    const command = readString(item, "command");
    return (
      readCommandActionLabel(item) ??
      (command ? formatCommandLabel(command) : undefined) ??
      formatLiveToolName(toolName, status)
    );
  }

  if (itemType === "functioncall" && toolName === "exec_command") {
    const command =
      readToolArgument(item, "cmd") ??
      readToolArgument(item, "command") ??
      readToolArgument(item, "displayCommand");
    return command ? formatCommandLabel(command) : formatLiveToolName(toolName, status);
  }

  if (itemType === "mcptoolcall") {
    const serverName = readString(item, "server") ?? readString(item, "serverName");
    return formatMcpToolName(serverName, toolName, status);
  }

  return formatLiveToolName(toolName, status);
}

function formatCollabAgentToolLabel(params: {
  tool: string;
  receiverThreadIds: string[];
  status: AppServerThreadActivityDetail["status"];
}): string {
  const targetCount = params.receiverThreadIds.length;
  const targetLabel =
    targetCount === 1
      ? `agent ${shortAgentId(params.receiverThreadIds[0] ?? "")}`
      : targetCount > 1
        ? `${targetCount} agents`
        : "agent";
  const failedPrefix = params.status === "failed" ? "Failed to " : "";

  if (params.tool === "spawnAgent") {
    if (params.status === "failed") {
      return `${failedPrefix}spawn ${targetLabel}`;
    }
    return `${params.status === "in_progress" ? "Spawning" : "Spawned"} ${targetLabel}`;
  }
  if (params.tool === "wait") {
    if (params.status === "failed") {
      return `${failedPrefix}wait on ${targetLabel}`;
    }
    return `${params.status === "in_progress" ? "Waiting on" : "Waited on"} ${targetLabel}`;
  }
  if (params.tool === "sendInput") {
    if (params.status === "failed") {
      return `${failedPrefix}send input to ${targetLabel}`;
    }
    return `${params.status === "in_progress" ? "Sending input to" : "Sent input to"} ${targetLabel}`;
  }
  if (params.tool === "resumeAgent") {
    if (params.status === "failed") {
      return `${failedPrefix}resume ${targetLabel}`;
    }
    return `${params.status === "in_progress" ? "Resuming" : "Resumed"} ${targetLabel}`;
  }
  if (params.tool === "closeAgent") {
    if (params.status === "failed") {
      return `${failedPrefix}close ${targetLabel}`;
    }
    return `${params.status === "in_progress" ? "Closing" : "Closed"} ${targetLabel}`;
  }
  return `${failedPrefix}Used ${params.tool}`;
}

function buildCollabAgentCommandDetail(
  item: Record<string, unknown>,
  toolName: string,
  receiverThreadIds: string[]
): AppServerThreadCommandDetail {
  const prompt = readString(item, "prompt");
  const model = readString(item, "model");
  const reasoningEffort =
    readString(item, "reasoningEffort") ?? readString(item, "reasoning_effort");
  const stateSummary = formatCollabAgentStates(readRecord(item.agentsStates));
  const output = [
    receiverThreadIds.length > 0 ? `Agents: ${receiverThreadIds.join(", ")}` : undefined,
    model ? `Model: ${model}` : undefined,
    reasoningEffort ? `Reasoning effort: ${reasoningEffort}` : undefined,
    prompt ? `Prompt: ${truncateActivityText(prompt, 1_000)}` : undefined,
    stateSummary ? `Agent states:\n${stateSummary}` : undefined,
  ].filter((entry): entry is string => Boolean(entry)).join("\n\n");

  return {
    displayCommand:
      receiverThreadIds.length > 0
        ? `${toolName} ${receiverThreadIds.map(shortAgentId).join(", ")}`
        : toolName,
    rawCommand: toolName,
    ...(output ? { output } : {}),
  };
}

function formatCollabAgentStates(
  states: Record<string, unknown> | undefined
): string | undefined {
  if (!states) {
    return undefined;
  }
  const lines = Object.entries(states).flatMap(([agentId, value]) => {
    const record = readRecord(value);
    if (!record) {
      return [];
    }
    const status = readString(record, "status") ?? "unknown";
    const message = readString(record, "message");
    const header = `${shortAgentId(agentId)}: ${status} (${agentId})`;
    if (!message) {
      return [header];
    }
    return [`${header}\nOutput:\n${indentCollabAgentMessage(message)}`];
  });
  return lines.length > 0 ? lines.join("\n") : undefined;
}

function indentCollabAgentMessage(message: string): string {
  return message
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim()
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

function shortAgentId(agentId: string): string {
  return agentId.length > 8 ? agentId.slice(0, 8) : agentId;
}

function truncateActivityText(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 3)}...` : normalized;
}

export function buildLiveToolDetails(
  item: Record<string, unknown>
): AppServerThreadActivityDetail[] {
  const itemType = readString(item, "type")?.replace(/[-_\s]/g, "").toLowerCase();
  if (
    itemType !== "dynamictoolcall" &&
    itemType !== "commandexecution" &&
    itemType !== "functioncall" &&
    itemType !== "mcptoolcall" &&
    itemType !== "collabagenttoolcall" &&
    itemType !== "websearch"
  ) {
    return [];
  }

  const itemId =
    readString(item, "id") ??
    readString(item, "itemId") ??
    readString(item, "item_id") ??
    readString(item, "call_id") ??
    readString(item, "callId") ??
    "tool";
  const toolName =
    readString(item, "tool") ??
    readString(item, "toolName") ??
    readString(item, "tool_name") ??
    readString(item, "name") ??
    (itemType === "websearch" ? "web search" : "tool");
  const status = normalizeItemStatus(item.status);
  const query = readToolArgument(item, "query") ?? readToolArgument(item, "q");
  const preview =
    itemType === "mcptoolcall"
      ? summarizeJsonValue(item.error) ?? summarizeJsonValue(item.result)
      : summarizeToolOutput(readToolOutputText(item));
  const elapsedMs = readElapsedMs(item);
  const command =
    itemType === "commandexecution"
      ? readString(item, "command")
      : itemType === "functioncall" && toolName === "exec_command"
        ? readToolArgument(item, "cmd") ??
          readToolArgument(item, "command") ??
          readToolArgument(item, "displayCommand")
        : undefined;
  const isExecFunctionCall = itemType === "functioncall" && toolName === "exec_command";
  const commandDetail =
    itemType === "commandexecution" || isExecFunctionCall
      ? buildLiveCommandDetail(item, command, elapsedMs)
      : itemType === "collabagenttoolcall"
        ? buildCollabAgentCommandDetail(item, toolName, readStringArray(item.receiverThreadIds))
        : undefined;
  const details: AppServerThreadActivityDetail[] = [
    {
      id: itemId,
      kind:
        itemType === "commandexecution"
          ? readCommandActivityKind(item)
          : isExecFunctionCall
            ? "command"
          : itemType === "websearch" || toolName.startsWith("search_")
            ? "read"
            : "command",
      label: [
        buildLiveToolLabel(item, itemType, status, toolName),
        elapsedMs ? ` (${formatElapsedMs(elapsedMs)})` : "",
        query ? `: ${query}` : "",
        preview ? ` - ${preview}` : "",
      ].join(""),
      ...(commandDetail ? { command: commandDetail } : {}),
      status,
    },
  ];

  for (const [index, source] of readItemSources(item).slice(0, 5).entries()) {
    const label = source.title || source.url;
    if (!label) {
      continue;
    }
    details.push({
      id: `${itemId}-source-${index + 1}`,
      kind: "read",
      label,
      url: source.url,
      status,
    });
  }

  return details;
}

export function buildMcpProgressDetail(
  params: Record<string, unknown>
): AppServerThreadActivityDetail | undefined {
  const itemId = readString(params, "itemId");
  const message = readString(params, "message");
  if (!itemId || !message) {
    return undefined;
  }

  return {
    id: itemId,
    kind: "command",
    label: `MCP ${message}`,
    status: "in_progress",
  };
}

export function summarizeActivityStatus(
  details: AppServerThreadActivityDetail[]
): AppServerThreadActivityEntry["status"] {
  if (details.some((detail) => detail.status === "failed")) {
    return "failed";
  }
  if (details.some((detail) => detail.status === "in_progress")) {
    return "in_progress";
  }
  if (details.some((detail) => detail.status === "cancelled")) {
    return "cancelled";
  }
  return details.some((detail) => detail.status === "completed") ? "completed" : undefined;
}

// Derive a short tool/command name from an activity detail label for the
// collapsed summary. Guards against Windows drive-letter paths: a label like
// "C:\\...\\powershell.exe ..." must not be split on ":" (which yields "C") —
// basename it instead.
function commandSummaryName(label: string): string | undefined {
  const trimmed = label.trim();
  if (/^[A-Za-z]:[\\/]/.test(trimmed)) {
    const base = trimmed.split(/[\\/]/).pop() ?? trimmed;
    return base.split(/\s+/)[0]?.trim() || undefined;
  }
  return trimmed.split(":")[0]?.split(" - ")[0]?.trim() || undefined;
}

export function summarizeLiveActivity(details: AppServerThreadActivityDetail[]): string {
  const primaryDetails = details.filter((detail) => !detail.id.includes("-source-"));
  const readCount = primaryDetails.filter((detail) => detail.kind === "read").length;
  const commandLabels = [
    ...new Set(
      primaryDetails
        .filter((detail) => detail.kind !== "read")
        .map((detail) => commandSummaryName(detail.label))
        .filter(Boolean)
    ),
  ];
  const parts: string[] = [];

  if (readCount > 0) {
    parts.push(`Explored ${readCount} item${readCount === 1 ? "" : "s"}`);
  }
  if (commandLabels.length === 1 && commandLabels[0]) {
    parts.push(commandLabels[0]);
  } else if (commandLabels.length > 1) {
    parts.push(`Used ${commandLabels.length} tools`);
  }

  return parts.join(" · ") || "Activity";
}

export function mergeCommandDetail(
  existing: AppServerThreadCommandDetail | undefined,
  next: AppServerThreadCommandDetail | undefined
): AppServerThreadCommandDetail | undefined {
  const incomingDisplayCommand = next?.displayCommand;
  const displayCommand =
    incomingDisplayCommand &&
    (!isGenericCommandLabel(incomingDisplayCommand) || !existing?.displayCommand)
      ? incomingDisplayCommand
      : existing?.displayCommand ?? incomingDisplayCommand;
  if (!displayCommand) {
    return undefined;
  }
  const source =
    next?.rawCommand && existing?.source === "tool"
      ? "shell"
      : next?.source ?? existing?.source;

  return {
    displayCommand,
    ...(source ? { source } : {}),
    ...(existing?.rawCommand || next?.rawCommand
      ? { rawCommand: next?.rawCommand ?? existing?.rawCommand }
      : {}),
    ...(existing?.cwd || next?.cwd ? { cwd: next?.cwd ?? existing?.cwd } : {}),
    ...(existing?.output || next?.output
      ? { output: next?.output ?? existing?.output }
      : {}),
    ...(typeof (next?.exitCode ?? existing?.exitCode) === "number"
      ? { exitCode: next?.exitCode ?? existing?.exitCode }
      : {}),
    ...(typeof (next?.durationMs ?? existing?.durationMs) === "number"
      ? { durationMs: next?.durationMs ?? existing?.durationMs }
      : {}),
  };
}

function isGenericCommandLabel(value: string): boolean {
  return /^(?:ran command|tool|tool call|tool_call|tool call update|tool_call_update)$/i.test(
    value.trim(),
  );
}

export function mergeActivityDetails(
  current: AppServerThreadActivityDetail[],
  next: AppServerThreadActivityDetail[]
): AppServerThreadActivityDetail[] {
  const merged = [...current];
  for (const detail of next) {
    const existingIndex = merged.findIndex((entry) => entry.id === detail.id);
    if (existingIndex >= 0) {
      const existing = merged[existingIndex];
      const command = mergeCommandDetail(existing?.command, detail.command);
      merged[existingIndex] = {
        ...existing,
        ...detail,
        kind:
          isGenericActivityDetailLabel(detail.label) &&
          !isGenericActivityDetailLabel(existing?.label ?? "")
            ? existing?.kind ?? detail.kind
            : detail.kind,
        label: preferSpecificActivityDetailLabel(existing?.label, detail.label),
        ...(command ? { command } : {}),
      };
    } else {
      merged.push(detail);
    }
  }
  return merged;
}

function preferSpecificActivityDetailLabel(
  existing: string | undefined,
  incoming: string
): string {
  if (
    existing &&
    !isGenericActivityDetailLabel(existing) &&
    isGenericActivityDetailLabel(incoming)
  ) {
    return existing;
  }
  return incoming || existing || "Activity";
}

function isGenericActivityDetailLabel(value: string): boolean {
  return /^(?:tool|tool call|tool_call|tool call update|tool_call_update)$/i.test(
    value.trim(),
  );
}

export function appendCommandOutputDelta(
  entry: AppServerThreadActivityEntry,
  params: { delta: string; itemId: string }
): AppServerThreadActivityEntry {
  const details = entry.details.map((detail) => {
    if (detail.id !== params.itemId) {
      return detail;
    }

    return {
      ...detail,
      command: {
        displayCommand: detail.command?.displayCommand ?? detail.label,
        ...detail.command,
        output: truncateRendererPayloadString(
          `${detail.command?.output ?? ""}${params.delta}`,
          "live command output",
        ),
      },
    };
  });

  return {
    ...entry,
    summary: summarizeLiveActivity(details),
    status: summarizeActivityStatus(details),
    details,
  };
}

export function buildLiveActivityEntry(params: {
  id: string;
  createdAt?: number;
  details: AppServerThreadActivityDetail[];
  rendererSequence?: number;
  turn?: AppServerThreadTurnMetadata;
}): AppServerThreadActivityEntry {
  return {
    type: "activity",
    id: params.id,
    createdAt: params.createdAt ?? Date.now(),
    summary: summarizeLiveActivity(params.details),
    status: summarizeActivityStatus(params.details),
    details: params.details,
    ...(params.turn ? { turn: params.turn } : {}),
    ...(typeof params.rendererSequence === "number"
      ? { [RENDERER_SEQUENCE_KEY]: params.rendererSequence }
      : {}),
  };
}

export function getBasename(path: string): string {
  const segments = path.split(/[\\/]/);
  return segments[segments.length - 1] || path;
}

export function formatChangedFileCount(params: {
  count: number;
  prefix: "Changed" | "Edited";
}): string {
  return `${params.prefix} ${params.count} file${params.count === 1 ? "" : "s"}`;
}

export function formatChangedFileSummary(params: {
  count: number;
  prefix: "Changed" | "Edited";
  additions: number;
  removals: number;
}): string {
  const parts = [formatChangedFileCount(params)];
  if (params.additions > 0 || params.removals > 0) {
    parts.push(
      `+${params.additions.toLocaleString()}, -${params.removals.toLocaleString()}`
    );
  }
  return parts.join(", ");
}

export function parseFileChangeOutput(
  delta: string,
  entryId: string
): AppServerThreadActivityDetail[] {
  const changes = new Map<string, Set<"add" | "delete" | "update">>();

  for (const line of delta.replace(/\r\n?/g, "\n").split("\n")) {
    const match = line.trim().match(/^([ADM])\s+(.+)$/);
    if (!match) {
      continue;
    }

    const kind =
      match[1] === "A" ? "add" : match[1] === "D" ? "delete" : "update";
    const path = match[2].trim();
    if (!path) {
      continue;
    }

    const existing = changes.get(path) ?? new Set<"add" | "delete" | "update">();
    existing.add(kind);
    changes.set(path, existing);
  }

  return [...changes.entries()].map(([path, kinds], index) => {
    const labelKind =
      kinds.has("add") && kinds.has("delete")
        ? "Recreated"
        : kinds.has("add")
          ? "Added"
          : kinds.has("delete")
            ? "Deleted"
            : "Modified";
    return {
      id: `${entryId}-${index + 1}`,
      kind: "write",
      label: `${labelKind} ${getBasename(path)}`,
      path,
    };
  });
}

export function buildFileChangeOutputEntry(params: {
  delta: string;
  id: string;
  createdAt?: number;
  rendererSequence?: number;
  turn?: AppServerThreadTurnMetadata;
}): AppServerThreadActivityEntry | undefined {
  const details = parseFileChangeOutput(params.delta, params.id);
  if (details.length === 0) {
    return undefined;
  }

  return {
    type: "activity",
    id: params.id,
    createdAt: params.createdAt ?? Date.now(),
    summary: formatChangedFileSummary({
      count: details.length,
      prefix: "Changed",
      additions: 0,
      removals: 0,
    }),
    details,
    ...(params.turn ? { turn: params.turn } : {}),
    ...(typeof params.rendererSequence === "number"
      ? { [RENDERER_SEQUENCE_KEY]: params.rendererSequence }
      : {}),
  };
}
