import fc from "fast-check";
import { afterEach, expect, it, vi } from "vitest";
import type { MessagingActivityStorage } from "@pwragent/owner-core/messaging-activity-storage";
import type { MessagingPairingStorage } from "@pwragent/owner-core/messaging-pairing-storage";
import type { MessagingActivityEntry, MessagingPairingEntry } from "@pwragent/shared";
import type { MessagingInboundEvent } from "@pwragent/messaging-interface";
import type { MessagingRequestSource, MessagingRequestStore } from "../messaging/core/messaging-storage";
import { MessagingActivityLog } from "../storage/messaging-activity-log";
import { MessagingPairingStore } from "../storage/messaging-pairing-store";
import { SqliteMessagingRequestStore } from "../state/messaging-request-store";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { openInMemoryStateDb } from "./sqlite-test-utils";

afterEach(() => vi.unstubAllEnvs());

it("orders activity by insertion while platform summaries retain the greatest observed timestamps", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const operation = fc.record({
    platform: fc.constantFrom("telegram" as const, "slack" as const),
    kind: fc.constantFrom("inbound-routed" as const, "outbound" as const, "summary" as const),
    at: fc.integer({ min: 1, max: 50 }), since: fc.nat({ max: 20 }), limit: fc.integer({ min: 1, max: 10 }),
  });
  await fc.assert(fc.asyncProperty(fc.array(operation, { minLength: 1, maxLength: 25 }), async (operations) => {
    const db = openInMemoryStateDb();
    const storage: MessagingActivityStorage = new MessagingActivityLog(db);
    const rows: MessagingActivityEntry[] = [];
    const summaries = new Map<string, { platform: string; lastRequestAt?: number; lastResponseAt?: number }>();
    try {
      for (const op of operations) {
        const summary = summaries.get(op.platform) ?? { platform: op.platform };
        if (op.kind === "summary") {
          storage.recordPlatformResponseActivity({ platform: op.platform, createdAt: op.at });
        } else {
          const input = { platform: op.platform, kind: op.kind, createdAt: op.at, summary: "Fixture event",
            payload: { text: "'; DROP TABLE bindings; --" } };
          const expected = { ...input, id: rows.length + 1 };
          expect(storage.record(input)).toEqual(expected);
          rows.push(expected);
        }
        if (op.kind === "inbound-routed") summary.lastRequestAt = Math.max(summary.lastRequestAt ?? 0, op.at);
        else summary.lastResponseAt = Math.max(summary.lastResponseAt ?? 0, op.at);
        summaries.set(op.platform, summary);
        const reads = await measureSqliteWrites(() => {
          expect(storage.list({ sinceId: op.since, limit: op.limit })).toEqual(rows
            .filter(row => row.id > op.since).reverse().slice(0, op.limit));
          expect(storage.getPlatformActivitySummary().summaries.sort((a, b) => a.platform.localeCompare(b.platform)))
            .toEqual([...summaries.values()].sort((a, b) => a.platform.localeCompare(b.platform)));
        });
        expect(reads.writes.commits).toBe(0);
      }
    } finally { db.close(); }
  }), { numRuns: 50 });
});

it("retains observed pairing cards and deduplicated approvals until resolution or expiry", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const operation = fc.record({
    slot: fc.integer({ min: 0, max: 2 }), kind: fc.constantFrom("observe", "approve", "resolve", "advance", "match"),
    target: fc.constantFrom("actor" as const, "conversation" as const, "team" as const),
    status: fc.constantFrom("approved" as const, "rejected" as const, "consumed" as const),
    elapsed: fc.nat({ max: 250 }),
  });
  await fc.assert(fc.asyncProperty(fc.array(operation, { minLength: 1, maxLength: 25 }), async (operations) => {
    const db = openInMemoryStateDb();
    const storage: MessagingPairingStorage = new MessagingPairingStore(db);
    let now = 1_000;
    const model: MessagingPairingEntry[] = [];
    const token = (slot: number) => `FIXTURE-PAIRING-TOKEN-${slot}`;
    try {
      for (const slot of [0, 1, 2]) model.push(storage.create({ token: token(slot), platform: "slack",
        instanceId: "fixture", scope: "observed", generatedAt: now + slot, expiresAt: 1_500 + slot * 100 }));
      for (const op of operations) {
        const current = model[op.slot]!;
        if (op.kind === "advance") now += op.elapsed;
        if (op.kind === "observe" && current.status === "pending") {
          const actor = { id: `actor-${op.slot}` };
          const chat = { id: `channel-${op.slot}`, kind: "channel" as const };
          storage.markObserved({ entryId: current.id, observedAt: now, actor, chat });
          Object.assign(current, { status: "observed", observedAt: now, observedActor: actor, observedChat: chat });
        } else if (op.kind === "approve" && current.status === "observed") {
          storage.recordApproval({ entryId: current.id, target: op.target });
          current.approvedTargets = [...new Set([...(current.approvedTargets ?? []), op.target])];
        } else if (op.kind === "resolve" && current.status === "observed") {
          storage.markStatus({ entryId: current.id, status: op.status });
          current.status = op.status;
        }
        // List and match retain their existing expiry side effect; get without a clock is a pure read.
        for (const row of model) {
          if ((row.status === "pending" || row.status === "observed") && row.expiresAt <= now) row.status = "expired";
        }
        if (op.kind === "match") {
          expect(storage.findMatchingPending({ token: token(op.slot), platform: "slack", instanceId: "fixture", now }))
            .toEqual(current.status === "pending" ? current : undefined);
        }
        expect(storage.list({ now })).toEqual(model.filter(row => row.status === "pending" || row.status === "observed")
          .toSorted((a, b) => b.generatedAt - a.generatedAt));
        expect(storage.countOutstanding({ platform: "slack", instanceId: "fixture", now }))
          .toBe(model.filter(row => row.status === "pending" || row.status === "observed").length);
        const reads = await measureSqliteWrites(() => {
          for (const row of model) expect(storage.get(row.id)).toEqual(row);
        });
        expect(reads.writes.commits).toBe(0);
        const persisted = JSON.stringify(db.raw.prepare("SELECT * FROM messaging_pairing_tokens").all());
        for (const slot of [0, 1, 2]) expect(persisted).not.toContain(token(slot));
      }
    } finally { db.close(); }
  }), { numRuns: 50 });
});

it("keeps request provenance immutable and private while latest human destinations advance independently", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const operation = fc.record({
    actor: fc.integer({ min: 0, max: 1 }), channel: fc.integer({ min: 0, max: 2 }),
    message: fc.integer({ min: 0, max: 3 }), at: fc.integer({ min: 1, max: 50 }), bot: fc.boolean(),
  });
  await fc.assert(fc.asyncProperty(fc.array(operation, { minLength: 1, maxLength: 25 }), async (operations) => {
    const db = openInMemoryStateDb();
    const storage: MessagingRequestStore = new SqliteMessagingRequestStore(db.raw);
    const requests = new Map<string, MessagingRequestSource>();
    const destinations = new Map<string, MessagingRequestSource>();
    try {
      for (const op of operations) {
        const key = `${op.actor}/${op.channel}/${op.message}`;
        const destination = `${op.actor}/${op.channel}`;
        const event: MessagingInboundEvent = {
          id: `message-${op.message}`, kind: "text", text: "Private fixture message", receivedAt: op.at,
          actor: { platformUserId: `actor-${op.actor}`, isBot: op.bot },
          channel: { channel: "slack", conversation: { id: `channel-${op.channel}`, kind: "channel", workspaceId: "fixture" } },
          routingState: { opaque: { channelId: `channel-${op.channel}`, token: "Private fixture credential" } },
        };
        const previous = requests.get(key);
        const write = await measureSqliteWrites(() => storage.remember({ agent: { backend: "codex", threadId: "owner" }, event }));
        expect(write.writes.commits).toBe(op.bot || previous ? 0 : 1);
        if (op.bot) expect(write.result).toBeUndefined();
        else if (previous) expect(write.result).toEqual(previous);
        else {
          const source = write.result!;
          expect(source.event).not.toHaveProperty("text");
          expect(JSON.stringify(source)).not.toContain("Private fixture");
          requests.set(key, source);
          const latest = destinations.get(destination);
          if (!latest || latest.event.receivedAt < op.at) destinations.set(destination, source);
        }
        const reads = await measureSqliteWrites(() => {
          for (const [identity, source] of requests) {
            const actor = identity.split("/")[0]!;
            expect(storage.get(source.ref)).toEqual(source);
            expect(storage.get({ ...source.ref, ownerId: "another-profile" })).toBeUndefined();
            const expected = [...destinations.entries()].filter(([id]) => id.startsWith(`${actor}/`)).map(([, value]) => value)
              .sort((a, b) => b.event.receivedAt - a.event.receivedAt || a.selector.localeCompare(b.selector));
            expect(storage.list(source, 25)).toEqual(expected);
            for (const target of destinations.values()) {
              const sameActor = target.event.actor.platformUserId === source.event.actor.platformUserId;
              expect(storage.destination(source, target.selector)).toEqual(sameActor ? target : undefined);
            }
          }
        });
        expect(reads.writes.commits).toBe(0);
      }
    } finally { db.close(); }
  }), { numRuns: 50 });
});
