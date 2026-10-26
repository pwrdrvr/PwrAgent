import type {
  FederationCapability, FederationNotificationEnvelope, FederationProtocolEnvelope, FederationServiceDataEnvelope,
  ServiceStreamData,
} from "@pwragent/shared";
import { FEDERATION_PROTOCOL_VERSION } from "@pwragent/shared";
import { registerFederationServices, SERVICE_METHOD_CAPABILITIES, type FederationServices } from "../../federation/federation-services";
import type { FederationServiceForwarder } from "../../federation/federation-service-forwarder";
import { FederationRouter } from "../../federation/federation-router";
import { FederationRpcEndpoint } from "../../federation/federation-rpc";
import { serviceDataEnvelope } from "../../federation/federation-service-stream";

/**
 * One direction of the link. While held, data frames queue instead of
 * arriving, and so does everything behind them, which keeps arrival order.
 * `bytes` is the payload waiting in the queue: the bytes in flight.
 */
export class ServiceLinkGate {
  bytes = 0;
  private held = false;
  private readonly queue: Array<() => void> = [];

  /** Frames of any kind waiting in the queue. */
  get pending(): number { return this.queue.length; }
  hold(): void { this.held = true; }
  /** Deliver everything queued, as one round trip would, and keep holding. */
  flush(): void {
    this.bytes = 0;
    for (const deliver of this.queue.splice(0)) deliver();
  }
  open(): void { this.held = false; this.flush(); }

  pass(envelope: FederationProtocolEnvelope, deliver: () => void): void {
    const data = envelope.kind === "service_data";
    if (!this.held || (!data && !this.queue.length)) { deliver(); return; }
    if (data) this.bytes += envelope.data.byteLength;
    this.queue.push(deliver);
  }
}

export function serviceNotification(source: string, target: string, method: string, params: unknown): FederationNotificationEnvelope {
  return {
    id: `fixture-notification:${Math.random()}`, kind: "notification", method, params,
    protocolVersion: FEDERATION_PROTOCOL_VERSION, sourceInstanceId: source, targetInstanceId: target, createdAt: Date.now(),
  };
}

export function serviceData(source: string, target: string, frame: ServiceStreamData): FederationServiceDataEnvelope {
  return serviceDataEnvelope(frame, {
    id: `fixture-data:${Math.random()}`, sourceInstanceId: source, targetInstanceId: target, createdAt: Date.now(),
  });
}

/**
 * Viewer RPC endpoint and forwarder against an owner router, directly or
 * through a relaying gateway router, in process. `ownerWindowed: false` is an
 * owner that predates windowed streams.
 */
export function serviceLink(service: FederationServices, forwarder: FederationServiceForwarder, options: {
  viaGateway?: boolean;
  capabilities?: FederationCapability[];
  ownerWindowed?: boolean;
} = {}) {
  const viaGateway = options.viaGateway ?? false;
  const capabilities = options.capabilities ?? ["service_forward_v1", "service_forward_v2", "gateway_relay"];
  const router = new FederationRouter({ localInstanceId: "owner", methodCapabilities: SERVICE_METHOD_CAPABILITIES,
    trustedRelayPeerId: viaGateway ? "gateway" : undefined });
  const gateway = new FederationRouter({ localInstanceId: "gateway", methodCapabilities: SERVICE_METHOD_CAPABILITIES });
  const frames: FederationProtocolEnvelope[] = [];
  const up = new ServiceLinkGate();
  const down = new ServiceLinkGate();
  const rpc = new FederationRpcEndpoint({ localInstanceId: "viewer", remoteInstanceId: "owner", defaultTimeoutMs: 5000,
    sendEnvelope: (envelope) => {
      frames.push(envelope);
      up.pass(envelope, () => { void (viaGateway ? gateway : router).routeEnvelope({ envelope, sourcePeerId: "viewer" }); });
    } });
  const toViewer = (envelope: FederationProtocolEnvelope): void => down.pass(envelope, () => {
    if (envelope.kind === "notification") forwarder.receiveNotification(envelope.sourceInstanceId, envelope.method, envelope.params);
    else if (envelope.kind === "service_data") forwarder.receiveData(envelope.sourceInstanceId, envelope);
    else rpc.receiveEnvelope(envelope);
  });
  const ownerUplink = viaGateway ? "gateway" : "viewer";
  router.registerConnection({ peerId: ownerUplink, capabilities, sendEnvelope: (envelope) => {
    frames.push(envelope);
    if (viaGateway) void gateway.routeEnvelope({ envelope, sourcePeerId: "owner" });
    else toViewer(envelope);
  } });
  gateway.registerConnection({ peerId: "owner", capabilities, sendEnvelope: (envelope) => { void router.routeEnvelope({ envelope, sourcePeerId: "gateway" }); } });
  // Record the gateway's own replies, such as a capability refusal.
  gateway.registerConnection({ peerId: "viewer", capabilities, sendEnvelope: (envelope) => {
    if (envelope.sourceInstanceId === "gateway") frames.push(envelope);
    toViewer(envelope);
  } });
  registerFederationServices(router, service, options.ownerWindowed === false ? {} : { link: {
    notify: (peerId, method, params) => { router.sendToPeer(ownerUplink, serviceNotification("owner", peerId, method, params)); },
    sendData: (peerId, frame) => { router.sendToPeer(ownerUplink, serviceData("owner", peerId, frame)); },
  } });
  return { rpc, router, frames, up, down };
}
