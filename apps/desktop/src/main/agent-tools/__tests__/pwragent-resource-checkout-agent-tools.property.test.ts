import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { DesktopResourceCheckoutService } from "../../resource-checkouts/resource-checkout-service";
import type { AgentToolCallContext } from "../agent-tool-definition";
import {
  buildResourceCheckoutToolDefinitions,
  createResourceCheckoutToolHandler,
  queuedCheckoutNextStep,
} from "../pwragent-resource-checkout-agent-tools";

/**
 * Agents read a queued checkout as "poll until granted" and slept in shells,
 * waking before the grant or long after it. The rule:
 *
 * - Every tool result that leaves this thread's request queued names the
 *   one way to wait: resource_checkout_wait with a continuation, then end
 *   the turn. No result that is not queued carries that step.
 * - No tool description tells an agent to poll status for a grant.
 */

const RESOURCE = "machine:mach_1:cpu";
const context = { backend: "claude", threadId: "t1" } as unknown as AgentToolCallContext;

const statusArb = fc.oneof(
  fc.constant(null),
  fc.record({
    receipt: fc.constantFrom({ outcome: "queued", queueEntryId: "q1", position: 2 }, { outcome: "granted", allocationId: "a1", generation: 3 }),
    state: fc.constantFrom("queued", "granted", "ended"),
    position: fc.integer({ min: 1, max: 9 }),
    durationMs: fc.integer({ min: 1, max: 3_600_000 }),
  }),
);

const actionResultArb = fc.oneof(
  fc.record({ outcome: fc.constant("queued"), queueEntryId: fc.constant("q1"), position: fc.integer({ min: 1, max: 9 }) }),
  fc.record({ outcome: fc.constant("granted"), allocationId: fc.constant("a1"), generation: fc.integer({ min: 1, max: 9 }) }),
  fc.record({ outcome: fc.constant("rejected"), reason: fc.constant("policy"), message: fc.constant("no") }),
  fc.record({ outcome: fc.constant("unknown"), message: fc.constant("?") }),
);

function handlerFor(status: unknown, result: unknown) {
  const service = {
    threadActor: () => ({ key: "thread:claude:t1" }),
    status: async () => status,
    perform: async () => result,
  } as unknown as DesktopResourceCheckoutService;
  return createResourceCheckoutToolHandler(service);
}

const isQueued = (value: unknown): boolean => {
  if (!value || typeof value !== "object") return false;
  const record = value as { state?: unknown; outcome?: unknown };
  return "state" in record ? record.state === "queued" : record.outcome === "queued";
};

describe("resource checkout tools: waiting for a grant", () => {
  it("names wait-with-continuation on exactly the results that leave the request queued", async () => {
    await fc.assert(fc.asyncProperty(statusArb, actionResultArb, fc.string({ minLength: 1, maxLength: 20 }), async (status, result, key) => {
      const handler = handlerFor(status, result);
      const read = await handler("resource_checkout_status", { resourceId: RESOURCE, idempotencyKey: key }, context);
      const waited = await handler("resource_checkout_wait", { resourceId: RESOURCE, idempotencyKey: key, timeoutMs: 1 }, context);
      const requested = await handler("resource_checkout_action", {
        action: { kind: "request", resourceId: RESOURCE, idempotencyKey: key, purpose: "tests", expectedDurationMs: 60_000, units: 4 },
      }, context);
      for (const [answer, source] of [[read, status], [waited, status], [requested, result]] as const) {
        const next = (answer as { next?: string } | null)?.next;
        if (isQueued(source)) {
          expect(next).toBe(queuedCheckoutNextStep(RESOURCE, key));
          expect(next).toMatch(/resource_checkout_wait .*continuation.*end the turn/);
        } else {
          expect(next).toBeUndefined();
        }
      }
    }));
  });

  it("never tells an agent to poll for a grant", () => {
    const tools = buildResourceCheckoutToolDefinitions(async () => null);
    const description = (name: string) => tools.find((tool) => tool.name === name)!.description;
    for (const tool of tools) {
      expect(tool.description).not.toMatch(/inspect status .* to see a queued request/i);
    }
    expect(description("resource_checkout_action")).toMatch(/resource_checkout_wait .*continuation, then end the turn/);
    expect(description("resource_checkout_wait")).toMatch(/Pass continuation.*end the turn/);
    expect(description("resource_checkout_status")).toMatch(/Do not call it repeatedly to wait for a grant/);
  });
});
