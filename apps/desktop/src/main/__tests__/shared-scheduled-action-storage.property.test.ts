import fc from "fast-check";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { ScheduledThreadAction } from "@pwragent/shared";
import { ScheduledThreadActionStore as SharedStore } from "@pwragent/sqlite-storage/scheduled-thread-action-store";
import {
  FileScheduledThreadActionPayloadStore as SharedFiles,
  MemoryScheduledThreadActionPayloadStore as SharedMemory,
} from "@pwragent/sqlite-storage/scheduled-thread-action-payload-store";
import { StateDb } from "@pwragent/sqlite-storage/state-db";
import { ScheduledThreadActionStore as DesktopStore } from "../storage/scheduled-thread-action-store";
import {
  FileScheduledThreadActionPayloadStore as DesktopFiles,
  MemoryScheduledThreadActionPayloadStore as DesktopMemory,
} from "../storage/scheduled-thread-action-payload-store";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { createTempStateDb, openInMemoryStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

afterEach(() => vi.unstubAllEnvs());
const bindings = [SharedStore, DesktopStore];
const backends = ["codex", "acp:kimi"] as const;
const expiredDispatchMessage = "The scheduler lease expired while this action was being dispatched. Check the thread before scheduling it again.";
const byId = (rows: ScheduledThreadAction[]) => rows.sort((a, b) => a.id.localeCompare(b.id));
const pending = (action: ScheduledThreadAction) => action.status === "held" || action.status === "scheduled";
const inFlight = (action: ScheduledThreadAction) => action.status === "dispatching" || action.status === "queued";

it("binds every desktop scheduled-action and payload constructor to the shared implementation", () => {
  const entries = [[DesktopStore, SharedStore], [DesktopFiles, SharedFiles], [DesktopMemory, SharedMemory]] as const;
  fc.assert(fc.property(fc.integer({ min: 0, max: entries.length - 1 }), index => {
    expect(entries[index]![0]).toBe(entries[index]![1]);
  }));
});

// A single claimant owns callbacks. Recovery cannot replay an ambiguous
// dispatch; queued work can be rescheduled, while explicit-release work stays held.
it("matches an independent multi-owner claim model across portable and desktop WAL connections and reopens", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  await fc.assert(fc.asyncProperty(fc.array(fc.record({
    host: fc.integer({ min: 0, max: 1 }), slot: fc.integer({ min: 0, max: 3 }),
    kind: fc.constantFrom("claim", "queue", "start", "hold", "fail", "cancel", "update", "renew", "recover"),
    owner: fc.constantFrom("first", "second"), advance: fc.integer({ min: 1, max: 40_000 }),
    protect: fc.boolean(), reopen: fc.boolean(),
  }), { minLength: 1, maxLength: 35 }), async commands => {
    const fixture = createTempStateDb("shared-scheduled-model-");
    const dbs = bindings.map(() => StateDb.open(fixture.dbPath));
    const stores = dbs.map((db, i) => new bindings[i]!(db));
    const model = new Map<number, { action: ScheduledThreadAction; owner?: string; expires?: number }>();
    let now = 10_000;
    try {
      for (let slot = 0; slot < 4; slot++) {
        const manualReleaseRequired = slot >= 2;
        const action: ScheduledThreadAction = { id: `action-${slot}`, backend: backends[slot % 2]!,
          threadId: "same-thread", kind: "turn", origin: "desktop", status: manualReleaseRequired ? "held" : "scheduled",
          manualReleaseRequired, scheduledFor: 1_000 + slot, displayText: `Invented payload ${slot}`,
          turn: { input: [{ type: "text", text: `Invented payload ${slot}` }] }, createdAt: 1, updatedAt: 1 };
        stores[0]!.create({ ...action, now: 1 });
        model.set(slot, { action });
      }
      for (const command of commands) {
        now += command.advance;
        const store = stores[command.host]!;
        const entry = model.get(command.slot)!;
        const action = entry.action;
        const owned = entry.owner === command.owner;
        let expected: unknown;
        let commits = 0;
        let rows = 0;
        const change = (patch: Partial<ScheduledThreadAction>, clear = false) => {
          entry.action = { ...action, ...patch, updatedAt: now };
          if (clear) { entry.owner = undefined; entry.expires = undefined; }
          rows = 1;
          return entry.action;
        };
        if (command.kind === "claim" && pending(action)) {
          commits = 1; entry.owner = command.owner; entry.expires = now + 30_000;
          expected = change({ status: "dispatching" });
        } else if (command.kind === "cancel" && pending(action)) {
          commits = 1; expected = change({ status: "cancelled" });
        } else if (command.kind === "update" && action.status === "scheduled") {
          commits = 1; expected = change({ displayText: `Edited at ${now}` });
        } else if (["queue", "start", "hold", "fail"].includes(command.kind)
          && (command.kind === "queue" ? action.status === "dispatching" : inFlight(action))) {
          commits = 1;
          if (owned) {
            if (command.kind === "queue") expected = change({ status: "queued", queueEntryId: `queue-${command.slot}` });
            else if (command.kind === "start") expected = change({ status: "started", turnId: "same-turn", errorMessage: undefined }, true);
            else if (command.kind === "hold") expected = change({ status: "held", queueEntryId: `queue-${command.slot}`,
              errorMessage: "Locked", manualReleaseRequired: true }, true);
            else expected = change({ status: "failed", errorMessage: "Refused" }, true);
          }
        } else if (command.kind === "renew") {
          commits = 1;
          for (const candidate of model.values()) if (inFlight(candidate.action) && candidate.owner === command.owner) {
            candidate.action = { ...candidate.action, updatedAt: now }; candidate.expires = now + 30_000; rows++;
          }
        } else if (command.kind === "recover") {
          const recovered: ScheduledThreadAction[] = [];
          for (const candidate of model.values()) {
            const current = candidate.action;
            if (!inFlight(current) || candidate.expires! > now || (command.protect && candidate.owner === command.owner)) continue;
            candidate.action = { ...current, updatedAt: now, ...(current.manualReleaseRequired
              ? { status: "held", queueEntryId: undefined }
              : current.status === "queued" ? { status: "scheduled", queueEntryId: undefined }
                : { status: "failed", errorMessage: expiredDispatchMessage }) };
            candidate.owner = undefined; candidate.expires = undefined;
            recovered.push(candidate.action); rows++;
          }
          commits = recovered.length ? 1 : 0; expected = recovered;
        }
        const written = await measureSqliteWrites(() => {
          const id = action.id;
          switch (command.kind) {
            case "claim": return store.claim(id, { now, ownerId: command.owner, leaseExpiresAt: now + 30_000 });
            case "queue": return store.markQueued(id, `queue-${command.slot}`, now, command.owner);
            case "start": return store.markStarted(id, "same-turn", now, command.owner);
            case "hold": return store.markHeld(id, `queue-${command.slot}`, "Locked", now, command.owner);
            case "fail": return store.markFailed(id, "Refused", now, command.owner);
            case "cancel": return store.cancel(id, now);
            case "update": return store.update(id, { displayText: `Edited at ${now}`, now });
            case "renew": return store.renewClaims(command.owner, now, now + 30_000);
            case "recover": return store.recoverExpiredClaims(now, new Set(command.protect ? [command.owner] : []));
          }
        });
        if (command.kind === "recover") expect(byId(written.result as ScheduledThreadAction[])).toEqual(byId(expected as ScheduledThreadAction[]));
        else expect(written.result, JSON.stringify(command)).toEqual(expected);
        expect([written.writes.commits, written.writes.rowsChanged]).toEqual([commits, rows]);
        if (command.reopen) {
          dbs[command.host]!.close();
          const reopened = await measureSqliteWrites(() => {
            const db = StateDb.open(fixture.dbPath); stores[command.host] = new bindings[command.host]!(db); return db;
          });
          expect(reopened.writes.commits).toBe(0); dbs[command.host] = reopened.result;
        }
        const reads = await measureSqliteWrites(() => {
          const expectedActions = [...model.values()].map(e => e.action);
          for (const reader of stores) {
            expect(byId(reader.list({ includeTerminal: true }))).toEqual(byId([...expectedActions]));
            for (const backend of backends) expect(byId(reader.list({ backend, threadId: "same-thread", includeTerminal: true })))
              .toEqual(byId(expectedActions.filter(a => a.backend === backend)));
            expect(reader.nextScheduledAt()).toBe(expectedActions.filter(a => a.status === "scheduled")
              .sort((a, b) => a.scheduledFor - b.scheduledFor)[0]?.scheduledFor);
            const owners = [...new Set([...model.values()].filter(e => inFlight(e.action) && e.expires! <= now).map(e => e.owner))].sort();
            expect(reader.expiredClaimOwnerIds(now).sort()).toEqual(owners);
            for (const candidate of expectedActions) expect(reader.ownsPendingWake(candidate, candidate.id)).toBe(pending(candidate));
          }
        });
        expect([reads.writes.commits, reads.writes.statements, reads.writes.rowsChanged]).toEqual([0, 0, 0]);
        expect(fs.readdirSync(path.join(fixture.tempDir, "scheduled-actions"))).toHaveLength(model.size);
      }
    } finally { for (const db of dbs) db.close(); removeTempStateDbDir(fixture.tempDir); }
  }), { numRuns: 25 });
});

it("preserves file payloads through rejected writes, cleans replaced and terminal payloads, and rolls claim transactions back", async () => {
  await fc.assert(fc.asyncProperty(fc.string({ maxLength: 120 }), fc.constantFrom(0, 1), async (text, host) => {
    const fixture = createTempStateDb("shared-scheduled-files-");
    const db = StateDb.open(fixture.dbPath);
    const store = new bindings[host]!(db);
    const files = () => fs.readdirSync(path.join(fixture.tempDir, "scheduled-actions"));
    const input = { id: "../invented-action", backend: "codex" as const, threadId: "thread", kind: "turn" as const,
      origin: "agent" as const, scheduledFor: 10, displayText: text, turn: { input: [{ type: "text" as const, text }] }, now: 1 };
    try {
      const original = store.create(input);
      const firstFiles = files();
      expect(firstFiles).toHaveLength(1);
      expect(firstFiles[0]).toMatch(/^[a-f0-9]{64}-[a-f0-9-]+\.json$/);
      const payloads = new SharedFiles(path.join(fixture.tempDir, "scheduled-actions"));
      expect(() => payloads.read(firstFiles[0]!, 0)).toThrow("budget");
      for (const ref of ["", "../outside.json", "/outside.json", "invalid.txt"]) expect(() => payloads.read(ref)).toThrow("Invalid");
      expect(() => store.create(input)).toThrow();
      expect(files()).toEqual(firstFiles);
      db.raw.exec("CREATE TRIGGER refuse_payload_update BEFORE UPDATE ON scheduled_thread_actions BEGIN SELECT RAISE(ABORT, 'fixture refusal'); END");
      expect(() => store.update(input.id, { displayText: "Refused edit", now: 2 })).toThrow("fixture refusal");
      expect(files()).toEqual(firstFiles); expect(store.get(input.id)).toEqual(original);
      db.raw.exec("DROP TRIGGER refuse_payload_update");
      expect(() => db.raw.transaction(() => { store.claimNextDue({ now: 10, ownerId: "owner", leaseExpiresAt: 40 }); throw new Error("rollback"); })()).toThrow("rollback");
      expect(store.get(input.id)).toEqual(original); expect(files()).toEqual(firstFiles);
      store.update(input.id, { displayText: "Accepted edit", now: 3 });
      expect(files()).toHaveLength(1); expect(files()).not.toEqual(firstFiles);
      expect(store.get(input.id)).toMatchObject({ displayText: "Accepted edit", turn: input.turn });
      store.cancel(input.id, 4); store.cleanupTerminalBefore(4); expect(store.get(input.id)).toBeDefined();
      store.cleanupTerminalBefore(5); expect(store.get(input.id)).toBeUndefined(); expect(files()).toEqual([]);
    } finally { db.close(); removeTempStateDbDir(fixture.tempDir); }
  }), { numRuns: 25 });
});

it("migrates generated legacy inline payloads exactly once and reopens them through either host", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  await fc.assert(fc.asyncProperty(fc.array(fc.string({ maxLength: 150 }), { minLength: 1, maxLength: 5 }),
    fc.constantFrom(0, 1), async (texts, firstHost) => {
      const fixture = createTempStateDb("shared-scheduled-legacy-");
      let db = StateDb.open(fixture.dbPath);
      try {
        db.raw.exec(`DROP TABLE scheduled_thread_actions;
          CREATE TABLE scheduled_thread_actions (
            action_id TEXT PRIMARY KEY, backend TEXT NOT NULL, thread_id TEXT NOT NULL,
            kind TEXT NOT NULL, origin TEXT NOT NULL, status TEXT NOT NULL,
            scheduled_for INTEGER NOT NULL, queue_entry_id TEXT,
            created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, payload TEXT NOT NULL
          );
          PRAGMA user_version = 39;`);
        for (const [i, displayText] of texts.entries()) db.raw.prepare(`INSERT INTO scheduled_thread_actions
          (action_id, backend, thread_id, kind, origin, status, scheduled_for, created_at, updated_at, payload)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(`legacy-${i}`, backends[i % 2], "same-thread", "turn", "desktop", "scheduled", 10 + i, 1, 1,
            JSON.stringify({ displayText, turn: { input: [{ type: "text", text: displayText }] }, turnId: `turn-${i}`, errorMessage: `legacy-${i}` }));
        db.close(); db = StateDb.open(fixture.dbPath);
        db.raw.exec("CREATE TRIGGER refuse_legacy_update BEFORE UPDATE ON scheduled_thread_actions BEGIN SELECT RAISE(ABORT, 'migration refusal'); END");
        expect(() => new bindings[firstHost]!(db)).toThrow("migration refusal");
        expect(fs.readdirSync(path.join(fixture.tempDir, "scheduled-actions"))).toEqual([]);
        expect(db.raw.prepare("SELECT count(*) AS n FROM scheduled_thread_actions WHERE payload_ref IS NULL AND payload <> '{}'").get()).toEqual({ n: texts.length });
        db.raw.exec("DROP TRIGGER refuse_legacy_update");
        const migration = await measureSqliteWrites(() => new bindings[firstHost]!(db));
        expect(migration.writes.commits).toBe(texts.length);
        const before = fs.readdirSync(path.join(fixture.tempDir, "scheduled-actions"));
        expect(db.raw.prepare("SELECT payload FROM scheduled_thread_actions").all()).toEqual(texts.map(() => ({ payload: "{}" })));
        db.close(); db = StateDb.open(fixture.dbPath);
        const reopened = await measureSqliteWrites(() => new bindings[1 - firstHost]!(db));
        expect(reopened.writes.commits).toBe(0);
        for (const [i, displayText] of texts.entries()) expect(reopened.result.get(`legacy-${i}`)).toMatchObject({
          displayText, turnId: `turn-${i}`, errorMessage: `legacy-${i}`, turn: { input: [{ type: "text", text: displayText }] },
        });
        expect(fs.readdirSync(path.join(fixture.tempDir, "scheduled-actions"))).toEqual(before);
      } finally { db.close(); removeTempStateDbDir(fixture.tempDir); }
    }), { numRuns: 25 });
});

it("keeps projection pages bounded and expires WAL cursors only when scheduled facts change", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  await fc.assert(fc.asyncProperty(fc.integer({ min: 101, max: 110 }), fc.string({ minLength: 1, maxLength: 80 }), async (count, text) => {
    const fixture = createTempStateDb("shared-scheduled-pages-");
    const dbs = bindings.map(() => StateDb.open(fixture.dbPath));
    const stores = dbs.map((db, i) => new bindings[i]!(db));
    const expected = Array.from({ length: count }, (_, i) => `page-${String(i).padStart(3, "0")}`);
    try {
      dbs[0]!.raw.transaction(() => {
        for (const id of expected) stores[0]!.create({ id, backend: "codex", threadId: "thread", kind: "turn", origin: "desktop",
          scheduledFor: 10, displayText: text, turn: { input: [{ type: "text", text }] }, now: 1 });
      })();
      const read = await measureSqliteWrites(() => {
        const request = { backend: "codex" as const, threadId: "thread", includeTerminal: true };
        const first = stores[0]!.listProjectionPage(request);
        expect(first.actions).toHaveLength(100); expect(first.complete).toBe(false);
        for (const store of stores) {
          expect(store.listProjectionPage(request)).toEqual(first);
          const second = store.listProjectionPage({ ...request, cursor: first.nextCursor });
          expect(second.complete).toBe(true);
          expect([...first.actions, ...second.actions].map(a => a.id)).toEqual(expected);
          expect(Buffer.byteLength(JSON.stringify(first.actions))).toBeLessThan(248 * 1024);
        }
        return { first, request };
      });
      expect([read.writes.commits, read.writes.statements, read.writes.rowsChanged]).toEqual([0, 0, 0]);
      stores[0]!.observeExternalProjectionChange();
      dbs[1]!.setMeta("unrelated", text);
      expect(stores[0]!.observeExternalProjectionChange()).toBe(false);
      stores[1]!.cancel(expected[0]!, 2);
      expect(stores[0]!.observeExternalProjectionChange()).toBe(true);
      expect(() => stores[0]!.listProjectionPage({ ...read.result.request, cursor: read.result.first.nextCursor })).toThrow("navigation_cursor_expired");
    } finally { for (const db of dbs) db.close(); removeTempStateDbDir(fixture.tempDir); }
  }), { numRuns: 8 });
});

it("keeps in-memory payload fallback detached and bounds memory payload reads", () => {
  fc.assert(fc.property(fc.string({ maxLength: 200 }), text => {
    const db = openInMemoryStateDb();
    try {
      const store = new SharedStore(db);
      store.create({ id: "memory", backend: "codex", threadId: "thread", kind: "turn", origin: "desktop", scheduledFor: 10,
        displayText: text, turn: { input: [{ type: "text", text }] }, now: 1 });
      const detached = store.get("memory")!; detached.displayText = "Changed by reader";
      expect(store.get("memory")?.displayText).toBe(text);
      const payload = new DesktopMemory(); const ref = payload.write("id", { displayText: text });
      expect(() => payload.read(ref, 0)).toThrow("budget"); payload.delete(ref);
      expect(() => payload.read(ref)).toThrow("not found");
    } finally { db.close(); }
  }));
});
