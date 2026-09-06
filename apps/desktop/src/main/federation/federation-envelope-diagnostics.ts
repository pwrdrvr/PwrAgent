import type { FederationProtocolEnvelope } from "@pwragent/shared";

export type FederationEnvelopeLogFields = Record<string, string | undefined>;

/** Volatile metadata only. Shared across gateway sockets to correlate relay hops.
 * Keep completed entries briefly: receiving a response precedes forwarding it.
 */
export class FederationEnvelopeDiagnostics {
  private readonly requests = new Map<string, { method: string; expiresAt: number }>();

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
    this.requests.set(key, { method: envelope.method, expiresAt: this.now() + this.ttlMs });
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
