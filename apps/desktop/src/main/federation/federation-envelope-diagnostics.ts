import type { FederationProtocolEnvelope } from "@pwragent/shared";
import { createHash } from "node:crypto";

export type FederationEnvelopeLogFields = Record<string, string | undefined>;

/** Account for large live notifications without recording any payload text. */
export function describeLargeBackendEvent(envelope: FederationProtocolEnvelope): Record<string, number> {
  if (envelope.kind !== "notification" || envelope.method !== "backend.event"
    || !envelope.params || typeof envelope.params !== "object") return {};
  const event = envelope.params as Record<string, unknown>;
  const notification = event.notification as { params?: Record<string, unknown> } | undefined;
  if (!notification?.params || typeof notification.params !== "object") return {};
  const { pricing, toolAccounting, ...other } = notification.params;
  const measure = (value: unknown): number => value === undefined ? 0 : Buffer.byteLength(JSON.stringify(value), "utf8");
  const stream = event.stream as { sequence?: unknown } | undefined;
  return {
    notificationParamsBytes: measure(notification.params),
    pricingBytes: measure(pricing),
    toolAccountingBytes: measure(toolAccounting),
    otherNotificationParamsBytes: measure(other),
    accountingPatchBytes: measure(event.accountingPatch),
    ...(typeof stream?.sequence === "number" ? { streamSequence: stream.sequence } : {}),
  };
}

/** Size-only diagnostics for the existing large-frame log, never payload text.
 * Parts are measured one at a time; no serialized replay is retained.
 * Inline image counters are a subset of the part bytes and count wire copies.
 */
export function describeLargeThreadReadResult(envelope: FederationProtocolEnvelope): Record<string, number> {
  if (envelope.kind !== "response" || !envelope.result || typeof envelope.result !== "object") return {};
  const result = envelope.result as Record<string, unknown>;
  if (!result.replay || typeof result.replay !== "object") return {};
  const { replay, pricing, toolAccounting, ...other } = result;
  const { entries, messages, ...metadata } = replay as Record<string, unknown>;
  let inlineImageUrlCount = 0;
  let inlineImageUrlBytes = 0;
  const measure = (value: unknown): number => {
    if (value === undefined) return 0;
    const serialized = JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === "string" && item.startsWith("data:image/")) {
        inlineImageUrlCount += 1;
        inlineImageUrlBytes += Buffer.byteLength(item, "utf8");
      }
      return item;
    });
    return Buffer.byteLength(serialized, "utf8");
  };
  return {
    replayEntryCount: Array.isArray(entries) ? entries.length : 0,
    replayMessageCount: Array.isArray(messages) ? messages.length : 0,
    replayEntriesBytes: measure(entries),
    replayMessagesBytes: measure(messages),
    replayMetadataBytes: measure(metadata),
    pricingBytes: measure(pricing),
    toolAccountingBytes: measure(toolAccounting),
    otherResultBytes: measure(other),
    inlineImageUrlCount,
    inlineImageUrlBytes,
  };
}

/** Volatile metadata only. Shared across gateway sockets to correlate relay hops.
 * Keep completed entries briefly: receiving a response precedes forwarding it.
 */
export class FederationEnvelopeDiagnostics {
  private readonly requests = new Map<string, {
    method: string;
    queryFingerprint?: string;
    threadId?: string;
    readReason?: string;
    expiresAt: number;
  }>();

  constructor(
    private readonly now = Date.now,
    private readonly capacity = 4096,
    private readonly ttlMs = 5 * 60_000,
  ) {}

  observe(envelope: FederationProtocolEnvelope): void {
    if (envelope.kind !== "request") return;
    const key = JSON.stringify([envelope.id, envelope.sourceInstanceId, envelope.targetInstanceId]);
    const existing = this.requests.get(key);
    if (existing && existing.expiresAt > this.now()) return;
    this.requests.delete(key);
    while (this.requests.size >= Math.max(1, this.capacity)) {
      this.requests.delete(this.requests.keys().next().value!);
    }
    this.requests.set(key, {
      method: envelope.method,
      queryFingerprint: searchQueryFingerprint(envelope),
      ...threadReadLogFields(envelope),
      expiresAt: this.now() + this.ttlMs,
    });
  }

  describe(
    envelope: FederationProtocolEnvelope,
    label: (id: string) => string | undefined = () => undefined,
  ): FederationEnvelopeLogFields {
    const requestId = envelope.kind === "request" ? envelope.id
      : envelope.kind === "response" || envelope.kind === "error" ? envelope.requestId : undefined;
    const key = JSON.stringify([requestId, envelope.targetInstanceId, envelope.sourceInstanceId]);
    const request = this.requests.get(key);
    if (request && request.expiresAt <= this.now()) this.requests.delete(key);
    const method = envelope.kind === "request" || envelope.kind === "notification"
      ? envelope.method
      : request && request.expiresAt > this.now() ? request.method : "unknown";
    const params = envelope.kind === "notification" ? envelope.params : undefined;
    const notification = params && typeof params === "object" && "notification" in params
      ? params.notification : undefined;
    const notificationParams = notification && typeof notification === "object" && "params" in notification
      && notification.params && typeof notification.params === "object" ? notification.params : undefined;
    return {
      envelopeKind: envelope.kind,
      envelopeId: envelope.id,
      requestId,
      method,
      queryFingerprint: envelope.kind === "request" ? searchQueryFingerprint(envelope)
        : request && request.expiresAt > this.now() ? request.queryFingerprint : undefined,
      ...(envelope.kind === "request" ? threadReadLogFields(envelope)
        : request && request.expiresAt > this.now()
          ? { threadId: request.threadId, readReason: request.readReason }
          : {}),
      ...(notificationParams && "threadId" in notificationParams
        && typeof notificationParams.threadId === "string" && notificationParams.threadId.length <= 256
        ? { threadId: notificationParams.threadId } : {}),
      errorCode: envelope.kind === "error" ? envelope.error.code : undefined,
      notificationMethod: notification && typeof notification === "object"
        && "method" in notification && typeof notification.method === "string"
        ? notification.method : undefined,
      sourceInstanceId: envelope.sourceInstanceId,
      sourceInstanceLabel: label(envelope.sourceInstanceId),
      targetInstanceId: envelope.targetInstanceId,
      targetInstanceLabel: envelope.targetInstanceId ? label(envelope.targetInstanceId) : undefined,
    };
  }
}

function threadReadLogFields(envelope: FederationProtocolEnvelope): {
  threadId?: string;
  readReason?: string;
} {
  if (envelope.kind !== "request" || envelope.method !== "backend.readThread") return {};
  const params = envelope.params;
  if (!params || typeof params !== "object") return {};
  return {
    threadId: "threadId" in params && typeof params.threadId === "string" && params.threadId.length <= 256
      ? params.threadId : undefined,
    readReason: "readReason" in params && (params.readReason === "star-map-card" || params.readReason === "thread-view")
      ? params.readReason : undefined,
  };
}

function searchQueryFingerprint(envelope: FederationProtocolEnvelope): string | undefined {
  if (envelope.kind !== "request"
    || (envelope.method !== "backend.searchNavigationThreads" && envelope.method !== "backend.searchFederatedThreads")) return undefined;
  const params = envelope.params;
  if (!params || typeof params !== "object" || !("query" in params) || typeof params.query !== "string") return undefined;
  return createHash("sha256").update(params.query.trim()).digest("hex").slice(0, 12);
}
