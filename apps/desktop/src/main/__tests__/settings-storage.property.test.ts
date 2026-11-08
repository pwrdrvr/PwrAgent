import fc from "fast-check";
import { afterEach, expect, expectTypeOf, it, vi } from "vitest";
import type { DesktopConfigSnapshotStorage, DurableConfigSnapshot } from "../settings/config-store/durable-config-snapshot";
import type { SettingsSecretStorage } from "@pwragent/owner-core/settings-secret-storage";
import {
  CONFIG_STORE_DURABLE_SCHEMA_VERSION,
  PROVIDER_IDS,
  normalizeConfigDomains,
  type ProviderId,
  type ProviderProjection,
} from "../settings/config-store/config-domains";
import { createDesktopConfigSnapshotStorage, createDesktopSecretStorage } from "../storage/desktop-settings-storage";
import { DurableConfigSnapshotStore } from "../storage/durable-config-snapshot-store";
import type { StateDb } from "../state/state-db";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { openInMemoryStateDb } from "./sqlite-test-utils";

const active = vi.hoisted(() => ({ db: undefined as StateDb | undefined }));
vi.mock("../state/app-state", () => ({
  getAppStateDb: () => {
    if (!active.db) throw new Error("App state not initialized");
    return active.db;
  },
}));

afterEach(() => {
  active.db = undefined;
  vi.unstubAllEnvs();
});

it("exposes the complete config contract without a database handle", () => {
  expectTypeOf<ReturnType<typeof createDesktopConfigSnapshotStorage>>().toEqualTypeOf<DesktopConfigSnapshotStorage>();
  expectTypeOf<DesktopConfigSnapshotStorage>().toEqualTypeOf<Pick<DurableConfigSnapshotStore, keyof DesktopConfigSnapshotStorage>>();
});

it("keeps encrypted settings secrets profile-local and preserves failed-write and read costs", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const names = ["discordBotToken", "telegramBotToken"] as const;
  const operation = fc.record({
    profile: fc.integer({ min: 0, max: 1 }),
    name: fc.constantFrom(...names),
    remove: fc.boolean(),
    deny: fc.boolean(),
    value: fc.string({ minLength: 1, maxLength: 20 }),
  });
  await fc.assert(fc.asyncProperty(fc.array(operation, { minLength: 1, maxLength: 25 }), async (operations) => {
    const databases = [openInMemoryStateDb(), openInMemoryStateDb()];
    const model = [new Map<string, string>(), new Map<string, string>()];
    let denied = false;
    const encryption = {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => "keychain",
      encryptString: (value: string) => {
        if (denied) throw new Error("fixture denial");
        return Buffer.from(`encrypted:${value}`);
      },
      decryptString: (value: Buffer) => value.toString().slice("encrypted:".length),
    };
    try {
      const construction = await measureSqliteWrites(() => databases.map(db => {
        active.db = db;
        return createDesktopSecretStorage(encryption);
      }));
      expectTypeOf(construction.result).toEqualTypeOf<SettingsSecretStorage[]>();
      expect(construction.writes.commits).toBe(0);
      for (const [index, op] of operations.entries()) {
        active.db = index % 2 === 0 ? databases[1 - op.profile] : undefined;
        denied = op.deny;
        const storage = construction.result[op.profile]!;
        const mutation = await measureSqliteWrites(async () => {
          if (op.remove) {
            await storage.deleteSecret(op.name);
            model[op.profile]!.delete(op.name);
          } else if (op.deny) {
            await expect(storage.setSecret(op.name, op.value)).rejects.toThrow("could not unlock secret storage");
          } else {
            await storage.setSecret(op.name, op.value);
            model[op.profile]!.set(op.name, op.value);
          }
        });
        expect(mutation.writes.commits).toBe(op.remove || !op.deny ? 1 : 0);
        const reads = await measureSqliteWrites(async () => {
          for (const [profile, port] of construction.result.entries()) {
            expect(port.describe().available).toBe(true);
            for (const name of names) {
              const value = model[profile]!.get(name);
              expect(await port.getSecret(name)).toBe(value);
              expect(await port.hasSecret(name)).toBe(value !== undefined);
              expect(databases[profile]!.getSecret(name)?.toString()).toBe(value === undefined ? undefined : `encrypted:${value}`);
            }
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

it("keeps snapshots and discoveries with their constructed profile and writes only at publication boundaries", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  expect(() => createDesktopConfigSnapshotStorage()).toThrow("App state not initialized");
  const operation = fc.record({
    kind: fc.constantFrom("config", "provider", "read"),
    profile: fc.integer({ min: 0, max: 1 }),
    provider: fc.constantFrom(...PROVIDER_IDS),
    enabled: fc.boolean(),
    validated: fc.boolean(),
  });
  await fc.assert(fc.asyncProperty(fc.array(operation, { minLength: 1, maxLength: 30 }), async (operations) => {
    const databases = [openInMemoryStateDb(), openInMemoryStateDb()];
    const model: Array<{ config?: DurableConfigSnapshot; providers: Partial<Record<ProviderId, ProviderProjection>> }> = [
      { providers: {} }, { providers: {} },
    ];
    try {
      const construction = await measureSqliteWrites(() => databases.map(db => {
        active.db = db;
        return createDesktopConfigSnapshotStorage();
      }));
      expect(construction.writes.commits).toBe(0);
      for (const [revision, op] of operations.entries()) {
        // Previously returned ports remain bound even after a switch or shutdown.
        active.db = revision % 2 === 0 ? databases[1 - op.profile] : undefined;
        const storage = construction.result[op.profile]!;
        const expected = model[op.profile]!;
        const domains = normalizeConfigDomains({ config: { messaging: { enabled: op.enabled } } });
        const publication = await measureSqliteWrites(() => {
          if (op.kind === "config") {
            const snapshot: DurableConfigSnapshot = {
              configRevision: String(revision), contentHash: `hash-${revision}`, domains,
              schemaVersion: CONFIG_STORE_DURABLE_SCHEMA_VERSION, updatedAt: revision,
            };
            storage.writeConfig(snapshot);
            expected.config = snapshot;
          } else if (op.kind === "provider") {
            const projection: ProviderProjection = {
              ...domains.providers[op.provider],
              dependencyFingerprint: `dependency-${revision}`,
              lastKnownGood: op.validated ? { candidates: [], validatedAt: revision } : undefined,
            };
            storage.writeProvider(projection);
            if (op.validated) expected.providers[op.provider] = projection;
          }
        });
        expect(publication.writes.commits).toBe(op.kind === "config" || (op.kind === "provider" && op.validated) ? 1 : 0);
        const reads = await measureSqliteWrites(() => {
          for (const [index, port] of construction.result.entries()) {
            const config = port.readConfig();
            const providers = port.readProviders();
            // Persisted JSON omits undefined fields; the model follows that wire format.
            expect(config).toEqual(model[index]!.config);
            expect(providers).toEqual(JSON.parse(JSON.stringify(model[index]!.providers)));
            if (config) {
              expect(Object.isFrozen(config)).toBe(true);
              expect(Object.isFrozen(config.domains.messaging)).toBe(true);
            }
            expect(Object.isFrozen(providers)).toBe(true);
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
