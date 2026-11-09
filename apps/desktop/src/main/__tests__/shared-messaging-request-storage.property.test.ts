import { createHash } from "node:crypto";
import { copyFileSync, realpathSync } from "node:fs";
import fc from "fast-check";
import { afterEach, expect, it, vi } from "vitest";
import type { MessagingInboundEvent } from "@pwragent/messaging-interface";
import type { MessagingRequestSource } from "@pwragent/owner-core/messaging-request-storage";
import type { PwrAgentMessagingResponse } from "@pwragent/shared";
import { SqliteMessagingRequestStore as SharedStore } from "@pwragent/sqlite-storage/messaging-request-store";
import { StateDb } from "@pwragent/sqlite-storage/state-db";
import { SqliteMessagingRequestStore as DesktopStore } from "../storage/messaging-request-store";
import { SqliteMessagingRequestStore as CompatibilityStore, messagingDestinationIdentity } from "../state/messaging-request-store";
import { createMessagingRequestStorage } from "../storage/desktop-messaging-storage";
import { projectMessagingRequest } from "../messaging/core/messaging-request-projection";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { createTempStateDb, openInMemoryStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

const active = vi.hoisted(() => ({ db: undefined as StateDb | undefined }));
vi.mock("../state/app-state", () => ({ getAppStateDb: () => {
  if (!active.db) throw new Error("No invented profile selected");
  return active.db;
} }));
afterEach(() => { active.db = undefined; vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const agent = { backend: "codex" as const, threadId: "invented-owner" };
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const event = (id: string, destination = "invented-channel", receivedAt = 100): MessagingInboundEvent => ({
  id, kind: "text", text: "Private invented prompt", receivedAt,
  actor: { platformUserId: "invented-human" },
  channel: { channel: "slack", conversation: { id: destination, kind: "channel", workspaceId: "invented-workspace" } },
  routingState: { opaque: { route: destination, token: "Private invented credential" } },
});
const construct = (db: StateDb, host: number) => host === 0
  ? new SharedStore(db.raw, projectMessagingRequest) : new DesktopStore(db.raw);

it("binds the actual factory to shared storage and retains its selected profile after construction", async () => {
  await fc.assert(fc.asyncProperty(fc.boolean(), fc.nat(), async (otherProfile, revision) => {
    const dbs = [openInMemoryStateDb(), openInMemoryStateDb()];
    try {
      active.db = dbs[0];
      const remember = vi.spyOn(SharedStore.prototype, "remember");
      const store = createMessagingRequestStorage();
      active.db = otherProfile ? dbs[1] : undefined;
      const source = store.remember({ agent, event: event(String(revision)) })!;
      expect(remember).toHaveBeenCalledOnce();
      expect(store).toBeInstanceOf(SharedStore);
      expect(CompatibilityStore).toBe(DesktopStore);
      expect(new SharedStore(dbs[0]!.raw, projectMessagingRequest).get(source.ref)).toEqual(source);
      expect(new DesktopStore(dbs[1]!.raw).get(source.ref)).toBeUndefined();
      remember.mockRestore();
    } finally { dbs.forEach(db => db.close()); }
  }), { numRuns: 25 });
});

function expectAlternateHostJsonRoundTrip(payload: unknown, identity: string): void {
  const db = openInMemoryStateDb();
  try {
    const projection = vi.fn((input: unknown) => ({ event: input, eventId: identity,
      platform: "alternate-host", actorId: "human", destinationIdentity: "opaque-destination", receivedAt: 42 }));
    const store = new SharedStore(db.raw, projection);
    const source = store.remember({ agent, event: payload })!;
    expect(projection).toHaveBeenCalledWith(payload);
    // Persisted reads obey JSON's data model, including -0 becoming 0.
    const expected = clone(source);
    expect(store.get(source.ref)).toEqual(expected);
    expect(store.destination(source, source.selector)).toEqual(expected);
    expect(store.list(source, 99)).toEqual([expected]);
  } finally { db.close(); }
}

it("persists arbitrary alternate-host JSON through a projection without messaging channel contracts", () => {
  fc.assert(fc.property(fc.jsonValue(), fc.string(), expectAlternateHostJsonRoundTrip), { numRuns: 40, examples: [
    [-0, "scalar-negative-zero"],
    [[-0], "array-negative-zero"],
    [{ "": { "": -0 } }, "nested-negative-zero"],
  ] });
});

it("persists the shrunk negative-zero payload using JSON number semantics on every read path", () => {
  const payload = { "": -0 };
  expectAlternateHostJsonRoundTrip(payload, "");
  expect(Object.is(payload[""], -0)).toBe(true);
});

// The oracle derives identities from the persisted profile namespace and models
// immutable receipts separately from latest-human destinations. Neither oracle
// calls the host projection or a storage method to compute its expected state.
it("models qualified identity, immutable requests, monotone destinations and exact writes over WAL hosts and reopens", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  await fc.assert(fc.asyncProperty(fc.array(fc.record({
    host: fc.integer({ min: 0, max: 1 }), actor: fc.integer({ min: 0, max: 1 }),
    destination: fc.integer({ min: 0, max: 4 }), message: fc.integer({ min: 0, max: 4 }),
    at: fc.integer({ min: -2, max: 4 }), backend: fc.constantFrom("codex" as const, "claude" as const),
    connection: fc.constantFrom(undefined, "", "connection"), binding: fc.constantFrom(undefined, "", "binding"),
    bot: fc.boolean(), observed: fc.boolean(), kind: fc.constantFrom("text" as const, "media" as const, "command" as const, "callback" as const, "lifecycle" as const),
    reopen: fc.boolean(),
  }), { minLength: 1, maxLength: 35 }), async commands => {
    const fixture = createTempStateDb("shared-messaging-request-model-");
    const dbs = [StateDb.open(fixture.dbPath), StateDb.open(fixture.dbPath)];
    const stores = dbs.map(construct);
    const owner = hash([dbs[0]!.raw.prepare("SELECT owner_id FROM messaging_request_owner").pluck().get(), realpathSync(fixture.dbPath)]);
    const requests = new Map<string, MessagingRequestSource<MessagingInboundEvent>>();
    const destinations = new Map<string, MessagingRequestSource<MessagingInboundEvent>>();
    try {
      for (const op of commands) {
        const input = event(String(op.message), String(op.destination), op.at);
        input.actor = { platformUserId: String(op.actor), isBot: op.bot };
        // Routing fields suffice for all four admitted kinds; lifecycle stays passive.
        const inbound = { ...input, kind: op.kind, observedOnly: op.observed } as MessagingInboundEvent;
        const principalScope = hash([owner, "slack", "invented-workspace", op.connection ?? null,
          op.backend, agent.threadId, String(op.actor)]);
        const selector = hash([principalScope, JSON.stringify(["slack", "invented-workspace", "channel", String(op.destination), null, null])]);
        const requestId = hash([selector, String(op.message)]);
        const previous = requests.get(requestId);
        const latest = destinations.get(selector);
        const admitted = !op.bot && !op.observed && op.kind !== "lifecycle";
        const measured = await measureSqliteWrites(() => stores[op.host]!.remember({ agent: { ...agent, backend: op.backend },
          bindingId: op.binding, connectionId: op.connection, instanceId: "invented-instance", event: inbound }));
        expect(measured.writes.commits).toBe(admitted && !previous ? 1 : 0);
        expect(measured.writes.rowsChanged).toBe(admitted && !previous ? 1 + Number(!latest || op.at > latest.event.receivedAt) : 0);
        if (!admitted) expect(measured.result).toBeUndefined();
        else if (previous) expect(measured.result).toEqual(previous);
        else {
          const source: MessagingRequestSource<MessagingInboundEvent> = {
            ref: { ownerId: owner, requestId, surfaceSelector: selector, instanceId: "invented-instance" },
            selector, principalScope, agent: { ...agent, backend: op.backend },
            ...(op.binding ? { bindingId: op.binding } : {}), ...(op.connection ? { connectionId: op.connection } : {}),
            route: op.binding ? "binding" : "default",
            event: { id: String(op.message), kind: "lifecycle", lifecycle: "bound", receivedAt: op.at,
              actor: { platformUserId: String(op.actor), isBot: false }, channel: input.channel,
              routingState: { opaque: { route: String(op.destination) } } },
          };
          expect(measured.result).toEqual(source);
          requests.set(requestId, clone(source));
          if (!latest || op.at > latest.event.receivedAt) destinations.set(selector, clone(source));
        }
        if (op.reopen) {
          dbs[op.host]!.close();
          const opened = await measureSqliteWrites(() => StateDb.open(fixture.dbPath));
          expect(opened.writes.commits).toBe(0);
          dbs[op.host] = opened.result;
          // Existing eager INSERT OR IGNORE setup is deliberately outside the feature measurement.
          stores[op.host] = construct(opened.result, op.host);
        }
        const reads = await measureSqliteWrites(() => {
          for (const store of stores) for (const source of requests.values()) {
            expect(store.get(source.ref)).toEqual(source);
            expect(store.get({ ...source.ref, ownerId: "wrong-profile" })).toBeUndefined();
            const expected = [...destinations.values()].filter(row => row.principalScope === source.principalScope)
              .sort((a, b) => b.event.receivedAt - a.event.receivedAt || (a.selector < b.selector ? -1 : 1));
            expect(store.list(source, 100)).toEqual(expected);
            for (const target of destinations.values()) expect(store.destination(source, target.selector))
              .toEqual(target.principalScope === source.principalScope ? target : undefined);
            const detached = store.get(source.ref)!;
            detached.agent.threadId = "mutated detached read";
          }
        });
        expect(reads.writes.commits).toBe(0);
      }
    } finally { dbs.forEach(db => db.close()); removeTempStateDbDir(fixture.tempDir); }
  }), { numRuns: 30 });
});

it("models bounded keyset pages at timestamp ties without skipping or repeating destinations", () => {
  fc.assert(fc.property(fc.array(fc.integer({ min: 0, max: 3 }), { minLength: 27, maxLength: 65 }), fc.integer({ min: 1, max: 40 }), (times, limit) => {
    const db = openInMemoryStateDb();
    try {
      const store = construct(db, 0);
      const all = times.map((at, i) => store.remember({ agent, event: event(String(i), String(i), at) })!);
      const expected = all.slice().sort((a, b) => b.event.receivedAt - a.event.receivedAt || (a.selector < b.selector ? -1 : 1));
      const found: typeof all = [];
      let before: { at: number; selector: string } | undefined;
      for (;;) {
        const page = store.list(all[0]!, limit, before);
        expect(page.length).toBeLessThanOrEqual(Math.min(limit, 26));
        if (!page.length) break;
        found.push(...page);
        const last = page.at(-1)!;
        before = { at: last.event.receivedAt, selector: last.selector };
      }
      expect(found).toEqual(expected);
      expect(store.list(all[0]!, -5)).toEqual(expected.slice(0, 1));
    } finally { db.close(); }
  }), { numRuns: 25 });
});

it("keeps profile-file authority across reopen but excludes copied databases", async () => {
  await fc.assert(fc.asyncProperty(fc.string(), async identity => {
    const original = createTempStateDb("shared-request-original-");
    const copied = createTempStateDb("shared-request-copy-");
    let db = StateDb.open(original.dbPath);
    try {
      const source = construct(db, 0).remember({ agent, event: event(identity) })!;
      db.close();
      copyFileSync(original.dbPath, copied.dbPath);
      db = StateDb.open(original.dbPath);
      expect(construct(db, 1).get(source.ref)).toEqual(source);
      const copy = StateDb.open(copied.dbPath);
      try {
        expect(construct(copy, 1).get(source.ref)).toBeUndefined();
        const next = construct(copy, 0).remember({ agent, event: event(identity) })!;
        expect(next.ref.ownerId).not.toBe(source.ref.ownerId);
        expect(next.ref.requestId).not.toBe(source.ref.requestId);
      } finally { copy.close(); }
    } finally { db.close(); removeTempStateDbDir(original.tempDir); removeTempStateDbDir(copied.tempDir); }
  }), { numRuns: 20 });
});

it("models first attachment outcomes, uncertain claims, cross-host deduplication and exact commits", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  await fc.assert(fc.asyncProperty(fc.array(fc.record({ host: fc.integer({ min: 0, max: 1 }), slot: fc.nat({ max: 4 }),
    finish: fc.boolean(), result: fc.string() }), { minLength: 1, maxLength: 35 }), async commands => {
    const fixture = createTempStateDb("shared-request-attachments-");
    const dbs = [StateDb.open(fixture.dbPath), StateDb.open(fixture.dbPath)];
    const stores = dbs.map(construct);
    const model = new Map<string, PwrAgentMessagingResponse | undefined>();
    try {
      for (const op of commands) {
        const operation = ["invented-request", op.slot];
        const id = hash(operation);
        const claimed = model.has(id);
        const previous = model.get(id);
        const outcome: PwrAgentMessagingResponse = { ok: false, error: { code: "unsupported_operation", message: op.result } };
        const measured = await measureSqliteWrites(() => {
          if (op.finish) stores[op.host]!.finishAttachment(id, outcome);
          else expect(stores[op.host]!.claimAttachment(operation)).toEqual({ id, claimed: !claimed, ...(previous ? { result: previous } : {}) });
        });
        expect(measured.writes.commits).toBe(op.finish || !claimed ? 1 : 0);
        expect(measured.writes.rowsChanged).toBe(op.finish ? Number(claimed && !previous) : Number(!claimed));
        if (!op.finish && !claimed) model.set(id, undefined);
        if (op.finish && claimed && !previous) model.set(id, clone(outcome));
      }
    } finally { dbs.forEach(db => db.close()); removeTempStateDbDir(fixture.tempDir); }
  }), { numRuns: 25 });
});

it("preserves routing privacy, refusal and atomic rollback without repairing malformed payloads", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  await fc.assert(fc.asyncProperty(fc.constantFrom("token", "Secret", "password", "authorization", "api_key", "apiKey"), fc.string(), async (key, value) => {
    const fixture = createTempStateDb("shared-request-privacy-");
    const db = StateDb.open(fixture.dbPath);
    const store = construct(db, 0);
    try {
      const input = event("private");
      input.routingState = { opaque: { nested: { [key]: value, safe: "route" } } };
      const source = store.remember({ agent, event: input })!;
      expect(source.event.routingState).toEqual({ opaque: { nested: { safe: "route" } } });
      expect(source.event).not.toHaveProperty("text");
      expect(messagingDestinationIdentity(input.channel)).toBe(JSON.stringify(["slack", "invented-workspace", "channel", "invented-channel", null, null]));
      db.raw.exec("CREATE TRIGGER refuse_destination BEFORE INSERT ON messaging_human_destinations BEGIN SELECT RAISE(ABORT, 'invented refusal'); END");
      const refused = await measureSqliteWrites(() => {
        expect(() => store.remember({ agent, event: { ...event("oversize"), routingState: { opaque: { route: "雪".repeat(6_000) } } } })).toThrow("16 KiB");
        expect(() => store.claimAttachment({ value: 1n })).toThrow();
        expect(() => store.remember({ agent, event: event("rolled-back") })).toThrow("invented refusal");
      });
      db.raw.exec("DROP TRIGGER refuse_destination");
      expect(refused.writes.commits).toBe(0);
      expect(db.raw.prepare("SELECT COUNT(*) FROM messaging_requests").pluck().get()).toBe(1);
      expect(() => db.raw.transaction(() => {
        store.remember({ agent, event: event("outer-rollback") });
        store.claimAttachment("rolled-back-claim");
        throw new Error("outer rollback");
      })()).toThrow("outer rollback");
      expect(db.raw.prepare("SELECT COUNT(*) FROM messaging_attachment_operations").pluck().get()).toBe(0);
      db.raw.prepare("UPDATE messaging_requests SET payload = ?").run("{broken");
      const reads = await measureSqliteWrites(() => {
        expect(() => store.get(source.ref)).toThrow();
        expect(() => store.list(source, 25)).toThrow();
        expect(() => store.destination(source, source.selector)).toThrow();
      });
      expect(reads.writes.commits).toBe(0);
      expect(db.raw.prepare("SELECT payload FROM messaging_requests").pluck().get()).toBe("{broken");
    } finally { db.close(); removeTempStateDbDir(fixture.tempDir); }
  }), { numRuns: 20 });
});
