import type {
  AppServerBackendKind,
  AppServerBackendScope,
  AppServerThreadSummary,
  ThreadIdentifier,
} from "./normalized-app-server";

export const FEDERATION_PROTOCOL_VERSION = 1;

export const FEDERATION_CAPABILITIES = [
  "remote_window",
  "thread_navigation",
  "thread_detail",
  "turn_control",
  "pending_request_control",
  "environment_actions",
  "federated_search",
  "messaging_route",
  "gateway_relay",
] as const;

export type FederationCapability = (typeof FEDERATION_CAPABILITIES)[number];

export type FederationInstanceRole = "gateway" | "child" | "dual";

export type FederationConnectionState =
  | "disabled"
  | "listening"
  | "connecting"
  | "handshaking"
  | "connected"
  | "degraded"
  | "rejected"
  | "revoked"
  | "disconnected";

export type FederationInstanceId = string;
export type FederationPeerId = FederationInstanceId;
export type FederationRequestId = string;
export type FederationSessionId = string;

export type FederationLocalTarget = {
  scope: "local";
};

export type FederationRemoteTarget = {
  instanceId: FederationInstanceId;
  scope: "remote";
};

export type FederationTarget =
  | FederationLocalTarget
  | FederationRemoteTarget;

export type FederatedThreadRef = {
  backend: AppServerBackendKind;
  target: FederationTarget;
  threadId: ThreadIdentifier;
};

export type FederatedBackendScope = {
  backend: AppServerBackendScope;
  target: FederationTarget;
};

export type FederationCapabilitySet = {
  protocolVersion: number;
  capabilities: FederationCapability[];
};

export type FederationPeerSummary = {
  id: FederationPeerId;
  label: string;
  role: FederationInstanceRole;
  status: FederationConnectionState;
  capabilities: FederationCapability[];
  protocolVersion?: number;
  endpoint?: string;
  profileName?: string;
  lastConnectedAt?: number;
  lastActivityAt?: number;
  revokedAt?: number;
  unavailableReason?: string;
};

export type FederationHealthStatus = {
  enabled: boolean;
  role: FederationInstanceRole;
  status: FederationConnectionState;
  instanceId?: FederationInstanceId;
  listenUrl?: string;
  publicUrl?: string;
  peers: FederationPeerSummary[];
};

export type ReadFederationHealthRequest = Record<string, never>;

export type ReadFederationHealthResponse = {
  health: FederationHealthStatus;
};

export type GenerateFederationInviteRequest = {
  label?: string;
  ttlMs?: number;
};

export type GenerateFederationInviteResponse = {
  invite: string;
  expiresAt: number;
};

export type ImportFederationInviteRequest = {
  invite: string;
};

export type ImportFederationInviteResponse = {
  accepted: boolean;
  gatewayInstanceId: FederationInstanceId;
  gatewayUrl: string;
};

export type OpenFederationWindowRequest = {
  target: FederationRemoteTarget;
  label?: string;
  initialThread?: FederatedThreadRef;
};

export type OpenFederationWindowResponse = {
  opened: boolean;
  windowId?: number;
  target: FederationRemoteTarget;
};

export type FederatedSearchRequest = {
  query: string;
  limit?: number;
};

export type FederatedSearchResult = {
  ref: FederatedThreadRef;
  thread: AppServerThreadSummary;
  instanceLabel: string;
  peerStatus?: FederationPeerSummary["status"];
  score: number;
};

export type FederatedSearchPeerFailure = {
  instanceId: FederationInstanceId;
  instanceLabel: string;
  error: string;
};

export type FederatedSearchResponse = {
  query: string;
  searchedAt: number;
  results: FederatedSearchResult[];
  failures: FederatedSearchPeerFailure[];
};

export type FederationEnvelopeBase = {
  id: FederationRequestId;
  protocolVersion: number;
  sourceInstanceId: FederationInstanceId;
  targetInstanceId?: FederationInstanceId;
  createdAt: number;
  deadlineAt?: number;
  hopCount?: number;
};

export type FederationRequestEnvelope<Method extends string = string, Params = unknown> =
  FederationEnvelopeBase & {
    kind: "request";
    method: Method;
    params: Params;
  };

export type FederationResponseEnvelope<Result = unknown> = FederationEnvelopeBase & {
  kind: "response";
  requestId: FederationRequestId;
  result: Result;
};

export type FederationErrorEnvelope = FederationEnvelopeBase & {
  kind: "error";
  requestId?: FederationRequestId;
  error: {
    code: string;
    message: string;
    retryable?: boolean;
  };
};

export type FederationNotificationEnvelope<
  Method extends string = string,
  Params = unknown,
> = FederationEnvelopeBase & {
  kind: "notification";
  method: Method;
  params: Params;
};

export type FederationProtocolEnvelope =
  | FederationRequestEnvelope
  | FederationResponseEnvelope
  | FederationErrorEnvelope
  | FederationNotificationEnvelope;

export function isFederationCapability(
  value: unknown,
): value is FederationCapability {
  return (
    typeof value === "string" &&
    (FEDERATION_CAPABILITIES as readonly string[]).includes(value)
  );
}

export function isFederationInstanceId(value: unknown): value is FederationInstanceId {
  if (typeof value !== "string") return false;
  if (value.length < 3 || value.length > 120) return false;
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    const isDigit = code >= 48 && code <= 57;
    const isUpper = code >= 65 && code <= 90;
    const isLower = code >= 97 && code <= 122;
    if (!isDigit && !isUpper && !isLower && ch !== "-" && ch !== "_") {
      return false;
    }
  }
  return true;
}

export function buildFederatedThreadRef(params: {
  backend: AppServerBackendKind;
  instanceId?: FederationInstanceId;
  threadId: ThreadIdentifier;
}): FederatedThreadRef {
  return {
    backend: params.backend,
    target: params.instanceId
      ? { scope: "remote", instanceId: params.instanceId }
      : { scope: "local" },
    threadId: params.threadId,
  };
}

export function isRemoteFederationTarget(
  target: FederationTarget,
): target is FederationRemoteTarget {
  return target.scope === "remote";
}

export function federationTargetKey(target: FederationTarget): string {
  return isRemoteFederationTarget(target) ? `remote:${target.instanceId}` : "local";
}

export function federatedThreadIdentityKey(ref: FederatedThreadRef): string {
  return `${federationTargetKey(ref.target)}:${encodeURIComponent(
    ref.backend,
  )}:${ref.threadId}`;
}
