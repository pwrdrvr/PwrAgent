import { createHmac } from "node:crypto";
import fc from "fast-check";
import { afterEach, expect, it, vi } from "vitest";
import type { MessagingActivityEntry, MessagingChannelKind, MessagingPairingEntry } from "@pwragent/shared";
import { MessagingPairingStore as SharedPairing } from "@pwragent/sqlite-storage/messaging-pairing-store";
import { MessagingActivityLog as SharedActivity } from "@pwragent/sqlite-storage/messaging-activity-log";
import { StateDb } from "@pwragent/sqlite-storage/state-db";
import { MessagingPairingStore as DesktopPairing } from "../storage/messaging-pairing-store";
import { MessagingActivityLog as DesktopActivity } from "../storage/messaging-activity-log";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

const pairings = [SharedPairing, DesktopPairing];
const activities = [SharedActivity, DesktopActivity];
const platforms: MessagingChannelKind[] = ["telegram", "discord", "slack", "line", "mattermost", "feishu"];
const scopes = ["user_dm", "bucket", "user_in_group", "observed"] as const;
const instances = ["default", "other' ; -- 雪"];
const tokens = ["fixture-secret-token", "' OR 1=1 --\0雪", "another-fixture-token"];
const hostChoice = fc.integer({ min: 0, max: 1 });
const platformChoice = fc.integer({ min: 0, max: platforms.length - 1 });
afterEach(() => vi.unstubAllEnvs());

it("binds every generated desktop choice to the functioning portable messaging implementations", () => {
  fc.assert(fc.property(hostChoice, host => {
    expect(pairings[host]).toBe(SharedPairing);
    expect(activities[host]).toBe(SharedActivity);
  }));
});

// The database owns the profile secret. An independent HMAC oracle checks every
// field in the binding, including NUL-separated boundaries, across both hosts.
it("models profile-secret generation, token privacy and qualified HMAC identity", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  await fc.assert(fc.asyncProperty(fc.record({ platform: platformChoice, host: hostChoice,
    scope: fc.integer({ min: 0, max: 3 }), token: fc.constantFrom(...tokens), time: fc.integer({ min: 1, max: 1_000 }),
  }), async op => {
    const fixture = createTempStateDb("shared-pairing-secret-");
    const dbs = [StateDb.open(fixture.dbPath), StateDb.open(fixture.dbPath)];
    try {
      const store = new pairings[op.host]!(dbs[op.host]!);
      const input = { token: op.token, platform: platforms[op.platform]!, instanceId: instances[op.host]!,
        scope: scopes[op.scope]!, generatedAt: op.time, expiresAt: 10_000 };
      const first = await measureSqliteWrites(() => store.create(input));
      expect(first.writes.commits).toBe(2); // secret + token, at the original sites
      const secret = dbs[1 - op.host]!.getMeta("messaging_pairing_secret_v1")!;
      expect(Buffer.from(secret, "base64")).toHaveLength(32);
      const inputs = [input, ...[
        { token: input.token + "x" }, { platform: platforms[(op.platform + 1) % platforms.length]! },
        { instanceId: instances[1 - op.host]! }, { scope: scopes[(op.scope + 1) % scopes.length]! },
        { generatedAt: input.generatedAt + 1 },
      ].map(change => ({ ...input, ...change }))];
      const digests: string[] = [];
      for (const [index, value] of inputs.entries()) {
        const written = index === 0 ? first : await measureSqliteWrites(() => store.create(value));
        if (index > 0) expect(written.writes.commits).toBe(1);
        const row = dbs[1 - op.host]!.raw.prepare("SELECT token_hmac, payload FROM messaging_pairing_tokens WHERE entry_id = ?")
          .get(written.result.id) as { token_hmac: string; payload: string };
        const oracle = createHmac("sha256", Buffer.from(secret, "base64"))
          .update([value.token, value.platform, value.instanceId, value.scope, String(value.generatedAt)].join("\0")).digest("hex");
        expect(row.token_hmac).toBe(oracle);
        expect(row.payload).toBe("{}");
        expect(written.result).not.toHaveProperty("token");
        expect(written.result).not.toHaveProperty("token_hmac");
        digests.push(row.token_hmac);
      }
      expect(new Set(digests).size).toBe(inputs.length);
      expect(dbs[1 - op.host]!.getMeta("messaging_pairing_secret_v1")).toBe(secret);
      const otherProfile = StateDb.open(":memory:");
      try {
        new SharedPairing(otherProfile).create(input);
        expect(otherProfile.getMeta("messaging_pairing_secret_v1")).not.toBe(secret);
      } finally { otherProfile.close(); }
      // Corrupt hex of a different length must be refused without throwing.
      dbs[0]!.raw.prepare("DELETE FROM messaging_pairing_tokens WHERE entry_id <> ?").run(first.result.id);
      dbs[0]!.raw.prepare("UPDATE messaging_pairing_tokens SET token_hmac = ?").run("ab");
      expect(store.findMatchingPending({ ...input, now: input.generatedAt })).toBeUndefined();
    } finally { dbs.forEach(db => db.close()); removeTempStateDbDir(fixture.tempDir); }
  }), { numRuns: 25 });
});

// Pending/observed expiry is irreversible by time alone. Explicit status writes
// retain the original store contract; approval accumulation is observed-only.
it("matches an independent pairing transition model over WAL connections, expiry and reopen", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  await fc.assert(fc.asyncProperty(fc.array(fc.record({ host: hostChoice, platform: platformChoice,
    instance: hostChoice, scope: fc.integer({ min: 0, max: 3 }), slot: fc.nat({ max: 20 }),
    kind: fc.constantFrom("create", "observe", "approve", "status", "expire", "find", "list", "count", "read"),
    status: fc.constantFrom("approved", "rejected", "consumed"),
    target: fc.constantFrom("actor", "conversation", "team"), time: fc.integer({ min: 0, max: 60 }), reopen: fc.boolean(),
  }), { minLength: 1, maxLength: 35 }), async operations => {
    const fixture = createTempStateDb("shared-pairing-model-");
    const dbs = pairings.map(() => StateDb.open(fixture.dbPath));
    const stores = dbs.map((db, index) => new pairings[index]!(db));
    const model: { entry: MessagingPairingEntry; token: string }[] = [];
    let hasSecret = false;
    const expire = (now: number) => {
      for (const { entry } of model) {
        if (["pending", "observed"].includes(entry.status) && entry.expiresAt <= now) entry.status = "expired";
      }
    };
    try {
      for (const [revision, op] of operations.entries()) {
        const store = stores[op.host]!;
        const selected = model.length ? model[op.slot % model.length] : undefined;
        const id = selected?.entry.id ?? "absent";
        const platform = platforms[op.platform]!;
        const instanceId = instances[op.instance]!;
        const now = 1_000 + op.time;
        let commits = 0;
        const measured = await measureSqliteWrites(() => {
          switch (op.kind) {
            case "create": {
              const token = tokens[op.slot % tokens.length]!;
              const entry = store.create({ token, platform, instanceId, scope: scopes[op.scope]!,
                generatedAt: 1_000 + revision, expiresAt: 1_020 + revision });
              model.push({ entry: { id: entry.id, platform, instanceId, scope: scopes[op.scope]!,
                status: "pending", generatedAt: 1_000 + revision, expiresAt: 1_020 + revision }, token });
              commits = hasSecret ? 1 : 2;
              hasSecret = true;
              break;
            }
            case "observe": {
              const actor = { id: "actor' ; --", displayName: `Invented actor ${revision}` };
              const chat = { id: "chat\0雪", kind: "channel" as const, title: "Invented conversation", bucketId: "team" };
              store.markObserved({ entryId: id, observedAt: now, actor, chat });
              if (selected?.entry.status === "pending") {
                Object.assign(selected.entry, { status: "observed", observedAt: now, observedActor: actor, observedChat: chat });
                commits = 1;
              }
              break;
            }
            case "approve":
              store.recordApproval({ entryId: id, target: op.target });
              if (selected?.entry.status === "observed") {
                selected.entry.approvedTargets = [...new Set([...(selected.entry.approvedTargets ?? []), op.target])];
                commits = 1;
              }
              break;
            case "status":
              store.markStatus({ entryId: id, status: op.status, failureReason: `Invented reason ${revision}` });
              if (selected) { selected.entry.status = op.status; selected.entry.failureReason = `Invented reason ${revision}`; commits = 1; }
              break;
            case "expire": store.expireBefore(now); expire(now); commits = 1; break;
            case "find": {
              expire(now);
              const expected = [...model].reverse().find(row => row.token === tokens[op.slot % tokens.length]
                && row.entry.platform === platform && row.entry.instanceId === instanceId && row.entry.status === "pending");
              expect(store.findMatchingPending({ token: tokens[op.slot % tokens.length]!, platform, instanceId, now })).toEqual(expected?.entry);
              commits = 1;
              break;
            }
            case "count":
              expire(now);
              expect(store.countOutstanding({ platform, instanceId, now })).toBe(model.filter(({ entry }) =>
                entry.platform === platform && entry.instanceId === instanceId && ["pending", "observed"].includes(entry.status)).length);
              commits = 1;
              break;
            case "list": {
              expire(now);
              const includeResolved = op.instance === 1;
              const filter = op.scope % 2 ? platform : undefined;
              expect(store.list({ includeResolved, platform: filter, now })).toEqual([...model].reverse()
                .filter(({ entry }) => (!filter || entry.platform === filter)
                  && (includeResolved || ["pending", "observed"].includes(entry.status))).map(row => row.entry));
              commits = 1;
              break;
            }
            case "read": expect(store.get(id)).toEqual(selected?.entry); break;
          }
        });
        expect(measured.writes.commits).toBe(commits);
        const reads = await measureSqliteWrites(() => {
          for (const reader of stores) for (const row of model) {
            expect(reader.get(row.entry.id)).toEqual(row.entry);
            const detached = reader.get(row.entry.id)!;
            if (detached.observedActor) detached.observedActor.displayName = "Changed caller copy";
            detached.approvedTargets?.push("team");
            expect(reader.get(row.entry.id)).toEqual(row.entry);
          }
        });
        expect(reads.writes.commits).toBe(0);
        if (op.reopen) {
          dbs[op.host]!.close();
          const reopen = await measureSqliteWrites(() => StateDb.open(fixture.dbPath));
          dbs[op.host] = reopen.result;
          stores[op.host] = new pairings[op.host]!(reopen.result);
          expect(reopen.writes.commits).toBe(0);
        }
      }
    } finally { dbs.forEach(db => db.close()); removeTempStateDbDir(fixture.tempDir); }
  }), { numRuns: 25 });
});

// Lists order by durable id, while summaries order timestamps independently.
// Diagnostic, pairing, binding and policy rows never count as requests.
it("models activity payloads, bounded cursors and monotone platform freshness across WAL hosts and reopen", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  await fc.assert(fc.asyncProperty(fc.array(fc.record({ host: hostChoice, platform: platformChoice,
    response: fc.boolean(), time: fc.integer({ min: 1, max: 1_000 }), reopen: fc.boolean(),
    kind: fc.constantFrom("inbound-routed", "inbound-rejected", "inbound-ignored", "outbound", "diagnostic", "pairing", "policy"),
    backend: fc.constantFrom("codex", "claude", "acp:fixture"),
    limit: fc.constantFrom(-5, 0, 1, 7, 100, 501, 10_000), cursor: fc.nat({ max: 30 }),
  }), { minLength: 1, maxLength: 30 }), async operations => {
    const fixture = createTempStateDb("shared-activity-model-");
    const dbs = activities.map(() => StateDb.open(fixture.dbPath));
    const stores = dbs.map((db, index) => new activities[index]!(db));
    const model: MessagingActivityEntry[] = [];
    const responses = new Map<string, number>();
    try {
      for (const [revision, op] of operations.entries()) {
        const platform = platforms[op.platform]!;
        const measured = await measureSqliteWrites(() => {
          if (op.response) {
            stores[op.host]!.recordPlatformResponseActivity({ platform, createdAt: op.time });
            responses.set(platform, Math.max(responses.get(platform) ?? 0, op.time));
          } else {
            const input = { platform, kind: op.kind, backend: op.backend, threadId: "shared-id' ; --", bindingId: "binding\0雪",
              conversationId: "conversation", conversationTitle: "Invented conversation", actorId: "actor",
              actorDisplayName: "Invented actor", summary: `Invented activity ${revision}`, createdAt: op.time,
              payload: { nested: { value: "' ; DROP TABLE meta; --\0雪" }, revision } };
            const written = stores[op.host]!.record(input);
            model.push({ ...input, id: written.id });
          }
        });
        expect(measured.writes.commits).toBe(1);
        const expectedSummary = new Map<string, { platform: string; lastRequestAt?: number; lastResponseAt?: number }>();
        for (const [origin, lastResponseAt] of responses) expectedSummary.set(origin, { platform: origin, lastResponseAt });
        for (const entry of model) {
          if (!["inbound-routed", "inbound-rejected", "inbound-ignored", "outbound"].includes(entry.kind)) continue;
          const row = expectedSummary.get(entry.platform) ?? { platform: entry.platform };
          if (entry.kind === "outbound") row.lastResponseAt = Math.max(row.lastResponseAt ?? 0, entry.createdAt);
          else row.lastRequestAt = Math.max(row.lastRequestAt ?? 0, entry.createdAt);
          expectedSummary.set(entry.platform, row);
        }
        const reads = await measureSqliteWrites(() => {
          for (const reader of stores) {
            expect(reader.list({ limit: op.limit, sinceId: op.cursor })).toEqual([...model].reverse()
              .filter(row => row.id > op.cursor).slice(0, Math.min(Math.max(op.limit, 1), 500)));
            expect(reader.list()).toEqual([...model].reverse().slice(0, 100));
            expect(reader.getPlatformActivitySummary().summaries.sort((a, b) => a.platform.localeCompare(b.platform)))
              .toEqual([...expectedSummary.values()].sort((a, b) => a.platform.localeCompare(b.platform)));
            const detached = reader.list()[0];
            if (detached?.payload) detached.payload.nested = "Changed caller copy";
            expect(reader.list()).toEqual([...model].reverse().slice(0, 100));
          }
        });
        expect(reads.writes.commits).toBe(0);
        if (op.reopen) {
          dbs[op.host]!.close();
          const reopen = await measureSqliteWrites(() => StateDb.open(fixture.dbPath));
          dbs[op.host] = reopen.result;
          stores[op.host] = new activities[op.host]!(reopen.result);
          expect(reopen.writes.commits).toBe(0);
        }
      }
    } finally { dbs.forEach(db => db.close()); removeTempStateDbDir(fixture.tempDir); }
  }), { numRuns: 25 });
});

it("publishes pairing and activity together or rolls both back without leaking a new secret", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  await fc.assert(fc.asyncProperty(hostChoice, fc.boolean(), async (host, commit) => {
    const fixture = createTempStateDb("shared-messaging-atomic-");
    const dbs = pairings.map(() => StateDb.open(fixture.dbPath));
    try {
      const pairs = dbs.map((db, index) => new pairings[index]!(db));
      const logs = dbs.map((db, index) => new activities[index]!(db));
      let id = "";
      const measured = await measureSqliteWrites(() => {
        const transaction = dbs[host]!.raw.transaction(() => {
          id = pairs[host]!.create({ token: tokens[0]!, platform: "slack", instanceId: "default", scope: "observed",
            generatedAt: 1_000, expiresAt: 2_000 }).id;
          logs[host]!.record({ platform: "slack", kind: "pairing", summary: "Invented atomic pairing", createdAt: 1_000 });
          expect(pairs[1 - host]!.get(id)).toBeUndefined();
          expect(logs[1 - host]!.list()).toEqual([]);
          expect(dbs[1 - host]!.getMeta("messaging_pairing_secret_v1")).toBeUndefined();
          if (!commit) throw new Error("fixture rollback");
        });
        if (commit) transaction.immediate();
        else expect(() => transaction.immediate()).toThrow("fixture rollback");
      });
      expect(measured.writes.commits).toBe(commit ? 1 : 0);
      expect(Boolean(pairs[1 - host]!.get(id))).toBe(commit);
      expect(logs[1 - host]!.list()).toHaveLength(commit ? 1 : 0);
      expect(Boolean(dbs[1 - host]!.getMeta("messaging_pairing_secret_v1"))).toBe(commit);
    } finally { dbs.forEach(db => db.close()); removeTempStateDbDir(fixture.tempDir); }
  }), { numRuns: 25 });
});

it("retains only the newest 500 activity ids per origin while preserving response freshness", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 501, max: 510 }), async count => {
    const fixture = createTempStateDb("shared-messaging-retention-");
    const db = StateDb.open(fixture.dbPath);
    try {
      const portable = new SharedActivity(db);
      const desktop = new DesktopActivity(db);
      const expected: MessagingActivityEntry[] = [];
      db.raw.transaction(() => {
        for (let i = 0; i < count; i++) for (const platform of ["telegram", "desktop"] as const) {
          expected.push(portable.record({ platform, kind: "diagnostic", summary: `Invented ${i}`, createdAt: count - i }));
        }
      })();
      portable.recordPlatformResponseActivity({ platform: "telegram", createdAt: 123 });
      db.cleanupExpired(1_000);
      const retained = expected.filter(row => expected.filter(other => other.platform === row.platform && other.id > row.id).length < 500);
      expect(desktop.list({ limit: 100_000 })).toEqual(retained.reverse().slice(0, 500));
      expect(db.raw.prepare("SELECT COUNT(*) AS count FROM messaging_activity_log").get()).toEqual({ count: 1_000 });
      expect(desktop.getPlatformActivitySummary()).toEqual({ summaries: [{ platform: "telegram", lastResponseAt: 123 }] });
    } finally { db.close(); removeTempStateDbDir(fixture.tempDir); }
  }), { numRuns: 3 });
});

it("reads malformed legacy payloads without repairing or losing their envelope", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  await fc.assert(fc.asyncProperty(hostChoice, fc.constantFrom("{", "not-json", "undefined"), async (host, payload) => {
    const fixture = createTempStateDb("shared-messaging-malformed-");
    const db = StateDb.open(fixture.dbPath);
    try {
      const pair = new pairings[host]!(db);
      const log = new activities[host]!(db);
      const entry = pair.create({ token: "fixture-legacy", platform: "slack", instanceId: "default", scope: "observed",
        generatedAt: 1, expiresAt: 10_000 });
      const activity = log.record({ platform: "desktop", kind: "policy", summary: "Invented legacy policy", createdAt: 1 });
      db.raw.prepare("UPDATE messaging_pairing_tokens SET payload = ? WHERE entry_id = ?").run(payload, entry.id);
      db.raw.prepare("UPDATE messaging_activity_log SET payload = ? WHERE id = ?").run(payload, activity.id);
      const reads = await measureSqliteWrites(() => {
        expect(pair.get(entry.id)).toEqual(entry);
        expect(log.list()).toEqual([activity]);
        expect(log.getPlatformActivitySummary()).toEqual({ summaries: [] });
      });
      expect(reads.writes.commits).toBe(0);
      expect(db.raw.prepare("SELECT payload FROM messaging_pairing_tokens WHERE entry_id = ?").pluck().get(entry.id)).toBe(payload);
      expect(db.raw.prepare("SELECT payload FROM messaging_activity_log WHERE id = ?").pluck().get(activity.id)).toBe(payload);
    } finally { db.close(); removeTempStateDbDir(fixture.tempDir); }
  }), { numRuns: 25 });
});
