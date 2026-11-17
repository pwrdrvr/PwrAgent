import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { setImmediate } from "node:timers/promises";
import { privateResponseHarness } from "./fixtures/private-response-harness";

// The oracle is the adapter promise: an explicit tool suppresses source output
// only after visible delivery. A natural-language private request always
// withholds its answer and attempts one compatibility delivery. The projection
// contains provider-visible bodies, never the controller's flags or helpers.
describe("private-response observable protocol", () => {
  it("preserves explicit-tool and compatibility-fallback delivery across valid sessions", async () => {
    await fc.assert(fc.asyncProperty(fc.record({
      supported: fc.boolean(), deliveryFails: fc.boolean(), fallback: fc.boolean(),
      tool: fc.boolean(), repeats: fc.integer({ min: 1, max: 3 }),
    }), async input => {
      const f = await privateResponseHarness({ privateSupported: input.supported, privateDeliveryFails: input.deliveryFails });
      try {
        const turnId = await f.start("old-thread", input.fallback ? "DM me the fixture answer" : "Fixture input");
        const text = "Fixture answer";
        if (input.tool) {
          const result = await f.controller.handlePwrAgentMessagingRequest({
            operation: "send_private_response", context: { backend: "codex", threadId: "old-thread", turnId }, args: { text },
          });
          expect(result.ok).toBe(input.supported && !input.deliveryFails);
        }
        for (let n = 0; n < input.repeats; n += 1) await f.answer("old-thread", turnId, text);
        for (let n = 0; n < input.repeats; n += 1) await f.complete("old-thread", turnId);
        const privateSuccess = input.supported && !input.deliveryFails && (input.tool || input.fallback);
        const sourceSuccess = !privateSuccess && (!input.fallback || input.tool);
        expect(f.privateTexts.filter(body => body === text)).toHaveLength(privateSuccess ? 1 : 0);
        expect(f.sourceTexts.filter(body => body === text)).toHaveLength(sourceSuccess ? 1 : 0);
      } finally {
        await f.close();
      }
    }), { numRuns: 25 });
  });

  it("withholds source text while a fallback is in flight, including repeated and terminal events", async () => {
    await fc.assert(fc.asyncProperty(fc.scheduler(), fc.boolean(), async (scheduler, terminal) => {
      let entered!: () => void;
      const deliveryEntered = new Promise<void>(resolve => { entered = resolve; });
      const f = await privateResponseHarness({ beforePrivateDelivery: async () => {
        entered();
        await scheduler.schedule(Promise.resolve(), "private provider response");
      } });
      try {
        const turnId = await f.start("old-thread", "DM me the fixture answer");
        const first = f.answer("old-thread", turnId, "Fixture concurrent answer");
        await Promise.race([deliveryEntered, first.then(() => {
          expect(f.privateTexts, "the private fallback must reach the provider").toContain("Fixture concurrent answer");
        })]);
        const repeated = scheduler.schedule(Promise.resolve(), "repeated final item").then(async () => {
          await f.answer("old-thread", turnId, "Fixture concurrent answer");
        });
        const completion = terminal
          ? scheduler.schedule(Promise.resolve(), "terminal notification").then(async () => { await f.complete("old-thread", turnId); })
          : Promise.resolve();
        await scheduler.waitFor(Promise.all([first, repeated, completion]));
        await setImmediate();
        expect(f.privateTexts.filter(body => body === "Fixture concurrent answer")).toHaveLength(1);
        expect(f.sourceTexts).not.toContain("Fixture concurrent answer");
      } finally {
        await f.close();
      }
    }), { numRuns: 25 });
  });
});
