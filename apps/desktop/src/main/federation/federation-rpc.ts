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
    this.options.sendEnvelope(envelope);
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
    pending.reject(new Error(envelope.error.code));
    return true;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}
