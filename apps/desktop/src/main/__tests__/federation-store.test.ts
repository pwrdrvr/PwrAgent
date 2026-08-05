import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FederationStore } from "../federation/federation-store";
import { StateDb } from "../state/state-db";

let stateDb: StateDb;
let store: FederationStore;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "pwragent-federation-"));
  stateDb = StateDb.open(path.join(tempDir, "state.db"));
  store = new FederationStore(stateDb);
});

afterEach(() => {
  stateDb.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("FederationStore", () => {
  it("persists peer metadata and filters revoked peers by default", () => {
    store.upsertPeer({
      updatedAt: 1_000,
      peer: {
        id: "laptop_one",
        label: "Laptop",
        role: "client",
        status: "connected",
        capabilities: ["remote_window", "federated_search"],
        protocolVersion: 1,
        endpoint: "wss://example.cloudflareaccess.com/pwragent",
        profileName: "default",
        lastActivityAt: 950,
      },
    });

    expect(store.getPeer("laptop_one")).toMatchObject({
      id: "laptop_one",
      label: "Laptop",
      role: "client",
      status: "connected",
      capabilities: ["remote_window", "federated_search"],
      protocolVersion: 1,
      endpoint: "wss://example.cloudflareaccess.com/pwragent",
      profileName: "default",
      createdAt: 1_000,
      updatedAt: 1_000,
      lastSeenAt: 950,
    });

    store.revokePeer("laptop_one", 2_000);

    expect(store.listPeers()).toEqual([]);
    expect(store.listPeers({ includeRevoked: true })).toMatchObject([
      {
        id: "laptop_one",
        status: "revoked",
        revokedAt: 2_000,
      },
    ]);

    store.upsertPeer({
      updatedAt: 3_000,
      peer: {
        id: "laptop_one",
        label: "Laptop",
        role: "client",
        status: "connected",
        capabilities: ["remote_window"],
      },
    });

    expect(store.getPeer("laptop_one")).toMatchObject({
      status: "revoked",
      revokedAt: 2_000,
    });
  });

  it("clears revocation only for an explicitly reauthorized peer", () => {
    store.upsertPeer({
      updatedAt: 1_000,
      peer: {
        id: "laptop_one",
        label: "Laptop",
        role: "client",
        status: "connected",
        capabilities: ["remote_window"],
      },
    });
    store.revokePeer("laptop_one", 2_000);

    store.upsertPeer({
      updatedAt: 3_000,
      clearRevocation: true,
      peer: {
        id: "laptop_one",
        label: "Laptop",
        role: "client",
        status: "connected",
        capabilities: ["remote_window"],
      },
    });

    expect(store.getPeer("laptop_one")).toMatchObject({
      status: "connected",
      updatedAt: 3_000,
    });
    expect(store.getPeer("laptop_one")?.revokedAt).toBeUndefined();
    expect(store.listPeers()).toHaveLength(1);
  });

  it("matches pending enrollments without storing the raw token", () => {
    const token = "123456789ABCDEFGHJKLMNPQRSTUVWX";
    const enrollment = store.createEnrollment({
      token,
      generatedAt: 1_000,
      expiresAt: 2_000,
      label: "Travel laptop",
      role: "client",
      endpoint: "wss://pwragent.example.com/federation",
    });

    expect(
      store.findMatchingPendingEnrollment({
        token,
        now: 1_500,
      }),
    ).toMatchObject({
      id: enrollment.id,
      status: "pending",
      label: "Travel laptop",
      role: "client",
    });

    const row = stateDb.raw
      .prepare(
        "SELECT token_hmac, payload FROM federation_enrollment_tokens WHERE enrollment_id = ?",
      )
      .get(enrollment.id) as { token_hmac: string; payload: string };
    expect(row.token_hmac).not.toContain(token);
    expect(row.payload).not.toContain(token);
  });

  it("expires enrollments and prevents replay after use", () => {
    const expiredToken = "ABCDEFGHJKLMNPQRSTUVWXYZ1234567";
    const expired = store.createEnrollment({
      token: expiredToken,
      generatedAt: 1_000,
      expiresAt: 2_000,
    });

    expect(
      store.findMatchingPendingEnrollment({
        token: expiredToken,
        now: 2_000,
      }),
    ).toBeUndefined();
    expect(store.getEnrollment(expired.id)).toMatchObject({ status: "expired" });

    const replayToken = "abcdefghijkmnopqrstuvwxyz1234567";
    const replay = store.createEnrollment({
      token: replayToken,
      generatedAt: 3_000,
      expiresAt: 4_000,
    });
    store.markEnrollmentUsed({
      enrollmentId: replay.id,
      peerId: "desktop_one",
      usedAt: 3_100,
    });

    expect(
      store.findMatchingPendingEnrollment({
        token: replayToken,
        now: 3_200,
      }),
    ).toBeUndefined();
    expect(store.getEnrollment(replay.id)).toMatchObject({
      status: "used",
      peerId: "desktop_one",
      usedAt: 3_100,
    });
  });

  it("parameterizes token and audit lookups", () => {
    const token = "123456789ABCDEFGHJKLMNPQRSTUVWX";
    const enrollment = store.createEnrollment({
      token,
      generatedAt: 1_000,
      expiresAt: 2_000,
    });

    store.appendAudit({
      peerId: "desktop_one",
      sessionId: "session-1",
      kind: "connected",
      createdAt: 1_250,
      detail: "connected over tunnel",
    });

    expect(
      store.findMatchingPendingEnrollment({
        token: "' OR 1=1 --",
        now: 1_500,
      }),
    ).toBeUndefined();
    expect(store.getEnrollment(enrollment.id)).toMatchObject({
      id: enrollment.id,
      status: "pending",
    });
    expect(store.listAudit({ peerId: "desktop_one" })).toMatchObject([
      {
        peerId: "desktop_one",
        sessionId: "session-1",
        kind: "connected",
        detail: "connected over tunnel",
      },
    ]);
    expect(store.listAudit({ peerId: "missing_peer" })).toEqual([]);
  });

  it("collapses identical consecutive audit events into one repeat-counted row", () => {
    const first = store.appendAudit({
      peerId: "desktop_one",
      kind: "error",
      createdAt: 1_000,
      detail: "unknown_peer",
    });
    const second = store.appendAudit({
      peerId: "desktop_one",
      kind: "error",
      createdAt: 31_000,
      detail: "unknown_peer",
    });
    // Interleaved connect_attempt rows (the retry loop's other event)
    // collapse into their own row without breaking the error run.
    store.appendAudit({
      peerId: "desktop_one",
      kind: "connect_attempt",
      createdAt: 31_100,
      detail: "reconnect",
    });
    store.appendAudit({
      peerId: "desktop_one",
      kind: "connect_attempt",
      createdAt: 61_100,
      detail: "reconnect",
    });
    const third = store.appendAudit({
      peerId: "desktop_one",
      kind: "error",
      createdAt: 61_000,
      detail: "unknown_peer",
    });

    expect(second.eventId).toBe(first.eventId);
    expect(third).toMatchObject({
      eventId: first.eventId,
      repeatCount: 3,
      firstSeenAt: 1_000,
      createdAt: 61_000,
    });
    const audit = store.listAudit({ peerId: "desktop_one" });
    expect(audit).toHaveLength(2);
    expect(audit).toMatchObject([
      { kind: "connect_attempt", repeatCount: 2, firstSeenAt: 31_100 },
      { kind: "error", repeatCount: 3, firstSeenAt: 1_000 },
    ]);
  });

  it("does not collapse events with different details or beyond the repeat window", () => {
    store.appendAudit({
      peerId: "desktop_one",
      kind: "error",
      createdAt: 1_000,
      detail: "unknown_peer",
    });
    store.appendAudit({
      peerId: "desktop_one",
      kind: "error",
      createdAt: 2_000,
      detail: "bad_signature",
    });
    // Same detail again but 11 minutes after the last matching row —
    // outside the collapse window, so it starts a fresh row.
    store.appendAudit({
      peerId: "desktop_one",
      kind: "error",
      createdAt: 2_000 + 11 * 60 * 1000,
      detail: "bad_signature",
    });

    expect(store.listAudit({ peerId: "desktop_one" })).toHaveLength(3);
  });

  it("evicts audit rows beyond the retention cap in the GC pass", () => {
    for (let index = 0; index < 520; index += 1) {
      store.appendAudit({
        peerId: "desktop_one",
        kind: "connected",
        // Distinct details defeat repeat-collapsing so each append is a row.
        createdAt: 1_000 + index * 20 * 60 * 1000,
        detail: `session ${index}`,
      });
    }

    stateDb.cleanupExpired();

    const audit = store.listAudit({ peerId: "desktop_one", limit: 500 });
    expect(audit).toHaveLength(500);
    // Newest rows survive; the oldest 20 are gone.
    expect(audit[0]?.detail).toBe("session 519");
    expect(audit[audit.length - 1]?.detail).toBe("session 20");
  });
});
