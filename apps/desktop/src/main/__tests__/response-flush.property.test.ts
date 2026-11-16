import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { createResponseFlush } from "../util/response-flush";

describe("response acknowledgement", () => {
  it("settles once according to the first transport outcome", async () => {
    await fc.assert(fc.asyncProperty(fc.array(fc.boolean(), { minLength: 1, maxLength: 20 }), async (outcomes) => {
      const flush = createResponseFlush();
      for (const failed of outcomes) flush.finish(failed ? new Error("closed") : undefined);
      if (outcomes[0]) await expect(flush.promise).rejects.toThrow("closed");
      else await expect(flush.promise).resolves.toBeUndefined();
    }));
  });

  it("fails within the acknowledgement deadline and cannot later authorize shutdown", async () => {
    vi.useFakeTimers();
    try {
      const flush = createResponseFlush(25);
      await vi.advanceTimersByTimeAsync(25);
      flush.finish();
      await expect(flush.promise).rejects.toThrow("timed out");
    } finally {
      vi.useRealTimers();
    }
  });
});
