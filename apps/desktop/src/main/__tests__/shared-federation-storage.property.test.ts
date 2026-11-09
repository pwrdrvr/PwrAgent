import { createHmac } from "node:crypto";
import fc from "fast-check";
import { afterEach, expect, it, vi } from "vitest";
import type { FederationEnrollmentEntry, FederationSessionAuditEntry, FederationStorage } from "@pwragent/shared";
import { FederationStore as SharedStore } from "@pwragent/sqlite-storage/federation-store";
import { StateDb } from "@pwragent/sqlite-storage/state-db";
import { FederationStore as DesktopStore } from "../storage/federation-store";
import { createFederationStorage } from "../storage/desktop-federation-storage";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

const active = vi.hoisted(() => ({ db: undefined as StateDb | undefined }));
vi.mock("../state/app-state", () => ({ getAppStateDb: () => {
  if (!active.db) throw new Error("No invented profile selected");
  return active.db;
} }));
afterEach(() => { active.db = undefined; vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const host = fc.integer({ min: 0, max: 1 });
const constructors = [SharedStore, DesktopStore];
const peers = ["invented_one", "invented_two", "invented_three"];
const tokens = ["Invented secret", "' OR 1=1 --\0雪", "", "different-token"];
const secretKey = "federation_enrollment_secret_v1";

it("binds the original desktop factory to shared persistence and the currently selected profile", async () => {
  await fc.assert(fc.asyncProperty(fc.array(host, { minLength: 1, maxLength: 8 }), fc.string({ maxLength: 15 }), async (selections, label) => {
    const fixture = createTempStateDb("shared-federation-factory-");
    const dbs = [StateDb.open(fixture.dbPath), StateDb.open(fixture.dbPath)];
    const upsert = vi.spyOn(SharedStore.prototype, "upsertPeer");
    try {
      for (const [index, selected] of selections.entries()) {
        active.db = dbs[selected];
        const store = createFederationStorage();
        store.upsertPeer({ peer: { id: "invented_one", label, role: "client", status: "connected", capabilities: [] }, updatedAt: index });
        expect(store).toBeInstanceOf(SharedStore);
        expect(upsert).toHaveBeenCalledTimes(index + 1);
        expect(new SharedStore(dbs[1 - selected]!).getPeer("invented_one")?.label).toBe(label);
        expect(createFederationStorage()).not.toBe(store); // original factory lifetime
        expect(DesktopStore).toBe(SharedStore);
      }
    } finally { upsert.mockRestore(); dbs.forEach(db => db.close()); removeTempStateDbDir(fixture.tempDir); }
  }), { numRuns: 20 });
});

// Revocation is authoritative until explicit reauthorization. Ordinary refresh
// can replace advertised facts, but cannot restore trust or change creation time.
it("models trust, explicit reauthorization and detached peer facts across WAL connections and reopen", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  await fc.assert(fc.asyncProperty(fc.array(fc.record({ host, slot: fc.nat({ max: 2 }),
    kind: fc.constantFrom("refresh", "revoke", "reauthorize"), label: fc.string({ maxLength: 12 }),
    activity: fc.option(fc.nat({ max: 100 }), { nil: undefined }), reopen: fc.boolean(),
  }), { minLength: 1, maxLength: 30 }), async commands => {
    const fixture = createTempStateDb("shared-federation-peers-");
    const dbs = constructors.map(() => StateDb.open(fixture.dbPath));
    const stores = dbs.map((db, index) => new constructors[index]!(db));
    const model = new Map<string, NonNullable<ReturnType<FederationStorage["getPeer"]>>>();
    try {
      for (const [index, op] of commands.entries()) {
        const id = peers[op.slot]!; const at = 100 + index; const previous = model.get(id);
        const measured = await measureSqliteWrites(() => {
          if (op.kind === "revoke") {
            stores[op.host]!.revokePeer(id, at);
            if (previous) model.set(id, { ...previous, status: "revoked", revokedAt: at, updatedAt: at });
          } else {
            const peer = { id, label: op.label, role: "client" as const, status: "connected" as const,
              capabilities: ["remote_window" as const], pinnedPublicKeyPem: `Invented key ${index}`,
              notes: op.label, lastActivityAt: op.activity, receiverPermissions: { remoteShells: false, portForwarding: false, filePush: false, filePull: false } };
            stores[op.host]!.upsertPeer({ peer, createdAt: at - 10, updatedAt: at, clearRevocation: op.kind === "reauthorize" });
            const revokedAt = op.kind === "reauthorize" ? undefined : previous?.revokedAt;
            model.set(id, clone({ ...peer, createdAt: previous?.createdAt ?? at - 10, updatedAt: at,
              lastSeenAt: op.activity, revokedAt, status: revokedAt === undefined ? "connected" : "revoked" }));
          }
        });
        expect(measured.writes.commits).toBe(1);
        if (op.reopen) {
          dbs[op.host]!.close(); const opened = await measureSqliteWrites(() => StateDb.open(fixture.dbPath));
          expect(opened.writes.commits).toBe(0); dbs[op.host] = opened.result; stores[op.host] = new constructors[op.host]!(opened.result);
        }
        const reads = await measureSqliteWrites(() => {
          for (const store of stores) {
            expect(clone(store.listPeers({ includeRevoked: true }))).toEqual([...model.values()].sort((a, b) => b.updatedAt - a.updatedAt));
            expect(store.listPeers().map(row => row.id)).toEqual([...model.values()].filter(row => row.revokedAt === undefined).sort((a, b) => b.updatedAt - a.updatedAt).map(row => row.id));
            for (const [key, expected] of model) {
              expect(clone(store.getPeer(key))).toEqual(expected);
              store.getPeer(key)!.capabilities.push("gateway_relay");
              expect(clone(store.getPeer(key))).toEqual(expected);
            }
          }
        });
        expect(reads.writes.commits).toBe(0);
      }
    } finally { dbs.forEach(db => db.close()); removeTempStateDbDir(fixture.tempDir); }
  }), { numRuns: 25 });
});

it("models enrollment transitions, strict expiry, newest matching token and exact original commits", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  await fc.assert(fc.asyncProperty(fc.array(fc.record({ host, slot: fc.nat({ max: 20 }), token: fc.nat({ max: 3 }),
    kind: fc.constantFrom("create", "find", "use", "revoke", "expire", "read"), time: fc.nat({ max: 60 }), reopen: fc.boolean(),
  }), { minLength: 1, maxLength: 35 }), async commands => {
    const fixture = createTempStateDb("shared-federation-enrollment-");
    const dbs = constructors.map(() => StateDb.open(fixture.dbPath)); const stores = dbs.map((db, index) => new constructors[index]!(db));
    const model: { entry: FederationEnrollmentEntry; token: string }[] = []; let hasSecret = false;
    const expire = (now: number) => model.forEach(({ entry }) => { if (entry.status === "pending" && entry.expiresAt <= now) entry.status = "expired"; });
    try {
      for (const [index, op] of commands.entries()) {
        const now = 1_000 + op.time; const store = stores[op.host]!; const selected = model.length ? model[op.slot % model.length] : undefined;
        const id = selected?.entry.id ?? "absent"; let commits = 1;
        const measured = await measureSqliteWrites(() => {
          switch (op.kind) {
            case "create": {
              const input = { token: tokens[op.token]!, generatedAt: 1_000 + index, expiresAt: 1_020 + index,
                role: "client" as const, label: `Invented ${index}`, gatewayInstanceId: "invented_gateway" };
              const entry = store.createEnrollment(input);
              const { token, ...facts } = input;
              model.push({ token, entry: { id: entry.id, status: "pending", ...facts } });
              commits = hasSecret ? 1 : 2; hasSecret = true;
              break;
            }
            case "find": {
              expire(now);
              const expected = [...model].reverse().find(row => row.token === tokens[op.token] && row.entry.status === "pending" && row.entry.expiresAt > now);
              expect(clone(store.findMatchingPendingEnrollment({ token: tokens[op.token]!, now }) ?? null)).toEqual(expected?.entry ?? null);
              break;
            }
            case "use":
              if (selected?.entry.status === "pending") Object.assign(selected.entry, { status: "used", usedAt: now, peerId: "invented_one" });
              expect(clone(store.markEnrollmentUsed({ enrollmentId: id, peerId: "invented_one", usedAt: now }) ?? null)).toEqual(selected?.entry ?? null);
              break;
            case "revoke": store.revokePendingEnrollment(id); if (selected?.entry.status === "pending") selected.entry.status = "revoked"; break;
            case "expire": store.expireEnrollments(now); expire(now); break;
            case "read": commits = 0; expect(clone(store.getEnrollment(id) ?? null)).toEqual(selected?.entry ?? null); break;
          }
        });
        expect(measured.writes.commits).toBe(commits);
        if (op.reopen) {
          dbs[op.host]!.close(); const opened = await measureSqliteWrites(() => StateDb.open(fixture.dbPath));
          expect(opened.writes.commits).toBe(0); dbs[op.host] = opened.result; stores[op.host] = new constructors[op.host]!(opened.result);
        }
        const reads = await measureSqliteWrites(() => {
          for (const reader of stores) for (const { entry } of model) expect(clone(reader.getEnrollment(entry.id))).toEqual(entry);
        });
        expect(reads.writes.commits).toBe(0);
      }
    } finally { dbs.forEach(db => db.close()); removeTempStateDbDir(fixture.tempDir); }
  }), { numRuns: 25 });
});

// HMAC identity is profile-secret + token + NUL + generatedAt. The independent
// crypto oracle observes persisted rows through another connection, never a helper.
it("keeps enrollment secrets profile-local and raw tokens out of SQLite with independent HMAC oracles", async () => {
  await fc.assert(fc.asyncProperty(host, fc.constantFrom(...tokens), fc.nat({ max: 100_000 }), async (selected, token, generatedAt) => {
    const fixture = createTempStateDb("shared-federation-secret-"); const dbs = [StateDb.open(fixture.dbPath), StateDb.open(fixture.dbPath)];
    const other = StateDb.open(":memory:");
    try {
      const store = new constructors[selected]!(dbs[selected]!);
      const entries = [generatedAt, generatedAt + 1].map(at => store.createEnrollment({ token, generatedAt: at, expiresAt: at + 2 }));
      const secret = dbs[1 - selected]!.getMeta(secretKey)!; expect(Buffer.from(secret, "base64")).toHaveLength(32);
      for (const entry of entries) {
        const row = dbs[1 - selected]!.raw.prepare("SELECT token_hmac, payload FROM federation_enrollment_tokens WHERE enrollment_id = ?").get(entry.id) as { token_hmac: string; payload: string };
        expect(row.token_hmac).toBe(createHmac("sha256", Buffer.from(secret, "base64")).update(token).update("\0").update(String(entry.generatedAt)).digest("hex"));
        expect(row.payload).toBe("{}"); expect(entry).not.toHaveProperty("token");
      }
      new SharedStore(other).createEnrollment({ token, generatedAt, expiresAt: generatedAt + 2 });
      expect(other.getMeta(secretKey)).not.toBe(secret);
      dbs[0]!.raw.prepare("DELETE FROM federation_enrollment_tokens WHERE enrollment_id <> ?").run(entries[0]!.id);
      dbs[0]!.raw.prepare("UPDATE federation_enrollment_tokens SET token_hmac = 'ab'").run();
      expect(store.findMatchingPendingEnrollment({ token, now: generatedAt })).toBeUndefined();
    } finally { other.close(); dbs.forEach(db => db.close()); removeTempStateDbDir(fixture.tempDir); }
  }), { numRuns: 25 });
});

// A repeat can collapse only into the newest matching kind/peer/session row,
// with identical detail and at most ten minutes since that row. Ordering and
// firstSeenAt remain independent of inserts, ties and backward clock movement.
it("models audit identity, repeat windows, first-seen authority, filters and exact writes", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  await fc.assert(fc.asyncProperty(fc.array(fc.record({ host, peer: fc.option(fc.nat({ max: 2 }), { nil: undefined }),
    session: fc.option(fc.nat({ max: 1 }), { nil: undefined }), kind: fc.constantFrom("error" as const, "connect_attempt" as const),
    detail: fc.option(fc.constantFrom("Invented failure", "other\0雪"), { nil: undefined }),
    time: fc.integer({ min: -1_000_000, max: 1_000_000 }), limit: fc.integer({ min: -2, max: 510 }), reopen: fc.boolean(),
  }), { minLength: 1, maxLength: 35 }), async commands => {
    const fixture = createTempStateDb("shared-federation-audit-"); const dbs = constructors.map(() => StateDb.open(fixture.dbPath));
    const stores = dbs.map((db, index) => new constructors[index]!(db)); const rows: FederationSessionAuditEntry[] = []; let nextId = 1;
    const ordered = () => [...rows].sort((a, b) => b.createdAt - a.createdAt || b.eventId - a.eventId);
    try {
      for (const op of commands) {
        const input = { peerId: op.peer === undefined ? undefined : peers[op.peer], sessionId: op.session === undefined ? undefined : `session-${op.session}`,
          kind: op.kind, detail: op.detail, createdAt: op.time };
        const newest = ordered().find(row => row.kind === input.kind && row.peerId === input.peerId && row.sessionId === input.sessionId);
        let expected: FederationSessionAuditEntry;
        if (newest && input.createdAt - newest.createdAt <= 600_000 && newest.detail === input.detail) {
          expected = clone({ ...input, eventId: newest.eventId, repeatCount: (newest.repeatCount ?? 1) + 1, firstSeenAt: newest.firstSeenAt ?? newest.createdAt });
          rows[rows.indexOf(newest)] = expected;
        } else { expected = clone({ ...input, eventId: nextId++ }); rows.push(expected); }
        const measured = await measureSqliteWrites(() => stores[op.host]!.appendAudit(input));
        expect(clone(measured.result)).toEqual(expected); expect(measured.writes.commits).toBe(1);
        if (op.reopen) { dbs[op.host]!.close(); dbs[op.host] = StateDb.open(fixture.dbPath); stores[op.host] = new constructors[op.host]!(dbs[op.host]!); }
        const reads = await measureSqliteWrites(() => {
          for (const store of stores) {
            expect(clone(store.listAudit({ limit: op.limit }))).toEqual(ordered().slice(0, Math.max(1, Math.min(op.limit, 500))));
            const filter = input.peerId ? (row: FederationSessionAuditEntry) => row.peerId === input.peerId
              : input.sessionId ? (row: FederationSessionAuditEntry) => row.sessionId === input.sessionId : () => true;
            expect(clone(store.listAudit({ peerId: input.peerId, sessionId: input.sessionId }))).toEqual(ordered().filter(filter).slice(0, 50));
          }
        }); expect(reads.writes.commits).toBe(0);
      }
    } finally { dbs.forEach(db => db.close()); removeTempStateDbDir(fixture.tempDir); }
  }), { numRuns: 25 });
});

it("preserves outer transaction visibility and rollback and the original independent secret write on insert refusal", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  await fc.assert(fc.asyncProperty(host, fc.string({ maxLength: 12 }), async (selected, token) => {
    const fixture = createTempStateDb("shared-federation-rollback-"); const dbs = [StateDb.open(fixture.dbPath), StateDb.open(fixture.dbPath)];
    try {
      const store = new constructors[selected]!(dbs[selected]!); const reader = new SharedStore(dbs[1 - selected]!);
      const measured = await measureSqliteWrites(() => expect(() => dbs[selected]!.raw.transaction(() => {
        store.upsertPeer({ peer: { id: "invented_one", label: token, role: "client", status: "connected", capabilities: [] }, updatedAt: 1 });
        store.createEnrollment({ token, generatedAt: 1, expiresAt: 2 }); store.appendAudit({ kind: "error", createdAt: 1 });
        expect(reader.listPeers()).toEqual([]); expect(reader.listAudit()).toEqual([]); expect(dbs[1 - selected]!.getMeta(secretKey)).toBeUndefined();
        throw new Error("Invented rollback");
      })()).toThrow("Invented rollback"));
      expect(measured.writes.commits).toBe(0); expect(reader.listPeers()).toEqual([]); expect(reader.listAudit()).toEqual([]);
      expect(dbs[selected]!.getMeta(secretKey)).toBeUndefined();
      dbs[selected]!.raw.exec("CREATE TEMP TRIGGER refuse_enrollment BEFORE INSERT ON federation_enrollment_tokens BEGIN SELECT RAISE(ABORT, 'Invented insert refusal'); END");
      const refused = await measureSqliteWrites(() => expect(() => store.createEnrollment({ token, generatedAt: 1, expiresAt: 2 })).toThrow("Invented insert refusal"));
      expect(refused.writes.commits).toBe(1); // original separate secret site survives
      expect(dbs[1 - selected]!.getMeta(secretKey)).toBeDefined();
      expect(dbs[1 - selected]!.raw.prepare("SELECT COUNT(*) AS count FROM federation_enrollment_tokens").get()).toEqual({ count: 0 });
    } finally { dbs.forEach(db => db.close()); removeTempStateDbDir(fixture.tempDir); }
  }), { numRuns: 25 });
});

it("keeps legacy records, malformed payload reads, invalid-peer refusal and list bounds without repair writes", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  await fc.assert(fc.asyncProperty(host, fc.constantFrom("child", "unknown", "dual"), async (selected, role) => {
    const fixture = createTempStateDb("shared-federation-legacy-"); const db = StateDb.open(fixture.dbPath);
    try {
      const store = new constructors[selected]!(db);
      store.upsertPeer({ peer: { id: "invented_one", label: "Invented legacy", role: "client", status: "connected", capabilities: [] }, updatedAt: 1 });
      const invite = store.createEnrollment({ token: "invented", generatedAt: 1, expiresAt: 2 });
      db.raw.prepare("UPDATE federation_peers SET role = ?, payload = ?").run(role, "invalid-json");
      db.raw.prepare("UPDATE federation_enrollment_tokens SET payload = ?").run(JSON.stringify({ role }));
      db.raw.transaction(() => { for (let index = 0; index < 510; index++) store.appendAudit({ kind: "error", createdAt: index, detail: String(index) }); })();
      const measured = await measureSqliteWrites(() => {
        expect(store.getPeer("invented_one")).toMatchObject({ role: role === "dual" ? "dual" : "client", capabilities: [] });
        expect(store.getEnrollment(invite.id)?.role).toBe(role === "child" ? "client" : role === "dual" ? "dual" : undefined);
        expect(store.listAudit()).toHaveLength(50); expect(store.listAudit({ limit: 1_000 })).toHaveLength(500);
        for (const id of ["", "bad/peer", "' OR 1=1 --", "white space"]) {
          expect(() => store.getPeer(id)).toThrow("Invalid federation peer id");
          expect(() => store.revokePeer(id, 1)).toThrow("Invalid federation peer id");
          expect(() => store.markEnrollmentUsed({ enrollmentId: invite.id, peerId: id, usedAt: 1 })).toThrow("Invalid federation peer id");
        }
      }); expect(measured.writes.commits).toBe(0);
    } finally { db.close(); removeTempStateDbDir(fixture.tempDir); }
  }), { numRuns: 10 });
});
