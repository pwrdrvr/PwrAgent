import fc from "fast-check";
import { afterEach, expect, it, vi } from "vitest";
import type {
  AcpAgentStorage,
  AcpAvailableCommandsRecord,
  AcpAvailableCommandsStorage,
  AcpSessionMetadata,
  AcpSessionStorage,
} from "@pwragent/owner-core/acp-storage";
import type { AcpBackendId } from "@pwragent/shared";
import type { AcpInstalledAgentRecord, AcpRegistrySnapshot } from "../acp/acp-registry-types";
import { AcpAgentStore } from "../storage/acp-agent-store";
import { AcpAvailableCommandsStore } from "../storage/acp-available-commands-store";
import { AcpSessionStore } from "../storage/acp-session-store";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { openInMemoryStateDb } from "./sqlite-test-utils";

afterEach(() => vi.unstubAllEnvs());

const backends: AcpBackendId[] = ["acp:alpha", "acp:beta"];
const identity = { backend: fc.integer({ min: 0, max: 1 }), slot: fc.integer({ min: 0, max: 2 }) };

it("keeps the latest registry and installed records across independent agent identities", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  await fc.assert(fc.asyncProperty(fc.array(fc.record({
    backend: fc.integer({ min: 0, max: 1 }), failed: fc.boolean(), version: fc.nat({ max: 100 }),
  }), { minLength: 1, maxLength: 30 }), async (operations) => {
    const db = openInMemoryStateDb();
    const storage: AcpAgentStorage<AcpRegistrySnapshot, AcpInstalledAgentRecord> = new AcpAgentStore(db);
    const model = new Map<AcpBackendId, AcpInstalledAgentRecord>();
    try {
      expect(storage.readRegistrySnapshot()).toBeUndefined();
      for (const [index, op] of operations.entries()) {
        const backendId = backends[op.backend]!;
        const record: AcpInstalledAgentRecord = {
          backendId, registryId: op.backend === 0 ? "Zulu" : "alpha", name: backendId,
          distributionKind: "npx", distributionSource: "fixture-package", allowlistRuleId: "fixture-rule",
          installStatus: op.failed ? "install-failed" : "installed", authStatus: "not-required",
          verificationStatus: "not-applicable", installedAt: 1_000, updatedAt: index,
          version: String(op.version), ...(op.failed ? { lastError: "Fixture failure" } : {}),
        };
        const snapshot: AcpRegistrySnapshot = { fetchedAt: index, agents: [], raw: { revision: op.version } };
        storage.upsertInstalledAgent(record);
        storage.saveRegistrySnapshot(snapshot);
        model.set(backendId, record);
        const reads = await measureSqliteWrites(() => {
          expect(storage.readRegistrySnapshot()).toEqual(snapshot);
          for (const backend of backends) expect(storage.getInstalledAgent(backend)).toEqual(model.get(backend));
          expect(storage.listInstalledAgents()).toEqual([...model.values()]
            .sort((a, b) => a.registryId.toLowerCase().localeCompare(b.registryId.toLowerCase())));
        });
        expect(reads.writes.commits).toBe(0);
      }
    } finally { db.close(); }
  }), { numRuns: 50 });
});

it("keeps session identity, visibility and history privacy stable across replacements, deletion and cleanup pages", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const operation = fc.record({
    ...identity, remove: fc.boolean(), hidden: fc.boolean(), archived: fc.boolean(),
    history: fc.boolean(), pageSize: fc.integer({ min: 1, max: 3 }),
  });
  await fc.assert(fc.asyncProperty(fc.array(operation, { minLength: 1, maxLength: 30 }), async (operations) => {
    const db = openInMemoryStateDb();
    const model = new Map<string, AcpSessionMetadata>();
    try {
      for (const [index, op] of operations.entries()) {
        const storage: AcpSessionStorage = new AcpSessionStore(db);
        const backendId = backends[op.backend]!;
        const sessionId = `session-${op.slot}`;
        const key = `${backendId}/${sessionId}`;
        if (op.remove) {
          storage.deleteSession(backendId, sessionId);
          model.delete(key);
        } else {
          const metadata: AcpSessionMetadata = {
            backendId, sessionId, title: `Revision ${index}`, cwd: "/fixture/repository",
            createdAt: 1_000, updatedAt: 2_000 + index, executionMode: "default", status: "idle",
            hidden: op.hidden, ...(op.archived ? { archivedAt: 3_000 } : {}),
            ...(op.history ? { hasConversationHistory: true } : {}),
          };
          // Legacy conversation payloads must reduce to the history marker at the storage boundary.
          const input = { ...metadata, hasConversationHistory: undefined, transcriptUpdates: op.history
            ? [{ receivedAt: 1_000, update: { kind: "agent_message_chunk", content: "Private fixture text" } }]
            : [{ receivedAt: 1_000, update: { kind: "available_commands_update" } }] };
          storage.upsertSession(input);
          model.set(key, metadata);
        }
        const reads = await measureSqliteWrites(() => {
          for (const backend of backends) {
            const records = [...model.values()].filter(row => row.backendId === backend);
            for (const slot of [0, 1, 2]) {
              expect(storage.getSession(backend, `session-${slot}`)).toEqual(model.get(`${backend}/session-${slot}`));
            }
            for (const archived of [false, true]) {
              for (const includeHidden of [false, true]) {
                expect(storage.listSessions(backend, { archived, includeHidden })).toEqual(records
                  .filter(row => Boolean(row.archivedAt) === archived && (includeHidden || !row.hidden))
                  .sort((a, b) => b.updatedAt - a.updatedAt));
              }
              const found: AcpSessionMetadata[] = [];
              let after: string | undefined;
              for (let page = 0; ; page += 1) {
                expect(page).toBeLessThan(5);
                const result = storage.listArchiveCleanupSessionsPage(backend, { archived, after, limit: op.pageSize });
                found.push(...result.sessions);
                if (!result.nextCursor) break;
                expect(result.nextCursor > (after ?? "")).toBe(true);
                after = result.nextCursor;
              }
              expect(found.map(row => row.sessionId)).toEqual(records
                .filter(row => Boolean(row.archivedAt) === archived).map(row => row.sessionId).sort());
              for (const row of found) {
                expect(row).not.toHaveProperty("transcriptUpdates");
                expect(row).not.toHaveProperty("availableCommands");
              }
            }
          }
        });
        expect(reads.writes.commits).toBe(0);
      }
    } finally { db.close(); }
  }), { numRuns: 50 });
});

it("keeps the last observed command list isolated by backend and repository, including empty replacements", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  await fc.assert(fc.asyncProperty(fc.array(fc.record({ ...identity, empty: fc.boolean() }),
    { minLength: 1, maxLength: 30 }), async (operations) => {
    const db = openInMemoryStateDb();
    const storage: AcpAvailableCommandsStorage = new AcpAvailableCommandsStore(db);
    const model = new Map<string, AcpAvailableCommandsRecord>();
    try {
      for (const [index, op] of operations.entries()) {
        const backendId = backends[op.backend]!;
        const repositoryPath = `/fixture/repo-${op.slot}`;
        const record: AcpAvailableCommandsRecord = { backendId, repositoryPath, observedAt: index,
          commands: op.empty ? [] : [{ name: `command-${index}`, description: "Fixture command",
            backend: backendId, scope: "session", source: "provider" }] };
        storage.upsert(record);
        model.set(`${backendId}/${repositoryPath}`, record);
        const reads = await measureSqliteWrites(() => {
          for (const backend of backends) {
            for (const slot of [0, 1, 2]) {
              const repository = `/fixture/repo-${slot}`;
              expect(storage.get(backend, repository)).toEqual(model.get(`${backend}/${repository}`));
            }
          }
        });
        expect(reads.writes.commits).toBe(0);
      }
    } finally { db.close(); }
  }), { numRuns: 50 });
});
