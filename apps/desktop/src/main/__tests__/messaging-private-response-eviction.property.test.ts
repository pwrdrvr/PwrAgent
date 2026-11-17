import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { privateResponseHarness } from "./fixtures/private-response-harness";

async function runEvictionScenario(count: number): Promise<void> {
  const f = await privateResponseHarness({ failContinuation: true });
  try {
    const turnId = await f.start("old-thread", "DM me the fixture answer");
    await f.answer("old-thread", turnId, "Old private answer");
    expect(f.privateTexts.filter(text => text === "Old private answer")).toHaveLength(1);
    expect(f.continuationFailures()).toBe(1);
    // Cross both actual 1,000-key terminal/attempt bounds while the old
    // provider turn is still live. The source fallback marker survives
    // because each successful explicit tool call removes its own marker.
    for (let i = 0; i < count; i += 1) {
      const next = await f.start("fill-thread");
      const response = await f.controller.handlePwrAgentMessagingRequest({
        operation: "send_private_response", context: { backend: "codex", threadId: "fill-thread", turnId: next },
        args: { text: "Fixture private reply" },
      });
      expect(response.ok).toBe(true);
      await f.complete("fill-thread", next);
    }
    await f.answer("old-thread", turnId, "Old private answer");
    expect(f.privateTexts.filter(text => text === "Old private answer"), "a delivered fallback must never be delivered twice").toHaveLength(1);
    expect(f.sourceTexts).not.toContain("Old private answer");
  } finally {
    await f.close();
  }
}

// Counterexample to the at-most-once promise, kept separate from the intended
// sequential/interleaved observable model. These are real public controller
// calls and real SQLite bindings, with contrived provider protocol data.
describe("private-response fallback eviction", () => {
  it("retains the old turn after exactly 1,000 other private turns complete", async () => {
    await runEvictionScenario(1_000);
  });

  it("does not redeliver a fallback after its successful delivery outlives continuation setup and history pressure", async () => {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 1_000, max: 1_002 }), async count => {
      await runEvictionScenario(count);
    }), { numRuns: 1 });
  });
});
