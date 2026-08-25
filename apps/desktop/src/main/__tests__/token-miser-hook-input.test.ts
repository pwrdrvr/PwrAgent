import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { readTokenMiserHookInput } from "../token-miser/token-miser-hook-input";

describe("readTokenMiserHookInput", () => {
  it("rejects as soon as hook input exceeds its byte limit", async () => {
    const input = new PassThrough();
    const result = readTokenMiserHookInput(input, 8);

    input.write("12345678");
    input.end("9");

    await expect(result).rejects.toThrow("exceeds 8 bytes");
  });
});
