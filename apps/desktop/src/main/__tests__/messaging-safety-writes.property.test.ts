import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { afterEach, expect, it } from "vitest";
import { applyDesktopSettingsPatch, readDesktopSettingsConfig } from "../settings/desktop-config";
import { MemoryDesktopSecretStore } from "../settings/desktop-secret-store";
import { DesktopSettingsService } from "../settings/desktop-settings-service";

const acknowledgmentRequired = "Review and acknowledge the messaging safety principles in Settings → Messaging before enabling a provider or saving messaging credentials.";
const acknowledgment = { acknowledgedAt: "2026-11-22T12:00:00.000Z", providers: [] };
const acknowledgmentToml = [
  "[general.messaging_acknowledgment]",
  `acknowledged_at = "${acknowledgment.acknowledgedAt}"`,
  "providers = []",
  "",
].join("\n");
const duplicateAcknowledgmentToml = `${acknowledgmentToml}acknowledged_at = 2026-11-22\n`;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function configPathForTest(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pwragent-messaging-safety-"));
  roots.push(root);
  return path.join(root, "config.toml");
}

it("leaves a disabled Telegram provider and the rest of its patch unsaved without a record", () => {
  const configPath = configPathForTest();
  const original = "[messaging.telegram]\nenabled = false\n";
  fs.writeFileSync(configPath, original);

  expect(() => applyDesktopSettingsPatch(configPath, {
    messaging: { telegram: { enabled: true, streamingResponses: true } },
  })).toThrow(acknowledgmentRequired);
  expect(fs.readFileSync(configPath, "utf8")).toBe(original);
});

it("rejects a provider enable when duplicate repair removes the readable timestamp", () => {
  const configPath = configPathForTest();
  fs.writeFileSync(configPath, duplicateAcknowledgmentToml);
  expect(readDesktopSettingsConfig(configPath).general?.messagingAcknowledgment).toEqual(acknowledgment);

  expect(() => applyDesktopSettingsPatch(configPath, {
    messaging: { telegram: { enabled: true } },
  })).toThrow(acknowledgmentRequired);
  expect(fs.readFileSync(configPath, "utf8")).toBe(duplicateAcknowledgmentToml);
});

it("requires a persisted acknowledgment for every new provider enable in a config patch", () => {
  const configPath = configPathForTest();
  fc.assert(fc.property(
    fc.constantFrom("telegram", "discord", "mattermost", "slack", "feishu", "line"),
    fc.constantFrom(undefined, false, true),
    fc.boolean(),
    fc.constantFrom("missing", "valid", "duplicate"),
    fc.constantFrom(undefined, null, acknowledgment, { ...acknowledgment, acknowledgedAt: "  " }),
    (provider, before, after, savedRecord, newRecord) => {
      const recordToml = savedRecord === "valid" ? acknowledgmentToml
        : savedRecord === "duplicate" ? duplicateAcknowledgmentToml : "";
      const original = recordToml
        + (before === undefined ? "" : `[messaging.${provider}]\nenabled = ${before}\n`);
      fs.writeFileSync(configPath, original);
      const save = () => applyDesktopSettingsPatch(configPath, {
        general: { messagingAcknowledgment: newRecord, developerMode: true },
        messaging: { [provider]: { enabled: after } },
      });
      const willHaveRecord = newRecord === undefined ? savedRecord === "valid" : newRecord === acknowledgment;

      if (after && before !== true && !willHaveRecord) {
        expect(save).toThrow(acknowledgmentRequired);
        expect(fs.readFileSync(configPath, "utf8")).toBe(original);
      } else {
        save();
        const saved = readDesktopSettingsConfig(configPath);
        expect(saved.messaging?.[provider]?.enabled).toBe(after);
        expect(Boolean(saved.general?.messagingAcknowledgment)).toBe(willHaveRecord);
        expect(saved.general?.developerMode).toBe(true);
      }
    },
  ));
});

it("checks the record on disk before storing a messaging secret and always allows clearing", async () => {
  const configPath = configPathForTest();
  const secretStore = new MemoryDesktopSecretStore();
  fs.writeFileSync(configPath, acknowledgmentToml);
  const service = new DesktopSettingsService({ configPath, env: {}, secretStore });
  await fc.assert(fc.asyncProperty(
    fc.constantFrom(
      "telegramBotToken", "discordBotToken", "mattermostBotToken", "mattermostHmacSecret",
      "slackBotToken", "slackAppToken", "slackSigningSecret", "feishuAppId", "feishuAppSecret",
      "feishuEncryptKey", "feishuVerificationToken", "lineChannelAccessToken", "lineChannelSecret",
      "openaiDecisionsApiKey",
    ),
    fc.constantFrom("acknowledged", "missing", "invalid"),
    fc.boolean(),
    async (secret, record, hasCredential) => {
      if (hasCredential) await secretStore.setSecret(secret, "existing-credential");
      else await secretStore.deleteSecret(secret);
      fs.writeFileSync(configPath, record === "acknowledged" ? acknowledgmentToml : record === "invalid" ? "invalid TOML\n" : "");

      if (record !== "acknowledged" && secret !== "openaiDecisionsApiKey") {
        await expect(service.replaceSecret(secret, "new-credential")).rejects.toThrow(acknowledgmentRequired);
        expect(secretStore.getSecretSync(secret)).toBe(hasCredential ? "existing-credential" : undefined);
      } else {
        await service.replaceSecret(secret, "new-credential");
        expect(secretStore.getSecretSync(secret)).toBe("new-credential");
      }
      await service.clearSecret(secret);
      expect(secretStore.getSecretSync(secret)).toBeUndefined();
    },
  ));
});
