import type { AppServerNotification } from "@pwragent/shared";
import { readAcpContentText, readAcpTopicTitle } from "./acp-session-normalizer";
import {
  isGenericShellToolTitle,
  readAcpToolCommand,
  readAcpToolContentCommand,
  readAcpToolDescription,
  readAcpToolInvocation,
  readAcpWebFetchUrl,
  readAcpWebSearch,
} from "./acp-command-extraction.js";
import { sanitizeAcpToolOutput } from "./acp-tool-output.js";
import {
  foldAcpTurnUsage,
  readAcpUsageEnvelope,
  type AcpTokenUsage,
  type AcpUsageEnvelope,
} from "./acp-usage.js";

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

export function acpUsageNotification(params: {
  envelope: AcpUsageEnvelope;
  model?: string;
  threadId: string;
  totalTokenUsage: AcpTokenUsage;
  turnId?: string;
}): AppServerNotification | undefined {
  if (!params.turnId) {
    return undefined;
  }
  const model = params.envelope.model ?? params.model;
  const latest = tokenUsageNotificationBreakdown(params.envelope.tokenUsage);
  const total = tokenUsageNotificationBreakdown(params.totalTokenUsage);
  return {
    method: "thread/tokenUsage/updated",
    params: {
      threadId: params.threadId,
      turnId: params.turnId,
      ...(model ? { model } : {}),
      tokenUsage: {
        last_token_usage: latest,
        ...(params.envelope.scope === "model-call"
          ? { total_token_usage: total }
          : {}),
      },
    },
  } as AppServerNotification;
}

export function acpTurnCompletedUsageNotification(params: {
  threadId: string;
  turnId?: string;
  update: Record<string, unknown>;
}): AppServerNotification | undefined {
  const envelope = readAcpUsageEnvelope(params.update);
  if (!envelope || envelope.scope !== "turn") {
    return undefined;
  }
  return acpUsageNotification({
    envelope,
    threadId: params.threadId,
    totalTokenUsage: foldAcpTurnUsage(undefined, envelope),
    turnId: params.turnId,
  });
}

function tokenUsageNotificationBreakdown(
  usage: AcpTokenUsage,
): Record<string, number> {
  return {
    ...(usage.inputTokens !== undefined
      ? { input_tokens: usage.inputTokens }
      : {}),
    ...(usage.cachedInputTokens !== undefined
      ? { cached_input_tokens: usage.cachedInputTokens }
      : {}),
    ...(usage.outputTokens !== undefined
      ? { output_tokens: usage.outputTokens }
      : {}),
    ...(usage.reasoningOutputTokens !== undefined
      ? { reasoning_output_tokens: usage.reasoningOutputTokens }
      : {}),
    ...(usage.totalTokens !== undefined
      ? { total_tokens: usage.totalTokens }
      : {}),
  };
}

function liveItemForAcpToolUpdate(
  update: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const toolKind = readString(update, "kind") ?? "tool";
  const id =
    readString(update, "toolCallId") ??
    readString(update, "tool_call_id") ??
    readString(update, "id") ??
    readString(update, "itemId") ??
    readString(update, "item_id");
  const rawCommand = readAcpToolCommand(update);
  const description = rawCommand
    ? readAcpToolDescription(update)
    : undefined;
  const title =
    description ??
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
  const webSearch = readAcpWebSearch(update);
  if (webSearch) {
    return {
      id: id ?? "web-search",
      type: "webSearch",
      toolName: "search_web",
      status,
      ...(webSearch.query
        ? { arguments: { query: webSearch.query } }
        : {}),
      ...(webSearch.sources.length ? { sources: webSearch.sources } : {}),
    };
  }

  const webFetchUrl = readAcpWebFetchUrl(update);
  const invocation = readAcpToolInvocation(update);
  const command = rawCommand ?? invocation ?? title;
  const commandActions = acpCommandActions({
    kind: webFetchUrl ? "read" : toolKind,
    path,
    semanticTitle: description,
    title: webFetchUrl
      ? `Fetched ${webFetchUrl}`
      : isGenericShellToolTitle(title)
        ? command
        : title,
  });
  const item: Record<string, unknown> = {
    id: id ?? `${toolKind}:${title}`,
    type: "commandExecution",
    toolName: webFetchUrl ? "web_fetch" : toolKind,
    status,
    command,
    commandSource: rawCommand ? "shell" : "tool",
    ...(commandActions.length ? { commandActions } : {}),
    ...(output ? { data: { output } } : {}),
  };
  return item;
}

function acpCommandActions(params: {
  kind: string;
  path: string | undefined;
  semanticTitle?: string;
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
  return params.semanticTitle
    ? [
        {
          type: "unknown",
          name: params.semanticTitle,
        },
      ]
    : [];
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
  const contentText = readAcpContentText(record.content);
  return sanitizeAcpToolOutput(
    readString(record, "output")
      ?? readString(record, "stdout")
      ?? readString(record, "stderr")
      ?? readString(record, "result")
      ?? (readAcpToolContentCommand(record) ? undefined : contentText),
  );
}

function readKind(update: Record<string, unknown>): string {
  return (
    readString(update, "sessionUpdate") ??
    readString(update, "session_update") ??
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
