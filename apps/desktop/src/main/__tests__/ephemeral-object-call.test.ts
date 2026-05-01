import { describe, expect, it, vi } from "vitest";
import { XaiEphemeralObjectCaller } from "../app-server/ephemeral-object-call";

function makeStructuredResult(object: unknown, cachedTokens?: number) {
  return {
    object,
    cachedTokens,
  };
}

describe("XaiEphemeralObjectCaller", () => {
  it("returns parsed object output from an injected client", async () => {
    const client = {
      generateObject: vi.fn(async () => makeStructuredResult({ title: "PROJECT-123 crash" }, 42)),
    };
    const caller = new XaiEphemeralObjectCaller({ client, model: "grok-test-model" });

    const result = await caller.generateObject({
      promptCacheKey: "thread-title-v1",
      headers: { "x-grok-conv-id": "thread-title-v1" },
      schema: { type: "object" },
      schemaName: "thread_title",
      system: "Return a title.",
      prompt: "PROJECT-123 investigate crash",
      timeoutMs: 5_000,
    });

    expect(result).toEqual({
      status: "ok",
      response: {
        object: { title: "PROJECT-123 crash" },
        cachedTokens: 42,
      },
    });
    expect(client.generateObject).toHaveBeenCalledWith({
      model: "grok-test-model",
      promptCacheKey: "thread-title-v1",
      headers: { "x-grok-conv-id": "thread-title-v1" },
      signal: expect.any(AbortSignal),
      schema: { type: "object" },
      schemaName: "thread_title",
      system: "Return a title.",
      prompt: "PROJECT-123 investigate crash",
    });
  });

  it("returns unavailable when no xAI credentials are configured", async () => {
    const originalXaiApiKey = process.env.XAI_API_KEY;
    delete process.env.XAI_API_KEY;

    try {
      const caller = new XaiEphemeralObjectCaller({
        resolveRuntimeConfig: () => ({
          apiKey: undefined,
          baseUrl: undefined,
          model: "grok-4.20-reasoning",
          configPath: "/tmp/grok-config.toml",
          stateRoot: "/tmp/grok-state",
        }),
      });

      await expect(
        caller.generateObject({
          schema: { type: "object" },
          system: "Return a title.",
          prompt: "Name this thread.",
        })
      ).resolves.toEqual({
        status: "unavailable",
        reason: "xai_unavailable",
      });
    } finally {
      if (originalXaiApiKey === undefined) {
        delete process.env.XAI_API_KEY;
      } else {
        process.env.XAI_API_KEY = originalXaiApiKey;
      }
    }
  });

  it("ignores xAI credentials from runtime config", async () => {
    const originalXaiApiKey = process.env.XAI_API_KEY;
    delete process.env.XAI_API_KEY;

    try {
      const caller = new XaiEphemeralObjectCaller({
        resolveRuntimeConfig: () => ({
          apiKey: "config-key",
          baseUrl: "https://api.example.test/v1",
          model: "grok-4.20-reasoning",
          configPath: "/tmp/grok-config.toml",
          stateRoot: "/tmp/grok-state",
        }),
      });

      await expect(
        caller.generateObject({
          schema: { type: "object" },
          system: "Return a title.",
          prompt: "Name this thread.",
        })
      ).resolves.toEqual({
        status: "unavailable",
        reason: "xai_unavailable",
      });
    } finally {
      if (originalXaiApiKey === undefined) {
        delete process.env.XAI_API_KEY;
      } else {
        process.env.XAI_API_KEY = originalXaiApiKey;
      }
    }
  });

  it("returns failed when the object call rejects", async () => {
    const client = {
      generateObject: vi.fn(async () => {
        throw new Error("timeout");
      }),
    };
    const caller = new XaiEphemeralObjectCaller({ client });

    await expect(
      caller.generateObject({
        schema: { type: "object" },
        system: "Return a title.",
        prompt: "Name this thread.",
      })
    ).resolves.toEqual({
      status: "failed",
      reason: "timeout",
    });
  });
});
