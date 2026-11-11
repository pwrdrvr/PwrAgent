import fc from "fast-check";
import { expect, it, vi } from "vitest";
import { OwnerConformanceCodexTransport as Provider } from "./fixtures/owner-conformance-codex-transport";

it("closing a fixture provider retires every completion it owns before another owner opens", async () => {
  vi.useFakeTimers();
  try {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 8 }), async count => {
      Provider.reset();
      const provider = new Provider(), events: Array<{ method?: string }> = [];
      provider.setMessageHandler(value => events.push(JSON.parse(value)));
      for (let index = 0; index < count; index++) {
        provider.send(JSON.stringify({ id: index * 2, method: "thread/start", params: { cwd: "/fixture" } }));
        const threadId = [...Provider.threads.keys()].at(-1)!;
        provider.send(JSON.stringify({ id: index * 2 + 1, method: "turn/start", params: { threadId, input: [{ type: "text", text: "quick" }] } }));
      }
      await provider.close();
      Provider.reset();
      await vi.runAllTimersAsync();
      expect(events.filter(event => event.method)).toEqual([]);
    }), { numRuns: 8 });
  } finally { vi.useRealTimers(); }
});
