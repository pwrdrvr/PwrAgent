import { describe, expect, it, vi } from "vitest";
import { EphemeralObjectCaller } from "../app-server/ephemeral-object-call";

function makeStructuredResult(object: unknown, cachedTokens?: number) {
  return {
    object,
    cachedTokens,
  };
}

describe("EphemeralObjectCaller", () => {
  it("returns parsed object output from an injected client", async () => {
    const client = {
      generateObject: vi.fn(async () => makeStructuredResult({ title: "PROJECT-123 crash" }, 42)),
    };
    const caller = new EphemeralObjectCaller({ client });

    const result = await caller.generateObject({
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
      schema: { type: "object" },
      schemaName: "thread_title",
      system: "Return a title.",
      prompt: "PROJECT-123 investigate crash",
      timeoutMs: 5_000,
    });
  });

  it("returns unavailable when no process-backed client is configured", async () => {
    const caller = new EphemeralObjectCaller();

    await expect(
      caller.generateObject({
        schema: { type: "object" },
        system: "Return a title.",
        prompt: "Name this thread.",
      })
    ).resolves.toEqual({
      status: "unavailable",
      reason: "structured_generation_unavailable",
    });
  });

  it("returns failed when the object call rejects", async () => {
    const client = {
      generateObject: vi.fn(async () => {
        throw new Error("timeout");
      }),
    };
    const caller = new EphemeralObjectCaller({ client });

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
