import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { afterEach, expect, it, vi } from "vitest";
import { AcpAgentService } from "../acp/acp-agent-service";
import { ensureAcpHelperWorkspace, ensureAcpRuntimeDiscoveryWorkspace } from "../acp/acp-capability-probe";
import { createAcpAvailableCommandsStorage, createAcpSessionStorage } from "../storage/desktop-runtime-storage";
import type { StateDb } from "../state/state-db";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { openInMemoryStateDb } from "./sqlite-test-utils";

const active = vi.hoisted(() => ({ db: undefined as StateDb | undefined, bootstrap: false, root: "" }));
vi.mock("../state/app-state", () => ({
  getAppStateDb: () => {
    if (!active.db) throw new Error("App state not initialized");
    return active.db;
  },
  getAppStateMode: () => active.bootstrap ? "bootstrap" : "active",
  isAppStateInitialized: () => active.db !== undefined,
  getAppScheduledThreadActionStore: vi.fn(),
}));
vi.mock("../profile", () => ({
  resolveActiveProfileDir: () => path.join(active.root, "active"),
  resolveBootstrapProfileDir: () => path.join(active.root, "bootstrap"),
}));
vi.mock("../acp/acp-runtime-discovery", () => ({ discoverAcpRuntimeCapabilities: vi.fn() }));

afterEach(() => {
  active.db = undefined;
  active.root = "";
  active.bootstrap = false;
  vi.unstubAllEnvs();
});

it("binds ACP services and storage once at construction even when the active database changes", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  expect(() => new AcpAgentService()).toThrow("App state not initialized");
  expect(() => createAcpSessionStorage()).toThrow("App state not initialized");
  expect(() => createAcpAvailableCommandsStorage()).toThrow("App state not initialized");
  await fc.assert(fc.asyncProperty(fc.array(fc.integer({ min: 0, max: 1 }), { minLength: 1, maxLength: 30 }),
    async (profiles) => {
      const databases = [openInMemoryStateDb(), openInMemoryStateDb()];
      try {
        let stores: Array<{ agents: AcpAgentService; sessions: ReturnType<typeof createAcpSessionStorage>;
          commands: ReturnType<typeof createAcpAvailableCommandsStorage> }> = [];
        const construction = await measureSqliteWrites(() => {
          stores = databases.map(db => {
            active.db = db;
            return { agents: new AcpAgentService(), sessions: createAcpSessionStorage(),
              commands: createAcpAvailableCommandsStorage() };
          });
        });
        expect(construction.writes.commits).toBe(0);
        const revisions: Array<number | undefined> = [undefined, undefined];
        for (const [revision, profile] of profiles.entries()) {
          // Writes must stay with the constructed store, even with no active database.
          active.db = revision % 2 === 0 ? databases[1 - profile] : undefined;
          const storage = stores[profile]!;
          const write = await measureSqliteWrites(() => {
            storage.agents.saveRegistrySnapshot({ fetchedAt: revision, agents: [], raw: {} });
            storage.sessions.upsertSession({ backendId: "acp:fixture", sessionId: "same-session",
              title: String(revision), createdAt: 1_000, updatedAt: revision, status: "idle", executionMode: "default" });
            storage.commands.upsert({ backendId: "acp:fixture", repositoryPath: "/fixture/repo",
              commands: [], observedAt: revision });
          });
          expect(write.writes.commits).toBe(3);
          revisions[profile] = revision;
          const reads = await measureSqliteWrites(() => {
            for (const [index, store] of stores.entries()) {
              expect(store.agents.readRegistrySnapshot()?.fetchedAt).toBe(revisions[index]);
              expect(store.sessions.getSession("acp:fixture", "same-session")?.updatedAt).toBe(revisions[index]);
              expect(store.commands.get("acp:fixture", "/fixture/repo")?.observedAt).toBe(revisions[index]);
            }
          });
          expect(reads.writes.commits).toBe(0);
        }
      } finally {
        active.db = undefined;
        for (const db of databases) db.close();
      }
    }), { numRuns: 25 });
});

it("selects bootstrap or active workspace directories at each call without SQLite writes", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const root = await mkdtemp(path.join(os.tmpdir(), "acp-storage-binding-"));
  active.root = root;
  try {
    await fc.assert(fc.asyncProperty(fc.array(fc.boolean(), { minLength: 1, maxLength: 15 }), async (modes) => {
      for (const bootstrap of modes) {
        active.bootstrap = bootstrap;
        const measured = await measureSqliteWrites(async () => {
          for (const [name, ensure] of [
            ["acp-helper-workspace", ensureAcpHelperWorkspace],
            ["acp-discovery-workspace", ensureAcpRuntimeDiscoveryWorkspace],
          ] as const) {
            const expected = path.join(root, bootstrap ? "bootstrap" : "active", "state", name);
            expect(await ensure()).toBe(expected);
            expect((await stat(expected)).isDirectory()).toBe(true);
          }
        });
        expect(measured.writes.commits).toBe(0);
      }
    }), { numRuns: 25 });
  } finally { await rm(root, { recursive: true, force: true }); }
});
