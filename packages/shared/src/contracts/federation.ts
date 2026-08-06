import type { CelestialIconId } from "./celestial";
import type {
  AppServerBackendKind,
  AppServerBackendScope,
  AppServerThreadSummary,
  ThreadIdentifier,
} from "./normalized-app-server";

export const FEDERATION_PROTOCOL_VERSION = 1;
export const FEDERATION_INVITE_VERSION = 1;
export const FEDERATION_TRANSPORT_VERSION = 1;

export const FEDERATION_CAPABILITIES = [
  "remote_window",
  "thread_navigation",
  "thread_detail",
  "turn_control",
  "scheduled_actions",
  "pending_request_control",
  "environment_actions",
  "federated_search",
  "messaging_route",
  "pwrsnap_connection",
  "gateway_relay",
  "remote_pty",
] as const;

export type FederationCapability = (typeof FEDERATION_CAPABILITIES)[number];

export type FederationInstanceRole = "gateway" | "client" | "dual";

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
  canRevoke?: boolean;
  protocolVersion?: number;
  endpoint?: string;
  profileName?: string;
  /** Assigned celestial identity icon, when the assignment map knows one. */
  celestialIcon?: CelestialIconId;
  lastConnectedAt?: number;
  lastActivityAt?: number;
  revokedAt?: number;
  unavailableReason?: string;
};

/**
 * Client-side pairing record: which gateway this instance imported an
 * invite for. Present whenever pinned gateway material exists, even
 * while the connection is failing — an enrolled-but-broken client must
 * be distinguishable from a never-enrolled one.
 */
export type FederationClientEnrollment = {
  gatewayInstanceId: FederationInstanceId;
  gatewayUrl?: string;
  enrolledAt?: number;
  /** Invite imported but the first enroll connection has not completed. */
  pendingInvite: boolean;
};

/**
 * Outer-transport schemes a federation gateway endpoint may use. Every
 * endpoint carries the same mandatory Noise IK channel and pinned-identity
 * authentication; the scheme only selects the reachability path.
 */
export const FEDERATION_ENDPOINT_SCHEMES = ["ws", "wss", "ssh"] as const;

export type FederationEndpointScheme =
  (typeof FEDERATION_ENDPOINT_SCHEMES)[number];

export type ParsedFederationEndpoint = {
  /** Lowercased scheme, without the trailing colon. */
  scheme: FederationEndpointScheme;
  /** Lowercased host, without userinfo or port. Brackets kept for IPv6. */
  host: string;
  /** Lowercased `host` or `host:port` — the credential-scoping identity. */
  hostPort: string;
  /** Userinfo before `@`, if any. Never contains a password. */
  user?: string;
  /** True only for schemes whose outer hop is TLS. */
  isTls: boolean;
};

/**
 * The single parser every federation endpoint decision goes through. Keeping
 * validation, the TLS decision, and credential scoping on one parser is
 * deliberate: a `startsWith("wss://")` check and a case-insensitive validator
 * disagreeing is exactly how credentials get attached to the wrong endpoint.
 *
 * This is written without `URL` because @pwragent/shared compiles without DOM
 * or Node lib types.
 */
export function parseFederationGatewayEndpoint(
  value: string,
): ParsedFederationEndpoint | undefined {
  const match = /^([A-Za-z]+):\/\/([^/?#]*)/.exec(value.trim());
  if (!match) return undefined;
  const scheme = match[1].toLowerCase();
  if (
    !(FEDERATION_ENDPOINT_SCHEMES as readonly string[]).includes(scheme)
  ) {
    return undefined;
  }
  const authority = match[2];
  const at = authority.lastIndexOf("@");
  const user = at >= 0 ? authority.slice(0, at) : undefined;
  const hostPort = (at >= 0 ? authority.slice(at + 1) : authority).toLowerCase();
  // Never accept credentials embedded in an endpoint URL.
  if (user !== undefined && user.includes(":")) return undefined;
  if (hostPort.length === 0) return undefined;
  // A leading "-" on the host or user would reach ssh(1) as an option rather
  // than a destination. Reject it everywhere rather than relying on argv
  // position to keep it harmless.
  if (hostPort.startsWith("-") || user?.startsWith("-")) return undefined;
  const host = hostPort.startsWith("[")
    ? hostPort.slice(0, hostPort.indexOf("]") + 1)
    : hostPort.split(":")[0];
  if (host.length === 0) return undefined;
  return {
    scheme: scheme as FederationEndpointScheme,
    host,
    hostPort,
    user,
    isTls: scheme === "wss",
  };
}

export function isFederationGatewayEndpointUrl(value: string): boolean {
  return parseFederationGatewayEndpoint(value) !== undefined;
}

/**
 * Whether an endpoint is the operator-designated Cloudflare-fronted endpoint,
 * and may therefore be sent Cloudflare Access tokens / mTLS client keys.
 *
 * Those credentials travel in the WebSocket upgrade — before the Noise
 * handshake pins anything — so they must be scoped to a specific host the
 * operator named, never to "any wss:// URL". When no endpoint is designated,
 * only a single-endpoint configuration qualifies, which preserves the
 * pre-multi-path behavior without widening it to additional hosts.
 */
export function federationEndpointAcceptsCloudflareCredentials(params: {
  endpoint: string;
  cloudflareEndpoint?: string;
  configuredEndpointCount: number;
}): boolean {
  const parsed = parseFederationGatewayEndpoint(params.endpoint);
  if (!parsed?.isTls) return false;
  const designated = params.cloudflareEndpoint?.trim();
  if (designated) {
    const target = parseFederationGatewayEndpoint(designated);
    return target !== undefined && target.hostPort === parsed.hostPort;
  }
  return params.configuredEndpointCount <= 1;
}

export type FederationEndpointState =
  | "active"
  | "connecting"
  | "failed"
  | "idle";

export type FederationEndpointStatus = {
  url: string;
  state: FederationEndpointState;
  lastAttemptAt?: number;
  lastConnectedAt?: number;
  lastError?: string;
};

export type FederationHealthStatus = {
  enabled: boolean;
  role: FederationInstanceRole;
  status: FederationConnectionState;
  instanceId?: FederationInstanceId;
  listenUrl?: string;
  publicUrl?: string;
  unavailableReason?: string;
  /** Client-mode gateway endpoints in configured order with live status. */
  gatewayEndpoints?: FederationEndpointStatus[];
  /** This instance's own assigned celestial identity icon. */
  localCelestialIcon?: CelestialIconId;
  peers: FederationPeerSummary[];
  clientEnrollment?: FederationClientEnrollment;
};

export type ReadFederationHealthRequest = Record<string, never>;

export type ReadFederationHealthResponse = {
  health: FederationHealthStatus;
};

export type FederationTailscaleMode = "serve" | "funnel";

export type FederationTailscaleStatus = {
  installed: boolean;
  connected: boolean;
  version?: string;
  backendState?: string;
  dnsName?: string;
  tailnetName?: string;
  serveConfigured: boolean;
  funnelConfigured: boolean;
  gatewayUrl?: string;
  unavailableReason?: string;
};

export type ReadFederationTailscaleStatusRequest = Record<string, never>;

export type ReadFederationTailscaleStatusResponse = {
  status: FederationTailscaleStatus;
};

export type ConfigureFederationTailscaleRequest = {
  mode: FederationTailscaleMode;
  listenPort: number;
};

export type ConfigureFederationTailscaleResponse = {
  status: FederationTailscaleStatus;
  gatewayUrl: string;
};

export type FederationDiagnosticEventKind =
  | "connect_attempt"
  | "connected"
  | "rejected"
  | "disconnected"
  | "relay"
  | "error"
  | "remote_pty_open"
  | "remote_pty_close";

export type FederationDiagnosticEvent = {
  eventId: number;
  peerId?: FederationPeerId;
  sessionId?: FederationSessionId;
  kind: FederationDiagnosticEventKind;
  /** Most recent occurrence when the row collapses repeats. */
  createdAt: number;
  detail?: string;
  /** Number of identical consecutive occurrences collapsed into this row. */
  repeatCount?: number;
  /** First occurrence when `repeatCount` > 1. */
  firstSeenAt?: number;
};

export type ReadFederationDiagnosticsRequest = {
  limit?: number;
  peerId?: FederationPeerId;
};

export type ReadFederationDiagnosticsResponse = {
  health: FederationHealthStatus;
  events: FederationDiagnosticEvent[];
};

export type RevokeFederationPeerRequest = {
  peerId: FederationPeerId;
};

export type RevokeFederationPeerResponse = {
  peer: FederationPeerSummary;
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
  /**
   * Every endpoint the invite asked this client to dial. Surfaced so the
   * operator can see what a pasted invite configured instead of discovering
   * it only by reading config.toml.
   */
  gatewayEndpoints: string[];
};

export type ResetFederationEnrollmentRequest = Record<string, never>;

export type ResetFederationEnrollmentResponse = {
  cleared: boolean;
};

export type OpenFederationWindowRequest = {
  target: FederationRemoteTarget;
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
  backend?: AppServerBackendScope;
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

export type FederatedSearchInstanceSummary = {
  instanceId: FederationInstanceId;
  instanceLabel: string;
  resultCount: number;
};

export type FederatedSearchResponse = {
  query: string;
  searchedAt: number;
  results: FederatedSearchResult[];
  failures: FederatedSearchPeerFailure[];
  /** Peers that were queried successfully, so the UI can disclose scope. */
  searchedInstances?: FederatedSearchInstanceSummary[];
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

/**
 * Narrow a capability-name list to the capabilities THIS build knows.
 * Unknown names from newer builds are ignored, never an error — that is
 * what lets capability additions ship without breaking older peers.
 */
export function filterKnownFederationCapabilities(
  value: readonly string[],
): FederationCapability[] {
  return value.filter(isFederationCapability);
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

/**
 * Display label for a federation peer: the machine label, with the
 * remote profile appended as "<label> / <profile>" when it matters.
 * The profile shows when it isn't "default", or when more than one
 * visible peer shares the machine label (several profiles of one
 * machine enrolled at once) — in that case even "default" shows so the
 * entries stay tellable apart. A lone default-profile peer keeps the
 * bare machine name. Peers that never advertised a profile (older
 * builds) always keep the bare label, and revoked peers are dead
 * entries that must not force the suffix onto their live sibling.
 */
export function formatFederationPeerDisplayLabel(
  peer: { label: string; profileName?: string },
  visiblePeers: readonly {
    label: string;
    profileName?: string;
    revokedAt?: number;
  }[],
): string {
  if (!peer.profileName) {
    return peer.label;
  }
  const sameMachinePeers = visiblePeers.filter(
    (candidate) => !candidate.revokedAt && candidate.label === peer.label,
  );
  if (peer.profileName === "default" && sameMachinePeers.length <= 1) {
    return peer.label;
  }
  return `${peer.label} / ${peer.profileName}`;
}

export function federationTargetKey(target: FederationTarget): string {
  return isRemoteFederationTarget(target) ? `remote:${target.instanceId}` : "local";
}

export function federatedThreadIdentityKey(ref: FederatedThreadRef): string {
  return `${federationTargetKey(ref.target)}:${encodeURIComponent(
    ref.backend,
  )}:${ref.threadId}`;
}
