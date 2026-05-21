import { describe, expect, it } from "vitest";
import {
  isMessagingRuntimeSecret,
  type DesktopSettingsSecretName,
} from "../contracts/settings";

describe("isMessagingRuntimeSecret", () => {
  // Enumerate every secret name. This list mirrors the
  // `DesktopSettingsSecretName` union. If a new secret is added to
  // the union, TS will narrow it differently and one of these
  // assertions will fail — forcing the author to make a conscious
  // decision about whether the new name should re-evaluate the
  // messaging runtime.
  const cases: Array<{
    name: DesktopSettingsSecretName;
    expected: boolean;
  }> = [
    { name: "telegramBotToken", expected: true },
    { name: "discordBotToken", expected: true },
    { name: "mattermostBotToken", expected: true },
    { name: "mattermostHmacSecret", expected: true },
    { name: "slackBotToken", expected: true },
    { name: "slackAppToken", expected: true },
    { name: "slackSigningSecret", expected: true },
    { name: "feishuAppId", expected: true },
    { name: "feishuAppSecret", expected: true },
    { name: "feishuEncryptKey", expected: true },
    { name: "feishuVerificationToken", expected: true },
    { name: "lineChannelAccessToken", expected: true },
    { name: "lineChannelSecret", expected: true },
    { name: "grokApiKey", expected: false },
  ];

  for (const { name, expected } of cases) {
    it(`${name} → ${expected ? "messaging" : "non-messaging"}`, () => {
      expect(isMessagingRuntimeSecret(name)).toBe(expected);
    });
  }
});
