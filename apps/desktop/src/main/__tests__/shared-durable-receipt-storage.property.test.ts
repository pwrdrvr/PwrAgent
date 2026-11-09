import fc from "fast-check";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { canonicalDurableSteerRequest, canonicalDurableTurnRequest } from "@pwragent/shared";
import type { SubmitDurableSteerRequest, SubmitDurableTurnRequest } from "@pwragent/shared";
import type { DurableRequestReceipt } from "@pwragent/owner-core/durable-turn-request-storage";
import { SqliteDurableTurnRequestStore as SharedStore } from "@pwragent/sqlite-storage/durable-turn-request-store";
import { StateDb } from "@pwragent/sqlite-storage/state-db";
import { SqliteDurableTurnRequestStore as DesktopStore } from "../storage/durable-turn-request-store";
import { DurableTurnRequestService } from "@pwragent/owner-core/durable-turn-request-service";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

afterEach(() => vi.unstubAllEnvs());
const bindings = [SharedStore, DesktopStore];
const scopes = ["first", "second", "scope' ; -- 雪"];
const ids = ["one", "two", "id' ; -- 雪"];
const keyOf = (scope: string, id: string) => JSON.stringify([scope, id]);

it("binds every generated desktop receipt-store choice to the portable implementation", () => {
  fc.assert(fc.property(fc.constantFrom(...bindings), binding => {
    expect(binding).toBe(SharedStore);
  }));
});

// Receipts are caller-qualified immutable identities; writes change their JSON
// facts, expiry removes only elapsed identities, and failed work changes none.
it("matches an independent receipt model over alternating WAL hosts, rollback and reopen with unchanged writes", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  await fc.assert(fc.asyncProperty(fc.array(fc.record({
    host: fc.integer({ min: 0, max: 1 }), scope: fc.constantFrom(...scopes), id: fc.constantFrom(...ids),
    kind: fc.constantFrom("put", "expire", "rollback", "duplicate", "read"),
    now: fc.integer({ min: 0, max: 200 }), steer: fc.boolean(), reopen: fc.boolean(),
  }), { minLength: 1, maxLength: 35 }), async commands => {
    const fixture = createTempStateDb("shared-receipt-model-");
    const dbs = bindings.map(() => StateDb.open(fixture.dbPath));
    const stores = dbs.map((db, index) => new bindings[index]!(db));
    const model = new Map<string, { scope: string; receipt: DurableRequestReceipt }>();
    try {
      for (const command of commands) {
        const store = stores[command.host]!;
        const key = keyOf(command.scope, command.id);
        const previous = model.get(key)?.receipt;
        const receipt: DurableRequestReceipt = previous
          ? { ...previous, state: "dispatching", updatedAt: command.now }
          : { version: 1, id: command.id, backend: command.steer ? "acp:kimi" : "codex", threadId: "same-thread",
            ownerInstanceId: "owner", payloadHash: "hash", queueEntryId: key, state: "accepted",
            acceptedAt: command.now, updatedAt: command.now, expiresAt: command.now + 100,
            ...(command.steer ? { operation: "steerTurn" as const } : {}) };
        const mutate = () => previous ? store.write(command.scope, receipt) : store.insert(command.scope, receipt);
        const measured = await measureSqliteWrites(() => {
          if (command.kind === "rollback") expect(() => store.transaction(() => {
            mutate(); throw new Error("Invented rollback");
          })).toThrow("Invented rollback");
          else if (command.kind === "duplicate" && previous) expect(() => store.transaction(() => {
            store.insert(command.scope, receipt);
          })).toThrow();
          else if (command.kind === "put" || command.kind === "duplicate") store.transaction(mutate);
          else if (command.kind === "expire") store.transaction(() => store.pruneExpired(command.now));
        });
        const writes = command.kind === "put" || (command.kind === "duplicate" && !previous) || command.kind === "expire";
        expect(measured.writes.commits).toBe(writes ? 1 : 0);
        if (command.kind === "put" || (command.kind === "duplicate" && !previous)) model.set(key, { scope: command.scope, receipt });
        if (command.kind === "expire") for (const [key, entry] of model) {
          if (entry.receipt.expiresAt <= command.now) model.delete(key);
        }
        if (command.reopen) {
          dbs[command.host]!.close();
          const reopened = await measureSqliteWrites(() => StateDb.open(fixture.dbPath));
          expect(reopened.writes.commits).toBe(0);
          dbs[command.host] = reopened.result;
          stores[command.host] = new bindings[command.host]!(reopened.result);
        }
        const reads = await measureSqliteWrites(() => {
          for (const reader of stores) {
            expect(reader.count()).toBe(model.size);
            for (const scope of scopes) {
              expect(reader.count(scope)).toBe([...model.values()].filter(entry => entry.scope === scope).length);
              for (const id of ids) {
                const key = keyOf(scope, id);
                expect(reader.read(scope, id)).toEqual(model.get(key)?.receipt);
                expect(reader.readQueueReceipt(key)).toEqual(model.get(key)?.receipt);
                expect(reader.findQueueReceipt(key)).toEqual(model.get(key));
              }
            }
          }
        });
        expect(reads.writes.commits).toBe(0);
      }
    } finally { for (const db of dbs) db.close(); removeTempStateDbDir(fixture.tempDir); }
  }), { numRuns: 25 });
});

// An immediate lock is acquired before work, even read-only work. FULL applies
// inside the callback and the original connection policy survives every exit.
it("takes an immediate WAL writer lock and restores every prior durability mode on return or refusal", () => {
  fc.assert(fc.property(fc.integer({ min: 0, max: 3 }), fc.boolean(), fc.integer({ min: 0, max: 1 }), (mode, refuse, host) => {
    const fixture = createTempStateDb("shared-receipt-durability-");
    const db = StateDb.open(fixture.dbPath);
    const observer = StateDb.open(fixture.dbPath);
    const store = new bindings[host]!(db);
    const token = {};
    db.raw.pragma(`synchronous = ${mode}`);
    observer.raw.pragma("busy_timeout = 0");
    try {
      const work = () => {
        expect(db.raw.inTransaction).toBe(true);
        expect(db.raw.pragma("synchronous", { simple: true })).toBe(2);
        expect(() => observer.raw.transaction(() => {}).immediate()).toThrow(/locked/);
        if (refuse) throw token;
        return token;
      };
      if (refuse) {
        try { store.transaction(work); throw new Error("Expected refusal"); }
        catch (error) { expect(error).toBe(token); }
      } else expect(store.transaction(work)).toBe(token);
      expect(db.raw.inTransaction).toBe(false);
      expect(db.raw.pragma("synchronous", { simple: true })).toBe(mode);
      expect(observer.raw.transaction(() => token).immediate()).toBe(token);
    } finally { observer.close(); db.close(); removeTempStateDbDir(fixture.tempDir); }
  }), { numRuns: 25 });
});

// The other WAL handle is the oracle: the claim must already be committed when
// provider dispatch starts, and a retry after an ambiguous acceptance never sends.
it("commits portable and desktop start/steer claims before dispatch and retains ambiguous receipts across restart", async () => {
  await fc.assert(fc.asyncProperty(fc.boolean(), fc.boolean(), fc.integer({ min: 0, max: 1 }), async (steering, ambiguous, host) => {
    const fixture = createTempStateDb("shared-receipt-dispatch-");
    let db = StateDb.open(fixture.dbPath);
    const observer = StateDb.open(fixture.dbPath);
    const reader = new bindings[1 - host]!(observer);
    const now = 1_800_000_000_000;
    const scope = steering ? JSON.stringify(["steerTurn", "caller"]) : "caller";
    const request: SubmitDurableSteerRequest | SubmitDurableTurnRequest = {
      clientRequest: { version: 1, id: randomUUID(), createdAt: now, payloadHash: "" },
      request: { backend: "codex", threadId: "thread", input: [{ type: "text", text: "Invented request" }],
        ...(steering ? { expectedTurnId: "active-turn" } : {}) },
    };
    const canonical = steering ? canonicalDurableSteerRequest("owner", request as SubmitDurableSteerRequest)
      : canonicalDurableTurnRequest("owner", request);
    request.clientRequest.payloadHash = createHash("sha256").update(canonical).digest("hex");
    let sends = 0;
    const inspectClaim = () => {
      sends++;
      expect(db.raw.inTransaction).toBe(false);
      expect(db.raw.pragma("synchronous", { simple: true })).toBe(1);
      expect(reader.read(scope, request.clientRequest.id)).toMatchObject({ state: "dispatching" });
      // No provider await owns a SQLite transaction or blocks another writer.
      observer.raw.transaction(() => {}).immediate();
      if (ambiguous) throw new Error("Invented lost acknowledgement");
    };
    const make = () => new DurableTurnRequestService({ storage: new bindings[host]!(db), ownerInstanceId: "owner",
      now: () => now, authorize: async () => {}, dispatch: async () => {
        inspectClaim(); return { backend: "codex", threadId: "thread", turnId: "turn" };
      }, steer: async request => {
        inspectClaim(); return { ok: true, backend: "codex", threadId: "thread", requestId: request.requestId,
          turnId: "active-turn", disposition: "steered" };
      } });
    const submit = (service: DurableTurnRequestService) => steering
      ? service.submitSteer("caller", request as SubmitDurableSteerRequest) : service.submit("caller", request);
    try {
      db.raw.pragma("synchronous = NORMAL");
      const first = await submit(make());
      expect(first.state).toBe(ambiguous ? "uncertain" : "dispatched");
      db.close(); db = StateDb.open(fixture.dbPath);
      expect(await submit(make())).toEqual(first);
      expect(sends).toBe(1);
    } finally { observer.close(); db.close(); removeTempStateDbDir(fixture.tempDir); }
  }), { numRuns: 25 });
});
