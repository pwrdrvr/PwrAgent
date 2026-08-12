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
  "navigation_snapshot_deltas",
  "thread_detail",
  "turn_control",
  "scheduled_actions",
  "pending_request_control",
  "environment_actions",
  "launchpad_metadata",
  "federated_search",
  "messaging_route",
  "pwrsnap_connection",
  "gateway_relay",
  "remote_pty",
  "event_subscriptions",
] as const;

export type FederationCapability = (typeof FEDERATION_CAPABILITIES)[number];

/**
 * Backend-event streams are opt-in and intentionally split by consumer need.
 * Unknown notification methods fall into `transcript`, the most restrictive
 * class, so a new producer cannot silently widen navigation-only subscribers.
 */
export const FEDERATION_EVENT_CLASSES = [
  "navigation",
  "transcript",
  "pending_requests",
  "scheduled_actions",
  "star_map",
] as const;

export type FederationEventClass =
  (typeof FEDERATION_EVENT_CLASSES)[number];

export type FederationEventSubscription = {
  sourceInstanceId: FederationInstanceId;
  eventClasses: FederationEventClass[];
};

export type FederationEventSubscriptionConsumer =
  | "star_map"
  | "thread_view";

export type SetFederationEventSubscriptionsRequest = {
  consumer?: FederationEventSubscriptionConsumer;
  subscriptions: FederationEventSubscription[];
};

export type SetFederationEventSubscriptionsResponse = {
  subscriptions: FederationEventSubscription[];
};

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

/**
 * Static host facts an instance advertises to enrolled peers. Refreshed on
 * every reconnect; `diskFreeBytes` is a snapshot from the last handshake or
 * directory broadcast, not a live reading. `machineId` is minted once per
 * PwrAgent root (`<root>/machine-id`) and shared by every profile on the
 * machine — instances with the same machineId run on the same hardware and
 * compete for its CPUs/RAM.
 */
export type FederationHostInfo = {
  platform?: string;
  osVersion?: string;
  hostname?: string;
  arch?: string;
  cpuCount?: number;
  memoryBytes?: number;
  diskFreeBytes?: number;
  machineId?: string;
};

/**
 * Live load reading sampled on the owning instance at answer time.
 * Deliberately a sibling of {@link FederationHostInfo}, not an extension:
 * host facts are static and advertised on handshake, load is queried on
 * demand (`backend.getLoadStatus`) and never gossiped. Instances sharing
 * `FederationHostInfo.machineId` run on the same hardware and report the
 * same underlying load — dedupe by machineId when aggregating.
 * `loadAvg*` are 0 on Windows (Node's `os.loadavg()` contract);
 * `diskFreeBytes` measures the volume holding the PwrAgent root and is
 * omitted when the read fails.
 */
export type FederationLoadStatus = {
  loadAvg1: number;
  loadAvg5: number;
  loadAvg15: number;
  /**
   * Cores the load averages are measured against. Carried in the reading
   * itself because a load average is uninterpretable without it — 3.3 is
   * idle on a 16-core box and badly oversubscribed on a 2-core one — and
   * the handshake host block is not available for the local instance.
   */
  cpuCount?: number;
  /**
   * Memory the instance could hand to new work — reclaimable cache
   * included, since the kernel will simply drop it under demand.
   *
   * Deliberately NOT `os.freemem()`, which on macOS counts only truly free
   * pages: a healthy 16 GB Mac with a few GB of file cache reports ~140 MB
   * there while its pressure gauge sits in the green, and presenting that as
   * free RAM reads as a machine about to die.
   */
  availableMemoryBytes: number;
  /** Installed RAM, so `availableMemoryBytes` can be read as a share. */
  totalMemoryBytes?: number;
  /** Live counterpart of the handshake snapshot `FederationHostInfo.diskFreeBytes`. */
  diskFreeBytes?: number;
  sampledAt: number;
};

/**
 * Locally observed wire-transfer counters for one directly connected
 * peer socket. Not a protocol field — each side counts the envelope
 * frames it sends and receives on its own transport (after encryption,
 * so compression changes show up here as real wire savings), and the
 * counters live only in the observing process: they start at first
 * activity and reset on app restart, never persisted or gossiped.
 *
 * On a gateway the counters attribute per peer socket, including
 * relayed sibling traffic on both legs. On a client, all remote
 * traffic rides the single gateway socket and lands on the gateway's
 * row. Handshake/auth frames and WebSocket keepalives are not counted.
 */
export type FederationTransferStats = {
  /** Wire bytes of envelope frames sent to the peer. */
  bytesSent: number;
  /** Wire bytes of envelope frames received from the peer. */
  bytesReceived: number;
  envelopesSent: number;
  envelopesReceived: number;
  /** When counting began (first observed activity in this process). */
  since: number;
  lastActivityAt: number;
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
  /**
   * Operator-written purpose notes for the instance ("Studio Mac — PwrSnap
   * dev + screen recording"). Advertised on handshake and peer-directory
   * gossip; read by orchestration agents when routing work.
   */
  notes?: string;
  host?: FederationHostInfo;
  /**
   * This instance's locally counted wire transfer with the peer.
   * Attached only on health/diagnostics reads — never advertised in
   * the peer directory, because the numbers describe the observer's
   * own socket, not the peer.
   */
  transfer?: FederationTransferStats;
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
  /**
   * This instance's display label — the resolved `instanceLabel` config
   * value, falling back to the hostname default. Surfaces mirroring the
   * peer list need the local instance's real name, not a placeholder.
   */
  localLabel?: string;
  /**
   * Active profile name for this instance. Two profiles on one machine
   * share a label, so this is what tells them apart via
   * {@link formatFederationPeerDisplayLabel}.
   */
  localProfileName?: string;
  /**
   * Another live app instance holding this profile's federation lease.
   * Present when this instance keeps its federation runtime stopped because
   * the profile is already served elsewhere (mirrors the messaging lease
   * holder surface). The instanceId is the app-runtime lease owner id, not
   * a federation instance id.
   */
  leaseHolder?: {
    instanceId: string;
    processId?: number;
    cwdHint?: string;
    startedAt?: number;
  };
  peers: FederationPeerSummary[];
  clientEnrollment?: FederationClientEnrollment;
};

export type ReadFederationHealthRequest = Record<string, never>;

export type ReadFederationHealthResponse = {
  health: FederationHealthStatus;
};

/**
 * Renderer poll for one instance's live load (Star Map health
 * indicators). An omitted `instanceId` — or the local instance's own id —
 * samples locally; a remote id rides the `backend.getLoadStatus`
 * federation RPC.
 */
export type ReadFederationInstanceLoadRequest = {
  instanceId?: FederationInstanceId;
};

/**
 * `load` is absent when the peer is not connected, has not granted
 * `thread_navigation`, or did not answer within the short load-query
 * timeout. A polling health surface degrades to "no indicator" — this
 * response never carries an error.
 */
export type ReadFederationInstanceLoadResponse = {
  load?: FederationLoadStatus;
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

/**
 * What a revoke / forget-pairing does to the viewer's pinned remote
 * threads for the affected instances.
 *
 * `remember` (the default everywhere) tombstones them: the rows stop
 * rendering, but a later re-enrollment restores the operator's curated
 * list. `forget` is the explicit, irreversible discard. Defaulting to
 * `remember` keeps an un-updated or buggy caller on the non-destructive
 * path — the reverse default would silently delete operator data.
 */
export type FederationPinDisposition = "forget" | "remember";

export function isFederationPinDisposition(
  value: unknown,
): value is FederationPinDisposition {
  return value === "forget" || value === "remember";
}

export type RevokeFederationPeerRequest = {
  peerId: FederationPeerId;
  pinDisposition?: FederationPinDisposition;
};

export type RevokeFederationPeerResponse = {
  peer: FederationPeerSummary;
};

/** Which instances a pending revoke / forget would affect. */
export type FederationPinImpactScope =
  | { kind: "peer"; peerId: FederationPeerId }
  | { kind: "enrollment" };

export type ReadFederationPinImpactRequest = {
  scope: FederationPinImpactScope;
};

/**
 * Drives the keep-or-forget prompt. Both counts zero means the operator
 * has nothing pinned from the affected instances, so the prompt must not
 * appear at all — there is nothing to preserve or discard.
 */
export type ReadFederationPinImpactResponse = {
  /** Live pins that would be hidden (remember) or deleted (forget). */
  pinnedThreadCount: number;
  /** Pins already tombstoned by an earlier revoke of the same scope. */
  tombstonedThreadCount: number;
  /** Display labels of the affected instances, for the prompt copy. */
  instanceLabels: string[];
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

export type ResetFederationEnrollmentRequest = {
  pinDisposition?: FederationPinDisposition;
};

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
  includeArchived?: boolean;
  projectKeys?: string[];
  updatedAfter?: number;
  updatedBefore?: number;
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
  totalCount: number;
  truncated: boolean;
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

export function isFederationEventClass(
  value: unknown,
): value is FederationEventClass {
  return (
    typeof value === "string"
    && (FEDERATION_EVENT_CLASSES as readonly string[]).includes(value)
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
/**
 * The machine label plus the profile name, but only when the profile is
 * actually needed to tell two instances apart. Surfaces that can lay the
 * two out separately (the star map's instance card stacks them so the card
 * stays narrow) should use this; `formatFederationPeerDisplayLabel` joins
 * the same parts for single-line contexts.
 */
export function formatFederationPeerDisplayLabelParts(
  peer: { label: string; profileName?: string },
  visiblePeers: readonly {
    label: string;
    profileName?: string;
    revokedAt?: number;
  }[],
): { label: string; profileName?: string } {
  if (!peer.profileName) {
    return { label: peer.label };
  }
  const sameMachinePeers = visiblePeers.filter(
    (candidate) => !candidate.revokedAt && candidate.label === peer.label,
  );
  if (peer.profileName === "default" && sameMachinePeers.length <= 1) {
    return { label: peer.label };
  }
  return { label: peer.label, profileName: peer.profileName };
}

export function formatFederationPeerDisplayLabel(
  peer: { label: string; profileName?: string },
  visiblePeers: readonly {
    label: string;
    profileName?: string;
    revokedAt?: number;
  }[],
): string {
  const parts = formatFederationPeerDisplayLabelParts(peer, visiblePeers);
  return parts.profileName
    ? `${parts.label} / ${parts.profileName}`
    : parts.label;
}

export function federationTargetKey(target: FederationTarget): string {
  return isRemoteFederationTarget(target) ? `remote:${target.instanceId}` : "local";
}

export function federatedThreadIdentityKey(ref: FederatedThreadRef): string {
  return `${federationTargetKey(ref.target)}:${ref.backend}:${ref.threadId}`;
}
