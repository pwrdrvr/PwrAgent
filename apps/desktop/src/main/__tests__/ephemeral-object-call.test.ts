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
    const caller = new XaiEphemeralObjectCaller({ client });

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
      model: undefined,
      promptCacheKey: "thread-title-v1",
      headers: { "x-grok-conv-id": "thread-title-v1" },
      schema: { type: "object" },
      schemaName: "thread_title",
      system: "Return a title.",
      prompt: "PROJECT-123 investigate crash",
      timeoutMs: 5_000,
    });
  });

  it("returns unavailable when no process-backed client is configured", async () => {
    const caller = new XaiEphemeralObjectCaller();

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
