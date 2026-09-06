import type { FederationProtocolEnvelope } from "@pwragent/shared";
import { createHash } from "node:crypto";

export type FederationEnvelopeLogFields = Record<string, string | undefined>;

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
