import { FederationRouter } from "../federation/federation-router";
import { createFederationEnrollmentInvite, completeFederationEnrollment, buildFederationProofMessage } from "../federation/federation-enrollment";
import { generateFederationIdentityKeyPair, signFederationMessage } from "../federation/federation-identity";
import { FEDERATION_CAPABILITIES } from "@pwragent/shared";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import path from "node:path";
import { FederationStore } from "../storage/federation-store";
import { StateDb } from "../state/state-db";
import { createTempStateDb, openInMemoryStateDb, removeTempStateDbDir } from "./sqlite-test-utils";
import { measureSqliteWrites, resetSqliteWriteMetrics, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { appendFederationRefusalAudit } from "@pwragent/federation/federation-refusal-audit";
import type { FederationPeerRole } from "@pwragent/shared";

const peer = { id: "outpost", label: "Fixture Outpost", role: "client" as const,
  status: "connected" as const, capabilities: [], pinnedPublicKeyPem: "fixture-key" };

describe("receiver-owned peer role", () => {
  it("only a local role change can change authority across arbitrary peer refreshes", () => {
    fc.assert(fc.property(fc.array(fc.record({ local: fc.boolean(), role: fc.constantFrom("full" as const, "contained" as const) }), { maxLength: 30 }), (commands) => {
      const db = openInMemoryStateDb();
      const store = new FederationStore(db);
      try {
        store.upsertPeer({ peer, updatedAt: 1 });
        let role: FederationPeerRole = "full";
        for (const [index, command] of commands.entries()) {
          if (command.local) { store.setPeerRole(peer.id, command.role, index + 2); role = command.role; }
          else store.upsertPeer({ peer: { ...peer, permissionRole: command.role }, updatedAt: index + 2 });
          expect(store.getPeer(peer.id)?.permissionRole).toBe(role);
        }
      } finally { db.close(); }
    }), { numRuns: 25 });
  });

  it("retains the role across restart and malformed saved roles fail closed", () => {
    const { dbPath, tempDir } = createTempStateDb("peer-role-");
    let db = StateDb.open(dbPath);
    try {
      const store = new FederationStore(db);
      store.upsertPeer({ peer, updatedAt: 1 });
      store.setPeerRole(peer.id, "contained", 2);
      db.close();
      db = StateDb.open(dbPath);
      expect(new FederationStore(db).getPeer(peer.id)?.permissionRole).toBe("contained");
      db.raw.prepare("UPDATE federation_peers SET payload = json_set(payload, '$.permissionRole', 'invalid') WHERE peer_id = ?").run(peer.id);
      expect(new FederationStore(db).getPeer(peer.id)?.permissionRole).toBe("contained");
    } finally { db.close(); removeTempStateDbDir(tempDir); }
  });

  it("budgets local role changes and records every refusal with zero SQLite commits", async () => {
    const previous = process.env[SQLITE_WRITE_METRICS_ENV];
    process.env[SQLITE_WRITE_METRICS_ENV] = "1";
    resetSqliteWriteMetrics();
    const { dbPath, tempDir } = createTempStateDb("role-budget-");
    const db = StateDb.open(dbPath);
    try {
      const store = new FederationStore(db);
      store.upsertPeer({ peer, updatedAt: 1 });
      const change = await measureSqliteWrites(async () => store.setPeerRole(peer.id, "contained", 2));
      expectSqliteWriteBudget({ scenario: "federation.peerRole.change", note: "One operator role change: 1 commit, about 0.00824 MB/day at one change/day.", writes: change.writes });
      let now = 0;
      const router = new FederationRouter({ localInstanceId: "receiver", now: () => now,
        peerRole: (id) => store.getPeer(id)?.permissionRole ?? "full",
        auditRefusal: (event) => appendFederationRefusalAudit(tempDir, event) });
      router.registerConnection({ peerId: peer.id, capabilities: [...FEDERATION_CAPABILITIES], sendEnvelope: () => {} });
      const refusals = await measureSqliteWrites(async () => {
        for (let index = 0; index < 1000; index++) {
          now = index;
          expect(await router.routeEnvelope({ sourcePeerId: peer.id, envelope: { id: `attempt-${index}`, kind: "request",
            method: "backend.startThread", sourceInstanceId: peer.id, targetInstanceId: "receiver", protocolVersion: 1,
            params: { privatePayload: "must not reach the journal" }, createdAt: index } })).toMatchObject({ status: "rejected" });
        }
      });
      expectSqliteWriteBudget({ scenario: "federation.peerRole.refusals", note: "1000 role reads and payload-free refusal journal entries: 0 SQLite commits, 0 MB/day of SQLite WAL.", writes: refusals.writes });
      const events = readFileSync(path.join(tempDir, "federation-refusals.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(events).toHaveLength(1000);
      expect(events[999]).toEqual({ peerId: peer.id, method: "backend.startThread", role: "contained", createdAt: 999 });
    } finally {
      db.close(); removeTempStateDbDir(tempDir);
      if (previous === undefined) delete process.env[SQLITE_WRITE_METRICS_ENV]; else process.env[SQLITE_WRITE_METRICS_ENV] = previous;
      resetSqliteWriteMetrics();
    }
  });
});

it("the receiver's invite fixes the first session role, and re-enrollment cannot widen an existing peer", () => {
  const keys = generateFederationIdentityKeyPair();
  fc.assert(fc.property(fc.constantFrom("full" as const, "contained" as const), fc.boolean(), (permissionRole, existingContained) => {
    const db = openInMemoryStateDb();
    const store = new FederationStore(db);
    try {
      if (existingContained) {
        store.upsertPeer({ peer: { ...peer, pinnedPublicKeyPem: keys.publicKeyPem }, updatedAt: 1 });
        store.setPeerRole(peer.id, "contained", 2);
      }
      createFederationEnrollmentInvite({ store, token: "fixture-token", gatewayInstanceId: "receiver",
        generatedAt: 1, expiresAt: 100, permissionRole });
      const message = buildFederationProofMessage({ purpose: "enroll", gatewayInstanceId: "receiver", peerInstanceId: peer.id,
        publicKeyPem: keys.publicKeyPem, protocolVersion: 1, nonce: "fixture", capabilities: FEDERATION_CAPABILITIES });
      const decision = completeFederationEnrollment({ store, gatewayInstanceId: "receiver", inviteToken: "fixture-token", now: 3,
        peer: { instanceId: peer.id, label: "Fixture", role: "client", publicKeyPem: keys.publicKeyPem, protocolVersion: 1,
          nonce: "fixture", capabilities: FEDERATION_CAPABILITIES, signatureBase64: signFederationMessage({ privateKeyPem: keys.privateKeyPem, message }) } });
      const expected = existingContained ? "contained" : permissionRole;
      expect(decision.accepted).toBe(true);
      expect(store.getPeer(peer.id)?.permissionRole).toBe(expected);
      if (decision.accepted) expect(decision.capabilities.includes("gateway_relay")).toBe(expected === "full");
    } finally { db.close(); }
  }), { numRuns: 25 });
});
