import fc from "fast-check";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
