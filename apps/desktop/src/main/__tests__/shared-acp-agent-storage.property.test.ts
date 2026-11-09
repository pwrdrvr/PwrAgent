import fc from "fast-check";
import { afterEach, expect, it, vi } from "vitest";
import { AcpAgentStore as SharedStore, type AcpInstalledAgentStorageRecord } from "@pwragent/sqlite-storage/acp-agent-store";
import { StateDb } from "@pwragent/sqlite-storage/state-db";
import type { AcpBackendId } from "@pwragent/shared";
import { AcpAgentStore as DesktopStore } from "../storage/acp-agent-store";
import { createAcpAgentStorage } from "../storage/desktop-runtime-storage";
import { AcpAgentService } from "../acp/acp-agent-service";
import type { AcpInstalledAgentRecord, AcpRegistrySnapshot } from "../acp/acp-registry-types";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { createTempStateDb, openInMemoryStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

const active = vi.hoisted(() => ({ db: undefined as StateDb | undefined }));
vi.mock("../state/app-state", () => ({ getAppStateDb: () => {
  if (!active.db) throw new Error("No invented profile selected");
  return active.db;
} }));
afterEach(() => { active.db = undefined; vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const backend = (slot: number): AcpBackendId => `acp:fixture-${slot}`;
const record = (slot: number, revision: number, registryId = `fixture-${slot}`): AcpInstalledAgentRecord => ({
  backendId: backend(slot), registryId, name: `Invented agent ${revision}`, version: revision % 2 ? String(revision) : undefined,
  distributionKind: "local", distributionSource: "Invented local executable", installStatus: "installed",
  authStatus: "not-required", verificationStatus: "not-applicable", allowlistRuleId: "invented-host-policy",
  installedAt: revision, updatedAt: revision,
  launchDescriptor: { backendId: backend(slot), registryId, distributionKind: "local", command: "/invented/node",
    args: ["invented-argument"], env: { INVENTED_SETTING: String(revision) } },
});
const snapshot = (revision: number): AcpRegistrySnapshot => ({ fetchedAt: revision, agents: [], raw: { revision } });

it("binds concrete choices and the original factory/service to the shared implementation at construction", async () => {
  await fc.assert(fc.asyncProperty(fc.boolean(), fc.nat({ max: 100 }), async (desktop, revision) => {
    const db = openInMemoryStateDb();
    try {
      expect(Object.getPrototypeOf(new (desktop ? DesktopStore : SharedStore)(db))).toBe(SharedStore.prototype);
      active.db = db;
      const write = vi.spyOn(SharedStore.prototype, "upsertInstalledAgent");
      const factory = createAcpAgentStorage();
      const service = new AcpAgentService();
      active.db = undefined;
      expect(Object.getPrototypeOf(factory)).toBe(SharedStore.prototype);
      service.upsertInstalledAgent(record(0, revision));
      expect(write).toHaveBeenCalledWith(record(0, revision));
      factory.saveRegistrySnapshot(snapshot(revision));
      expect(service.readRegistrySnapshot()).toEqual(snapshot(revision));
      expect(new SharedStore(db).getInstalledAgent(backend(0))).toEqual(clone(record(0, revision)));
      write.mockRestore();
    } finally { db.close(); }
  }), { numRuns: 25 });
});

// A second host's records deliberately have no desktop launch or registry types.
// SQLite owns only these scalar indexes; every other JSON field is opaque.
it("preserves arbitrary host JSON payloads over the minimal generic port", async () => {
  await fc.assert(fc.property(fc.jsonValue(), fc.integer(), (opaque, fetchedAt) => {
    const db = openInMemoryStateDb();
    try {
      type OtherAgent = AcpInstalledAgentStorageRecord & { opaque: unknown };
      const store = new SharedStore<{ fetchedAt: number; opaque: unknown }, OtherAgent>(db);
      const agent: OtherAgent = { backendId: "acp:other-host", registryId: "Other", name: "Invented",
        installStatus: "host-install-state", authStatus: "host-auth-state", verificationStatus: "host-verification-state",
        installedAt: 1, updatedAt: 2, opaque };
      store.saveRegistrySnapshot({ fetchedAt, opaque });
      store.upsertInstalledAgent(agent);
      // The oracle is the JSON round trip: even nested -0 becomes 0.
      const expectedAgent = clone(agent);
      expect(store.readRegistrySnapshot()).toEqual(clone({ fetchedAt, opaque }));
      expect(store.getInstalledAgent("acp:other-host")).toEqual(expectedAgent);
      expect(store.listInstalledAgents()).toEqual([expectedAgent]);
    } finally { db.close(); }
  }), { numRuns: 25, examples: [[-0, 0], [[-0], 0], [[{ "": -0 }], 0]] });
});

it("matches independent backend replacement, NOCASE order and latest-cache models across WAL hosts and reopens", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  await fc.assert(fc.asyncProperty(fc.array(fc.record({
    host: fc.integer({ min: 0, max: 1 }), slot: fc.integer({ min: 0, max: 4 }),
    registryId: fc.constantFrom("Zulu", "alpha", "ALPHA", "Ä", "'); DROP TABLE meta; -- 雪"),
    kind: fc.constantFrom("agent", "same", "registry", "read"), revision: fc.integer({ min: -100, max: 100 }), reopen: fc.boolean(),
  }), { minLength: 1, maxLength: 30 }), async commands => {
    const fixture = createTempStateDb("shared-acp-agent-model-");
    const dbs = [StateDb.open(fixture.dbPath), StateDb.open(fixture.dbPath)];
    const construct = (host: number) => host ? new DesktopStore(dbs[host]!) : new SharedStore<AcpRegistrySnapshot, AcpInstalledAgentRecord>(dbs[host]!);
    const stores = [construct(0), construct(1)];
    const agents = new Map<AcpBackendId, AcpInstalledAgentRecord>();
    let latest: AcpRegistrySnapshot | undefined;
    const fold = (s: string) => s.replace(/[A-Z]/g, character => character.toLowerCase());
    try {
      for (const command of commands) {
        const previous = agents.get(backend(command.slot));
        const next = command.kind === "same" && previous ? clone(previous) : clone(record(command.slot, command.revision, command.registryId));
        const measured = await measureSqliteWrites(() => {
          if (command.kind === "agent" || command.kind === "same") stores[command.host]!.upsertInstalledAgent(next);
          if (command.kind === "registry") stores[command.host]!.saveRegistrySnapshot(snapshot(command.revision));
        });
        const writes = Number(command.kind !== "read");
        expect({ commits: measured.writes.commits, rows: measured.writes.rowsChanged }).toEqual({ commits: writes, rows: writes });
        if (command.kind === "agent" || command.kind === "same") { agents.delete(next.backendId); agents.set(next.backendId, clone(next)); }
        if (command.kind === "registry") latest = snapshot(command.revision);
        if (command.reopen) {
          dbs[command.host]!.close();
          const opened = await measureSqliteWrites(() => StateDb.open(fixture.dbPath));
          expect(opened.writes.commits).toBe(0);
          dbs[command.host] = opened.result; stores[command.host] = construct(command.host);
        }
        const expected = [...agents.values()].sort((a, b) => fold(a.registryId) < fold(b.registryId) ? -1 : fold(a.registryId) > fold(b.registryId) ? 1 : 0);
        const reads = await measureSqliteWrites(() => {
          for (const store of stores) {
            expect(store.readRegistrySnapshot()).toEqual(latest);
            expect(store.listInstalledAgents()).toEqual(expected);
            for (let slot = 0; slot < 6; slot++) expect(store.getInstalledAgent(backend(slot))).toEqual(agents.get(backend(slot)));
            const detached = store.listInstalledAgents()[0];
            if (detached?.launchDescriptor) detached.launchDescriptor.env.INVENTED_SETTING = "mutated detached read";
          }
          const indexed = dbs[0]!.raw.prepare(`SELECT backend_id, registry_id, version, install_status, auth_status,
            verification_status, installed_at, updated_at FROM acp_installed_agents ORDER BY registry_id COLLATE NOCASE`).all();
          expect(indexed).toEqual(expected.map(agent => ({ backend_id: agent.backendId, registry_id: agent.registryId,
            version: agent.version ?? null, install_status: agent.installStatus, auth_status: agent.authStatus,
            verification_status: agent.verificationStatus, installed_at: agent.installedAt, updated_at: agent.updatedAt })));
          expect(dbs[0]!.raw.prepare("SELECT fetched_at FROM acp_registry_cache WHERE cache_key = 'latest'").pluck().get()).toBe(latest?.fetchedAt);
        });
        expect(reads.writes.commits).toBe(0);
      }
    } finally { dbs.forEach(db => db.close()); removeTempStateDbDir(fixture.tempDir); }
  }), { numRuns: 25 });
});

it("keeps permissive legacy payload guards and JSON failure behavior without repairing reads", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  await fc.assert(fc.asyncProperty(fc.jsonValue(), fc.constantFrom("backendId", "registryId", "name", "installStatus", "authStatus", "verificationStatus"),
    async (opaque, field) => {
      const db = openInMemoryStateDb();
      try {
        const store = new SharedStore(db);
        const valid = { backendId: "acp:legacy", registryId: "Legacy", name: "Invented legacy", installStatus: "old",
          authStatus: "unknown-host-state", verificationStatus: "old", opaque };
        const expected = clone(valid);
        store.upsertInstalledAgent(record(0, 1));
        store.upsertInstalledAgent(record(1, 1));
        const corrupt = { ...valid, [field]: field === "backendId" ? "codex" : null };
        db.raw.prepare("UPDATE acp_installed_agents SET payload = ? WHERE backend_id = ?").run(JSON.stringify(valid), backend(0));
        db.raw.prepare("UPDATE acp_installed_agents SET payload = ? WHERE backend_id = ?").run(JSON.stringify(corrupt), backend(1));
        const before = db.raw.prepare("SELECT * FROM acp_installed_agents").all();
        const reads = await measureSqliteWrites(() => {
          // Guard admits legacy rows without timestamps/version/launch data and
          // does not substitute indexed columns for the persisted JSON identity.
          expect(store.getInstalledAgent(backend(0))).toEqual(expected);
          expect(store.getInstalledAgent(backend(1))).toBeUndefined();
          expect(store.listInstalledAgents()).toEqual([expected]);
        });
        expect(reads.writes.commits).toBe(0);
        expect(db.raw.prepare("SELECT * FROM acp_installed_agents").all()).toEqual(before);
        for (const payload of ["{malformed", "null", "[]", "false", "123", JSON.stringify({ opaque })]) {
          db.raw.prepare("UPDATE acp_installed_agents SET payload = ?").run(payload);
          store.saveRegistrySnapshot({ fetchedAt: 1 });
          db.raw.prepare("UPDATE acp_registry_cache SET payload = ?").run(payload);
          const measured = await measureSqliteWrites(() => {
            const parsed = (() => { try { return JSON.parse(payload) as unknown; } catch { return undefined; } })();
            expect(store.readRegistrySnapshot()).toEqual(parsed);
            expect(store.listInstalledAgents()).toEqual([]);
            expect(store.getInstalledAgent(backend(0))).toBeUndefined();
          });
          expect(measured.writes.commits).toBe(0);
        }
      } finally { db.close(); }
    }), { numRuns: 25, examples: [[-0, "name"], [[{ "": -0 }], "registryId"]] });
});

it("preserves outer transaction atomicity, WAL visibility and zero-write serialization refusal", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  await fc.assert(fc.asyncProperty(fc.integer({ min: 0, max: 100 }), fc.boolean(), async (revision, commit) => {
    const fixture = createTempStateDb("shared-acp-agent-atomic-");
    const writer = StateDb.open(fixture.dbPath), reader = StateDb.open(fixture.dbPath);
    try {
      const shared = new SharedStore<AcpRegistrySnapshot, AcpInstalledAgentRecord>(writer), desktop = new DesktopStore(reader);
      shared.saveRegistrySnapshot(snapshot(-1)); shared.upsertInstalledAgent(record(0, -1));
      const measured = await measureSqliteWrites(() => {
        const run = writer.raw.transaction(() => {
          shared.saveRegistrySnapshot(snapshot(revision)); shared.upsertInstalledAgent(record(0, revision));
          expect(desktop.readRegistrySnapshot()).toEqual(snapshot(-1));
          expect(desktop.getInstalledAgent(backend(0))).toEqual(clone(record(0, -1)));
          if (!commit) throw new Error("Invented transaction refusal");
        });
        if (commit) run(); else expect(run).toThrow("Invented transaction refusal");
      });
      expect(measured.writes.commits).toBe(Number(commit));
      expect(desktop.readRegistrySnapshot()).toEqual(snapshot(commit ? revision : -1));
      expect(desktop.getInstalledAgent(backend(0))).toEqual(clone(record(0, commit ? revision : -1)));
      const refused = await measureSqliteWrites(() => {
        expect(() => shared.saveRegistrySnapshot({ ...snapshot(5), raw: { unserializable: 1n } })).toThrow();
        expect(() => shared.upsertInstalledAgent({ ...record(0, 5), lastError: 1n } as unknown as AcpInstalledAgentRecord)).toThrow();
      });
      expect(refused.writes.commits).toBe(0);
      expect(desktop.getInstalledAgent(backend(0))).toEqual(clone(record(0, commit ? revision : -1)));
    } finally { writer.close(); reader.close(); removeTempStateDbDir(fixture.tempDir); }
  }), { numRuns: 25 });
});
