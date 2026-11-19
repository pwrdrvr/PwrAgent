import { setImmediate } from "node:timers/promises";
import fc from "fast-check";
import { expect, it } from "vitest";
import type {
  MessagingBindingRecord,
  MessagingDeliveryResult,
  MessagingDeliveryScope,
  MessagingSurfaceIntent,
} from "@pwragent/messaging-interface";
import { PERMISSIVE_CAPABILITY_PROFILE } from "@pwragent/messaging-interface/testing";
import { MessagingDeliveryBudget } from "../messaging/core/messaging-delivery-budget";
import { MessagingDeliveryLane } from "../messaging/core/messaging-delivery-lane";
import { MessagingOutboundDelivery } from "../messaging/core/messaging-outbound-delivery";

const scope: MessagingDeliveryScope = {
  id: "telegram:group:fixture",
  kind: "group",
  platform: "telegram",
  budget: { intervalMs: 10_000, limit: 20, reserved: 1 },
};

const binding: MessagingBindingRecord = {
  id: "fixture-binding",
  channel: { channel: "telegram", conversation: { id: "fixture", kind: "channel" } },
  backend: "codex",
  threadId: "fixture-thread",
  authorizedActorIds: ["fixture-actor"],
  createdAt: 1_000,
  updatedAt: 1_000,
};

const intent: MessagingSurfaceIntent = {
  id: "fixture-reply",
  kind: "message",
  role: "assistant",
  createdAt: 1_000,
  parts: [{ type: "text", text: "Fixture reply" }],
};

type DeliveryOptions = ConstructorParameters<typeof MessagingOutboundDelivery>[0];

function fixture(deliver: DeliveryOptions["adapter"]["deliver"]) {
  let time = 1_000;
  const now = () => time;
  const trace: string[] = [];
  const writes: DeliveryOptions["store"] = {
    async recordDelivery(record) {
      trace.push(`persist:${record.outcome}`);
      return record;
    },
    async revokeBinding() {
      trace.push("revoke");
      return binding;
    },
  };
  const options = {
    adapter: {
      capabilityProfile: PERMISSIVE_CAPABILITY_PROFILE,
      resolveDeliveryScope: () => scope,
      deliver,
    },
    store: writes,
    deliveryBudget: new MessagingDeliveryBudget({ now }),
    deliveryLane: new MessagingDeliveryLane(),
    sleepUntil: async (retryAt: number, clock: () => number) => {
      expect(clock).toBe(now);
      trace.push("wait");
      time = retryAt;
    },
  };
  const owner = new MessagingOutboundDelivery(options, {
    disposed: false,
    capabilityProfile: PERMISSIVE_CAPABILITY_PROFILE,
    logger: {},
    clock: now,
    now,
    flushToolUpdatesForBinding: async () => { trace.push("flush"); },
    markWorkingCardWaiting: async () => { trace.push("waiting"); },
    desktopActivityLog: () => undefined,
    recordBindingTransition: async (action) => { trace.push(action); },
    notifyBindingChanged: () => { trace.push("binding-changed"); },
    flagDeliveryCheck: async () => {},
  });
  return { owner, options, trace, now };
}

it("honors the provider deadline and records only the settled attempt", async () => {
  await fc.assert(fc.asyncProperty(
    fc.boolean(),
    fc.integer({ min: 1, max: 8_000 }),
    async (retryable, retryAfterMs) => {
      const attempts: number[] = [];
      const failed: MessagingDeliveryResult = {
        channel: "telegram", outcome: "failed", deliveredAt: 1_000,
        rateLimit: { scope, retryAfterMs, observedAt: 1_000, retryable },
      };
      const f = fixture(async (routed) => {
        expect(routed.audit?.channel).toEqual(binding.channel);
        expect(routed.allowedActorIds).toEqual(binding.authorizedActorIds);
        attempts.push(f.now());
        f.trace.push("send");
        return attempts.length === 1
          ? failed
          : { channel: "telegram", outcome: "presented", deliveredAt: f.now() };
      });

      const result = await f.owner.deliver(intent, binding);
      expect(result.outcome).toBe(retryable ? "presented" : "failed");
      expect(attempts).toEqual(retryable ? [1_000, 1_000 + retryAfterMs + 2_000] : [1_000]);
      expect(f.trace).toEqual(retryable
        ? ["flush", "send", "wait", "send", "persist:presented"]
        : ["flush", "send", "persist:failed"]);
      expect(f.options.deliveryLane.isOccupied(scope.id)).toBe(false);
    },
  ));
});

it("settles an in-flight adapter result according to the observed cancellation order", async () => {
  await fc.assert(fc.asyncProperty(fc.scheduler(), async (scheduler) => {
    const entered = Promise.withResolvers<void>();
    const cancellation = Promise.withResolvers<void>();
    const providerResult: MessagingDeliveryResult = {
      channel: "telegram", outcome: "failed", deliveredAt: 1_000, errorMessage: "chat not found",
    };
    let cancelled = false;
    const f = fixture(() => {
      const settle = scheduler.schedule(Promise.resolve(providerResult), "adapter settlement");
      entered.resolve();
      return settle;
    });
    const send = f.owner.deliver(intent, binding, undefined, {
      isCancelled: () => cancelled,
      whenCancelled: cancellation.promise,
      onCancelledDelivery: async (result) => {
        expect(result).toBe(providerResult);
        f.trace.push("cancelled-result");
      },
    });
    await entered.promise;
    const cancel = scheduler.schedule(Promise.resolve(), "cancel").then(() => {
      f.trace.push("cancel");
      cancelled = true;
      cancellation.resolve();
    });
    await scheduler.waitNext(1);
    await setImmediate();
    await scheduler.waitNext(1);
    await cancel;
    const result = await send;
    await setImmediate();
    const cancelFirst = scheduler.report()[0]?.label === "cancel";
    expect(result.outcome).toBe(cancelFirst ? "discarded" : "failed");
    expect(f.trace.filter(effect => effect !== "cancel")).toEqual(cancelFirst
      ? ["flush", "cancelled-result"]
      : ["flush", "persist:failed", "revoke", "unbound", "binding-changed"]);
  }), { numRuns: 40 });
});

it("uses the store installed while delivery was in flight", async () => {
  const result = Promise.withResolvers<MessagingDeliveryResult>();
  const entered = Promise.withResolvers<void>();
  const f = fixture(() => {
    entered.resolve();
    return result.promise;
  });
  const send = f.owner.deliver(intent, binding);
  await entered.promise;
  f.options.store = {
    ...f.options.store,
    async recordDelivery(record) {
      f.trace.push(`wrapped:${record.outcome}`);
      return record;
    },
  };
  result.resolve({ channel: "telegram", outcome: "presented", deliveredAt: f.now() });
  await expect(send).resolves.toMatchObject({ outcome: "presented" });
  expect(f.trace).toEqual(["flush", "wrapped:presented"]);
});
