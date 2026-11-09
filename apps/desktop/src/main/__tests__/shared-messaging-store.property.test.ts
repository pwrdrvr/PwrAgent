import fc from "fast-check";
import { afterEach, expect, it, vi } from "vitest";
import type { MessagingBindingRecord, MessagingCallbackHandleRecord, MessagingDefaultAgentAssignmentRecord, MessagingManagedTopicRecord, MessagingPendingIntentRecord } from "@pwragent/messaging-interface";
import { SqliteMessagingStore as SharedStore, type SqliteMessagingPolicy, type SqliteMessagingSnapshot, type SqliteMessagingStorageRecords } from "@pwragent/sqlite-storage/messaging-store-sqlite";
import { StateDb } from "@pwragent/sqlite-storage/state-db";
import { SqliteMessagingStore as DesktopStore } from "../storage/messaging-store-sqlite";
import { SqliteMessagingStore as CompatibilityStore } from "../state/messaging-store-sqlite";
import { messagingSqlitePolicy } from "../storage/messaging-sqlite-policy";
import { disposeAppState, getAppStateDb, initializeAppState } from "../state/app-state";
import { getMessagingStorage } from "../storage/desktop-messaging-storage";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { createTempStateDb, openInMemoryStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const binding = (id: string, at = 10): MessagingBindingRecord => ({
  id, backend: "codex", threadId: "same-thread", authorizedActorIds: ["human", "human"], createdAt: 1, updatedAt: at,
  channel: { channel: "slack", conversation: { kind: "channel", id, workspaceId: "invented-workspace" } },
});
const construct = (db: StateDb, host: number) => host === 0 ? new SharedStore(db, messagingSqlitePolicy)
  : host === 1 ? new DesktopStore(db) : new CompatibilityStore(db);
afterEach(() => { disposeAppState(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it("binds the actual app-state construction and accessor to shared persistence for their original lifetime", async () => {
  await fc.assert(fc.asyncProperty(fc.boolean(), fc.string(), async (changeRoot, id) => {
    const fixture = createTempStateDb("shared-messaging-app-state-");
    try {
      vi.stubEnv("PWRAGENT_HOME", fixture.tempDir);
      const upsert = vi.spyOn(SharedStore.prototype, "upsertBinding");
      const initialized = initializeAppState("bootstrap");
      const originalDatabase = getAppStateDb();
      const store = getMessagingStorage();
      if (changeRoot) vi.stubEnv("PWRAGENT_HOME", fixture.tempDir + "-unselected");
      await store.upsertBinding(binding(id));
      expect(upsert).toHaveBeenCalledOnce();
      expect(store).toBeInstanceOf(SharedStore);
      expect(store).toBe(initialized.messagingStore);
      expect(getMessagingStorage()).toBe(store);
      expect(CompatibilityStore).toBe(DesktopStore);
      expect(getAppStateDb()).toBe(originalDatabase);
      expect(await new SharedStore(getAppStateDb(), messagingSqlitePolicy).getBinding(id)).toEqual(await store.getBinding(id));
      upsert.mockRestore();
    } finally { disposeAppState(); removeTempStateDbDir(fixture.tempDir); }
  }), { numRuns: 20 });
});

it("models binding identity, merge admission, monotone observations, detached reads and exact writes across WAL hosts", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  await fc.assert(fc.asyncProperty(fc.array(fc.record({ host: fc.integer({ min: 0, max: 2 }), id: fc.nat({ max: 3 }),
    at: fc.integer({ min: 1, max: 20 }), backend: fc.constantFrom("codex" as const, "claude" as const),
    revoked: fc.boolean(), merge: fc.boolean(), title: fc.string({ maxLength: 10 }), reopen: fc.boolean(),
  }), { minLength: 1, maxLength: 25 }), async commands => {
    const fixture = createTempStateDb("shared-messaging-bindings-");
    const dbs = [StateDb.open(fixture.dbPath), StateDb.open(fixture.dbPath), StateDb.open(fixture.dbPath)];
    const stores = dbs.map(construct);
    const model = new Map<string, MessagingBindingRecord>();
    const observed = new Map<string, { first: number; last: number; title?: string }>();
    try {
      for (const op of commands) {
        const id = String(op.id); const previous = model.get(id);
        const next = { ...binding(id, op.at), backend: op.backend, revokedAt: op.revoked ? op.at : undefined,
          channel: { ...binding(id).channel, conversation: { ...binding(id).channel.conversation, title: op.title } },
          routingState: { opaque: { route: id, nested: { api_key: "private", safe: op.title } } } };
        const admittedMerge = op.merge && previous && !previous.revokedAt && op.at >= previous.updatedAt;
        const changed = admittedMerge && previous.channel.conversation.title !== op.title;
        const measured = await measureSqliteWrites(async () => {
          if (!op.merge) await stores[op.host]!.upsertBinding(next);
          else {
            const result = await stores[op.host]!.mergeBindingChannelMetadata({ bindingId: id, channel: next.channel, observedAt: op.at, title: op.title });
            expect(result?.changed).toBe(previous && !previous.revokedAt ? Boolean(changed) : undefined);
          }
        });
        expect(measured.writes.commits).toBe(op.merge ? (changed ? 2 : 0) : (op.revoked ? 1 : 2));
        if (!op.merge) model.set(id, clone({ ...next, authorizedActorIds: ["human"], targetKind: "thread",
          routingState: { opaque: { route: id, nested: { api_key: "[REDACTED]", safe: op.title } } } }));
        else if (changed) model.set(id, clone({ ...previous!, channel: next.channel, updatedAt: op.at }));
        if ((!op.merge && !op.revoked) || changed) {
          const at = model.get(id)!.updatedAt; const prior = observed.get(id);
          observed.set(id, { first: Math.min(prior?.first ?? at, at), last: Math.max(prior?.last ?? at, at), title: op.title });
        }
        if (op.reopen) {
          dbs[op.host]!.close();
          const reopened = await measureSqliteWrites(() => StateDb.open(fixture.dbPath));
          expect(reopened.writes.commits).toBe(0); dbs[op.host] = reopened.result; stores[op.host] = construct(reopened.result, op.host);
        }
        const reads = await measureSqliteWrites(async () => {
          for (const store of stores) {
            for (const [key, expected] of model) {
              expect(await store.getBinding(key)).toEqual(expected);
              const detached = (await store.getBinding(key))!; detached.authorizedActorIds.push("mutated");
            }
            for (const backend of ["codex", "claude"] as const) expect((await store.findActiveBindingsForThread({ backend, threadId: "same-thread" })).map(row => row.id).sort())
              .toEqual([...model.values()].filter(row => !row.revokedAt && row.backend === backend).map(row => row.id).sort());
            const surfaces = await store.findObservedSurfaces();
            expect(surfaces.length).toBe(observed.size);
            for (const row of surfaces) expect({ first: row.firstSeenAt, last: row.lastSeenAt, title: row.channel.conversation.title }).toEqual(observed.get(row.channel.conversation.id));
          }
        });
        expect(reads.writes.commits).toBe(0);
      }
    } finally { dbs.forEach(db => db.close()); removeTempStateDbDir(fixture.tempDir); }
  }), { numRuns: 25 });
});

it("models one active default Agent per scope, target qualification and rollback without extra commits", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  await fc.assert(fc.asyncProperty(fc.array(fc.record({ host: fc.nat({ max: 1 }), id: fc.nat({ max: 4 }), scope: fc.nat({ max: 2 }),
    backend: fc.constantFrom("codex" as const, "acp:gemini" as const), revoke: fc.boolean(),
  }), { minLength: 1, maxLength: 25 }), async commands => {
    const fixture = createTempStateDb("shared-messaging-defaults-"); const dbs = [StateDb.open(fixture.dbPath), StateDb.open(fixture.dbPath)];
    const stores = dbs.map(construct); const model = new Map<string, MessagingDefaultAgentAssignmentRecord>();
    try {
      for (const [index, op] of commands.entries()) {
        const at = index + 10; const id = String(op.id);
        const scope: MessagingDefaultAgentAssignmentRecord["scope"] = op.scope === 0 ? { kind: "profile" }
          : op.scope === 1 ? { kind: "provider", channel: "slack" } : { kind: "workspace", channel: "slack", workspaceId: "invented-workspace" };
        const next: MessagingDefaultAgentAssignmentRecord = { id, scope, target: { kind: "agent", backend: op.backend, threadId: "same-agent" },
          createdAt: at, updatedAt: at, ...(op.revoke ? { revokedAt: at } : {}) };
        const measured = await measureSqliteWrites(() => stores[op.host]!.upsertDefaultAgentAssignment(next));
        expect(measured.writes.commits).toBe(1);
        if (!op.revoke) for (const [key, row] of model) if (!row.revokedAt && key !== id && JSON.stringify(row.scope) === JSON.stringify(scope))
          model.set(key, { ...row, revokedAt: at, updatedAt: at });
        model.set(id, clone(next));
        for (const store of stores) {
          for (const [key, expected] of model) expect(await store.getDefaultAgentAssignment(key)).toEqual(expected);
          expect((await store.findActiveDefaultAgentAssignmentsForChannel(binding("surface").channel)).map(row => row.id)).toEqual(
            [...model.values()].filter(row => !row.revokedAt).sort((a, b) => {
              const rank = (r: MessagingDefaultAgentAssignmentRecord) => r.scope.kind === "workspace" ? 0 : r.scope.kind === "provider" ? 1 : 2;
              return rank(a) - rank(b);
            }).map(row => row.id));
        }
      }
      const before = await stores[0]!.readSnapshot();
      dbs[0]!.raw.exec("CREATE TEMP TRIGGER refuse_default BEFORE INSERT ON messaging_default_agent_assignments WHEN NEW.assignment_id = 'refused' BEGIN SELECT RAISE(ABORT, 'invented refusal'); END");
      const measured = await measureSqliteWrites(async () => expect(stores[0]!.upsertDefaultAgentAssignment({ id: "refused", scope: { kind: "profile" },
        target: { kind: "agent", backend: "codex", threadId: "other" }, createdAt: 100, updatedAt: 100 })).rejects.toThrow("invented refusal"));
      expect(measured.writes.commits).toBe(0); expect(await stores[1]!.readSnapshot()).toEqual(before);
    } finally { dbs.forEach(db => db.close()); removeTempStateDbDir(fixture.tempDir); }
  }), { numRuns: 25 });
});

const pending = (id: string, at: number, expiresAt: number, actor: string): MessagingPendingIntentRecord => ({
  id, channel: binding("surface").channel, allowedActorIds: [actor, actor], createdAt: at, expiresAt,
  intent: { id, kind: "questionnaire", createdAt: at, questions: [], answers: [], currentIndex: 0, phase: "answering",
    asyncReply: { backend: "codex", threadId: "thread", itemId: id } },
});
const callback = (id: string, at: number, expiresAt: number, actor: string): MessagingCallbackHandleRecord => ({
  id, handle: "same-handle", actionId: "invented-action", channel: binding("surface").channel,
  allowedActorIds: [actor, actor], createdAt: at, updatedAt: at, expiresAt, browseSessionId: "session", bindingId: "binding",
  value: { token: "private", safe: id },
});
it("models callback and questionnaire authorization, strict expiry, latest selection and bounded cleanup across WAL readers", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  await fc.assert(fc.asyncProperty(fc.array(fc.record({ id: fc.nat({ max: 5 }), at: fc.integer({ min: 1, max: 20 }), expiry: fc.integer({ min: 1, max: 20 }),
    actor: fc.constantFrom("human-a", "human-b"), host: fc.nat({ max: 1 }), cleanup: fc.boolean(),
  }), { minLength: 1, maxLength: 25 }), async commands => {
    const fixture = createTempStateDb("shared-messaging-expiry-"); const dbs = [StateDb.open(fixture.dbPath), StateDb.open(fixture.dbPath)];
    const stores = dbs.map(construct); const intents = new Map<string, MessagingPendingIntentRecord>(); const handles = new Map<string, MessagingCallbackHandleRecord>();
    try {
      for (const op of commands) {
        const id = String(op.id); const p = pending(id, op.at, op.expiry, op.actor); const h = callback(id, op.at, op.expiry, op.actor);
        const measured = await measureSqliteWrites(async () => { await stores[op.host]!.upsertPendingIntent(p); await stores[op.host]!.upsertCallbackHandle(h); });
        expect(measured.writes.commits).toBe(2);
        intents.set(id, { ...p, allowedActorIds: [op.actor] }); handles.set(id, { ...h, allowedActorIds: [op.actor], value: { token: "[REDACTED]", safe: id } });
        if (op.cleanup) {
          const removed = [...intents.values()].filter(row => row.expiresAt <= op.at).map(row => row.id).sort();
          const clean = await measureSqliteWrites(async () => {
            expect((await stores[op.host]!.cleanupExpiredPendingIntents({ now: op.at })).sort()).toEqual(removed);
            expect((await stores[op.host]!.cleanupExpiredCallbackHandles({ now: op.at })).sort()).toEqual(removed);
          });
          expect(clean.writes.commits).toBe(removed.length ? 2 : 0); removed.forEach(key => { intents.delete(key); handles.delete(key); });
        }
        const reads = await measureSqliteWrites(async () => {
          for (const store of stores) for (const actor of ["human-a", "human-b", "stranger"]) {
            const eligible = [...intents.values()].filter(row => row.expiresAt > op.at && row.allowedActorIds.includes(actor));
            const selected = await store.findActivePendingIntentForChannel({ actorId: actor, channel: p.channel!, now: op.at });
            if (!eligible.length) expect(selected).toBeUndefined();
            else {
              expect(selected?.createdAt).toBe(Math.max(...eligible.map(row => row.createdAt)));
              expect(intents.get(selected!.id)).toEqual(selected);
            }
            const found = await store.resolveCallbackHandle({ actorId: actor, channel: p.channel!, handle: "same-handle", now: op.at });
            if (!eligible.length) expect(found).toBeUndefined();
            else {
              expect(found?.updatedAt).toBe(Math.max(...eligible.map(row => row.createdAt)));
              expect(handles.get(found!.id)).toEqual(found);
            }
            expect((await store.findActivePendingAsyncQuestionnaires({ backend: "codex", threadId: "thread", now: op.at })).map(row => row.id).sort())
              .toEqual([...intents.values()].filter(row => row.expiresAt > op.at).map(row => row.id).sort());
            expect(await store.findActivePendingAsyncQuestionnaires({ backend: "claude", threadId: "thread", now: op.at })).toEqual([]);
          }
        }); expect(reads.writes.commits).toBe(0);
      }
    } finally { dbs.forEach(db => db.close()); removeTempStateDbDir(fixture.tempDir); }
  }), { numRuns: 25 });
});

it("keeps owned topic metadata authoritative over observations and makes repeated observations write-free", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  await fc.assert(fc.asyncProperty(fc.array(fc.record({ at: fc.integer({ min: 1, max: 20 }), observed: fc.integer({ min: 1, max: 30 }),
    host: fc.nat({ max: 1 }), closed: fc.boolean(), title: fc.string({ maxLength: 10 }),
  }), { minLength: 1, maxLength: 25 }), async commands => {
    const fixture = createTempStateDb("shared-messaging-topics-"); const dbs = [StateDb.open(fixture.dbPath), StateDb.open(fixture.dbPath)]; const stores = dbs.map(construct);
    let expected: MessagingManagedTopicRecord = { id: "topic", channel: "telegram", supergroupId: "group", topicId: "topic", title: "owned-title",
      conversation: { kind: "topic", id: "topic", parentId: "group" }, authorizedActorIds: ["owner"], source: "owned", lifecycle: "open", createdAt: 1, updatedAt: 1 };
    try {
      await stores[0]!.upsertManagedTopic(expected);
      for (const op of commands) {
        const observation = { ...expected, title: op.title, authorizedActorIds: ["observer"], source: "observed" as const,
          lifecycle: op.closed ? "closed" as const : "open" as const, updatedAt: op.at, lastObservedAt: op.observed };
        const nextObserved = Math.max(expected.lastObservedAt ?? 0, op.observed);
        const changed = op.at > expected.updatedAt || nextObserved !== expected.lastObservedAt;
        const next = op.at > expected.updatedAt ? { ...expected, lifecycle: observation.lifecycle, updatedAt: op.at, lastObservedAt: nextObserved }
          : { ...expected, lastObservedAt: nextObserved };
        const measured = await measureSqliteWrites(() => stores[op.host]!.mergeManagedTopicObservation(observation));
        expect(measured.writes.commits).toBe(Number(changed)); expect(measured.result.changed).toBe(changed);
        expected = next; expect(measured.result.topic).toEqual(expected);
        for (const store of stores) expect(await store.getManagedTopic("topic")).toEqual(expected);
      }
    } finally { dbs.forEach(db => db.close()); removeTempStateDbDir(fixture.tempDir); }
  }), { numRuns: 25 });
});

it("preserves serialization failures, legacy migration, malformed read behavior and atomic cleanup refusal", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  await fc.assert(fc.asyncProperty(fc.string(), async hostileId => {
    const db = openInMemoryStateDb(); const store = construct(db, 0);
    try {
      const legacy = { id: hostileId, scopeKind: "profile", backend: "codex", threadId: "legacy-agent", createdAt: 1, updatedAt: 2 };
      db.raw.prepare("INSERT INTO messaging_default_agent_assignments(assignment_id, scope_kind, scope_key, backend, thread_id, status, created_at, updated_at, payload) VALUES (?, 'profile', 'profile', 'codex', 'legacy-agent', 'active', 1, 2, ?)").run(hostileId, JSON.stringify(legacy));
      const reads = await measureSqliteWrites(async () => {
        expect(await store.getDefaultAgentAssignment(hostileId)).toEqual({ id: hostileId, scope: { kind: "profile" }, target: { kind: "agent", backend: "codex", threadId: "legacy-agent" }, createdAt: 1, updatedAt: 2 });
      }); expect(reads.writes.commits).toBe(0);
      await store.upsertPendingIntent(pending("a", 1, 20, "human")); await store.upsertPendingIntent(pending("b", 2, 20, "human"));
      db.raw.exec("CREATE TEMP TRIGGER refuse_cleanup BEFORE DELETE ON pending_intents WHEN OLD.intent_id = 'b' BEGIN SELECT RAISE(ABORT, 'invented cleanup refusal'); END");
      const failure = await measureSqliteWrites(async () => expect(store.deletePendingIntentsForChannel({ channel: binding("surface").channel })).rejects.toThrow("invented cleanup refusal"));
      expect(failure.writes.commits).toBe(0); expect(db.raw.prepare("SELECT COUNT(*) FROM pending_intents").pluck().get()).toBe(2);
      const cyclic = binding("cyclic") as MessagingBindingRecord & { cycle?: unknown }; cyclic.cycle = cyclic;
      const serialization = await measureSqliteWrites(async () => expect(store.upsertBinding(cyclic)).rejects.toThrow());
      expect(serialization.writes.commits).toBe(0);
      db.raw.prepare("UPDATE messaging_default_agent_assignments SET payload = ?").run("{malformed");
      await store.upsertBinding(binding("malformed")); db.raw.prepare("UPDATE bindings SET payload = ? WHERE binding_id = ?").run("{malformed", "malformed");
      const malformed = await measureSqliteWrites(async () => {
        expect(await store.getDefaultAgentAssignment(hostileId)).toBeUndefined();
        await expect(store.getBinding("malformed")).rejects.toThrow();
        await expect(store.readSnapshot()).rejects.toThrow();
      }); expect(malformed.writes.commits).toBe(0);
    } finally { db.close(); }
  }), { numRuns: 25 });
});

// An independent host uses arbitrary channel names, opaque payloads and its own
// snapshot shape. Its type map contains no messaging-interface record.
type AltTimed = { id: string; createdAt: number; updatedAt: number };
type AltChannel = { channel: string; conversation: { id: string; kind: string } };
type AltBinding = AltTimed & { backend: string; threadId: string; channel: AltChannel; revokedAt?: number; payload: unknown };
type AlternateRecords = {
  channel: AltChannel; binding: AltBinding; bindingMetadataUpdate: { bindingId: string };
  bindingMetadataMerge: { binding: AltBinding; changed: boolean };
  observedSurface: { channel: AltChannel; firstSeenAt: number; lastSeenAt: number };
  defaultAgentScope: { kind: string };
  defaultAgentAssignment: AltTimed & { scope: { kind: string }; target: { backend: string; threadId: string }; revokedAt?: number };
  monitorSubscription: AltTimed & { channel: AltChannel; revokedAt?: number };
  managedTopic: AltTimed & { channel: string; supergroupId: string; topicId: string; lifecycle: string };
  managedTopicObservationMerge: { topic: AlternateRecords["managedTopic"]; changed: boolean };
  threadTopicLink: AltTimed & { backend: string; threadId: string; channel: string; supergroupId: string; topicRecordId: string };
  topicCleanupProposal: AltTimed & { channel: string; supergroupId: string; status: string };
  pendingIntent: { id: string; channel?: AltChannel; allowedActorIds: string[]; createdAt: number; expiresAt: number; intent: { requestContext?: { backend: string; threadId: string; requestId: string } } };
  browseSession: AltTimed & { channel: AltChannel; expiresAt: number; allowedActorIds: string[] };
  callbackHandle: AltTimed & { channel: AltChannel; expiresAt: number; allowedActorIds: string[]; handle: string };
  delivery: { id: string; deliveredAt?: number };
  snapshot: { host: string; bindings: Record<string, AltBinding> };
};
const alternatePolicy: SqliteMessagingPolicy<AlternateRecords & SqliteMessagingStorageRecords<AlternateRecords>> = {
  sanitizeBinding: clone, sanitizeDefaultAgentAssignment: clone, sanitizeMonitorSubscription: clone, sanitizeManagedTopic: clone,
  sanitizePendingIntent: clone, sanitizeBrowseSession: clone, sanitizeCallbackHandle: clone, sanitizeDelivery: clone,
  buildMessagingConversationKey: channel => JSON.stringify(channel), buildMessagingConversationLookupKeys: channel => [JSON.stringify(channel)],
  buildChannelId: channel => channel.conversation.id, buildMessagingDefaultAgentScopeKey: scope => scope.kind,
  buildDefaultAgentScopeLookup: () => [{ key: "all" }], channelKindForDefaultAgentScope: () => null,
  parseDefaultAgentAssignment: payload => JSON.parse(payload),
  mergeMessagingBindingChannelMetadata: current => current ? { binding: current, changed: false } : undefined,
  mergeMessagingManagedTopicObservation: (current, topic) => ({ topic: current ?? topic, changed: !current }),
  isBindingForThread: (row, target) => row.backend === target.backend && row.threadId === target.threadId,
  isAsyncQuestionnaireForThread: () => false,
  observeSurface: (current, channel, at) => ({ channel, firstSeenAt: Math.min(current?.firstSeenAt ?? at, at), lastSeenAt: Math.max(current?.lastSeenAt ?? at, at) }),
  bindingMetadataResult: (row, changed) => ({ binding: row, changed }), managedTopicResult: (topic, changed) => ({ topic, changed }),
  snapshot: records => ({ host: "alternate", bindings: records.bindings }),
};
it("persists an alternate host's channel, opaque JSON and snapshot without desktop domain contracts", async () => {
  await fc.assert(fc.asyncProperty(fc.jsonValue(), fc.string(), async (payload, id) => {
    const db = openInMemoryStateDb();
    try {
      const store = new SharedStore<AlternateRecords>(db, alternatePolicy);
      const row = { id, backend: "alternate-backend", threadId: "thread", channel: { channel: "alternate-channel", conversation: { id, kind: "alternate-surface" } },
        createdAt: 1, updatedAt: 1, payload };
      // JSON persistence canonicalizes values such as negative zero. Keep the
      // original input at the boundary and compare with the JSON data model.
      const persisted = clone(row);
      expect(await store.upsertBinding(row)).toEqual(persisted);
      expect(await store.findActiveBindingForChannel(row.channel)).toEqual(persisted);
      expect(await store.readSnapshot()).toEqual({ host: "alternate", bindings: { [id]: persisted } });
    } finally { db.close(); }
  }), { numRuns: 25, examples: [[{}, "__proto__"], [{ "": [-0] }, ""]] });
});

it("retains arbitrary record ids as own keys in every snapshot dictionary without writes", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  await fc.assert(fc.asyncProperty(fc.oneof(fc.constantFrom("__proto__", "constructor", "toString"), fc.string()), async id => {
    const db = openInMemoryStateDb();
    let captured: SqliteMessagingSnapshot<AlternateRecords> | undefined;
    const store = new SharedStore<AlternateRecords>(db, { ...alternatePolicy, snapshot: records => {
      captured = records;
      return alternatePolicy.snapshot(records);
    } });
    const timed = { id, createdAt: 1, updatedAt: 2 };
    const channel = { channel: "alternate", conversation: { id, kind: "alternate" } };
    const target = { backend: "alternate", threadId: "thread" };
    const expected: { [Key in keyof SqliteMessagingSnapshot<AlternateRecords>]: SqliteMessagingSnapshot<AlternateRecords>[Key][string] } = {
      bindings: { ...timed, ...target, channel, payload: {} },
      defaultAgentAssignments: { ...timed, scope: { kind: "profile" }, target },
      monitorSubscriptions: { ...timed, channel },
      topics: { ...timed, channel: channel.channel, supergroupId: "group", topicId: "topic", lifecycle: "active" },
      topicLinks: { ...timed, ...target, channel: channel.channel, supergroupId: "group", topicRecordId: id },
      topicCleanupProposals: { ...timed, channel: channel.channel, supergroupId: "group", status: "pending" },
      pendingIntents: { id, channel, createdAt: 1, expiresAt: 100, allowedActorIds: [], intent: {} },
      browseSessions: { ...timed, channel, expiresAt: 100, allowedActorIds: [] },
      callbackHandles: { ...timed, channel, expiresAt: 100, allowedActorIds: [], handle: id },
      deliveries: { id, deliveredAt: 2 },
    };
    try {
      await store.upsertBinding(expected.bindings);
      await store.upsertDefaultAgentAssignment(expected.defaultAgentAssignments);
      await store.upsertMonitorSubscription(expected.monitorSubscriptions);
      await store.upsertManagedTopic(expected.topics);
      await store.upsertThreadTopicLink(expected.topicLinks);
      await store.upsertTopicCleanupProposal(expected.topicCleanupProposals);
      await store.upsertPendingIntent(expected.pendingIntents);
      await store.upsertBrowseSession(expected.browseSessions);
      await store.upsertCallbackHandle(expected.callbackHandles);
      await store.recordDelivery(expected.deliveries);
      const read = await measureSqliteWrites(() => store.readSnapshot());
      expect(read.writes.commits).toBe(0);
      for (const dictionary of Object.keys(expected) as Array<keyof typeof expected>) {
        expect(Object.entries(captured![dictionary]), dictionary).toEqual([[id, expected[dictionary]]]);
      }
    } finally { db.close(); }
  }), { numRuns: 25, examples: [["__proto__"]] });
});

it("models browse-session expiry and channel-versus-binding cleanup while preserving qualified federated bindings", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 2, max: 6 }), fc.integer({ min: 1, max: 6 }), fc.string(), async (count, now, opaque) => {
    const fixture = createTempStateDb("shared-messaging-browse-"); const dbs = [StateDb.open(fixture.dbPath), StateDb.open(fixture.dbPath)]; const stores = dbs.map(construct);
    try {
      for (let i = 0; i < count; i++) {
        const id = String(i); const b = binding(id);
        const remote = { backend: "codex" as const, threadId: "same-thread", target: { scope: "remote" as const, instanceId: id } };
        await stores[i % 2]!.upsertBinding({ ...b, federatedThread: remote });
        expect((await stores[1]!.findActiveBindingsForFederatedThread(remote)).map(row => row.id)).toEqual([id]);
        expect(await stores[1]!.findActiveBindingsForFederatedThread({ ...remote, backend: "claude" })).toEqual([]);
        await stores[i % 2]!.upsertBrowseSession({ id, bindingId: id, allowedActorIds: ["human", "human"], channel: binding("surface").channel,
          createdAt: i, updatedAt: i, expiresAt: i + 2, launchAction: "resume_thread", mode: "recents", pageIndex: 0, pageSize: 3, query: opaque });
        await stores[i % 2]!.upsertCallbackHandle({ ...callback(id, i, 100, "human"), browseSessionId: id, bindingId: id });
      }
      const eligible = Array.from({ length: count }, (_, i) => i).filter(i => i + 2 > now);
      const selected = await stores[1]!.findActiveBrowseSessionForChannel({ actorId: "human", channel: binding("surface").channel, now });
      expect(selected?.id).toBe(eligible.length ? String(eligible.at(-1)) : undefined);
      expect(await stores[1]!.findActiveBrowseSessionForChannel({ actorId: "stranger", channel: binding("surface").channel, now })).toBeUndefined();
      const expired = Array.from({ length: count }, (_, i) => i).filter(i => i + 2 <= now).map(String);
      expect((await stores[0]!.cleanupExpiredBrowseSessions({ now })).sort()).toEqual(expired.sort());
      for (const id of expired) expect(await stores[1]!.getCallbackHandle(id, { now: 0 })).toBeUndefined();
      await stores[0]!.upsertPendingIntent({ ...pending("unbound", 1, 100, "human"), channel: binding("0").channel });
      await stores[0]!.upsertPendingIntent({ ...pending("bound", 1, 100, "human"), channel: binding("0").channel, bindingId: "0" });
      await stores[0]!.upsertPendingIntent({ ...pending("other", 1, 100, "human"), channel: binding("0").channel, bindingId: "1" });
      await stores[0]!.revokeBinding({ bindingId: "0", revokedAt: 50 });
      expect(await stores[1]!.getPendingIntent("unbound", { now: 0 })).toBeUndefined();
      expect(await stores[1]!.getPendingIntent("bound", { now: 0 })).toBeUndefined();
      expect(await stores[1]!.getPendingIntent("other", { now: 0 })).toBeDefined();
      expect(await stores[1]!.getCallbackHandle("0", { now: 0 })).toBeUndefined();
      expect((await stores[1]!.findActiveBindings()).length).toBe(count - 1);
    } finally { dbs.forEach(db => db.close()); removeTempStateDbDir(fixture.tempDir); }
  }), { numRuns: 25 });
});
