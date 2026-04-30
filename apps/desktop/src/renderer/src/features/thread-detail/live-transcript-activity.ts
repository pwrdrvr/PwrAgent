import type {
  AppServerSource,
  AppServerThreadActivityDetail,
  AppServerThreadActivityEntry,
  AppServerThreadCommandDetail,
  AppServerThreadTurnMetadata,
} from "@pwragnt/shared";

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

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function normalizeTimestamp(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return value < 1_000_000_000_000 ? value * 1_000 : value;
}

function readToolArgument(item: Record<string, unknown>, key: string): string | undefined {
  return readString(readRecord(item.arguments), key);
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

function formatCommandLabel(command: string | undefined): string {
  if (!command) {
    return "Ran command";
  }

  const stripped = command
    .replace(/^\/bin\/[a-z]+ -lc /, "")
    .replace(/^['"]|['"]$/g, "");
  const collapsed = stripped.replace(/\s+/g, " ").trim();
  if (!collapsed) {
    return "Ran command";
  }

  return collapsed.length > 72 ? `${collapsed.slice(0, 69)}...` : collapsed;
}

function readDisplayCommand(command: string | undefined): string | undefined {
  if (!command) {
    return undefined;
  }

  const stripped = command
    .replace(/^\/bin\/[a-z]+ -lc /, "")
    .replace(/^['"]|['"]$/g, "");
  const collapsed = stripped.replace(/\s+/g, " ").trim();
  return collapsed || undefined;
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
  const exitCode = readExitCode(item);
  const cwd = readString(item, "cwd") ??
    readString(item, "workingDirectory") ??
    readString(item, "working_directory");
  return {
    displayCommand,
    rawCommand: command,
    ...(cwd ? { cwd } : {}),
    ...(output ? { output } : {}),
    ...(typeof exitCode === "number" ? { exitCode } : {}),
    ...(typeof elapsedMs === "number" ? { durationMs: elapsedMs } : {}),
  };
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
    const fallbackName = readString(record, "name");
    if (actionType === "read" && actionPath) {
      return `Read ${actionPath.split("/").filter(Boolean).pop() ?? actionPath}`;
    }
    if (actionType === "search" && actionPath) {
      return `Searched ${actionPath.split("/").filter(Boolean).pop() ?? actionPath}`;
    }
    if (actionType === "listFiles") {
      return "Listed files";
    }
    if (actionType === "search") {
      return "Ran search";
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
  if (itemType === "commandexecution") {
    const command = readString(item, "command");
    return (
      readCommandActionLabel(item) ??
      (command ? formatCommandLabel(command) : undefined) ??
      formatLiveToolName(toolName, status)
    );
  }

  if (itemType === "mcptoolcall") {
    const serverName = readString(item, "server") ?? readString(item, "serverName");
    return formatMcpToolName(serverName, toolName, status);
  }

  return formatLiveToolName(toolName, status);
}

export function buildLiveToolDetails(
  item: Record<string, unknown>
): AppServerThreadActivityDetail[] {
  const itemType = readString(item, "type")?.replace(/[-_\s]/g, "").toLowerCase();
  if (
    itemType !== "dynamictoolcall" &&
    itemType !== "commandexecution" &&
    itemType !== "mcptoolcall" &&
    itemType !== "websearch"
  ) {
    return [];
  }

  const itemId = readString(item, "id") ?? readString(item, "itemId") ?? "tool";
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
  const command = itemType === "commandexecution" ? readString(item, "command") : undefined;
  const commandDetail = itemType === "commandexecution"
    ? buildLiveCommandDetail(item, command, elapsedMs)
    : undefined;
  const details: AppServerThreadActivityDetail[] = [
    {
      id: itemId,
      kind:
        itemType === "commandexecution"
          ? readCommandActivityKind(item)
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

export function summarizeLiveActivity(details: AppServerThreadActivityDetail[]): string {
  const primaryDetails = details.filter((detail) => !detail.id.includes("-source-"));
  const readCount = primaryDetails.filter((detail) => detail.kind === "read").length;
  const commandLabels = [
    ...new Set(
      primaryDetails
        .filter((detail) => detail.kind !== "read")
        .map((detail) => detail.label.split(":")[0]?.split(" - ")[0]?.trim())
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
  const displayCommand = next?.displayCommand ?? existing?.displayCommand;
  if (!displayCommand) {
    return undefined;
  }

  return {
    displayCommand,
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
        ...(command ? { command } : {}),
      };
    } else {
      merged.push(detail);
    }
  }
  return merged;
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
        output: `${detail.command?.output ?? ""}${params.delta}`,
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
  };
}
