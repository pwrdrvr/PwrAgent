import { inspect } from "node:util";
import fc from "fast-check";
import { GrammyError, HttpError } from "grammy";
import { describe, expect, it, vi } from "vitest";
import { TelegramAdapter, type TelegramBotApi } from "../telegram-adapter.ts";

const startupMethods = ["getMe", "getWebhookInfo", "deleteWebhook", "setMyCommands"] as const;
type StartupMethod = typeof startupMethods[number];

const syntheticToken = "1234567890:SyntheticBotToken";
const tokenArbitrary = fc.tuple(
  fc.integer({ min: 1_000_000, max: 9_999_999 }),
  fc.stringMatching(/^[A-Za-z0-9_-]{15,35}$/),
).map(([id, secret]) => `${id}:${secret}`);

function timeout(method: StartupMethod, token: string): HttpError {
  return new HttpError(`Network request for '${method}' failed!`, Object.assign(
    new Error(`request to https://api.telegram.org/bot${token}/${method} failed`),
    { code: "ETIMEDOUT" },
  ));
}

function setup(
  botToken = syntheticToken,
  waitForStartupRetry: (delayMs: number, signal: AbortSignal) => Promise<void> = async () => {},
) {
  const api = {
    getMe: vi.fn().mockResolvedValue({ id: 42, is_bot: true, username: "TestBot" }),
    getWebhookInfo: vi.fn().mockResolvedValue({ url: "" }),
    deleteWebhook: vi.fn().mockResolvedValue(true),
    setMyCommands: vi.fn().mockResolvedValue(true),
  };
  const poll = vi.fn(async () => {});
  const logger = { debug: vi.fn(), warn: vi.fn() };
  const options = {
    bot: { api: api as unknown as TelegramBotApi, start: poll },
    config: { channel: "telegram" as const, botToken, authorizedActorIds: [] },
    logger,
    waitForStartupRetry,
  };
  const adapter = new TelegramAdapter(options);
  return { adapter, api, logger, poll };
}

describe("Telegram startup retries", () => {
  it("polls once after transient setup failures within the retry budget", async () => {
    await fc.assert(fc.asyncProperty(
      fc.constantFrom(...startupMethods),
      fc.integer({ min: 1, max: 2 }),
      fc.option(fc.integer({ min: 500, max: 599 }), { nil: undefined }),
      async (method, failures, status) => {
        const { adapter, api, poll } = setup();
        const error = status === undefined
          ? timeout(method, syntheticToken)
          : new GrammyError("Call failed", {
            ok: false,
            error_code: status,
            description: "Server error",
          }, method, {});
        for (let attempt = 0; attempt < failures; attempt += 1) {
          api[method].mockRejectedValueOnce(error);
        }

        await expect(adapter.start(vi.fn())).resolves.toBeUndefined();

        expect(api[method]).toHaveBeenCalledTimes(failures + 1);
        expect(poll).toHaveBeenCalledTimes(1);
      },
    ));
  });

  it("stops retrying an unreachable API and keeps credentials out of failure diagnostics", async () => {
    await fc.assert(fc.asyncProperty(tokenArbitrary, async (token) => {
      const { adapter, api, logger, poll } = setup(token);
      api.getWebhookInfo.mockRejectedValue(timeout("getWebhookInfo", token));

      const startup = adapter.start(vi.fn());
      await expect(startup).rejects.toThrow("getWebhookInfo");
      const failure = await startup.catch((error: unknown) => error);

      const output = JSON.stringify(logger.warn.mock.calls);
      expect(output.includes(token), "startup warnings contain a bot token").toBe(false);
      expect(inspect(failure).includes(token), "startup failure exposes a bot token").toBe(false);
      expect(output).toContain("ETIMEDOUT");
      expect(api.getWebhookInfo).toHaveBeenCalledTimes(3);
      expect(poll).not.toHaveBeenCalled();
    }));
  });

  it("starts polling when the identity and webhook lookups recover from timeouts", async () => {
    const { adapter, api, poll } = setup();
    api.getMe.mockRejectedValueOnce(timeout("getMe", syntheticToken));
    api.getWebhookInfo.mockRejectedValueOnce(timeout("getWebhookInfo", syntheticToken));

    await expect(adapter.start(vi.fn())).resolves.toBeUndefined();

    expect(api.getMe).toHaveBeenCalledTimes(2);
    expect(api.getWebhookInfo).toHaveBeenCalledTimes(2);
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it("redacts the token in the timeout cause", async () => {
    const { adapter, api, logger } = setup();
    api.getWebhookInfo.mockRejectedValue(timeout("getWebhookInfo", syntheticToken));

    await expect(adapter.start(vi.fn())).rejects.toThrow("getWebhookInfo");

    expect(logger.warn).toHaveBeenCalledWith("telegram getWebhookInfo failed", expect.objectContaining({
      code: "ETIMEDOUT",
      cause: "request to https://api.telegram.org/bot<redacted>/getWebhookInfo failed",
    }));
  });

  it("does not retry an authentication rejection", async () => {
    const { adapter, api, poll } = setup();
    api.getWebhookInfo.mockRejectedValue(new GrammyError("Call failed", {
      ok: false,
      error_code: 401,
      description: "Unauthorized",
    }, "getWebhookInfo", {}));

    await expect(adapter.start(vi.fn())).rejects.toThrow("Unauthorized");

    expect(api.getWebhookInfo).toHaveBeenCalledTimes(1);
    expect(poll).not.toHaveBeenCalled();
  });

  it("cancels an outstanding retry without issuing another request or starting polling", async () => {
    await fc.assert(fc.asyncProperty(fc.constantFrom(...startupMethods), async (method) => {
      let notifyRetry!: (signal: AbortSignal) => void;
      const waiting = new Promise<AbortSignal>((resolve) => { notifyRetry = resolve; });
      let finishBackoff!: () => void;
      const backoff = new Promise<void>((resolve) => { finishBackoff = resolve; });
      const { adapter, api, poll } = setup(syntheticToken, async (_delayMs, signal) => {
        notifyRetry(signal);
        await backoff;
      });
      api[method].mockRejectedValueOnce(timeout(method, syntheticToken));

      const startup = adapter.start(vi.fn());
      const signal = await Promise.race([
        waiting,
        startup.then(() => { throw new Error("Startup finished before scheduling a retry"); }),
      ]);
      await adapter.stop();
      finishBackoff();
      await startup;

      expect(signal.aborted).toBe(true);
      expect(api[method]).toHaveBeenCalledTimes(1);
      expect(poll).not.toHaveBeenCalled();
    }));
  });
});
