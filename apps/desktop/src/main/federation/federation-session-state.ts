import type {
  FederationCapability,
  FederationPeerId,
  FederationSessionId,
} from "@pwragent/shared";

export type FederationActiveSession = {
  sessionId: FederationSessionId;
  peerId: FederationPeerId;
  connectedAt: number;
  lastHeartbeatAt: number;
  capabilities: FederationCapability[];
  status: "active" | "closed";
  closedAt?: number;
  closeReason?: "replaced" | "revoked" | "timeout" | "transport_closed";
};

export class FederationSessionRegistry {
  private readonly sessions = new Map<FederationSessionId, FederationActiveSession>();

  openSession(params: {
    sessionId: FederationSessionId;
    peerId: FederationPeerId;
    connectedAt: number;
    capabilities: readonly FederationCapability[];
  }): FederationActiveSession {
    for (const session of this.sessions.values()) {
      if (session.peerId === params.peerId && session.status === "active") {
        this.closeSession({
          sessionId: session.sessionId,
          closedAt: params.connectedAt,
          reason: "replaced",
        });
      }
    }
    const session: FederationActiveSession = {
      sessionId: params.sessionId,
      peerId: params.peerId,
      connectedAt: params.connectedAt,
      lastHeartbeatAt: params.connectedAt,
      capabilities: params.capabilities.slice(),
      status: "active",
    };
    this.sessions.set(params.sessionId, session);
    return session;
  }

  heartbeat(sessionId: FederationSessionId, heartbeatAt: number): FederationActiveSession | undefined {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== "active") return session;
    session.lastHeartbeatAt = heartbeatAt;
    return session;
  }

  closeSession(params: {
    sessionId: FederationSessionId;
    closedAt: number;
    reason: FederationActiveSession["closeReason"];
  }): FederationActiveSession | undefined {
    const session = this.sessions.get(params.sessionId);
    if (!session || session.status === "closed") return session;
    session.status = "closed";
    session.closedAt = params.closedAt;
    session.closeReason = params.reason;
    return session;
  }

  closePeerSessions(params: {
    peerId: FederationPeerId;
    closedAt: number;
    reason: FederationActiveSession["closeReason"];
  }): FederationActiveSession[] {
    const closed: FederationActiveSession[] = [];
    for (const session of this.sessions.values()) {
      if (session.peerId !== params.peerId || session.status !== "active") {
        continue;
      }
      const next = this.closeSession({
        sessionId: session.sessionId,
        closedAt: params.closedAt,
        reason: params.reason,
      });
      if (next) closed.push(next);
    }
    return closed;
  }

  expireStaleSessions(params: {
    now: number;
    heartbeatTimeoutMs: number;
  }): FederationActiveSession[] {
    const expired: FederationActiveSession[] = [];
    for (const session of this.sessions.values()) {
      if (session.status !== "active") continue;
      if (session.lastHeartbeatAt + params.heartbeatTimeoutMs > params.now) {
        continue;
      }
      const next = this.closeSession({
        sessionId: session.sessionId,
        closedAt: params.now,
        reason: "timeout",
      });
      if (next) expired.push(next);
    }
    return expired;
  }

  getSession(sessionId: FederationSessionId): FederationActiveSession | undefined {
    return this.sessions.get(sessionId);
  }

  listActiveSessions(): FederationActiveSession[] {
    return Array.from(this.sessions.values()).filter(
      (session) => session.status === "active",
    );
  }
}
