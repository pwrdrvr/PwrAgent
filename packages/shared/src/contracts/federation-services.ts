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
export type ServiceUiResponse = {
  services: ThreadService[];
  forwards: ServiceForward[];
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
