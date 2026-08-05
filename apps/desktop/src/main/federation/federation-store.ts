import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type {
  FederationCapability,
  FederationConnectionState,
  FederationInstanceRole,
  FederationPeerId,
  FederationPeerSummary,
  FederationSessionId,
} from "@pwragent/shared";
import { isFederationInstanceId } from "@pwragent/shared";
import type { StateDb } from "../state/state-db";

const FEDERATION_ENROLLMENT_SECRET_META_KEY =
  "federation_enrollment_secret_v1";

export type FederationEnrollmentStatus =
  | "pending"
  | "used"
  | "expired"
  | "revoked";

export type FederationEnrollmentEntry = {
  id: string;
  status: FederationEnrollmentStatus;
  generatedAt: number;
  expiresAt: number;
  usedAt?: number;
  peerId?: FederationPeerId;
  label?: string;
  role?: FederationInstanceRole;
  endpoint?: string;
  gatewayInstanceId?: string;
};

export type FederationSessionAuditKind =
  | "connect_attempt"
  | "connected"
  | "rejected"
  | "disconnected"
  | "relay"
  | "error"
  | "remote_pty_open"
  | "remote_pty_close";

export type FederationSessionAuditEntry = {
  eventId: number;
  peerId?: FederationPeerId;
  sessionId?: FederationSessionId;
  kind: FederationSessionAuditKind;
  createdAt: number;
  detail?: string;
  repeatCount?: number;
  firstSeenAt?: number;
};

/**
 * A repeat of the newest matching audit row inside this window collapses
 * into that row (repeat_count bump) instead of inserting. Sized to cover
 * the client reconnect loop's 30s max backoff with a wide margin while
 * still letting a failure that recurs after a quiet gap start a fresh row.
 */
const FEDERATION_AUDIT_REPEAT_COLLAPSE_WINDOW_MS = 10 * 60 * 1000;

type FederationPeerPayload = {
  capabilities?: FederationCapability[];
  protocolVersion?: number;
  endpoint?: string;
  profileName?: string;
  notes?: string;
  pinnedPublicKeyPem?: string;
  lastConnectedAt?: number;
  lastActivityAt?: number;
  unavailableReason?: string;
};

type FederationEnrollmentPayload = {
  label?: string;
  role?: FederationInstanceRole;
  endpoint?: string;
  gatewayInstanceId?: string;
};

type FederationSessionAuditPayload = {
  detail?: string;
  repeatCount?: number;
  firstSeenAt?: number;
};

type FederationPeerRow = {
  peer_id: string;
  label: string;
  role: string;
  status: string;
  created_at: number;
  updated_at: number;
  last_seen_at: number | null;
  revoked_at: number | null;
  payload: string;
};

type FederationEnrollmentRow = {
  enrollment_id: string;
  token_hmac: string;
  status: string;
  generated_at: number;
  expires_at: number;
  used_at: number | null;
  peer_id: string | null;
  payload: string;
};

type FederationSessionAuditRow = {
  event_id: number;
  peer_id: string | null;
  session_id: string | null;
  kind: string;
  created_at: number;
  payload: string;
};

export class FederationStore {
  constructor(private readonly stateDb: StateDb) {}

  upsertPeer(params: {
    peer: FederationPeerSummary & { pinnedPublicKeyPem?: string };
    createdAt?: number;
    updatedAt: number;
    /**
     * A successfully verified one-time enrollment explicitly restores trust
     * in an instance that was previously revoked. Ordinary peer refreshes
     * must never clear revocation state implicitly.
     */
    clearRevocation?: boolean;
  }): void {
    assertPeerId(params.peer.id);
    const existing = this.getPeer(params.peer.id);
    const createdAt = params.createdAt ?? existing?.createdAt ?? params.updatedAt;
    const revokedAt = params.clearRevocation
      ? undefined
      : params.peer.revokedAt ?? existing?.revokedAt;
    const status = revokedAt === undefined ? params.peer.status : "revoked";
    const payload: FederationPeerPayload = {
      capabilities: params.peer.capabilities,
      protocolVersion: params.peer.protocolVersion,
      endpoint: params.peer.endpoint,
      profileName: params.peer.profileName,
      notes: params.peer.notes,
      pinnedPublicKeyPem: params.peer.pinnedPublicKeyPem,
      lastConnectedAt: params.peer.lastConnectedAt,
      lastActivityAt: params.peer.lastActivityAt,
      unavailableReason: params.peer.unavailableReason,
    };
    this.stateDb.raw
      .prepare(
        `INSERT INTO federation_peers(
           peer_id, label, role, status, created_at, updated_at, last_seen_at,
           revoked_at, payload
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(peer_id) DO UPDATE SET
           label = excluded.label,
           role = excluded.role,
           status = excluded.status,
           updated_at = excluded.updated_at,
           last_seen_at = excluded.last_seen_at,
           revoked_at = excluded.revoked_at,
           payload = excluded.payload`,
      )
      .run(
        params.peer.id,
        params.peer.label,
        params.peer.role,
        status,
        createdAt,
        params.updatedAt,
        params.peer.lastActivityAt ?? null,
        revokedAt ?? null,
        JSON.stringify(payload),
      );
  }

  getPeer(peerId: FederationPeerId): (FederationPeerSummary & {
    createdAt: number;
    updatedAt: number;
    lastSeenAt?: number;
    pinnedPublicKeyPem?: string;
  }) | undefined {
    assertPeerId(peerId);
    const row = this.stateDb.raw
      .prepare(
        `SELECT peer_id, label, role, status, created_at, updated_at,
                last_seen_at, revoked_at, payload
         FROM federation_peers
         WHERE peer_id = ?`,
      )
      .get(peerId) as FederationPeerRow | undefined;
    return row ? rowToPeer(row) : undefined;
  }

  listPeers(options?: { includeRevoked?: boolean }): FederationPeerSummary[] {
    const rows = options?.includeRevoked
      ? (this.stateDb.raw
          .prepare(
            `SELECT peer_id, label, role, status, created_at, updated_at,
                    last_seen_at, revoked_at, payload
             FROM federation_peers
             ORDER BY updated_at DESC`,
          )
          .all() as FederationPeerRow[])
      : (this.stateDb.raw
          .prepare(
            `SELECT peer_id, label, role, status, created_at, updated_at,
                    last_seen_at, revoked_at, payload
             FROM federation_peers
             WHERE revoked_at IS NULL
             ORDER BY updated_at DESC`,
          )
          .all() as FederationPeerRow[]);
    return rows.map(rowToPeer);
  }

  revokePeer(peerId: FederationPeerId, revokedAt: number): void {
    assertPeerId(peerId);
    this.stateDb.raw
      .prepare(
        `UPDATE federation_peers
         SET status = 'revoked', revoked_at = ?, updated_at = ?
         WHERE peer_id = ?`,
      )
      .run(revokedAt, revokedAt, peerId);
  }

  createEnrollment(params: {
    token: string;
    generatedAt: number;
    expiresAt: number;
    label?: string;
    role?: FederationInstanceRole;
    endpoint?: string;
    gatewayInstanceId?: string;
  }): FederationEnrollmentEntry {
    const entry: FederationEnrollmentEntry = {
      id: `federation-enrollment:${randomUUID()}`,
      status: "pending",
      generatedAt: params.generatedAt,
      expiresAt: params.expiresAt,
      label: params.label,
      role: params.role,
      endpoint: params.endpoint,
      gatewayInstanceId: params.gatewayInstanceId,
    };
    this.stateDb.raw
      .prepare(
        `INSERT INTO federation_enrollment_tokens(
           enrollment_id, token_hmac, status, generated_at, expires_at,
           used_at, peer_id, payload
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.id,
        this.hmacToken(params.token, params.generatedAt),
        entry.status,
        params.generatedAt,
        params.expiresAt,
        null,
        null,
        JSON.stringify({
          label: params.label,
          role: params.role,
          endpoint: params.endpoint,
          gatewayInstanceId: params.gatewayInstanceId,
        } satisfies FederationEnrollmentPayload),
      );
    return entry;
  }

  findMatchingPendingEnrollment(params: {
    token: string;
    now: number;
  }): FederationEnrollmentEntry | undefined {
    this.expireEnrollments(params.now);
    const rows = this.stateDb.raw
      .prepare(
        `SELECT enrollment_id, token_hmac, status, generated_at, expires_at,
                used_at, peer_id, payload
         FROM federation_enrollment_tokens
         WHERE status = 'pending'
           AND expires_at > ?
         ORDER BY generated_at DESC`,
      )
      .all(params.now) as FederationEnrollmentRow[];

    for (const row of rows) {
      const candidate = this.hmacToken(params.token, row.generated_at);
      if (safeEqualHex(candidate, row.token_hmac)) {
        return rowToEnrollment(row);
      }
    }
    return undefined;
  }

  markEnrollmentUsed(params: {
    enrollmentId: string;
    peerId: FederationPeerId;
    usedAt: number;
  }): FederationEnrollmentEntry | undefined {
    assertPeerId(params.peerId);
    this.stateDb.raw
      .prepare(
        `UPDATE federation_enrollment_tokens
         SET status = 'used', used_at = ?, peer_id = ?
         WHERE enrollment_id = ? AND status = 'pending'`,
      )
      .run(params.usedAt, params.peerId, params.enrollmentId);
    return this.getEnrollment(params.enrollmentId);
  }

  getEnrollment(enrollmentId: string): FederationEnrollmentEntry | undefined {
    const row = this.stateDb.raw
      .prepare(
        `SELECT enrollment_id, token_hmac, status, generated_at, expires_at,
                used_at, peer_id, payload
         FROM federation_enrollment_tokens
         WHERE enrollment_id = ?`,
      )
      .get(enrollmentId) as FederationEnrollmentRow | undefined;
    return row ? rowToEnrollment(row) : undefined;
  }

  expireEnrollments(now: number): void {
    this.stateDb.raw
      .prepare(
        `UPDATE federation_enrollment_tokens
         SET status = 'expired'
         WHERE status = 'pending' AND expires_at <= ?`,
      )
      .run(now);
  }

  appendAudit(params: {
    peerId?: FederationPeerId;
    sessionId?: FederationSessionId;
    kind: FederationSessionAuditKind;
    createdAt: number;
    detail?: string;
  }): FederationSessionAuditEntry {
    if (params.peerId) assertPeerId(params.peerId);
    const collapsed = this.collapseRepeatAudit(params);
    if (collapsed) return collapsed;
    const result = this.stateDb.raw
      .prepare(
        `INSERT INTO federation_session_audit(
           peer_id, session_id, kind, created_at, payload
         ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        params.peerId ?? null,
        params.sessionId ?? null,
        params.kind,
        params.createdAt,
        JSON.stringify({ detail: params.detail } satisfies FederationSessionAuditPayload),
      );
    return {
      eventId: Number(result.lastInsertRowid),
      peerId: params.peerId,
      sessionId: params.sessionId,
      kind: params.kind,
      createdAt: params.createdAt,
      detail: params.detail,
    };
  }

  /**
   * The client reconnect loop emits an identical connect_attempt + error
   * pair every backoff cycle; without collapsing, a broken pairing writes
   * thousands of duplicate rows a day. When the newest row for the same
   * kind/peer/session carries the same detail and is recent, bump its
   * repeat count and refresh created_at instead of inserting a new row.
   */
  private collapseRepeatAudit(params: {
    peerId?: FederationPeerId;
    sessionId?: FederationSessionId;
    kind: FederationSessionAuditKind;
    createdAt: number;
    detail?: string;
  }): FederationSessionAuditEntry | undefined {
    const newest = this.stateDb.raw
      .prepare(
        `SELECT event_id, peer_id, session_id, kind, created_at, payload
         FROM federation_session_audit
         WHERE kind = ?
           AND peer_id IS ?
           AND session_id IS ?
         ORDER BY created_at DESC, event_id DESC
         LIMIT 1`,
      )
      .get(
        params.kind,
        params.peerId ?? null,
        params.sessionId ?? null,
      ) as FederationSessionAuditRow | undefined;
    if (!newest) return undefined;
    if (params.createdAt - newest.created_at > FEDERATION_AUDIT_REPEAT_COLLAPSE_WINDOW_MS) {
      return undefined;
    }
    const payload = parseJson<FederationSessionAuditPayload>(newest.payload);
    if ((payload.detail ?? undefined) !== (params.detail ?? undefined)) {
      return undefined;
    }
    const repeatCount = (payload.repeatCount ?? 1) + 1;
    const firstSeenAt = payload.firstSeenAt ?? newest.created_at;
    this.stateDb.raw
      .prepare(
        `UPDATE federation_session_audit
         SET created_at = ?, payload = ?
         WHERE event_id = ?`,
      )
      .run(
        params.createdAt,
        JSON.stringify({
          detail: params.detail,
          repeatCount,
          firstSeenAt,
        } satisfies FederationSessionAuditPayload),
        newest.event_id,
      );
    return {
      eventId: newest.event_id,
      peerId: params.peerId,
      sessionId: params.sessionId,
      kind: params.kind,
      createdAt: params.createdAt,
      detail: params.detail,
      repeatCount,
      firstSeenAt,
    };
  }

  listAudit(params?: {
    peerId?: FederationPeerId;
    sessionId?: FederationSessionId;
    limit?: number;
  }): FederationSessionAuditEntry[] {
    if (params?.peerId) assertPeerId(params.peerId);
    const limit = Math.max(1, Math.min(params?.limit ?? 50, 500));
    const rows = params?.peerId
      ? (this.stateDb.raw
          .prepare(
            `SELECT event_id, peer_id, session_id, kind, created_at, payload
             FROM federation_session_audit
             WHERE peer_id = ?
             ORDER BY created_at DESC, event_id DESC
             LIMIT ?`,
          )
          .all(params.peerId, limit) as FederationSessionAuditRow[])
      : params?.sessionId
        ? (this.stateDb.raw
            .prepare(
              `SELECT event_id, peer_id, session_id, kind, created_at, payload
               FROM federation_session_audit
               WHERE session_id = ?
               ORDER BY created_at DESC, event_id DESC
               LIMIT ?`,
            )
            .all(params.sessionId, limit) as FederationSessionAuditRow[])
        : (this.stateDb.raw
            .prepare(
              `SELECT event_id, peer_id, session_id, kind, created_at, payload
               FROM federation_session_audit
               ORDER BY created_at DESC, event_id DESC
               LIMIT ?`,
            )
            .all(limit) as FederationSessionAuditRow[]);
    return rows.map(rowToAudit);
  }

  private hmacToken(token: string, generatedAt: number): string {
    return createHmac("sha256", this.enrollmentSecret())
      .update(token)
      .update("\0")
      .update(String(generatedAt))
      .digest("hex");
  }

  private enrollmentSecret(): Buffer {
    const existing = this.stateDb.getMeta(FEDERATION_ENROLLMENT_SECRET_META_KEY);
    if (existing) return Buffer.from(existing, "base64");
    const generated = randomBytes(32);
    this.stateDb.setMeta(
      FEDERATION_ENROLLMENT_SECRET_META_KEY,
      generated.toString("base64"),
    );
    return generated;
  }
}

function assertPeerId(peerId: FederationPeerId): void {
  if (!isFederationInstanceId(peerId)) {
    throw new Error(`Invalid federation peer id: ${peerId}`);
  }
}

function rowToPeer(row: FederationPeerRow): FederationPeerSummary & {
  createdAt: number;
  updatedAt: number;
  lastSeenAt?: number;
  pinnedPublicKeyPem?: string;
} {
  const payload = parseJson<FederationPeerPayload>(row.payload);
  return {
    id: row.peer_id,
    label: row.label,
    role: normalizeFederationInstanceRole(row.role) ?? "client",
    status: row.status as FederationConnectionState,
    capabilities: payload.capabilities ?? [],
    protocolVersion: payload.protocolVersion,
    endpoint: payload.endpoint,
    profileName: payload.profileName,
    notes: payload.notes,
    pinnedPublicKeyPem: payload.pinnedPublicKeyPem,
    lastConnectedAt: payload.lastConnectedAt,
    lastActivityAt: payload.lastActivityAt,
    revokedAt: row.revoked_at ?? undefined,
    unavailableReason: payload.unavailableReason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSeenAt: row.last_seen_at ?? undefined,
  };
}

function rowToEnrollment(row: FederationEnrollmentRow): FederationEnrollmentEntry {
  const payload = parseJson<FederationEnrollmentPayload>(row.payload);
  return {
    id: row.enrollment_id,
    status: row.status as FederationEnrollmentStatus,
    generatedAt: row.generated_at,
    expiresAt: row.expires_at,
    usedAt: row.used_at ?? undefined,
    peerId: row.peer_id ?? undefined,
    label: payload.label,
    role: normalizeFederationInstanceRole(payload.role),
    endpoint: payload.endpoint,
    gatewayInstanceId: payload.gatewayInstanceId,
  };
}

function normalizeFederationInstanceRole(
  value: FederationInstanceRole | string | undefined,
): FederationInstanceRole | undefined {
  if (value === "child") {
    return "client";
  }
  return value === "gateway" || value === "client" || value === "dual"
    ? value
    : undefined;
}

function rowToAudit(row: FederationSessionAuditRow): FederationSessionAuditEntry {
  const payload = parseJson<FederationSessionAuditPayload>(row.payload);
  return {
    eventId: row.event_id,
    peerId: row.peer_id ?? undefined,
    sessionId: row.session_id ?? undefined,
    kind: row.kind as FederationSessionAuditKind,
    createdAt: row.created_at,
    detail: payload.detail,
    repeatCount: payload.repeatCount,
    firstSeenAt: payload.firstSeenAt,
  };
}

function parseJson<T extends object>(payload: string): Partial<T> {
  try {
    return JSON.parse(payload) as Partial<T>;
  } catch {
    return {};
  }
}

function safeEqualHex(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}
