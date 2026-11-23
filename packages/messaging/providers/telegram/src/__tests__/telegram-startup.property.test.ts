import { inspect } from "node:util";
import { setImmediate, setTimeout as wait } from "node:timers/promises";
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
  waitForStartupDelay = (delayMs: number, signal: AbortSignal) => delayMs === 5_000
    ? wait(delayMs, undefined, { signal })
    : waitForStartupRetry(delayMs, signal),
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
    waitForStartupDelay,
  };
  const adapter = new TelegramAdapter(options);
  return { adapter, api, logger, poll };
}

function startupClock() {
  let now = 0;
  const timers: Array<{ at: number; fire: () => void }> = [];
  return {
    wait: (delayMs: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
      signal.throwIfAborted();
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      timers.push({
        at: now + delayMs,
        fire: () => {
          signal.removeEventListener("abort", abort);
          resolve();
        },
      });
    }),
    async advanceTo(target: number) {
      for (;;) {
        timers.sort((left, right) => left.at - right.at);
        const timer = timers[0];
        if (!timer || timer.at > target) break;
        timers.shift();
        now = timer.at;
        timer.fire();
        await setImmediate();
      }
      now = target;
    },
  };
}

async function expectIdentityLookupToYield(firstFailureMs: number) {
  const clock = startupClock();
  const { adapter, api, poll } = setup(syntheticToken, clock.wait, clock.wait);
  // Leave the retry pending past the desktop deadline. Required setup is responsive.
  api.getMe.mockImplementationOnce(async (signal: AbortSignal) => {
    await clock.wait(firstFailureMs, signal);
    throw timeout("getMe", syntheticToken);
  }).mockImplementation(async (signal: AbortSignal) => {
    await clock.wait(90_000, signal);
    return { id: 42, is_bot: true, username: "TestBot" };
  });

  const startup = adapter.start(vi.fn());
  try {
    await clock.advanceTo(5_000);
    expect(api.getWebhookInfo).toHaveBeenCalledTimes(1);
    expect(poll).toHaveBeenCalledTimes(1);
    expect(api.getMe.mock.lastCall?.[0].aborted).toBe(true);
    expect(api.getWebhookInfo.mock.lastCall?.[0].aborted).toBe(false);
    expect(adapter.readDmPairingAccountId()).toBe("1234567890");
    expect(adapter.readDmPairingAddress()).toBeUndefined();
  } finally {
    await adapter.stop();
    await startup;
  }
}

describe("Telegram startup retries", () => {
  it("limits cumulative time spent on optional identity attempts and backoff", async () => {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 0, max: 90_000 }), expectIdentityLookupToYield));
  });

  it("starts required setup when the first identity request would have taken 45 seconds", async () => {
    await expectIdentityLookupToYield(45_000);
  });

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
