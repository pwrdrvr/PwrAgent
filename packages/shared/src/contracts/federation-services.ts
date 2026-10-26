import type { FederationServiceDataEnvelope } from "./federation";
import type { AppServerBackendKind } from "./normalized-app-server";

export type ServiceThread = { backend: AppServerBackendKind; threadId: string };
export type AdvertiseServiceArgs = {
  port: number;
  name: string;
  protocol: "http" | "https" | "tcp";
  address?: "127.0.0.1" | "::1";
  description?: string;
  ttlSeconds?: number;
};
export type ThreadService = ServiceThread & {
  serviceId: string;
  ownerInstanceId: string;
  ownerSessionId: string;
  address: "127.0.0.1" | "::1";
  port: number;
  name: string;
  description: string;
  protocol: AdvertiseServiceArgs["protocol"];
  createdAt: number;
  expiresAt: number;
};
export type ServiceForward = {
  forwardId: string;
  service: ThreadService;
  localPort: number;
  url?: string;
  sentBytes: number;
  receivedBytes: number;
  error?: string;
};
export type ServiceUiRequest = ServiceThread & {
  instanceId?: string;
  viewId: string;
  action: "watch" | "list" | "connect" | "disconnect" | "open" | "remove" | "leave";
  serviceId?: string;
  forwardId?: string;
};
/** Peers holding a forwarding lease on one of this machine's services. */
export type ServiceInboundForward = { serviceId: string; peerLabels: string[] };
export type ServiceUiResponse = {
  services: ThreadService[];
  forwards: ServiceForward[];
  /** Whether the owning machine allows peers to forward its ports. "unknown"
   * covers owners that predate the permission summary. */
  forwarding?: "allowed" | "blocked" | "unknown";
  /** Owner view only: which peers are forwarding each local service. */
  inbound?: ServiceInboundForward[];
};
export const FEDERATION_SERVICE_CAPABILITY = "service_forward_v1" as const;
export const FEDERATION_SERVICE_METHODS = {
  list: "services.v1.list",
  lease: "services.v1.lease",
  renew: "services.v1.renew",
  release: "services.v1.release",
  open: "services.v1.open",
  exchange: "services.v1.exchange",
  close: "services.v1.close",
  remove: "services.v1.remove",
} as const;
export type ServiceExchange = { streamId: string; seq: number; data: string; fin: boolean; receive: boolean };
export type ServiceExchangeResult = { seq: number; data: string; fin: boolean; writable: boolean };

/**
 * Windowed service streams. A v2 peer also serves every v1 method: leases,
 * inventory, and release stay on v1, and only the data path changes.
 *
 * Each direction has its own credit window, as SSH channels do. The receiver
 * advertises an initial window at open and grants more with
 * `services.v2.window` as its local socket drains. The sender may have that
 * many bytes in flight across many data frames. Data frames are one-way
 * binary `service_data` envelopes, so the owner pushes raw bytes as they
 * arrive instead of waiting to be polled.
 */
export const FEDERATION_SERVICE_V2_CAPABILITY = "service_forward_v2" as const;
/** Requests: capability-gated by the router, so an older owner answers
 * `method_not_found` or `capability_denied` and the viewer falls back to v1. */
export const FEDERATION_SERVICE_V2_METHODS = {
  open: "services.v2.open",
  renew: "services.v2.renew",
} as const;
/** Control notifications in both directions. Older peers drop them silently. */
export const FEDERATION_SERVICE_V2_NOTIFICATIONS = {
  window: "services.v2.window",
  close: "services.v2.close",
} as const;
/** Viewer to owner. The viewer names the stream, so frames that race the
 * response still find it. `window` is the viewer's receive credit. */
export type ServiceStreamOpen = { leaseId: string; streamId: string; window: number; frameBytes: number };
/** The owner's receive credit and largest accepted frame. */
export type ServiceStreamOpened = { window: number; frameBytes: number };
/** Keeps the lease and the named streams alive; unnamed streams are reaped. */
export type ServiceStreamRenew = { leaseId: string; streamIds: string[] };
/** The stream fields of a `service_data` envelope. */
export type ServiceStreamData = Pick<FederationServiceDataEnvelope, "streamId" | "seq" | "fin" | "data">;
/** Grants `bytes` more send credit. */
export type ServiceStreamWindow = { streamId: string; bytes: number };
/**
 * The sender neither sends nor accepts more on the stream. After the
 * sender's FIN and without an error, pending local writes still flush.
 */
export type ServiceStreamClose = { streamId: string; error?: string };
