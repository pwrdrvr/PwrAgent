import path from "node:path";
import {
  readProtocolCaptureFile,
  type CapturedProtocolEnvelopeRecord,
  type ProtocolCaptureEnvelope,
} from "./capture-store";

type ThreadListRequestVariant = {
  method: "thread/list" | "thread/loaded/list";
  paramsKeys: string[];
  archived?: boolean;
  limit?: number;
  filterKey?: "searchTerm" | "query" | "filter";
};

type ThreadListSample = {
  id: string;
  cwd?: string;
  projectKey?: string;
  path?: string;
  gitBranch?: string;
  statusType?: string;
};

export type ThreadOrderEvent = {
  itemId?: string;
  itemIndex?: number;
  kind: "assistant-message" | "tool-activity" | "turn" | "other";
  label: string;
  method?: string;
  sequence: number;
  source: "notification" | "threadRead";
  threadId?: string;
  timestamp: number;
  turnId?: string;
};

type ThreadIdentityFieldCounts = {
  cwd: number;
  sessionCwd: number;
  projectKey: number;
  path: number;
  gitBranch: number;
  status: number;
};

export type CodexThreadProtocolAnalysis = {
  capturePath: string;
  captureId?: string;
  requestCounts: Record<string, number>;
  notificationCounts: Record<string, number>;
  threadList: {
    requestMethods: Array<"thread/list" | "thread/loaded/list">;
    requestVariants: ThreadListRequestVariant[];
    responseContainerKeys: string[];
    responseResultKeys: string[];
    activeRequestCount: number;
    archivedRequestCount: number;
    identityFieldCounts: ThreadIdentityFieldCounts;
    sampleThreads: ThreadListSample[];
  };
  threadRead: {
    requestCount: number;
    includeTurnsVariants: boolean[];
  };
  threadOrder: {
    events: ThreadOrderEvent[];
  };
};

export async function analyzeCodexThreadProtocolCapture(params: {
  capturePath: string;
}): Promise<CodexThreadProtocolAnalysis> {
  const capturePath = path.resolve(params.capturePath);
  const records = await readProtocolCaptureFile(capturePath);
  const requestsById = buildRequestIndex(records);
  const requestEnvelopesById = buildRequestEnvelopeIndex(records);

  const requestCounts: Record<string, number> = {};
  const notificationCounts: Record<string, number> = {};
  const requestVariants = new Map<string, ThreadListRequestVariant>();
  const responseContainerKeys = new Set<string>();
  const responseResultKeys = new Set<string>();
  const requestMethods = new Set<"thread/list" | "thread/loaded/list">();
  const identityFieldCounts: ThreadIdentityFieldCounts = {
    cwd: 0,
    sessionCwd: 0,
    projectKey: 0,
    path: 0,
    gitBranch: 0,
    status: 0,
  };
  const sampleThreads = new Map<string, ThreadListSample>();
  let activeRequestCount = 0;
  let archivedRequestCount = 0;
  let threadReadRequestCount = 0;
  const includeTurnsVariants = new Set<boolean>();
  const threadOrderEvents: ThreadOrderEvent[] = [];

  for (const entry of records) {
    const method = entry.envelope.method?.trim();
    if (entry.record.direction === "outbound" && entry.record.kind === "request" && method) {
      requestCounts[method] = (requestCounts[method] ?? 0) + 1;

      if (method === "thread/list" || method === "thread/loaded/list") {
        requestMethods.add(method);
        const paramsRecord = asRecord(entry.envelope.params);
        const archived = typeof paramsRecord?.archived === "boolean" ? paramsRecord.archived : undefined;
        if (archived === true) {
          archivedRequestCount += 1;
        } else if (archived === false) {
          activeRequestCount += 1;
        }

        const filterKey = (["searchTerm", "query", "filter"] as const).find(
          (key) => typeof paramsRecord?.[key] === "string" && String(paramsRecord[key]).trim(),
        );
        const variant: ThreadListRequestVariant = {
          method,
          paramsKeys: Object.keys(paramsRecord ?? {}).sort(),
          ...(archived !== undefined ? { archived } : {}),
          ...(typeof paramsRecord?.limit === "number" ? { limit: paramsRecord.limit } : {}),
          ...(filterKey ? { filterKey } : {}),
        };
        requestVariants.set(JSON.stringify(variant), variant);
      }

      if (method === "thread/read") {
        threadReadRequestCount += 1;
        const paramsRecord = asRecord(entry.envelope.params);
        includeTurnsVariants.add(Boolean(paramsRecord?.includeTurns));
      }
      continue;
    }

    if (entry.record.direction === "inbound" && entry.record.kind === "notification" && method) {
      notificationCounts[method] = (notificationCounts[method] ?? 0) + 1;
      const orderEvent = extractNotificationOrderEvent(entry);
      if (orderEvent) {
        threadOrderEvents.push(orderEvent);
      }
      continue;
    }

    if (entry.record.direction !== "inbound" || entry.record.kind !== "response") {
      continue;
    }

    const responseMethod = lookupMethodForResponse(requestsById, entry.envelope);
    if (responseMethod === "thread/read") {
      threadOrderEvents.push(
        ...extractThreadReadOrderEvents(entry, requestEnvelopesById),
      );
    }
    if (responseMethod !== "thread/list" && responseMethod !== "thread/loaded/list") {
      continue;
    }

    requestMethods.add(responseMethod);
    const resultRecord = asRecord(entry.envelope.result);
    if (resultRecord) {
      for (const key of Object.keys(resultRecord).sort()) {
        responseResultKeys.add(key);
      }
    }

    const extracted = extractThreadRecords(entry.envelope.result);
    for (const container of extracted) {
      responseContainerKeys.add(container.containerKey);

      for (const record of container.records) {
        accumulateIdentityFields(record, identityFieldCounts);

        const threadId = pickString(record, ["id", "threadId", "thread_id"]);
        if (!threadId || sampleThreads.has(threadId) || sampleThreads.size >= 8) {
          continue;
        }

        sampleThreads.set(threadId, {
          id: threadId,
          cwd:
            pickString(record, ["cwd"]) ?? pickString(asRecord(record.session) ?? {}, ["cwd"]),
          projectKey:
            pickString(record, ["projectKey", "project_key"]) ??
            pickString(asRecord(record.session) ?? {}, ["projectKey", "project_key"]),
          path: pickString(record, ["path"]),
          gitBranch:
            pickString(asRecord(record.gitInfo) ?? {}, ["branch"]) ??
            pickString(asRecord(record.git_info) ?? {}, ["branch"]) ??
            pickString(asRecord(asRecord(record.session)?.gitInfo) ?? {}, ["branch"]),
          statusType: pickString(asRecord(record.status) ?? {}, ["type"]),
        });
      }
    }
  }

  return {
    capturePath,
    captureId: records[0]?.record.captureId,
    requestCounts: sortRecord(requestCounts),
    notificationCounts: sortRecord(notificationCounts),
    threadList: {
      requestMethods: [...requestMethods].sort(),
      requestVariants: [...requestVariants.values()].sort(compareRequestVariants),
      responseContainerKeys: [...responseContainerKeys].sort(),
      responseResultKeys: [...responseResultKeys].sort(),
      activeRequestCount,
      archivedRequestCount,
      identityFieldCounts,
      sampleThreads: [...sampleThreads.values()],
    },
    threadRead: {
      requestCount: threadReadRequestCount,
      includeTurnsVariants: [...includeTurnsVariants].sort(),
    },
    threadOrder: {
      events: threadOrderEvents.sort(compareThreadOrderEvents),
    },
  };
}

function buildRequestIndex(
  records: CapturedProtocolEnvelopeRecord[],
): Map<string, string> {
  const requestsById = new Map<string, string>();
  for (const entry of records) {
    const method = entry.envelope.method?.trim();
    if (
      entry.record.direction === "outbound" &&
      entry.record.kind === "request" &&
      method &&
      entry.envelope.id !== null &&
      entry.envelope.id !== undefined
    ) {
      requestsById.set(String(entry.envelope.id), method);
    }
  }
  return requestsById;
}

function buildRequestEnvelopeIndex(
  records: CapturedProtocolEnvelopeRecord[],
): Map<string, ProtocolCaptureEnvelope> {
  const requestsById = new Map<string, ProtocolCaptureEnvelope>();
  for (const entry of records) {
    const method = entry.envelope.method?.trim();
    if (
      entry.record.direction === "outbound" &&
      entry.record.kind === "request" &&
      method &&
      entry.envelope.id !== null &&
      entry.envelope.id !== undefined
    ) {
      requestsById.set(String(entry.envelope.id), entry.envelope);
    }
  }
  return requestsById;
}

function lookupMethodForResponse(
  requestsById: Map<string, string>,
  envelope: ProtocolCaptureEnvelope,
): string | undefined {
  if (envelope.id === null || envelope.id === undefined) {
    return undefined;
  }
  return requestsById.get(String(envelope.id));
}

function compareThreadOrderEvents(
  left: ThreadOrderEvent,
  right: ThreadOrderEvent,
): number {
  return (
    left.sequence - right.sequence ||
    (left.itemIndex ?? -1) - (right.itemIndex ?? -1) ||
    left.label.localeCompare(right.label)
  );
}

function extractNotificationOrderEvent(
  entry: CapturedProtocolEnvelopeRecord,
): ThreadOrderEvent | undefined {
  const method = entry.envelope.method?.trim();
  const params = asRecord(entry.envelope.params);
  if (!method || !params) {
    return undefined;
  }

  const threadId = pickString(params, ["threadId", "thread_id"]);
  if (!threadId) {
    return undefined;
  }

  const item = asRecord(params.item);
  const itemId =
    pickString(params, ["itemId", "item_id"]) ??
    pickString(item ?? {}, ["id", "itemId", "item_id"]);
  const turnId =
    pickString(params, ["turnId", "turn_id"]) ??
    pickString(item ?? {}, ["turnId", "turn_id"]);
  const itemType = pickString(item ?? {}, ["type"]);
  const delta = pickString(params, ["delta"]);

  return {
    ...(itemId ? { itemId } : {}),
    kind: classifyOrderEventKind(method, itemType),
    label: describeOrderEvent({
      method,
      item,
      itemType,
      delta,
      params,
    }),
    method,
    sequence: entry.record.sequence,
    source: "notification",
    threadId,
    timestamp: entry.record.timestamp,
    ...(turnId ? { turnId } : {}),
  };
}

function extractThreadReadOrderEvents(
  entry: CapturedProtocolEnvelopeRecord,
  requestEnvelopesById: Map<string, ProtocolCaptureEnvelope>,
): ThreadOrderEvent[] {
  const requestId =
    entry.envelope.id === null || entry.envelope.id === undefined
      ? undefined
      : String(entry.envelope.id);
  const request = requestId ? requestEnvelopesById.get(requestId) : undefined;
  if (request?.method !== "thread/read") {
    return [];
  }

  const requestParams = asRecord(request.params);
  const threadId = pickString(requestParams ?? {}, ["threadId", "thread_id"]);
  const result = asRecord(entry.envelope.result);
  const thread = asRecord(result?.thread);
  const turns = Array.isArray(thread?.turns)
    ? thread.turns
        .map((turn) => asRecord(turn))
        .filter((turn): turn is Record<string, unknown> => turn !== null)
    : [];
  const events: ThreadOrderEvent[] = [];

  for (const turn of turns) {
    const turnId = pickString(turn, ["id", "turnId", "turn_id"]);
    const items = Array.isArray(turn.items)
      ? turn.items
          .map((item) => asRecord(item))
          .filter((item): item is Record<string, unknown> => item !== null)
      : [];

    for (const [itemIndex, item] of items.entries()) {
      const itemType = pickString(item, ["type"]);
      const itemId = pickString(item, ["id", "itemId", "item_id", "call_id"]);
      events.push({
        ...(itemId ? { itemId } : {}),
        itemIndex,
        kind: classifyOrderEventKind("thread/read", itemType),
        label: describeOrderEvent({
          method: "thread/read",
          item,
          itemType,
          params: item,
        }),
        method: "thread/read",
        sequence: entry.record.sequence,
        source: "threadRead",
        ...(threadId ? { threadId } : {}),
        timestamp: entry.record.timestamp,
        ...(turnId ? { turnId } : {}),
      });
    }
  }

  return events;
}

function classifyOrderEventKind(
  method: string,
  itemType: string | undefined,
): ThreadOrderEvent["kind"] {
  if (method === "turn/completed" || method === "turn/started" || method === "turn/failed") {
    return "turn";
  }

  if (method === "item/agentMessage/delta" || itemType === "agentMessage") {
    return "assistant-message";
  }

  if (
    itemType === "commandExecution" ||
    itemType === "functionCall" ||
    itemType === "mcpToolCall" ||
    method.includes("commandExecution") ||
    method.includes("mcpToolCall")
  ) {
    return "tool-activity";
  }

  return "other";
}

function describeOrderEvent(params: {
  delta?: string;
  item: Record<string, unknown> | null;
  itemType?: string;
  method: string;
  params: Record<string, unknown>;
}): string {
  if (params.method === "item/agentMessage/delta") {
    return compactLabel(params.delta ?? "assistant message delta");
  }

  if (params.method === "turn/completed") {
    return "turn completed";
  }

  if (params.itemType === "agentMessage") {
    return compactLabel(pickString(params.item ?? {}, ["text"]) ?? "assistant message");
  }

  if (params.itemType === "commandExecution") {
    return compactLabel(
      pickString(params.item ?? {}, ["command", "displayCommand"]) ??
        "command execution",
    );
  }

  return compactLabel(params.itemType ?? params.method);
}

function compactLabel(value: string): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized;
}

function compareRequestVariants(
  left: ThreadListRequestVariant,
  right: ThreadListRequestVariant,
): number {
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}

function sortRecord(input: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(input).sort(([left], [right]) => left.localeCompare(right)));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function pickString(
  record: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}

function looksLikeThreadRecord(record: Record<string, unknown>): boolean {
  if (!pickString(record, ["id", "threadId", "thread_id"])) {
    return false;
  }

  return [
    "cwd",
    "path",
    "projectKey",
    "project_key",
    "gitInfo",
    "git_info",
    "preview",
    "name",
    "title",
    "updatedAt",
    "updated_at",
  ].some((key) => key in record);
}

function isThreadRecord(value: Record<string, unknown> | null): value is Record<string, unknown> {
  return value !== null && looksLikeThreadRecord(value);
}

function extractThreadRecords(value: unknown): Array<{
  containerKey: string;
  records: Record<string, unknown>[];
}> {
  const resultRecord = asRecord(value);
  if (!resultRecord) {
    return [];
  }

  const output: Array<{ containerKey: string; records: Record<string, unknown>[] }> = [];
  for (const containerKey of ["data", "threads", "results", "items"]) {
    const container = resultRecord[containerKey];
    if (!Array.isArray(container)) {
      continue;
    }

    const records = container.map((entry) => asRecord(entry)).filter(isThreadRecord);
    if (records.length > 0) {
      output.push({
        containerKey,
        records,
      });
    }
  }

  if (output.length === 0 && Array.isArray(value)) {
    const records = value.map((entry) => asRecord(entry)).filter(isThreadRecord);
    if (records.length > 0) {
      output.push({
        containerKey: "root",
        records,
      });
    }
  }

  return output;
}

function accumulateIdentityFields(
  record: Record<string, unknown>,
  counts: ThreadIdentityFieldCounts,
): void {
  const sessionRecord = asRecord(record.session);
  if (pickString(record, ["cwd"])) {
    counts.cwd += 1;
  }
  if (pickString(sessionRecord ?? {}, ["cwd"])) {
    counts.sessionCwd += 1;
  }
  if (pickString(record, ["projectKey", "project_key"])) {
    counts.projectKey += 1;
  }
  if (pickString(record, ["path"])) {
    counts.path += 1;
  }
  if (
    pickString(asRecord(record.gitInfo) ?? {}, ["branch"]) ||
    pickString(asRecord(record.git_info) ?? {}, ["branch"]) ||
    pickString(asRecord(sessionRecord?.gitInfo) ?? {}, ["branch"]) ||
    pickString(asRecord(sessionRecord?.git_info) ?? {}, ["branch"])
  ) {
    counts.gitBranch += 1;
  }
  if (pickString(asRecord(record.status) ?? {}, ["type"])) {
    counts.status += 1;
  }
}
