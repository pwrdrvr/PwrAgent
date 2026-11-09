import fc from "fast-check";
import { afterEach, expect, it, vi } from "vitest";
import type { AcpAvailableCommandsRecord, AcpSessionMetadata } from "@pwragent/owner-core/acp-storage";
import type { AcpBackendId, AppServerAvailableCommandSummary } from "@pwragent/shared";
import { AcpSessionStore as SharedSessions } from "@pwragent/sqlite-storage/acp-session-store";
import { AcpAvailableCommandsStore as SharedCommands } from "@pwragent/sqlite-storage/acp-available-commands-store";
import { StateDb } from "@pwragent/sqlite-storage/state-db";
import { AcpSessionStore as DesktopSessions } from "../storage/acp-session-store";
import { AcpAvailableCommandsStore as DesktopCommands } from "../storage/acp-available-commands-store";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

const sessionBindings = [SharedSessions, DesktopSessions];
const commandBindings = [SharedCommands, DesktopCommands];
const backends: AcpBackendId[] = ["acp:alpha", "acp:beta"];
const ids = ["a", "b", "session' ; -- 雪"];
const repositories = ["/fixture/one", "/fixture/two", "/fixture/quote' ; -- 雪"];
const identity = { host: fc.integer({ min: 0, max: 1 }), backend: fc.integer({ min: 0, max: 1 }),
  slot: fc.integer({ min: 0, max: 2 }), reopen: fc.boolean() };
const keyOf = (backend: AcpBackendId, id: string) => JSON.stringify([backend, id]);
afterEach(() => vi.unstubAllEnvs());

it("binds generated desktop session and command choices to the same functioning portable implementations", () => {
  fc.assert(fc.property(fc.integer({ min: 0, max: 1 }), host => {
    expect(sessionBindings[host]).toBe(SharedSessions);
    expect(commandBindings[host]).toBe(SharedCommands);
  }));
});

// The model owns only metadata. Legacy provider history contributes a scalar
// marker, never transcript text; pages advance over raw identities before filtering.
it("matches independent session/privacy and keyset-page models across WAL hosts, rollback and reopen", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  await fc.assert(fc.asyncProperty(fc.array(fc.record({ ...identity,
    kind: fc.constantFrom("put", "legacy", "remove", "rollback", "read"),
    hidden: fc.boolean(), archived: fc.boolean(), marker: fc.option(fc.boolean(), { nil: undefined }),
    history: fc.constantFrom("pwragent_user_prompt", "user_message_chunk", "agent_message_chunk", "available_commands_update"),
    alias: fc.constantFrom("kind", "type", "sessionUpdate", "session_update"),
    pageSize: fc.integer({ min: 1, max: 3 }),
  }), { minLength: 1, maxLength: 30 }), async operations => {
    const fixture = createTempStateDb("shared-acp-sessions-");
    const dbs = sessionBindings.map(() => StateDb.open(fixture.dbPath));
    const stores = dbs.map((db, index) => new sessionBindings[index]!(db));
    const model = new Map<string, AcpSessionMetadata>();
    try {
      for (const [revision, op] of operations.entries()) {
        const backendId = backends[op.backend]!;
        const sessionId = ids[op.slot]!;
        const key = keyOf(backendId, sessionId);
        const expected: AcpSessionMetadata = { backendId, sessionId, agentSessionId: `provider-${sessionId}`,
          title: `Invented title ${revision}`, titleSource: "explicit", cwd: "/fixture/repo", createdAt: 1,
          updatedAt: revision + 100, status: "idle", executionMode: "full-access", hidden: op.hidden,
          availableCommands: [{ name: "fixture", backend: backendId, scope: "session", source: "provider" }],
          ...(op.archived ? { archivedAt: 10 } : {}),
          ...((op.marker ?? (op.history !== "available_commands_update" ? true : undefined)) === undefined
            ? {} : { hasConversationHistory: op.marker ?? true }),
        };
        const input = { ...expected, hasConversationHistory: op.marker,
          transcriptUpdates: [{ receivedAt: 1, update: { [op.alias]: op.history, content: "PRIVATE invented history" } }] };
        const measured = await measureSqliteWrites(() => {
          if (op.kind === "legacy") dbs[op.host]!.raw.prepare(`INSERT OR REPLACE INTO acp_sessions
            (backend_id, session_id, created_at, updated_at, payload) VALUES (?, ?, ?, ?, ?)`)
            .run(backendId, sessionId, input.createdAt, input.updatedAt, JSON.stringify(input));
          else if (op.kind === "remove") stores[op.host]!.deleteSession(backendId, sessionId);
          else if (op.kind === "put") stores[op.host]!.upsertSession(input);
          else if (op.kind === "rollback") expect(() => dbs[op.host]!.raw.transaction(() => {
            stores[op.host]!.upsertSession(input); throw new Error("Invented refusal");
          })()).toThrow("Invented refusal");
        });
        expect(measured.writes.commits).toBe(["put", "legacy", "remove"].includes(op.kind) ? 1 : 0);
        if (op.kind === "put" || op.kind === "legacy") model.set(key, expected);
        if (op.kind === "remove") model.delete(key);
        if (op.kind === "put") {
          const raw = dbs[op.host]!.raw.prepare("SELECT payload FROM acp_sessions WHERE backend_id = ? AND session_id = ?")
            .pluck().get(backendId, sessionId) as string;
          expect(JSON.parse(raw)).toEqual(expected);
          expect(raw).not.toContain("PRIVATE");
        }
        if (op.reopen) {
          dbs[op.host]!.close();
          const opened = await measureSqliteWrites(() => StateDb.open(fixture.dbPath));
          expect(opened.writes.commits).toBe(0);
          dbs[op.host] = opened.result;
          stores[op.host] = new sessionBindings[op.host]!(opened.result);
        }
        const reads = await measureSqliteWrites(() => {
          for (const store of stores) for (const backend of backends) {
            // Stored owners remain discoverable, including hidden and archived sessions.
            expect(store.listBackendIds().sort()).toEqual([...new Set([...model.values()].map(row => row.backendId))].sort());
            const rows = [...model.values()].filter(row => row.backendId === backend);
            for (const id of ids) expect(store.getSession(backend, id)).toEqual(model.get(keyOf(backend, id)));
            for (const archived of [false, true]) {
              for (const includeHidden of [false, true]) expect(store.listSessions(backend, { archived, includeHidden }))
                .toEqual(rows.filter(row => Boolean(row.archivedAt) === archived && (includeHidden || !row.hidden))
                  .sort((a, b) => b.updatedAt - a.updatedAt));
              let after: string | undefined;
              for (let page = 0; ; page += 1) {
                expect(page).toBeLessThan(5);
                const rawPage = rows.filter(row => row.sessionId > (after ?? ""))
                  .sort((a, b) => a.sessionId < b.sessionId ? -1 : 1).slice(0, op.pageSize);
                const nextCursor = rawPage.length === op.pageSize ? rawPage.at(-1)?.sessionId : undefined;
                expect(store.listArchiveCleanupSessionsPage(backend, { archived, after, limit: op.pageSize }))
                  .toEqual({ sessions: rawPage.filter(row => Boolean(row.archivedAt) === archived).map(row => ({
                    backendId: backend, sessionId: row.sessionId, title: "", cwd: row.cwd,
                    createdAt: row.createdAt, updatedAt: row.updatedAt, executionMode: "default",
                    status: row.status, archivedAt: row.archivedAt ?? null,
                  })), nextCursor });
                if (!nextCursor) break;
                after = nextCursor;
              }
            }
            const detached = store.listSessions(backend, { includeHidden: true });
            for (const row of detached) { row.title = "Changed caller copy"; row.availableCommands?.push({ name: "caller" } as AppServerAvailableCommandSummary); }
          }
        });
        expect(reads.writes.commits).toBe(0);
      }
    } finally { for (const db of dbs) db.close(); removeTempStateDbDir(fixture.tempDir); }
  }), { numRuns: 25 });
});

// Last-observed commands are qualified by agent and repository. A shared outer
// transaction publishes both store mutations together or publishes neither.
it("models command filtering, replacement and atomic session/command visibility across WAL hosts and reopen", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  await fc.assert(fc.asyncProperty(fc.array(fc.record({ ...identity,
    kind: fc.constantFrom("put", "legacy", "rollback", "atomic", "read"), empty: fc.boolean(),
  }), { minLength: 1, maxLength: 25 }), async operations => {
    const fixture = createTempStateDb("shared-acp-commands-");
    const dbs = commandBindings.map(() => StateDb.open(fixture.dbPath));
    const stores = dbs.map((db, index) => new commandBindings[index]!(db));
    const sessions = dbs.map((db, index) => new sessionBindings[index]!(db));
    const model = new Map<string, AcpAvailableCommandsRecord>();
    const sessionModel = new Map<string, AcpSessionMetadata>();
    try {
      for (const [revision, op] of operations.entries()) {
        const backendId = backends[op.backend]!;
        const repositoryPath = repositories[op.slot]!;
        const sessionId = ids[op.slot]!;
        const commands: AppServerAvailableCommandSummary[] = op.empty ? [] : [
          { name: `fixture-${revision}`, description: "Invented command", backend: backendId, scope: "session", source: "provider" },
        ];
        const record = { backendId, repositoryPath, commands, observedAt: revision + 100 };
        const metadata: AcpSessionMetadata = { backendId, sessionId, title: `Atomic ${revision}`,
          createdAt: 1, updatedAt: revision + 100, executionMode: "default", status: "idle" };
        const writeBoth = () => {
          stores[op.host]!.upsert(record);
          sessions[op.host]!.upsertSession(metadata);
          const observer = 1 - op.host;
          expect(stores[observer]!.get(backendId, repositoryPath)).toEqual(model.get(keyOf(backendId, repositoryPath)));
          expect(sessions[observer]!.getSession(backendId, sessionId)).toEqual(sessionModel.get(keyOf(backendId, sessionId)));
        };
        const measured = await measureSqliteWrites(() => {
          if (op.kind === "put") stores[op.host]!.upsert(record);
          else if (op.kind === "legacy") dbs[op.host]!.raw.prepare(`INSERT OR REPLACE INTO acp_available_commands
            (backend_id, repository_path, observed_at, payload) VALUES (?, ?, ?, ?)`)
            .run(backendId, repositoryPath, record.observedAt, JSON.stringify([null, false, 1, "bad", {}, { name: 2 }, ...commands]));
          else if (op.kind === "atomic") dbs[op.host]!.raw.transaction(writeBoth)();
          else if (op.kind === "rollback") expect(() => dbs[op.host]!.raw.transaction(() => {
            writeBoth(); throw new Error("Invented refusal");
          })()).toThrow("Invented refusal");
        });
        expect(measured.writes.commits).toBe(["put", "legacy", "atomic"].includes(op.kind) ? 1 : 0);
        if (["put", "legacy", "atomic"].includes(op.kind)) model.set(keyOf(backendId, repositoryPath), record);
        if (op.kind === "atomic") sessionModel.set(keyOf(backendId, sessionId), metadata);
        if (op.reopen) {
          dbs[op.host]!.close();
          const opened = await measureSqliteWrites(() => StateDb.open(fixture.dbPath));
          expect(opened.writes.commits).toBe(0);
          dbs[op.host] = opened.result;
          stores[op.host] = new commandBindings[op.host]!(opened.result);
          sessions[op.host] = new sessionBindings[op.host]!(opened.result);
        }
        const reads = await measureSqliteWrites(() => {
          for (const [host, store] of stores.entries()) for (const backend of backends) for (const slot of [0, 1, 2]) {
            expect(store.get(backend, repositories[slot]!)).toEqual(model.get(keyOf(backend, repositories[slot]!)));
            expect(sessions[host]!.getSession(backend, ids[slot]!)).toEqual(sessionModel.get(keyOf(backend, ids[slot]!)));
            store.get(backend, repositories[slot]!)?.commands.splice(0);
          }
        });
        expect(reads.writes.commits).toBe(0);
      }
    } finally { for (const db of dbs) db.close(); removeTempStateDbDir(fixture.tempDir); }
  }), { numRuns: 25 });
});

it("rejects generated malformed session and command payloads without repairing or writing on reads", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  await fc.assert(fc.asyncProperty(fc.constantFrom("not json", "null", "[]", "{}", '{"backendId":"codex"}'), async payload => {
    const fixture = createTempStateDb("shared-acp-malformed-");
    const db = StateDb.open(fixture.dbPath);
    try {
      db.raw.prepare("INSERT INTO acp_sessions (backend_id, session_id, created_at, updated_at, payload) VALUES (?, ?, ?, ?, ?)")
        .run("acp:alpha", "bad", 1, 1, payload);
      db.raw.prepare("INSERT INTO acp_available_commands (backend_id, repository_path, observed_at, payload) VALUES (?, ?, ?, ?)")
        .run("acp:alpha", "/fixture", 1, payload);
      const reads = await measureSqliteWrites(() => {
        for (const [index, binding] of sessionBindings.entries()) {
          expect(new binding(db).getSession("acp:alpha", "bad")).toBeUndefined();
          expect(new binding(db).listSessions("acp:alpha")).toEqual([]);
          expect(new commandBindings[index]!(db).get("acp:alpha", "/fixture"))
            .toEqual(payload === "[]" ? { backendId: "acp:alpha", repositoryPath: "/fixture", observedAt: 1, commands: [] } : undefined);
        }
      });
      expect(reads.writes.commits).toBe(0);
    } finally { db.close(); removeTempStateDbDir(fixture.tempDir); }
  }), { numRuns: 25 });
});
