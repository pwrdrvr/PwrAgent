import {
  TOOL_DETAILS_UNAVAILABLE_LABEL,
  type AppServerNotification,
} from "@pwragent/shared";
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

/**
 * ACP frequently sends the useful title/input in `tool_call`, then reports
 * completion as a sparse `tool_call_update` containing only the id and status.
 * Keep that provider-shaped lifecycle at the ACP boundary so every downstream
 * consumer receives one normalized item with the best metadata seen so far.
 *
 * This is presentation state only. Raw ACP updates still go to the replay
 * normalizer/rollout store unchanged, which keeps the transcript inspectable.
 */
export class AcpLiveToolUpdateResolver {
  private readonly activeUpdates = new Map<string, Record<string, unknown>>();
  private anonymousToolSequence = 0;
  private readonly deferredTerminalUpdateKeys = new Set<string>();
  private readonly terminalUpdates = new Map<string, Record<string, unknown>>();

  resolve(params: {
    backendId: string;
    threadId: string;
    turnId?: string;
    update: Record<string, unknown>;
  }): Record<string, unknown> | undefined {
    const kind = readKind(params.update);
    if (kind !== "tool_call" && kind !== "tool_call_update") {
      return params.update;
    }

    const toolCallId = readAcpToolCallId(params.update);
    if (!toolCallId) {
      // A provider omitted the only stable lifecycle key. Preserve each live
      // observation rather than collapsing different malformed calls onto the
      // same "tool" row; the durable raw update remains the inspectable source
      // of truth after this process exits.
      this.anonymousToolSequence += 1;
      return {
        ...params.update,
        itemId: `pwragent:anonymous-acp-tool:${this.anonymousToolSequence}`,
      };
    }

    const key = [
      params.backendId,
      params.threadId,
      params.turnId ?? "no-turn",
      toolCallId,
    ].join("\0");
    const terminal = this.terminalUpdates.get(key);
    const resolved = mergeAcpLiveToolUpdates(
      this.activeUpdates.get(key) ?? terminal,
      params.update,
    );
    if (terminal) {
      // Once the provider has made a call terminal, a delayed start can still
      // enrich its title/input, but must never turn the existing row back into
      // an in-progress operation.
      resolved.status = normalizeAcpToolStatus(readString(terminal, "status"));
    }
    if (isTerminalToolStatus(resolved.status)) {
      this.activeUpdates.delete(key);
      this.rememberTerminalUpdate(key, resolved);

      const isMeaningful = hasMeaningfulAcpToolMetadata(resolved);
      if (!terminal && !isMeaningful) {
        // A sparse terminal can arrive before its rich `tool_call`. Hold the
        // generic completion until that call arrives or the turn ends, rather
        // than sending a generic update that delivery dedupe cannot correct.
        this.deferredTerminalUpdateKeys.add(key);
        return undefined;
      }
      if (this.deferredTerminalUpdateKeys.has(key) && !isMeaningful) {
        return undefined;
      }
      this.deferredTerminalUpdateKeys.delete(key);
    } else {
      this.activeUpdates.set(key, resolved);
    }
    return resolved;
  }

  drainDeferredTerminalUpdates(params: {
    backendId: string;
    threadId: string;
    turnId: string;
  }): Record<string, unknown>[] {
    const prefix = [params.backendId, params.threadId, params.turnId].join("\0");
    const updates: Record<string, unknown>[] = [];
    for (const key of this.deferredTerminalUpdateKeys) {
      if (!key.startsWith(`${prefix}\0`)) {
        continue;
      }
      const update = this.terminalUpdates.get(key);
      if (update) {
        updates.push(update);
      }
      this.deferredTerminalUpdateKeys.delete(key);
    }
    return updates;
  }

  clearTurn(params: {
    backendId: string;
    threadId: string;
    turnId: string;
  }): void {
    const prefix = [params.backendId, params.threadId, params.turnId].join("\0");
    for (const key of this.activeUpdates.keys()) {
      if (key.startsWith(`${prefix}\0`)) {
        this.activeUpdates.delete(key);
      }
    }
    for (const key of this.deferredTerminalUpdateKeys) {
      if (key.startsWith(`${prefix}\0`)) {
        this.deferredTerminalUpdateKeys.delete(key);
      }
    }
    for (const key of this.terminalUpdates.keys()) {
      if (key.startsWith(`${prefix}\0`)) {
        this.terminalUpdates.delete(key);
      }
    }
  }

  clear(): void {
    this.activeUpdates.clear();
    this.deferredTerminalUpdateKeys.clear();
    this.terminalUpdates.clear();
  }

  private rememberTerminalUpdate(key: string, update: Record<string, unknown>): void {
    this.terminalUpdates.delete(key);
    this.terminalUpdates.set(key, update);
    // A terminal event normally clears at turn completion. Keep a bounded
    // cache as a defensive fallback for a provider that omits it.
    while (this.terminalUpdates.size > 512) {
      const oldest = this.terminalUpdates.keys().next().value;
      if (typeof oldest !== "string") {
        return;
      }
      this.terminalUpdates.delete(oldest);
      this.deferredTerminalUpdateKeys.delete(oldest);
    }
  }
}

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
    (isGenericAcpToolKind(toolKind)
      ? TOOL_DETAILS_UNAVAILABLE_LABEL
      : toolKind);
  if (!id && !title) {
    return undefined;
  }

  const path = readAcpToolPath(update);
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
  const normalized = status?.toLowerCase();
  return normalized === "completed" ||
    normalized === "failed" ||
    normalized === "cancelled" ||
    normalized === "in_progress"
    ? normalized
    : "in_progress";
}

function isGenericAcpToolKind(value: string): boolean {
  return /^(?:other|tool|unknown)$/i.test(value.trim());
}

function isTerminalToolStatus(status: unknown): boolean {
  return typeof status === "string" && ["completed", "failed", "cancelled"].includes(
    status.toLowerCase(),
  );
}

function hasMeaningfulAcpToolMetadata(update: Record<string, unknown>): boolean {
  const item = liveItemForAcpToolUpdate(update);
  const command = item ? readString(item, "command") : undefined;
  return Boolean(command && !isGenericAcpToolMetadata(command));
}

function isGenericAcpToolMetadata(value: string): boolean {
  return /^(?:tool|tool call|tool_call|tool call update|tool_call_update|unknown|other|tool details unavailable)$/i.test(
    value.trim(),
  );
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

function readAcpToolCallId(
  update: Record<string, unknown>,
): string | undefined {
  return (
    readString(update, "toolCallId") ??
    readString(update, "tool_call_id") ??
    readString(update, "id") ??
    readString(update, "itemId") ??
    readString(update, "item_id")
  );
}

function readAcpToolPath(
  update: Record<string, unknown>,
): string | undefined {
  const rawInput = readRecord(update.rawInput);
  return (
    readString(update, "path") ??
    readString(rawInput ?? {}, "path") ??
    readString(rawInput ?? {}, "file") ??
    readString(rawInput ?? {}, "filePath") ??
    readString(rawInput ?? {}, "file_path") ??
    readFirstLocationPath(update)
  );
}

function mergeAcpLiveToolUpdates(
  previous: Record<string, unknown> | undefined,
  update: Record<string, unknown>,
): Record<string, unknown> {
  if (!previous) {
    return update;
  }

  const merged = { ...previous, ...update };
  for (const key of ["kind", "title", "name", "command"] as const) {
    const previousValue = readString(previous, key);
    const updateValue = readString(update, key);
    if (
      previousValue
      && (!updateValue
        || (key === "kind"
          ? isGenericAcpToolKind(updateValue)
          : isGenericAcpToolMetadata(updateValue)))
    ) {
      merged[key] = previousValue;
    }
  }
  for (const key of ["_meta", "rawInput", "rawOutput"] as const) {
    const previousRecord = readRecord(previous[key]);
    const updateRecord = readRecord(update[key]);
    if (previousRecord && updateRecord) {
      merged[key] = { ...previousRecord, ...updateRecord };
    }
  }
  return merged;
}

function readString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
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
