import fc from "fast-check";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import type { DesktopTelegramConnection } from "@pwragent/shared/contracts/settings";
import { applyDesktopSettingsPatch, parseDesktopSettingsToml } from "../settings/desktop-config";
import { publishTelegramConnection } from "../settings/telegram-connection-migration";
import { StateDb } from "../state/state-db";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";
import { DesktopSettingsService } from "../settings/desktop-settings-service";
import { MemoryDesktopSecretStore } from "../settings/desktop-secret-store";
import { DbBackedSafeStorageSecretStore } from "../state/secret-store-sqlite";

const legacyId = `mc_${"1".repeat(32)}`;
const newId = `mc_${"2".repeat(32)}`;
const fields = { enabled: true, authorizedUserIds: [], authorizedSupergroupIds: [] };

it("bounds the one-time SQLite cost of staging two Telegram credentials", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const fixture = createTempStateDb("telegram-migration-budget-");
  const db = StateDb.open(fixture.dbPath);
  try {
    db.setSecret("telegramBotToken", Buffer.from("contrived-legacy-ciphertext"));
    const { writes } = await measureSqliteWrites(async () => {
      const candidate = {
        ...fields, id: db.getOrInsertMeta("telegram_connection_migration_v1:new:222", newId),
        displayName: "Orchard Ops", legacy: false, token: "222:fixture",
      };
      const legacy = {
        ...fields, id: db.getOrInsertMeta("telegram_connection_migration_v1:legacy", legacyId),
        displayName: "Telegram", legacy: true, token: "111:fixture",
      };
      await publishTelegramConnection([], candidate, legacy, {
        verify: async (token) => token.split(":")[0],
        writeSecret: async (slot) => db.setSecret(slot, Buffer.from("contrived-ciphertext")),
        publish: async () => {},
      });
    });
    expectSqliteWriteBudget({
      scenario: "telegram-connection-migration-staging",
      note: "Reserve two connection IDs and stage both encrypted credentials before config publication.",
      writes,
    });
  } finally {
    db.close();
    removeTempStateDbDir(fixture.tempDir);
    vi.unstubAllEnvs();
  }
});

it("round trips the connection set and its explicit empty state while retaining legacy settings", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "telegram-connections-config-"));
  const configPath = path.join(root, "config.toml");
  const legacySettings = '[messaging.telegram]\nenabled = true\nresponse_mode = "mentions"\n';
  writeFileSync(configPath, legacySettings);
  const rows = [
    { ...fields, id: legacyId, legacy: true, displayName: "Telegram", botAccountId: "111" },
    { ...fields, id: newId, legacy: false, displayName: "Orchard Ops", botAccountId: "222" },
  ];
  try {
    const saved = applyDesktopSettingsPatch(configPath, { messaging: { telegram: { connections: rows } } });
    expect(saved.text).toContain(legacySettings.trim());
    expect(parseDesktopSettingsToml(saved.text, configPath).messaging?.telegram?.connections).toEqual(rows);
    const cleared = applyDesktopSettingsPatch(configPath, { messaging: { telegram: { connections: [] } } });
    expect(cleared.text).toContain(legacySettings.trim());
    expect(parseDesktopSettingsToml(cleared.text, configPath).messaging?.telegram?.connections).toEqual([]);
    const restored = applyDesktopSettingsPatch(configPath, { messaging: { telegram: { connections: rows } } });
    expect(parseDesktopSettingsToml(restored.text, configPath).messaging?.telegram?.connections).toEqual(rows);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("preserves comment placement and untouched rows across a named connection rename and removal", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "telegram-connections-comments-"));
  const configPath = path.join(root, "config.toml");
  const legacy = { ...fields, id: legacyId, legacy: true, displayName: "Telegram", botAccountId: "111" };
  const named = { ...fields, id: newId, legacy: false, displayName: "Orchard Ops", botAccountId: "222" };
  const originalRow = `[[messaging.telegram.connections]]
id = "${legacyId}"
# Keep the original bot's name.
display_name = "Telegram"
bot_account_id = "111"
enabled = true
legacy = true`;
  const nextSection = "# Keep this note with Discord.\n[messaging.discord]\nenabled = false";
  try {
    writeFileSync(configPath, `${originalRow}

[[messaging.telegram.connections]]
id = "${newId}"
display_name = "Orchard Ops" # Named bot
bot_account_id = "222"
enabled = true

${nextSection}
`);
    const renamed = applyDesktopSettingsPatch(configPath, { messaging: { telegram: {
      connections: [legacy, { ...named, displayName: "Orchard Alerts" }],
    } } });
    expect(renamed.text).toContain(originalRow);
    expect(renamed.text).toContain('display_name = "Orchard Alerts" # Named bot');
    expect(renamed.text).toContain(nextSection);
    const removed = applyDesktopSettingsPatch(configPath, { messaging: { telegram: { connections: [legacy] } } });
    expect(removed.text).toContain(originalRow);
    expect(removed.text).toContain(nextSection);
    expect(parseDesktopSettingsToml(removed.text, configPath).messaging?.telegram?.connections).toEqual([legacy]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it.each(['"invalid"', "[42]"])("falls back to the original token for connections = %s and rejects a destructive save", async (shape) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "telegram-connections-malformed-"));
  const configPath = path.join(root, "config.toml");
  try {
    const malformed = `[messaging.telegram]\nconnections = ${shape}\n`;
    writeFileSync(configPath, malformed);
    const secretStore = new MemoryDesktopSecretStore();
    await secretStore.setSecret("telegramBotToken", "111:fixture");
    const service = new DesktopSettingsService({ configPath, env: {}, secretStore });
    expect(service.readConfiguredTelegramConnections()).toBeUndefined();
    expect(service.resolveTelegramBotTokenSync()).toBe("111:fixture");
    await expect(service.saveTelegramConnection({ kind: "add", displayName: "Orchard Ops", token: "222:fixture" }))
      .rejects.toThrow(/malformed Telegram connections/);
    expect(readFileSync(configPath, "utf8")).toBe(malformed);
    writeFileSync(configPath, "[messaging.telegram]\nconnections = []\n");
    const empty = new DesktopSettingsService({ configPath, env: {}, secretStore });
    expect(empty.readConfiguredTelegramConnections()).toEqual([]);
    expect(empty.resolveTelegramBotTokenSync()).toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("removes the exact named credential and preserves the legacy downgrade slot", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const root = mkdtempSync(path.join(os.tmpdir(), "telegram-connections-remove-"));
  const configPath = path.join(root, "config.toml");
  const db = StateDb.open(path.join(root, "state.db"));
  try {
    applyDesktopSettingsPatch(configPath, { messaging: { telegram: { connections: [
      { ...fields, id: legacyId, legacy: true, displayName: "Telegram", botAccountId: "111" },
      { ...fields, id: newId, legacy: false, displayName: "Orchard Ops", botAccountId: "222" },
    ] } } });
    const secretStore = new DbBackedSafeStorageSecretStore({
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(value),
      decryptString: (value) => value.toString(),
    }, db);
    await secretStore.setSecret("telegramBotToken", "111:downgrade");
    await secretStore.setSecret(`telegramBotToken:${legacyId}`, "111:fixture");
    await secretStore.setSecret(`telegramBotToken:${newId}`, "222:fixture");
    db.getOrInsertMeta("telegram_connection_migration_v1:new:222", newId);
    const service = new DesktopSettingsService({
      configPath, env: {}, secretStore,
      releaseTelegramConnectionId: (attempt, id) => db.deleteMetaIfValue(`telegram_connection_migration_v1:${attempt}`, id),
    });
    const { writes } = await measureSqliteWrites(() => service.saveTelegramConnection({ kind: "remove", id: newId }));
    expectSqliteWriteBudget({
      scenario: "telegram-connection-removal",
      note: "Delete the named encrypted credential and release its ID reservation.",
      writes,
    });
    expect(await secretStore.getSecret(`telegramBotToken:${newId}`)).toBeUndefined();
    expect(await secretStore.getSecret(`telegramBotToken:${legacyId}`)).toBe("111:fixture");
    expect(await secretStore.getSecret("telegramBotToken")).toBe("111:downgrade");
    expect(service.readConfiguredTelegramConnections()?.map((row) => row.id)).toEqual([legacyId]);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
  }
});

it("publishes only complete verified credentials and retries interrupted migration without replacing the downgrade slot", async () => {
  await fc.assert(fc.asyncProperty(
    fc.uniqueArray(fc.integer({ min: 1, max: 100_000 }), { minLength: 2, maxLength: 2 }),
    fc.integer({ min: 0, max: 2 }),
    async ([legacyAccount, namedAccount], failureAt) => {
      const legacy = { ...fields, id: legacyId, legacy: true, displayName: "Telegram", token: `${legacyAccount}:legacy` };
      const candidate = { ...fields, id: newId, legacy: false, displayName: "Orchard Ops", token: `${namedAccount}:named` };
      const secrets = new Map([["telegramBotToken", legacy.token]]);
      let config: DesktopTelegramConnection[] | undefined;
      let operation = -1;
      let interrupt = true;
      const writeStep = () => {
        if (interrupt && ++operation === failureAt) throw new Error("interrupted");
      };
      const attempt = () => publishTelegramConnection([], candidate, legacy, {
        verify: async (token) => token.split(":")[0],
        writeSecret: async (slot, token) => {
          writeStep();
          expect(config).toBeUndefined();
          secrets.set(slot, token);
        },
        publish: async (rows) => {
          writeStep();
          for (const row of rows) {
            expect(secrets.get(`telegramBotToken:${row.id}`)?.split(":")[0]).toBe(row.botAccountId);
          }
          config = rows;
        },
      });
      await expect(attempt()).rejects.toThrow("interrupted");
      expect(config).toBeUndefined();
      expect(secrets.get("telegramBotToken")).toBe(legacy.token);
      interrupt = false;
      await attempt();
      expect(config?.map(({ id, botAccountId }) => [id, botAccountId]))
        .toEqual([[legacyId, String(legacyAccount)], [newId, String(namedAccount)]]);
      expect(secrets.get("telegramBotToken")).toBe(legacy.token);
    },
  ));
});

it("stages no credentials when the additional token does not prove a distinct bot", async () => {
  for (const verified of [undefined, "123"]) {
    const writes: string[] = [];
    await expect(publishTelegramConnection(
      [],
      { ...fields, id: newId, legacy: false, displayName: "Orchard Ops", token: "candidate" },
      { ...fields, id: legacyId, legacy: true, displayName: "Telegram", token: "legacy" },
      {
        verify: async (token) => token === "legacy" ? "123" : verified,
        writeSecret: async (slot) => { writes.push(slot); },
        publish: async () => { writes.push("config"); },
      },
    )).rejects.toThrow(/verify|already connected/);
    expect(writes).toEqual([]);
  }
});
