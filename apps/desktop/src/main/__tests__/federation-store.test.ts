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
        role: "child",
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
      role: "child",
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
  });

  it("matches pending enrollments without storing the raw token", () => {
    const token = "123456789ABCDEFGHJKLMNPQRSTUVWX";
    const enrollment = store.createEnrollment({
      token,
      generatedAt: 1_000,
      expiresAt: 2_000,
      label: "Travel laptop",
      role: "child",
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
      role: "child",
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
});
