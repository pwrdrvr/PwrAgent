import type {
  FederationCapability,
  FederationErrorEnvelope,
  FederationInstanceId,
  FederationProtocolEnvelope,
  FederationRequestEnvelope,
  FederationResponseEnvelope,
} from "@pwragent/shared";
import { FEDERATION_PROTOCOL_VERSION } from "@pwragent/shared";

export type FederationRouterConnection = {
  peerId: FederationInstanceId;
  capabilities: readonly FederationCapability[];
  sendEnvelope: (envelope: FederationProtocolEnvelope) => void;
};

export type FederationRequestHandler = (
  envelope: FederationRequestEnvelope,
) => Promise<unknown> | unknown;

export type FederationRouteResult =
  | { status: "handled"; response?: FederationResponseEnvelope }
  | { status: "relayed"; targetInstanceId: FederationInstanceId }
  | { status: "rejected"; code: string; message: string };

export class FederationRouter {
  private readonly connections = new Map<FederationInstanceId, FederationRouterConnection>();
  private readonly handlers = new Map<string, FederationRequestHandler>();

  constructor(
    private readonly options: {
      localInstanceId: FederationInstanceId;
      methodCapabilities?: Record<string, FederationCapability>;
      maxHopCount?: number;
      now?: () => number;
    },
  ) {}

  registerConnection(connection: FederationRouterConnection): void {
    this.connections.set(connection.peerId, connection);
  }

  unregisterConnection(peerId: FederationInstanceId): void {
    this.connections.delete(peerId);
  }

  registerHandler(method: string, handler: FederationRequestHandler): void {
    this.handlers.set(method, handler);
  }

  async routeEnvelope(params: {
    envelope: FederationProtocolEnvelope;
    sourcePeerId?: FederationInstanceId;
  }): Promise<FederationRouteResult> {
    const deadlineFailure = this.checkDeadline(params.envelope);
    if (deadlineFailure) {
      this.replyToSource(params.sourcePeerId, deadlineFailure);
      return {
        status: "rejected",
        code: deadlineFailure.error.code,
        message: deadlineFailure.error.message,
      };
    }

    if (
      params.envelope.targetInstanceId &&
      params.envelope.targetInstanceId !== this.options.localInstanceId
    ) {
      return this.relayEnvelope(params);
    }

    if (params.envelope.kind !== "request") {
      return { status: "handled" };
    }

    const capabilityFailure = this.checkCapability(
      params.envelope,
      params.sourcePeerId,
    );
    if (capabilityFailure) {
      this.replyToSource(params.sourcePeerId, capabilityFailure);
      return {
        status: "rejected",
        code: capabilityFailure.error.code,
        message: capabilityFailure.error.message,
      };
    }

    const handler = this.handlers.get(params.envelope.method);
    if (!handler) {
      const failure = this.errorEnvelope(params.envelope, {
        code: "method_not_found",
        message: `No federation handler registered for ${params.envelope.method}`,
      });
      this.replyToSource(params.sourcePeerId, failure);
      return {
        status: "rejected",
        code: failure.error.code,
        message: failure.error.message,
      };
    }

    try {
      const result = await handler(params.envelope);
      const response: FederationResponseEnvelope = {
        id: `${params.envelope.id}:response`,
        kind: "response",
        requestId: params.envelope.id,
        protocolVersion: FEDERATION_PROTOCOL_VERSION,
        sourceInstanceId: this.options.localInstanceId,
        targetInstanceId: params.envelope.sourceInstanceId,
        createdAt: this.now(),
        result,
      };
      this.replyToSource(params.sourcePeerId, response);
      return { status: "handled", response };
    } catch (error) {
      const failure = this.errorEnvelope(params.envelope, {
        code: "handler_failed",
        message: error instanceof Error ? error.message : String(error),
      });
      this.replyToSource(params.sourcePeerId, failure);
      return {
        status: "rejected",
        code: failure.error.code,
        message: failure.error.message,
      };
    }
  }

  private relayEnvelope(params: {
    envelope: FederationProtocolEnvelope;
    sourcePeerId?: FederationInstanceId;
  }): FederationRouteResult {
    const targetInstanceId = params.envelope.targetInstanceId;
    if (!targetInstanceId) {
      return {
        status: "rejected",
        code: "missing_target",
        message: "Remote relay target is missing.",
      };
    }
    const hopCount = params.envelope.hopCount ?? 0;
    if (hopCount >= (this.options.maxHopCount ?? 4)) {
      const failure = this.errorEnvelope(params.envelope, {
        code: "relay_hop_limit",
        message: "Federation relay hop limit exceeded.",
      });
      this.replyToSource(params.sourcePeerId, failure);
      return {
        status: "rejected",
        code: failure.error.code,
        message: failure.error.message,
      };
    }

    if (params.sourcePeerId) {
      const source = this.connections.get(params.sourcePeerId);
      if (!source?.capabilities.includes("gateway_relay")) {
        const failure = this.errorEnvelope(params.envelope, {
          code: "relay_not_authorized",
          message: "Source peer is not authorized to relay through this gateway.",
        });
        this.replyToSource(params.sourcePeerId, failure);
        return {
          status: "rejected",
          code: failure.error.code,
          message: failure.error.message,
        };
      }
    }

    const target = this.connections.get(targetInstanceId);
    if (!target) {
      const failure = this.errorEnvelope(params.envelope, {
        code: "target_unavailable",
        message: "Target federation peer is not connected.",
      });
      this.replyToSource(params.sourcePeerId, failure);
      return {
        status: "rejected",
        code: failure.error.code,
        message: failure.error.message,
      };
    }

    target.sendEnvelope({
      ...params.envelope,
      hopCount: hopCount + 1,
    });
    return { status: "relayed", targetInstanceId };
  }

  private checkCapability(
    envelope: FederationRequestEnvelope,
    sourcePeerId: FederationInstanceId | undefined,
  ): FederationErrorEnvelope | undefined {
    if (!sourcePeerId) return undefined;
    const requiredCapability = this.options.methodCapabilities?.[envelope.method];
    if (!requiredCapability) return undefined;
    const source = this.connections.get(sourcePeerId);
    if (source?.capabilities.includes(requiredCapability)) return undefined;
    return this.errorEnvelope(envelope, {
      code: "capability_denied",
      message: `Method ${envelope.method} requires ${requiredCapability}.`,
    });
  }

  private checkDeadline(
    envelope: FederationProtocolEnvelope,
  ): FederationErrorEnvelope | undefined {
    if (envelope.deadlineAt === undefined || envelope.deadlineAt > this.now()) {
      return undefined;
    }
    return this.errorEnvelope(envelope, {
      code: "deadline_expired",
      message: "Federation request deadline expired.",
    });
  }

  private replyToSource(
    sourcePeerId: FederationInstanceId | undefined,
    envelope: FederationProtocolEnvelope,
  ): void {
    if (!sourcePeerId) return;
    this.connections.get(sourcePeerId)?.sendEnvelope(envelope);
  }

  private errorEnvelope(
    envelope: FederationProtocolEnvelope,
    error: { code: string; message: string },
  ): FederationErrorEnvelope {
    return {
      id: `${envelope.id}:error`,
      kind: "error",
      requestId: envelope.kind === "request" ? envelope.id : undefined,
      protocolVersion: FEDERATION_PROTOCOL_VERSION,
      sourceInstanceId: this.options.localInstanceId,
      targetInstanceId: envelope.sourceInstanceId,
      createdAt: this.now(),
      error,
    };
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}
