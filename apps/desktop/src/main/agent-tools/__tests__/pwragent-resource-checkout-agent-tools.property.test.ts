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

/** Keys the tools accept; a blank key is refused before any of this runs. */
const keyArb = fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$/);
/** The same key as an agent may send it: the authority trims it. */
const paddingArb = fc.constantFrom("", " ", "  ");

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

describe("resource checkout tools: machine CPU scope", () => {
  it("describes machine CPU reservations as advisory during discovery", () => {
    const tools = buildResourceCheckoutToolDefinitions(async () => null);
    const tool = tools.find((definition) => definition.name === "resource_checkout_discover");
    expect(tool?.description).toMatch(/machine CPU reservations are advisory/i);
  });

  it.each(["resource_checkout_action", "resource_checkout_acquire"])("advertises the machine CPU policy in %s", (name) => {
    const tools = buildResourceCheckoutToolDefinitions(async () => null);
    const tool = tools.find((definition) => definition.name === name);
    expect(tool?.description).toMatch(/substantial workloads or when the operator explicitly requests a reservation/i);
    expect(tool?.description).toMatch(/start routine dev launches, short debugger or profiler sessions, and lightweight inspection without requesting or waiting for a checkout/i);
    expect(tool?.description).toMatch(/explicit units on counted resources/i);
    expect(tool?.description).toMatch(/resource_checkout_discover.*sharing\.capacity.*cap command parallelism at that capacity.*set units to the capped parallel worker count/i);
  });
});

describe("resource checkout tools: waiting for a grant", () => {
  it("names wait-with-continuation on exactly the results that leave the request queued", async () => {
    await fc.assert(fc.asyncProperty(statusArb, actionResultArb, keyArb, paddingArb, async (status, result, key, pad) => {
      const handler = handlerFor(status, result);
      const sent = `${pad}${key}${pad}`;
      const read = await handler("resource_checkout_status", { resourceId: RESOURCE, idempotencyKey: sent }, context);
      const waited = await handler("resource_checkout_wait", { resourceId: RESOURCE, idempotencyKey: sent, timeoutMs: 1 }, context);
      const requested = await handler("resource_checkout_action", {
        action: { kind: "request", resourceId: RESOURCE, idempotencyKey: sent, purpose: "tests", expectedDurationMs: 60_000, units: 4 },
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
    expect(description("resource_checkout_action")).not.toMatch(/omit units to reserve the full machine pool/i);
    expect(description("resource_checkout_acquire")).toMatch(/try\/finally/i);
    expect(description("resource_checkout_wait")).toMatch(/Pass continuation.*end the turn/);
    expect(description("resource_checkout_status")).toMatch(/Do not call it repeatedly to wait for a grant/);
  });
});
