import { describe, expect, it, vi } from "vitest";
import { CredentialTester } from "../credential-tester/credential-tester";

function buildFetcher(overrides: {
  status?: number;
  body?: string;
  fail?: Error;
}) {
  return vi.fn<typeof fetch>(async (_input, _init) => {
    if (overrides.fail) throw overrides.fail;
    return new Response(overrides.body ?? "", {
      status: overrides.status ?? 200,
    });
  });
}

function buildTester(options: Partial<{
  fetch: typeof fetch;
  resolveTelegramBotToken: () => string | undefined;
  resolveDiscordBotToken: () => string | undefined;
  resolveGrokApiKey: () => Promise<string | undefined>;
  resolveCodexCommand: () => Promise<string | undefined>;
  runCodexVersion: (
    command: string,
  ) => Promise<{ stdout: string; stderr: string }>;
}> = {}) {
  const tester = new CredentialTester({
    resolveTelegramBotToken: options.resolveTelegramBotToken ?? (() => "telegram-token"),
    resolveDiscordBotToken: options.resolveDiscordBotToken ?? (() => "discord-token"),
    resolveGrokApiKey: options.resolveGrokApiKey ?? (async () => "grok-key"),
    resolveCodexCommand: options.resolveCodexCommand ?? (async () => "/usr/local/bin/codex"),
    fetch: options.fetch as typeof fetch,
    runCodexVersion:
      options.runCodexVersion
      ?? (async () => ({ stdout: "codex 0.130.0\n", stderr: "" })),
  });
  return tester;
}

describe("CredentialTester", () => {
  describe("telegram", () => {
    it("returns ok with the bot username when getMe succeeds", async () => {
      const fetcher = buildFetcher({
        status: 200,
        body: JSON.stringify({
          ok: true,
          result: { id: 1, is_bot: true, username: "pwragent_bot" },
        }),
      });
      const tester = buildTester({ fetch: fetcher });
      const result = await tester.test("telegram");
      expect(result.status).toBe("ok");
      expect(result.account).toBe("@pwragent_bot");
      expect(result.detail).toBe("api.telegram.org");
      // The token MUST land in the URL path, not in a header.
      const callUrl = String(fetcher.mock.calls[0]?.[0] ?? "");
      expect(callUrl).toContain("/bottelegram-token/getMe");
    });

    it("returns failed with the API description when token rejected", async () => {
      const fetcher = buildFetcher({
        status: 401,
        body: JSON.stringify({
          ok: false,
          error_code: 401,
          description: "Unauthorized",
        }),
      });
      const tester = buildTester({ fetch: fetcher });
      const result = await tester.test("telegram");
      expect(result.status).toBe("failed");
      expect(result.errorMessage).toBe("Unauthorized");
    });

    it("returns unset when no token is configured", async () => {
      const fetcher = buildFetcher({});
      const tester = buildTester({
        fetch: fetcher,
        resolveTelegramBotToken: () => undefined,
      });
      const result = await tester.test("telegram");
      expect(result.status).toBe("unset");
      // Never hit the network when there's no credential to test.
      expect(fetcher).not.toHaveBeenCalled();
    });
  });

  describe("discord", () => {
    it("returns ok with the username when /users/@me succeeds", async () => {
      const fetcher = buildFetcher({
        status: 200,
        body: JSON.stringify({
          id: "1234",
          username: "pwragent",
          discriminator: "0",
        }),
      });
      const tester = buildTester({ fetch: fetcher });
      const result = await tester.test("discord");
      expect(result.status).toBe("ok");
      // discriminator "0" is the modern username-only state — no #suffix.
      expect(result.account).toBe("pwragent");
      // Bot tokens MUST go in the Authorization header, not the URL.
      const init = fetcher.mock.calls[0]?.[1];
      expect(init?.headers).toMatchObject({
        Authorization: "Bot discord-token",
      });
    });

    it("returns failed when token rejected", async () => {
      const fetcher = buildFetcher({
        status: 401,
        body: JSON.stringify({ message: "401: Unauthorized" }),
      });
      const tester = buildTester({ fetch: fetcher });
      const result = await tester.test("discord");
      expect(result.status).toBe("failed");
      expect(result.errorMessage).toBe("401: Unauthorized");
    });
  });

  describe("grok", () => {
    it("summarizes available models on ok", async () => {
      const fetcher = buildFetcher({
        status: 200,
        body: JSON.stringify({
          data: [
            { id: "grok-4-fast" },
            { id: "grok-4-fast-reasoning" },
            { id: "grok-3" },
            { id: "grok-3-mini" },
          ],
        }),
      });
      const tester = buildTester({ fetch: fetcher });
      const result = await tester.test("grok");
      expect(result.status).toBe("ok");
      // First three plus +N more.
      expect(result.detail).toBe("grok-4-fast, grok-4-fast-reasoning, grok-3, +1 more");
      const init = fetcher.mock.calls[0]?.[1];
      expect(init?.headers).toMatchObject({
        Authorization: "Bearer grok-key",
      });
    });

    it("returns failed when API rejects", async () => {
      const fetcher = buildFetcher({
        status: 401,
        body: JSON.stringify({ error: { message: "invalid api key" } }),
      });
      const tester = buildTester({ fetch: fetcher });
      const result = await tester.test("grok");
      expect(result.status).toBe("failed");
      expect(result.errorMessage).toBe("invalid api key");
    });
  });

  describe("codex", () => {
    it("returns ok with the parsed version when --version succeeds", async () => {
      const tester = buildTester({
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

    it("returns failed when the binary spawns but doesn't print a version", async () => {
      const tester = buildTester({
        runCodexVersion: async () => ({ stdout: "no version here\n", stderr: "" }),
      });
      const result = await tester.test("codex");
      expect(result.status).toBe("failed");
      expect(result.errorMessage).toBe("version banner not recognized in stdout/stderr");
    });

    it("returns failed when the binary throws (ENOENT etc.)", async () => {
      const tester = buildTester({
        runCodexVersion: async () => {
          throw new Error("spawn ENOENT");
        },
      });
      const result = await tester.test("codex");
      expect(result.status).toBe("failed");
      expect(result.errorMessage).toBe("spawn ENOENT");
    });

    it("returns unset when no codex command is configured", async () => {
      const tester = buildTester({
        resolveCodexCommand: async () => undefined,
      });
      const result = await tester.test("codex");
      expect(result.status).toBe("unset");
    });
  });

  describe("lastResult cache", () => {
    it("retains the most recent result per kind", async () => {
      const fetcher = buildFetcher({
        status: 200,
        body: JSON.stringify({
          ok: true,
          result: { username: "x", id: 1, is_bot: true },
        }),
      });
      const tester = buildTester({ fetch: fetcher });
      expect(tester.lastResult("telegram")).toBeUndefined();
      const fresh = await tester.test("telegram");
      const cached = tester.lastResult("telegram");
      expect(cached).toEqual(fresh);
    });
  });
});
