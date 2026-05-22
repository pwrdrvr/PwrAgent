import type { AppServerNotification } from "@pwragent/shared";
import { readAcpContentText, readAcpTopicTitle } from "./acp-session-normalizer";

export function acpToolUpdateNotifications(params: {
  threadId: string;
  turnId?: string;
  update: Record<string, unknown>;
}): AppServerNotification[] {
  const kind = readKind(params.update);
  if (kind !== "tool_call" && kind !== "tool_call_update") {
    return [];
  }
  if (readAcpTopicTitle(params.update)) {
    return [];
  }

  const item = liveItemForAcpToolUpdate(params.update);
  if (!item) {
    return [];
  }

  const method = isTerminalToolStatus(item.status) ? "item/completed" : "item/started";
  return [
    {
      method,
      params: {
        threadId: params.threadId,
        ...(params.turnId ? { turnId: params.turnId } : {}),
        item,
      },
    } as AppServerNotification,
  ];
}

function liveItemForAcpToolUpdate(
  update: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const toolKind = readString(update, "kind") ?? "tool";
  const id =
    readString(update, "toolCallId") ??
    readString(update, "id") ??
    readString(update, "itemId");
  const title =
    readString(update, "title") ??
    readString(update, "command") ??
    readString(update, "name") ??
    readFirstLocationPath(update) ??
    toolKind;
  if (!id && !title) {
    return undefined;
  }

  const path = readString(update, "path") ?? readFirstLocationPath(update);
  const status = normalizeAcpToolStatus(readString(update, "status"));
  const output = readAcpToolOutput(update);
  const command = readString(update, "command") ?? title;
  const commandActions = acpCommandActions({ kind: toolKind, path, title });
  const item: Record<string, unknown> = {
    id: id ?? `${toolKind}:${title}`,
    type: "commandExecution",
    toolName: toolKind,
    status,
    command,
    ...(commandActions.length ? { commandActions } : {}),
    ...(output ? { data: { output } } : {}),
  };
  return item;
}

function acpCommandActions(params: {
  kind: string;
  path: string | undefined;
  title: string;
}): Record<string, unknown>[] {
  if (params.kind === "read") {
    return [
      {
        type: "read",
        ...(params.path ? { path: params.path } : {}),
        name: params.title,
      },
    ];
  }
  if (params.kind === "search") {
    return [
      {
        type: "search",
        ...(params.path ? { path: params.path } : {}),
        name: params.title,
      },
    ];
  }
  if (params.kind === "list") {
    return [
      {
        type: "listFiles",
        ...(params.path ? { path: params.path } : {}),
        name: params.title,
      },
    ];
  }
  return [];
}

function normalizeAcpToolStatus(status: string | undefined): string {
  return status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "in_progress"
    ? status
    : "in_progress";
}

function isTerminalToolStatus(status: unknown): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function readAcpToolOutput(record: Record<string, unknown>): string | undefined {
  return (
    readString(record, "output") ??
    readString(record, "stdout") ??
    readString(record, "stderr") ??
    readString(record, "result") ??
    readAcpContentText(record.content)
  );
}

function readKind(update: Record<string, unknown>): string {
  return (
    readString(update, "sessionUpdate") ??
    readString(update, "kind") ??
    readString(update, "type") ??
    "unknown"
  );
}

function readString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readFirstLocationPath(record: Record<string, unknown>): string | undefined {
  const locations = record.locations;
  if (!Array.isArray(locations)) {
    return undefined;
  }
  for (const location of locations) {
    if (!location || typeof location !== "object" || Array.isArray(location)) {
      continue;
    }
    const path = (location as Record<string, unknown>).path;
    if (typeof path === "string" && path.trim()) {
      return path;
    }
  }
  return undefined;
}
