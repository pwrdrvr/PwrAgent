import { randomUUID } from "node:crypto";
import type {
  FederationErrorEnvelope,
  FederationInstanceId,
  FederationProtocolEnvelope,
  FederationRequestEnvelope,
  FederationResponseEnvelope,
} from "@pwragent/shared";
import { FEDERATION_PROTOCOL_VERSION } from "@pwragent/shared";

type PendingRequest = {
  reject: (error: Error) => void;
  resolve: (value: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class FederationRpcEndpoint {
  private readonly pending = new Map<string, PendingRequest>();

  constructor(
    private readonly options: {
      localInstanceId: FederationInstanceId;
      remoteInstanceId: FederationInstanceId;
      sendEnvelope: (envelope: FederationProtocolEnvelope) => void;
      now?: () => number;
      defaultTimeoutMs?: number;
    },
  ) {}

  get remoteInstanceId(): FederationInstanceId {
    return this.options.remoteInstanceId;
  }

  request<Result = unknown>(params: {
    method: string;
    params: unknown;
    timeoutMs?: number;
  }): Promise<Result> {
    const id = `federation-request:${randomUUID()}`;
    const timeoutMs = params.timeoutMs ?? this.options.defaultTimeoutMs ?? 30_000;
    const envelope: FederationRequestEnvelope = {
      id,
      kind: "request",
      method: params.method,
      params: params.params,
      protocolVersion: FEDERATION_PROTOCOL_VERSION,
      sourceInstanceId: this.options.localInstanceId,
      targetInstanceId: this.options.remoteInstanceId,
      createdAt: this.now(),
      deadlineAt: this.now() + timeoutMs,
    };

    const promise = new Promise<Result>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Federation request timed out: ${params.method}`));
      }, timeoutMs);
      if (timer.unref) timer.unref();
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
    });
    try {
      this.options.sendEnvelope(envelope);
    } catch (error) {
      const pending = this.pending.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }
    return promise;
  }

  receiveEnvelope(envelope: FederationProtocolEnvelope): boolean {
    if (envelope.kind === "response") {
      return this.resolveResponse(envelope);
    }
    if (envelope.kind === "error") {
      return this.rejectError(envelope);
    }
    return false;
  }

  rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(error);
    }
  }

  private resolveResponse(envelope: FederationResponseEnvelope): boolean {
    const pending = this.pending.get(envelope.requestId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pending.delete(envelope.requestId);
    pending.resolve(envelope.result);
    return true;
  }

  private rejectError(envelope: FederationErrorEnvelope): boolean {
    if (!envelope.requestId) return false;
    const pending = this.pending.get(envelope.requestId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pending.delete(envelope.requestId);
    // Keep the remote's human-readable message; the bare code alone is
    // what surfaces in settings and toasts otherwise. The code stays
    // available on the error for programmatic callers.
    const message =
      envelope.error.message && envelope.error.message !== envelope.error.code
        ? `${envelope.error.code}: ${envelope.error.message}`
        : envelope.error.code;
    const error = new Error(message) as Error & { code?: string };
    error.code = envelope.error.code;
    pending.reject(error);
    return true;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}
