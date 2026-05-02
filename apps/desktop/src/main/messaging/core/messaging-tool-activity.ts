import path from "node:path";
import type { AgentEvent } from "@pwragnt/shared";

export type MessagingToolActivityStatus = "completed" | "failed" | "cancelled";

export type MessagingToolActivityKind =
  | "command"
  | "file"
  | "mcp"
  | "search"
  | "tool";

export type MessagingToolActivity = {
  durationMs?: number;
  id: string;
  kind: MessagingToolActivityKind;
  pathBasename?: string;
  status: MessagingToolActivityStatus;
  title: string;
};

const SECRET_FRAGMENT_PATTERN =
  /((?:--?)?(?:api[-_]?key|token|secret|password|authorization)(?:=|\s+))("[^"]*"|'[^']*'|\S+)/gi;
const ASSIGNMENT_SECRET_PATTERN =
  /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|AUTHORIZATION)[A-Z0-9_]*=)("[^"]*"|'[^']*'|\S+)/g;

export function summarizeToolActivityFromBackendEvent(
  event: AgentEvent,
): MessagingToolActivity | undefined {
  if (event.notification.method !== "item/completed") {
    return undefined;
  }

  const params = event.notification.params as {
    item?: unknown;
    turnId?: unknown;
  };
  const item = readRecord(params.item);
  if (!item) {
    return undefined;
  }

  const itemType = normalizeItemType(readString(item, "type"));
  if (!itemType || !isRecognizedToolItemType(itemType)) {
    return undefined;
  }

  const id =
    readString(item, "id") ??
    readString(item, "itemId") ??
    readString(item, "item_id") ??
    `${event.backend}:${String(params.turnId ?? "turn")}:${itemType}`;
  const status = normalizeToolStatus(item);
  const durationMs = readDurationMs(item);

  if (itemType === "commandexecution") {
    return {
      id,
      kind: commandActivityKind(item),
      status,
      title: commandActivityTitle(item),
      ...(durationMs !== undefined ? { durationMs } : {}),
    };
  }

  if (itemType === "filechange") {
    const fileSummary = fileChangeTitle(item);
    return {
      id,
      kind: "file",
      pathBasename: fileSummary.pathBasename,
      status,
      title: fileSummary.title,
      ...(durationMs !== undefined ? { durationMs } : {}),
    };
  }

  if (itemType === "mcptoolcall") {
    return {
      id,
      kind: "mcp",
      status,
      title: mcpToolTitle(item),
      ...(durationMs !== undefined ? { durationMs } : {}),
    };
  }

  if (itemType === "websearch") {
    return {
      id,
      kind: "search",
      status,
      title: webSearchTitle(item),
      ...(durationMs !== undefined ? { durationMs } : {}),
    };
  }

  return {
    id,
    kind: "tool",
    status,
    title: dynamicToolTitle(item),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}

export function formatToolActivityLine(activity: MessagingToolActivity): string {
  return [
    activity.status === "failed"
      ? `Failed: ${activity.title}`
      : activity.status === "cancelled"
        ? `Cancelled: ${activity.title}`
        : activity.title,
    activity.durationMs !== undefined ? ` (${formatDuration(activity.durationMs)})` : "",
  ].join("");
}

function isRecognizedToolItemType(itemType: string): boolean {
  return (
    itemType === "commandexecution" ||
    itemType === "mcptoolcall" ||
    itemType === "dynamictoolcall" ||
    itemType === "websearch" ||
    itemType === "filechange" ||
    itemType === "functioncall"
  );
}

function commandActivityKind(item: Record<string, unknown>): MessagingToolActivityKind {
  const actions = readCommandActions(item);
  return actions.some((action) =>
    ["read", "search", "listFiles"].includes(readString(action, "type") ?? ""),
  )
    ? "search"
    : "command";
}

function commandActivityTitle(item: Record<string, unknown>): string {
  const actionTitle = commandActionTitle(item);
  if (actionTitle) {
    return actionTitle;
  }

  return safeCommandTitle(readString(item, "command"));
}

function commandActionTitle(item: Record<string, unknown>): string | undefined {
  for (const action of readCommandActions(item)) {
    const actionType = readString(action, "type");
    const actionPath = readString(action, "path");
    const fallbackName = readString(action, "name");
    const basename = actionPath ? path.basename(actionPath) || actionPath : undefined;

    if (actionType === "read" && basename) {
      return `Read ${basename}`;
    }
    if (actionType === "search" && basename) {
      return `Searched ${basename}`;
    }
    if (actionType === "listFiles") {
      return basename ? `Listed ${basename}` : "Listed files";
    }
    if (actionType === "search") {
      return "Ran search";
    }
    if (fallbackName) {
      return truncateTitle(fallbackName);
    }
  }

  return undefined;
}

function readCommandActions(item: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(item.commandActions)
    ? item.commandActions
        .map((entry) => readRecord(entry))
        .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    : [];
}

function fileChangeTitle(item: Record<string, unknown>): {
  pathBasename?: string;
  title: string;
} {
  const changes = Array.isArray(item.changes)
    ? item.changes
        .map((entry) => readRecord(entry))
        .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    : [];

  if (changes.length === 1) {
    const changePath = readString(changes[0]!, "path");
    const basename = changePath ? path.basename(changePath) || changePath : undefined;
    return {
      pathBasename: basename,
      title: basename ? `Edited ${basename}` : "Edited file",
    };
  }

  if (changes.length > 1) {
    return {
      title: `Edited ${changes.length} files`,
    };
  }

  const itemPath = readString(item, "path");
  const basename = itemPath ? path.basename(itemPath) || itemPath : undefined;
  return {
    pathBasename: basename,
    title: basename ? `Edited ${basename}` : "Edited file",
  };
}

function mcpToolTitle(item: Record<string, unknown>): string {
  const toolName =
    readString(item, "tool") ??
    readString(item, "toolName") ??
    readString(item, "tool_name") ??
    readString(item, "name") ??
    "tool";
  const serverName = readString(item, "server") ?? readString(item, "serverName");
  return truncateTitle(`Used MCP ${serverName ? `${serverName}/` : ""}${toolName}`);
}

function webSearchTitle(item: Record<string, unknown>): string {
  const query = readString(item, "query") ?? readToolArgument(item, "query");
  return query
    ? truncateTitle(`Searched web: ${redactTitleText(query)}`)
    : "Searched web";
}

function dynamicToolTitle(item: Record<string, unknown>): string {
  const name =
    readString(item, "tool") ??
    readString(item, "toolName") ??
    readString(item, "tool_name") ??
    readString(item, "name") ??
    "Used tool";
  const normalizedName = normalizeToolName(name);
  const args = readToolArguments(item);

  if (isCommandLikeDynamicTool(normalizedName)) {
    return safeCommandTitle(
      readFirstString(args, ["cmd", "command", "shellCommand"]),
    );
  }

  if (isReadFileDynamicTool(normalizedName)) {
    const basename = readDynamicPathBasename(args);
    return basename ? `Read ${basename}` : "Read file";
  }

  if (isListFilesDynamicTool(normalizedName)) {
    const basename = readDynamicPathBasename(args);
    return basename ? `Listed ${basename}` : "Listed files";
  }

  if (isSearchCodeDynamicTool(normalizedName)) {
    const basename = readDynamicPathBasename(args);
    if (basename) {
      return `Searched ${basename}`;
    }

    const query = readSafeDynamicText(args, ["query", "pattern", "search", "term"]);
    return query ? truncateTitle(`Searched code: ${query}`) : "Searched code";
  }
  return truncateTitle(name.replace(/_/g, " "));
}

function isCommandLikeDynamicTool(normalizedName: string): boolean {
  return ["execcommand", "shellcommand", "runcommand", "bash"].includes(normalizedName);
}

function isReadFileDynamicTool(normalizedName: string): boolean {
  return ["read", "readfile", "readfiles"].includes(normalizedName);
}

function isListFilesDynamicTool(normalizedName: string): boolean {
  return ["list", "listfile", "listfiles", "ls"].includes(normalizedName);
}

function isSearchCodeDynamicTool(normalizedName: string): boolean {
  return [
    "grep",
    "search",
    "searchcode",
    "codesearch",
    "findinfiles",
  ].includes(normalizedName);
}

function readDynamicPathBasename(
  args: Record<string, unknown> | undefined,
): string | undefined {
  const value = readFirstString(args, [
    "path",
    "file",
    "filePath",
    "filepath",
    "directory",
    "dir",
    "cwd",
  ]);
  if (!value) {
    return undefined;
  }

  const basename = path.basename(value) || value;
  return redactTitleText(basename);
}

function readSafeDynamicText(
  args: Record<string, unknown> | undefined,
  keys: string[],
): string | undefined {
  const value = readFirstString(args, keys);
  return value ? redactTitleText(value) : undefined;
}

function readFirstString(
  item: Record<string, unknown> | undefined,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = item ? readString(item, key) : undefined;
    if (value) {
      return value;
    }
  }
  return undefined;
}

function normalizeToolName(value: string): string {
  return value.replace(/[-_\s]/g, "").toLowerCase();
}

function readToolArgument(
  item: Record<string, unknown>,
  key: string,
): string | undefined {
  return readString(readToolArguments(item) ?? {}, key);
}

function readToolArguments(
  item: Record<string, unknown>,
): Record<string, unknown> | undefined {
  return (
    readRecord(parseJsonValue(item.arguments)) ??
    readRecord(parseJsonValue(item.input)) ??
    readRecord(item.arguments) ??
    readRecord(item.input)
  );
}

function safeCommandTitle(command: string | undefined): string {
  if (!command) {
    return "Ran command";
  }

  const stripped = command
    .replace(/^\/bin\/[a-z]+ -lc /, "")
    .replace(/^['"]|['"]$/g, "");
  const collapsed = redactTitleText(stripped);
  return collapsed ? truncateTitle(collapsed) : "Ran command";
}

function redactTitleText(value: string): string {
  return value
    .replace(SECRET_FRAGMENT_PATTERN, "$1[redacted]")
    .replace(ASSIGNMENT_SECRET_PATTERN, "$1[redacted]")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeToolStatus(
  item: Record<string, unknown>,
): MessagingToolActivityStatus {
  const rawStatus = readString(item, "status")?.toLowerCase();
  if (rawStatus === "failed" || rawStatus === "error") {
    return "failed";
  }
  if (rawStatus === "cancelled" || rawStatus === "canceled") {
    return "cancelled";
  }
  if (item.success === false) {
    return "failed";
  }
  const exitCode = readNumber(item, "exitCode") ?? readNumber(item, "exit_code");
  return typeof exitCode === "number" && exitCode !== 0 ? "failed" : "completed";
}

function readDurationMs(item: Record<string, unknown>): number | undefined {
  const direct =
    readNumber(item, "durationMs") ??
    readNumber(item, "duration_ms") ??
    readNumber(item, "elapsedMs") ??
    readNumber(item, "elapsed_ms");
  if (typeof direct === "number") {
    return direct;
  }

  const startedAt = normalizeTimestamp(
    readNumber(item, "startedAt") ?? readNumber(item, "started_at"),
  );
  const completedAt = normalizeTimestamp(
    readNumber(item, "completedAt") ?? readNumber(item, "completed_at"),
  );
  return startedAt !== undefined &&
    completedAt !== undefined &&
    completedAt >= startedAt
    ? completedAt - startedAt
    : undefined;
}

function normalizeTimestamp(value: number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  return value < 10_000_000_000 ? value * 1000 : value;
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) {
    return `${durationMs}ms`;
  }
  const seconds = durationMs / 1_000;
  return seconds >= 10 ? `${seconds.toFixed(0)}s` : `${seconds.toFixed(1)}s`;
}

function truncateTitle(title: string, limit = 72): string {
  const normalized = title.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function normalizeItemType(value: string | undefined): string | undefined {
  return value?.replace(/[-_\s]/g, "").toLowerCase();
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readString(
  item: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = item[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNumber(
  item: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = item[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
