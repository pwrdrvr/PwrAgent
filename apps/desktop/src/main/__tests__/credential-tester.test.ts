import { describe, expect, it, vi } from "vitest";
import type { MessagingCredentialValidationResult } from "@pwragent/messaging-interface";
import { CredentialTester } from "../credential-tester/credential-tester";
import type { CredentialValidationRequest } from "../messaging/messaging-runtime";

type TesterOptions = {
  resolveTelegramBotToken?: () => string | undefined;
  resolveDiscordBotToken?: () => string | undefined;
  resolveMattermostBotToken?: () => string | undefined;
  resolveMattermostServerUrl?: () => string | undefined;
  resolveSlackBotToken?: () => string | undefined;
  resolveSlackAppToken?: () => string | undefined;
  resolveFeishuAppId?: () => string | undefined;
  resolveFeishuAppSecret?: () => string | undefined;
  resolveFeishuTenantUrl?: () => string | undefined;
  resolveLineChannelAccessToken?: () => string | undefined;
  resolveCodexCommand?: () => Promise<string | undefined>;
  runCodexVersion?: (
    command: string,
  ) => Promise<{ stdout: string; stderr: string }>;
  validateMessagingCredentials?: (
    request: CredentialValidationRequest,
  ) => Promise<MessagingCredentialValidationResult>;
};

function buildTester(options: TesterOptions = {}) {
  const validateMessagingCredentials =
    options.validateMessagingCredentials
    ?? vi.fn(async (
      request: CredentialValidationRequest,
    ): Promise<MessagingCredentialValidationResult> => ({
      status: "ok" as const,
      durationMs: 1,
      testedAt: Date.now(),
      account:
        request.channel === "telegram" ? "@pwragent_bot" : "pwragent",
      detail:
        request.channel === "telegram"
          ? "api.telegram.org"
          : "discord.com/api/v10",
    }));
  const tester = new CredentialTester({
    resolveTelegramBotToken: options.resolveTelegramBotToken ?? (() => "telegram-token"),
    resolveDiscordBotToken: options.resolveDiscordBotToken ?? (() => "discord-token"),
    resolveMattermostBotToken:
      options.resolveMattermostBotToken ?? (() => "mattermost-token"),
    resolveMattermostServerUrl:
      options.resolveMattermostServerUrl
      ?? (() => "https://mm.example.com"),
    resolveSlackBotToken: options.resolveSlackBotToken ?? (() => "slack-token"),
    resolveSlackAppToken: options.resolveSlackAppToken ?? (() => "slack-app-token"),
    resolveFeishuAppId: options.resolveFeishuAppId ?? (() => "cli_feishu"),
    resolveFeishuAppSecret: options.resolveFeishuAppSecret ?? (() => "feishu-secret"),
    resolveFeishuTenantUrl:
      options.resolveFeishuTenantUrl ?? (() => "https://open.feishu.cn"),
    resolveLineChannelAccessToken:
      options.resolveLineChannelAccessToken ?? (() => "line-token"),
    resolveCodexCommand: options.resolveCodexCommand ?? (async () => "/usr/local/bin/codex"),
    validateMessagingCredentials,
    runCodexVersion:
      options.runCodexVersion
      ?? (async () => ({ stdout: "codex 0.130.0\n", stderr: "" })),
  });
  return { tester, validateMessagingCredentials };
}

describe("CredentialTester", () => {
  describe("telegram", () => {
    it("dispatches to the messaging runtime and lifts the result", async () => {
      // Telegram probes are NOT raw fetch — the tester calls
      // `validateMessagingCredentials` which the IPC layer wires to
      // `MessagingRuntime.requestCredentialValidation` → dynamic
      // import of `@pwragent/messaging-provider-telegram` →
      // `validateCredentials` (using grammy.Bot.api.getMe()).
      const validateMessagingCredentials = vi.fn(async () => ({
        status: "ok" as const,
        durationMs: 42,
        testedAt: 1234,
        account: "@pwragent_bot",
        detail: "api.telegram.org",
      }));
      const { tester } = buildTester({ validateMessagingCredentials });
      const result = await tester.test("telegram");
      expect(validateMessagingCredentials).toHaveBeenCalledWith({
        channel: "telegram",
        credential: { botToken: "telegram-token" },
      });
      expect(result.status).toBe("ok");
      expect(result.account).toBe("@pwragent_bot");
      expect(result.detail).toBe("api.telegram.org");
    });

    it("propagates failure from the provider verbatim", async () => {
      const validateMessagingCredentials = vi.fn(async () => ({
        status: "failed" as const,
        durationMs: 80,
        testedAt: Date.now(),
        errorMessage: "Unauthorized",
      }));
      const { tester } = buildTester({ validateMessagingCredentials });
      const result = await tester.test("telegram");
      expect(result.status).toBe("failed");
      expect(result.errorMessage).toBe("Unauthorized");
    });

    it("returns unset when no token is configured — no provider load", async () => {
      const validateMessagingCredentials = vi.fn(async () => ({
        status: "ok" as const,
        durationMs: 1,
        testedAt: Date.now(),
      }));
      const { tester } = buildTester({
        resolveTelegramBotToken: () => undefined,
        validateMessagingCredentials,
      });
      const result = await tester.test("telegram");
      expect(result.status).toBe("unset");
      // Critical: the dispatcher MUST short-circuit before reaching
      // the runtime when there's no credential, otherwise we'd
      // dynamic-import the provider just to discover the obvious.
      expect(validateMessagingCredentials).not.toHaveBeenCalled();
    });
  });

  describe("discord", () => {
    it("dispatches to the messaging runtime and lifts the result", async () => {
      const validateMessagingCredentials = vi.fn(async () => ({
        status: "ok" as const,
        durationMs: 65,
        testedAt: Date.now(),
        account: "pwragent",
        detail: "discord.com/api/v10",
      }));
      const { tester } = buildTester({ validateMessagingCredentials });
      const result = await tester.test("discord");
      expect(validateMessagingCredentials).toHaveBeenCalledWith({
        channel: "discord",
        credential: { botToken: "discord-token" },
      });
      expect(result.status).toBe("ok");
      expect(result.account).toBe("pwragent");
      expect(result.detail).toBe("discord.com/api/v10");
    });

    it("returns unset when no token is configured — no provider load", async () => {
      const validateMessagingCredentials = vi.fn(async () => ({
        status: "ok" as const,
        durationMs: 1,
        testedAt: Date.now(),
      }));
      const { tester } = buildTester({
        resolveDiscordBotToken: () => undefined,
        validateMessagingCredentials,
      });
      const result = await tester.test("discord");
      expect(result.status).toBe("unset");
      expect(validateMessagingCredentials).not.toHaveBeenCalled();
    });
  });

  describe("mattermost", () => {
    it("dispatches the bot token + server URL through the runtime", async () => {
      const validateMessagingCredentials = vi.fn(async () => ({
        status: "ok" as const,
        durationMs: 33,
        testedAt: Date.now(),
        account: "pwragent",
        detail: "mm.example.com",
      }));
      const { tester } = buildTester({ validateMessagingCredentials });
      const result = await tester.test("mattermost");
      expect(validateMessagingCredentials).toHaveBeenCalledWith({
        channel: "mattermost",
        credential: {
          botToken: "mattermost-token",
          serverUrl: "https://mm.example.com",
        },
      });
      expect(result.status).toBe("ok");
      expect(result.account).toBe("pwragent");
      expect(result.detail).toBe("mm.example.com");
    });

    it("returns unset when bot token is missing — no provider load", async () => {
      const validateMessagingCredentials = vi.fn(async () => ({
        status: "ok" as const,
        durationMs: 1,
        testedAt: Date.now(),
      }));
      const { tester } = buildTester({
        resolveMattermostBotToken: () => undefined,
        validateMessagingCredentials,
      });
      const result = await tester.test("mattermost");
      expect(result.status).toBe("unset");
      expect(validateMessagingCredentials).not.toHaveBeenCalled();
    });

    it("returns unset when server URL is missing — no provider load", async () => {
      const validateMessagingCredentials = vi.fn(async () => ({
        status: "ok" as const,
        durationMs: 1,
        testedAt: Date.now(),
      }));
      const { tester } = buildTester({
        resolveMattermostServerUrl: () => undefined,
        validateMessagingCredentials,
      });
      const result = await tester.test("mattermost");
      expect(result.status).toBe("unset");
      expect(validateMessagingCredentials).not.toHaveBeenCalled();
    });
  });

  describe("slack", () => {
    it("dispatches bot and app tokens through the runtime", async () => {
      const validateMessagingCredentials = vi.fn(async () => ({
        status: "ok" as const,
        durationMs: 28,
        testedAt: Date.now(),
        account: "pwragent",
        detail: "PwrDrvr · Socket Mode ok",
      }));
      const { tester } = buildTester({ validateMessagingCredentials });
      const result = await tester.test("slack");
      expect(validateMessagingCredentials).toHaveBeenCalledWith({
        channel: "slack",
        credential: {
          botToken: "slack-token",
          appToken: "slack-app-token",
        },
      });
      expect(result.status).toBe("ok");
      expect(result.account).toBe("pwragent");
      expect(result.detail).toBe("PwrDrvr · Socket Mode ok");
    });

    it("still probes when only the bot token is present", async () => {
      const validateMessagingCredentials = vi.fn(async () => ({
        status: "failed" as const,
        durationMs: 12,
        testedAt: Date.now(),
        account: "pwragent",
        errorMessage:
          "Socket Mode needs an App-Level Token (xapp-) with connections:write, generated under Basic Information.",
      }));
      const { tester } = buildTester({
        resolveSlackAppToken: () => undefined,
        validateMessagingCredentials,
      });
      const result = await tester.test("slack");
      expect(validateMessagingCredentials).toHaveBeenCalledWith({
        channel: "slack",
        credential: { botToken: "slack-token" },
      });
      expect(result.status).toBe("failed");
      expect(result.account).toBe("pwragent");
      expect(result.errorMessage).toMatch(/xapp-/);
    });

    it("returns unset when no bot token is configured — no provider load", async () => {
      const validateMessagingCredentials = vi.fn(async () => ({
        status: "ok" as const,
        durationMs: 1,
        testedAt: Date.now(),
      }));
      const { tester } = buildTester({
        resolveSlackBotToken: () => undefined,
        validateMessagingCredentials,
      });
      const result = await tester.test("slack");
      expect(result.status).toBe("unset");
      expect(validateMessagingCredentials).not.toHaveBeenCalled();
    });

    it("lifts a bot-ok / socket-fail result from the provider", async () => {
      const validateMessagingCredentials = vi.fn(async () => ({
        status: "failed" as const,
        durationMs: 40,
        testedAt: Date.now(),
        account: "pwragent",
        detail: "PwrDrvr",
        errorMessage:
          "The bot token is valid, but PwrAgent could not open Slack Socket Mode. Check that Socket Mode is enabled and the xapp- token has connections:write.",
      }));
      const { tester } = buildTester({ validateMessagingCredentials });
      const result = await tester.test("slack");
      expect(result.status).toBe("failed");
      expect(result.account).toBe("pwragent");
      expect(result.errorMessage).toMatch(/Socket Mode/);
    });
  });

  describe("feishu", () => {
    it("dispatches App ID, App Secret, and tenant URL through the runtime", async () => {
      const validateMessagingCredentials = vi.fn(async () => ({
        status: "ok" as const,
        durationMs: 41,
        testedAt: Date.now(),
        account: "PwrAgent",
        detail: "tenant_1",
      }));
      const { tester } = buildTester({ validateMessagingCredentials });
      const result = await tester.test("feishu");
      expect(validateMessagingCredentials).toHaveBeenCalledWith({
        channel: "feishu",
        credential: {
          appId: "cli_feishu",
          appSecret: "feishu-secret",
          tenantUrl: "https://open.feishu.cn",
        },
      });
      expect(result.status).toBe("ok");
      expect(result.account).toBe("PwrAgent");
      expect(result.detail).toBe("tenant_1");
    });

    it("returns unset when an app credential is missing", async () => {
      const validateMessagingCredentials = vi.fn(async () => ({
        status: "ok" as const,
        durationMs: 1,
        testedAt: Date.now(),
      }));
      const { tester } = buildTester({
        resolveFeishuAppSecret: () => undefined,
        validateMessagingCredentials,
      });
      const result = await tester.test("feishu");
      expect(result.status).toBe("unset");
      expect(validateMessagingCredentials).not.toHaveBeenCalled();
    });
  });
  describe("codex", () => {
    it("returns ok with the parsed version when --version succeeds", async () => {
      const { tester } = buildTester({
        runCodexVersion: async () => ({
          stdout: "codex 0.128.0-alpha.1\n",
          stderr: "",
        }),
      });
      const result = await tester.test("codex");
      expect(result.status).toBe("ok");
      expect(result.account).toBe("/usr/local/bin/codex");
      expect(result.detail).toBe("0.128.0-alpha.1");
    });

    it("returns failed when the parsed Codex version is too old", async () => {
      const { tester } = buildTester({
        runCodexVersion: async () => ({
          stdout: "codex 0.94.0\n",
          stderr: "",
        }),
      });
      const result = await tester.test("codex");
      expect(result.status).toBe("failed");
      expect(result.account).toBe("/usr/local/bin/codex");
      expect(result.errorMessage).toBe(
        "Codex CLI 0.94.0 is older than the minimum supported version 0.125.0",
      );
    });

    it("returns failed when the binary spawns but doesn't print a version", async () => {
      const { tester } = buildTester({
        runCodexVersion: async () => ({ stdout: "no version here\n", stderr: "" }),
      });
      const result = await tester.test("codex");
      expect(result.status).toBe("failed");
      expect(result.errorMessage).toBe("version banner not recognized in stdout/stderr");
    });

    it("returns failed when the binary throws (ENOENT etc.)", async () => {
      const { tester } = buildTester({
        runCodexVersion: async () => {
          throw new Error("spawn ENOENT");
        },
      });
      const result = await tester.test("codex");
      expect(result.status).toBe("failed");
      expect(result.errorMessage).toBe("spawn ENOENT");
    });

    it("returns unset when no codex command is configured", async () => {
      const { tester } = buildTester({
        resolveCodexCommand: async () => undefined,
      });
      const result = await tester.test("codex");
      expect(result.status).toBe("unset");
    });
  });

  describe("lastResult cache", () => {
    it("retains the most recent result per kind", async () => {
      const { tester, validateMessagingCredentials } = buildTester({});
      expect(tester.lastResult("telegram")).toBeUndefined();
      const fresh = await tester.test("telegram");
      expect(validateMessagingCredentials).toHaveBeenCalledTimes(1);
      const cached = tester.lastResult("telegram");
      expect(cached).toEqual(fresh);
    });
  });
});
