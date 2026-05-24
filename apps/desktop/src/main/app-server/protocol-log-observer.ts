import type { JsonRpcObserver, JsonRpcObserverEvent } from "../codex-app-server/json-rpc";
import { getMainLogger } from "../log";

const PROTOCOL_LOG_ENV = "PWRAGENT_APP_SERVER_PROTOCOL_LOG";
const STREAM_LOG_INTERVAL_MS = 500;
const COALESCED_MESSAGE_LOG_INTERVAL_MS = 1_000;
const PREVIEW_LIMIT = 160;

type ProtocolLogBackend = string;

type ProtocolLogger = Pick<ReturnType<typeof getMainLogger>, "info">;

type ProtocolLogObserverOptions = {
  backend: ProtocolLogBackend;
  logger?: ProtocolLogger;
  now?: () => number;
  streamLogIntervalMs?: number;
  coalescedMessageLogIntervalMs?: number;
};

type JsonRpcEnvelope = JsonRpcObserverEvent["envelope"];

type DeltaBuffer = {
  chars: number;
  count: number;
  firstAt: number;
  lastAt: number;
  lastLoggedAt: number;
  preview: string;
};

type CoalescedMessageBuffer = {
  firstAt: number;
  lastAt: number;
  lastLoggedAt: number;
  lastFields: Partial<Record<string, unknown>>;
  suppressedCount: number;
};

export function createCompositeJsonRpcObserver(
  observers: Array<JsonRpcObserver | undefined>,
): JsonRpcObserver | undefined {
  const activeObservers = observers.filter(
    (observer): observer is JsonRpcObserver => Boolean(observer),
  );
  if (activeObservers.length === 0) {
    return undefined;
  }

  return {
    onMessage: async (event) => {
      let firstError: unknown;
      for (const observer of activeObservers) {
        try {
          await observer.onMessage(event);
        } catch (error) {
          firstError ??= error;
        }
      }

      if (firstError) {
        throw firstError;
      }
    },
  };
}

export function createProtocolLogObserverFromEnv(
  options: Pick<ProtocolLogObserverOptions, "backend">,
): JsonRpcObserver | undefined {
  if (!isEnabled(process.env[PROTOCOL_LOG_ENV])) {
    return undefined;
  }

  return createProtocolLogObserver(options);
}

export function createProtocolLogObserver(
  options: ProtocolLogObserverOptions,
): JsonRpcObserver {
  const logger =
    options.logger ?? getMainLogger(`pwragent:${options.backend}:protocol`);
  const now = options.now ?? (() => Date.now());
  const streamLogIntervalMs =
    options.streamLogIntervalMs ?? STREAM_LOG_INTERVAL_MS;
  const coalescedMessageLogIntervalMs =
    options.coalescedMessageLogIntervalMs ?? COALESCED_MESSAGE_LOG_INTERVAL_MS;
  const deltaBuffers = new Map<string, DeltaBuffer>();
  const coalescedMessageBuffers = new Map<string, CoalescedMessageBuffer>();
  const requestMethodsById = new Map<string, string>();
  const requestDiagnosticsById = new Map<
    string,
    NonNullable<JsonRpcObserverEvent["diagnostics"]>
  >();

  function logDeltaBuffer(
    key: string,
    buffer: DeltaBuffer,
    reason: "final" | "interval",
  ): void {
    logger.info("stream delta", {
      backend: options.backend,
      chars: buffer.chars,
      count: buffer.count,
      durationMs: buffer.lastAt - buffer.firstAt,
      reason,
      streamKey: key,
      text: buffer.preview,
    });
  }

  function flushDeltaBuffersFor(envelope: JsonRpcEnvelope): void {
    const method = envelope.method;
    if (
      method !== "item/completed" &&
      method !== "turn/completed" &&
      method !== "turn/failed" &&
      method !== "turn/cancelled"
    ) {
      return;
    }

    const params = asRecord(envelope.params);
    const item = asRecord(params?.item);
    const threadId = pickString(params, "threadId");
    const turnId = pickString(params, "turnId");
    const itemId = pickString(item, "id") ?? pickString(params, "itemId");

    for (const [key, buffer] of deltaBuffers) {
      if (
        (threadId && !key.includes(`thread:${threadId}`)) ||
        (turnId && !key.includes(`turn:${turnId}`)) ||
        (itemId && !key.includes(`item:${itemId}`))
      ) {
        continue;
      }

      logDeltaBuffer(key, buffer, "final");
      deltaBuffers.delete(key);
    }
  }

  function logCoalescedMessageBuffer(
    key: string,
    buffer: CoalescedMessageBuffer,
    reason: "interval",
  ): void {
    if (buffer.suppressedCount === 0) {
      return;
    }

    logger.info(
      "message coalesced",
      compactFields({
        ...buffer.lastFields,
        coalescedDurationMs: buffer.lastAt - buffer.firstAt,
        messageKey: key,
        reason,
        suppressedCount: buffer.suppressedCount,
      }),
    );
  }

  function logMessage(
    fields: Partial<Record<string, unknown>>,
    coalescedKey: string | undefined,
  ): void {
    if (!coalescedKey) {
      logger.info("message", fields);
      return;
    }

    const timestamp = now();
    const buffer = coalescedMessageBuffers.get(coalescedKey);
    if (!buffer) {
      coalescedMessageBuffers.set(coalescedKey, {
        firstAt: timestamp,
        lastAt: timestamp,
        lastFields: fields,
        lastLoggedAt: timestamp,
        suppressedCount: 0,
      });
      logger.info("message", fields);
      return;
    }

    buffer.lastAt = timestamp;
    buffer.lastFields = fields;
    buffer.suppressedCount += 1;

    if (timestamp - buffer.lastLoggedAt >= coalescedMessageLogIntervalMs) {
      logCoalescedMessageBuffer(coalescedKey, buffer, "interval");
      buffer.firstAt = timestamp;
      buffer.lastLoggedAt = timestamp;
      buffer.suppressedCount = 0;
    }
  }

  return {
    onMessage: (event) => {
      const envelope = event.envelope;
      const params = asRecord(envelope.params);
      const item = asRecord(params?.item);
      const update = asRecord(params?.update);
      const error = asRecord(envelope.error);
      const id = envelope.id == null ? undefined : String(envelope.id);
      const kind = classifyEnvelope(envelope);
      const method =
        envelope.method ?? (id ? requestMethodsById.get(id) : undefined) ?? "response";
      const updateKind = pickString(
        update,
        "sessionUpdate",
        "session_update",
        "kind",
        "type",
      );
      const diagnostics =
        event.diagnostics ?? (id ? requestDiagnosticsById.get(id) : undefined);
      const delta =
        pickRawString(params, "delta") ??
        pickAcpStreamingSessionUpdateText(method, updateKind, update);
      const deltaKey = delta
        ? buildDeltaKey({
            backend: options.backend,
            direction: event.direction,
            method,
            params,
          })
        : undefined;

      if (delta && deltaKey) {
        const timestamp = now();
        const buffer =
          deltaBuffers.get(deltaKey) ??
          {
            chars: 0,
            count: 0,
            firstAt: timestamp,
            lastAt: timestamp,
            lastLoggedAt: 0,
            preview: "",
          };
        buffer.chars += delta.length;
        buffer.count += 1;
        buffer.lastAt = timestamp;
        buffer.preview = appendPreview(buffer.preview, delta);
        deltaBuffers.set(deltaKey, buffer);

        if (timestamp - buffer.lastLoggedAt >= streamLogIntervalMs) {
          logDeltaBuffer(deltaKey, buffer, "interval");
          buffer.lastLoggedAt = timestamp;
        }
        return;
      }

      flushDeltaBuffersFor(envelope);
      if (kind === "request" && id && envelope.method) {
        requestMethodsById.set(id, envelope.method);
        if (event.diagnostics) {
          requestDiagnosticsById.set(id, event.diagnostics);
        }
      }
      const paramKeys = Object.keys(params ?? {});
      const messageFields = compactFields({
        backend: options.backend,
        callerReason: diagnostics?.callerReason,
        direction: compactDirection(event.direction),
        errorCode: pickNumberOrString(error, "code"),
        errorMessage: pickString(error, "message"),
        id,
        itemId: pickString(params, "itemId") ?? pickString(item, "id"),
        kind,
        method,
        ownerId: diagnostics?.ownerId,
        paramKeys: paramKeys.length > 0 ? paramKeys : undefined,
        sessionId: pickString(params, "sessionId"),
        status: pickString(update, "status"),
        title: pickString(update, "title"),
        toolCallId: pickString(update, "toolCallId", "tool_call_id", "id"),
        turnId: pickString(params, "turnId"),
        threadId: pickString(params, "threadId"),
        updateKind,
      });
      const coalescedMessageKey = shouldCoalesceMessage({
        backend: options.backend,
        method,
        updateKind,
      })
        ? buildCoalescedMessageKey({
            backend: options.backend,
            direction: event.direction,
            method,
            params,
          })
        : undefined;
      logMessage(messageFields, coalescedMessageKey);
      if (kind === "response" && id) {
        requestMethodsById.delete(id);
        requestDiagnosticsById.delete(id);
      }
    },
  };
}

function isEnabled(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function classifyEnvelope(envelope: JsonRpcEnvelope): "notification" | "request" | "response" {
  if (envelope.method && envelope.id != null) {
    return "request";
  }
  if (envelope.method) {
    return "notification";
  }
  return "response";
}

function compactDirection(direction: JsonRpcObserverEvent["direction"]): "in" | "out" {
  return direction === "inbound" ? "in" : "out";
}

function compactFields<T extends Record<string, unknown>>(fields: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function pickString(
  record: Record<string, unknown> | undefined,
  ...keys: string[]
): string | undefined {
  if (!record) {
    return undefined;
  }

  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return undefined;
}

function pickRawString(
  record: Record<string, unknown> | undefined,
  ...keys: string[]
): string | undefined {
  if (!record) {
    return undefined;
  }

  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function pickAcpStreamingSessionUpdateText(
  method: string,
  updateKind: string | undefined,
  update: Record<string, unknown> | undefined,
): string | undefined {
  if (
    method !== "session/update" ||
    (updateKind !== "agent_message_chunk" &&
      updateKind !== "agent_thought_chunk")
  ) {
    return undefined;
  }
  const content = asRecord(update?.content);
  return pickRawString(content, "text") ?? pickRawString(update, "text");
}

function pickNumberOrString(
  record: Record<string, unknown> | undefined,
  ...keys: string[]
): number | string | undefined {
  if (!record) {
    return undefined;
  }

  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" || (typeof value === "string" && value.trim())) {
      return value;
    }
  }
  return undefined;
}

function shouldCoalesceMessage(params: {
  backend: ProtocolLogBackend;
  method: string;
  updateKind: string | undefined;
}): boolean {
  return (
    params.backend.startsWith("acp:") &&
    params.method === "session/update" &&
    params.updateKind === "tool_call_update"
  );
}

function appendPreview(existing: string, delta: string): string {
  const combined = `${existing}${delta}`;
  if (combined.length <= PREVIEW_LIMIT) {
    return combined;
  }

  const halfLimit = Math.floor(PREVIEW_LIMIT / 2);
  return `${combined.slice(0, halfLimit)}...${combined.slice(-halfLimit)}`;
}

function buildDeltaKey(params: {
  backend: ProtocolLogBackend;
  direction: JsonRpcObserverEvent["direction"];
  method: string;
  params?: Record<string, unknown>;
}): string {
  const item = asRecord(params.params?.item);
  const update = asRecord(params.params?.update);
  return [
    `backend:${params.backend}`,
    `direction:${params.direction}`,
    `method:${params.method}`,
    `session:${pickString(params.params, "sessionId") ?? "unknown"}`,
    `thread:${pickString(params.params, "threadId") ?? "unknown"}`,
    `turn:${pickString(params.params, "turnId") ?? "unknown"}`,
    `item:${pickString(params.params, "itemId") ?? pickString(item, "id") ?? "unknown"}`,
    `stream:${
      pickString(params.params, "stream") ??
      pickString(update, "sessionUpdate", "session_update", "kind", "type") ??
      "text"
    }`,
  ].join(" ");
}

function buildCoalescedMessageKey(params: {
  backend: ProtocolLogBackend;
  direction: JsonRpcObserverEvent["direction"];
  method: string;
  params?: Record<string, unknown>;
}): string {
  const update = asRecord(params.params?.update);
  return [
    `backend:${params.backend}`,
    `direction:${params.direction}`,
    `method:${params.method}`,
    `session:${pickString(params.params, "sessionId") ?? "unknown"}`,
    `update:${
      pickString(update, "sessionUpdate", "session_update", "kind", "type") ??
      "unknown"
    }`,
    `tool:${pickString(update, "toolCallId", "tool_call_id", "id") ?? "unknown"}`,
    `status:${pickString(update, "status") ?? "unknown"}`,
  ].join(" ");
}
