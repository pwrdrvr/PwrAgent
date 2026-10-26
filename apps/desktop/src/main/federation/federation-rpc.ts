import { randomUUID } from "node:crypto";
import type {
  FederationErrorEnvelope,
  FederationInstanceId,
  FederationNotificationEnvelope,
  FederationProtocolEnvelope,
  FederationRequestEnvelope,
  FederationResponseEnvelope,
  FederationServiceDataEnvelope,
  ServiceStreamData,
} from "@pwragent/shared";
import { FEDERATION_PROTOCOL_VERSION } from "@pwragent/shared";
import { serviceDataEnvelope } from "./federation-service-stream";

type PendingRequest = {
  cleanupAbort: () => void;
  reject: (error: Error) => void;
  resolve: (value: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
};

export type FederationRpcRequestOptions = {
  /** Local demand cancellation. Never serialized into a peer envelope. */
  signal?: AbortSignal;
  /**
   * Absolute wall-clock deadline shared by every RPC attempt in one logical
   * operation. This prevents compatibility fallbacks from restarting a full
   * timeout after the first request consumes most of the caller's budget.
   */
  deadlineAt?: number;
  /**
   * Owner-side requester identity used to bind retained cursors. This is
   * injected from the authenticated request envelope and is never serialized
   * from a client-supplied RPC option.
   */
  requesterInstanceId?: FederationInstanceId;
};

export function hasFederationErrorCode(
  error: unknown,
  code: string,
): boolean {
  return (
    typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === code
  );
}

export class FederationRpcEndpoint {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly notificationPrefix = `federation-notification:${randomUUID()}:`;
  private notificationCount = 0;

  constructor(
    private readonly options: {
      localInstanceId: FederationInstanceId;
      remoteInstanceId: FederationInstanceId;
      sendEnvelope: (envelope: FederationProtocolEnvelope) => void;
      /** One-way path that may wait for transport capacity. Defaults to `sendEnvelope`. */
      sendOneWay?: (
        envelope: FederationNotificationEnvelope | FederationServiceDataEnvelope,
      ) => void | Promise<void>;
      now?: () => number;
      defaultTimeoutMs?: number;
    },
  ) {}

  request<Result = unknown>(params: {
    method: string;
    params: unknown;
    /** null keeps the request open until a response, abort, or peer disconnect. */
    timeoutMs?: number | null;
    deadlineAt?: number;
    signal?: AbortSignal;
  }): Promise<Result> {
    if (params.signal?.aborted) return Promise.reject(params.signal.reason);
    const id = `federation-request:${randomUUID()}`;
    const now = this.now();
    const deadlineAt = params.timeoutMs === null
      ? undefined
      : params.deadlineAt
        ?? now + (params.timeoutMs ?? this.options.defaultTimeoutMs ?? 30_000);
    const timeoutMs = deadlineAt === undefined ? undefined : deadlineAt - now;
    if (timeoutMs !== undefined && timeoutMs <= 0) {
      return Promise.reject(
        new Error(`Federation request timed out: ${params.method}`),
      );
    }
    const envelope: FederationRequestEnvelope = {
      id,
      kind: "request",
      method: params.method,
      params: params.params,
      protocolVersion: FEDERATION_PROTOCOL_VERSION,
      sourceInstanceId: this.options.localInstanceId,
      targetInstanceId: this.options.remoteInstanceId,
      createdAt: now,
      ...(deadlineAt === undefined ? {} : { deadlineAt }),
    };

    const promise = new Promise<Result>((resolve, reject) => {
      const abort = (): void => {
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        pending.cleanupAbort();
        this.pending.delete(id);
        reject(params.signal?.reason ?? new Error("Federation request cancelled."));
      };
      const cleanupAbort = (): void => params.signal?.removeEventListener("abort", abort);
      const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
        cleanupAbort();
        this.pending.delete(id);
        reject(new Error(`Federation request timed out: ${params.method}`));
      }, timeoutMs);
      if (timer?.unref) timer.unref();
      this.pending.set(id, {
        cleanupAbort,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      params.signal?.addEventListener("abort", abort, { once: true });
    });
    try {
      this.options.sendEnvelope(envelope);
    } catch (error) {
      const pending = this.pending.get(id);
      if (pending) {
        pending.cleanupAbort();
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }
    return promise;
  }

  /** One-way message to the remote instance. A returned promise is transport backpressure. */
  notify(method: string, params: unknown): void | Promise<void> {
    const envelope: FederationNotificationEnvelope = {
      id: `${this.notificationPrefix}${(this.notificationCount += 1)}`,
      kind: "notification",
      method,
      params,
      protocolVersion: FEDERATION_PROTOCOL_VERSION,
      sourceInstanceId: this.options.localInstanceId,
      targetInstanceId: this.options.remoteInstanceId,
      createdAt: this.now(),
    };
    return (this.options.sendOneWay ?? this.options.sendEnvelope)(envelope);
  }

  /** One binary service stream frame. A returned promise is transport backpressure. */
  sendServiceData(frame: ServiceStreamData): void | Promise<void> {
    const envelope = serviceDataEnvelope(frame, {
      id: `${this.notificationPrefix}${(this.notificationCount += 1)}`,
      sourceInstanceId: this.options.localInstanceId,
      targetInstanceId: this.options.remoteInstanceId,
      createdAt: this.now(),
    });
    return (this.options.sendOneWay ?? this.options.sendEnvelope)(envelope);
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
      pending.cleanupAbort();
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(error);
    }
  }

  private resolveResponse(envelope: FederationResponseEnvelope): boolean {
    const pending = this.pending.get(envelope.requestId);
    if (!pending) return false;
    pending.cleanupAbort();
    clearTimeout(pending.timer);
    this.pending.delete(envelope.requestId);
    pending.resolve(envelope.result);
    return true;
  }

  private rejectError(envelope: FederationErrorEnvelope): boolean {
    if (!envelope.requestId) return false;
    const pending = this.pending.get(envelope.requestId);
    if (!pending) return false;
    pending.cleanupAbort();
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
