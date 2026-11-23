import { setImmediate } from "node:timers/promises";
import fc from "fast-check";
import { expect, it, vi } from "vitest";
import type {
  MessagingBindingRecord,
  MessagingDeliveryResult,
  MessagingDeliveryScope,
  MessagingSurfaceIntent,
} from "@pwragent/messaging-interface";
import { PERMISSIVE_CAPABILITY_PROFILE } from "@pwragent/messaging-interface/testing";
import { TelegramAdapter, type TelegramBotApi } from "@pwragent/messaging-provider-telegram";
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

function fixture(
  deliver: DeliveryOptions["adapter"]["deliver"],
  resolveDeliveryScope: DeliveryOptions["adapter"]["resolveDeliveryScope"] = () => scope,
) {
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
      resolveDeliveryScope,
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

const telegramBinding: MessagingBindingRecord = {
  ...binding,
  channel: { channel: "telegram", conversation: { id: "101", kind: "topic", parentId: "-100777" } },
};

function telegramFixture(api: Partial<TelegramBotApi>) {
  const f = fixture((routed) => adapter.deliver(routed), (routed) => adapter.resolveDeliveryScope(routed));
  const adapter = new TelegramAdapter({
    api: api as TelegramBotApi,
    config: { channel: "telegram", botToken: "12345:fixture-token", authorizedActorIds: [] },
    now: f.now,
    pollOnStart: false,
  });
  return { ...f, adapter };
}

it("queues the Release Stats reply after an explicit rich-send 429", async () => {
  await fc.assert(fc.asyncProperty(fc.option(fc.integer({ min: 1, max: 60 })), async (seconds) => {
    const attempts: number[] = [];
    const f = telegramFixture({
      sendRichMessage: async () => {
        attempts.push(f.now());
        if (attempts.length === 1) {
          throw Object.assign(new Error("Too Many Requests"), {
            error_code: 429, ...(seconds === null ? {} : { parameters: { retry_after: seconds } }),
          });
        }
        return { chat: { id: -100777, type: "supergroup" }, message_id: 123 };
      },
    });
    const richReply: MessagingSurfaceIntent = {
      ...intent,
      parts: [{ type: "text", markdown: "markdown", text: "| Asset | Downloads |\n| --- | --- |\n| ZIP | 123 |" }],
    };
    const deadline = 1_000 + (seconds ?? 1) * 1_000 + 2_000;
    const sleepUntil = f.options.sleepUntil;
    f.options.sleepUntil = async (retryAt, clock) => {
      expect(retryAt).toBe(deadline);
      const scope = f.adapter.resolveDeliveryScope({
        ...intent,
        audit: {
          actor: { platformUserId: "42" },
          channel: { channel: "telegram", conversation: { id: "102", kind: "topic", parentId: "-100777" } },
          occurredAt: clock(),
        },
      });
      expect(f.options.deliveryBudget.admit({ priority: "routine_status", scope }))
        .toMatchObject({ outcome: "dropped", reason: "cool-off" });
      await sleepUntil(retryAt, clock);
    };
    await expect(f.owner.deliver(richReply, telegramBinding)).resolves.toMatchObject({ outcome: "presented" });
    expect(attempts).toEqual([1_000, deadline]);
    expect(f.trace.filter((entry) => entry.startsWith("persist:"))).toEqual(["persist:presented"]);
  }), { examples: [[11], [null]] });
});

it("does not replay a Telegram timeout or a multipart reply with a delivered chunk", async () => {
  await fc.assert(fc.asyncProperty(fc.boolean(), async (partial) => {
    const sent = { chat: { id: -100777, type: "supergroup" as const }, message_id: 123 };
    const sendMessage = vi.fn<TelegramBotApi["sendMessage"]>();
    if (partial) sendMessage.mockResolvedValueOnce(sent);
    sendMessage.mockRejectedValueOnce(partial
      ? Object.assign(new Error("Too Many Requests"), { error_code: 429, parameters: { retry_after: 11 } })
      : new Error("socket timeout"));
    const f = telegramFixture({ sendMessage });
    const reply: MessagingSurfaceIntent = {
      ...intent,
      parts: [{ type: "text", text: partial ? "x".repeat(5_000) : "Fixture reply" }],
    };
    await expect(f.owner.deliver(reply, telegramBinding)).resolves.toMatchObject({ outcome: "failed" });
    expect(sendMessage).toHaveBeenCalledTimes(partial ? 2 : 1);
    expect(f.trace).not.toContain("wait");
  }));
});

it("paces replies across Telegram topics and federated owners in the same group", async () => {
  await fc.assert(fc.asyncProperty(fc.boolean(), fc.integer({ min: 102, max: 1_000 }), async (remoteFirst, topicId) => {
    const attempts: number[] = [];
    const f = telegramFixture({
      sendMessage: async () => {
        attempts.push(f.now());
        return { chat: { id: -100777, type: "supergroup" }, message_id: attempts.length };
      },
    });
    const remote: MessagingBindingRecord = {
      ...telegramBinding,
      channel: { channel: "telegram", conversation: { id: String(topicId), kind: "topic", parentId: "-100777" } },
      federatedThread: { backend: "codex", threadId: "fixture-peer-thread", target: { scope: "remote", instanceId: "fixture-peer" } },
    };
    const bindings = remoteFirst ? [remote, telegramBinding] : [telegramBinding, remote];
    for (const target of bindings) {
      await expect(f.owner.deliver(intent, target)).resolves.toMatchObject({ outcome: "presented" });
    }
    expect(attempts[1]! - attempts[0]!).toBeGreaterThanOrEqual(1_000);
  }));
});

it("counts a Telegram stream preview and a final reply in the same budget", async () => {
  const attempts: number[] = [];
  const f = telegramFixture({
    sendMessage: async () => {
      attempts.push(f.now());
      return { chat: { id: -100777, type: "supergroup" }, message_id: attempts.length };
    },
  });
  const preview: MessagingSurfaceIntent = {
    id: "fixture-preview", createdAt: 1_000, kind: "stream_update", role: "assistant",
    policy: "enabled", text: "Working", stream: { key: "fixture-stream", sequence: 1, isFinal: false },
  };
  await expect(f.owner.deliver(preview, telegramBinding)).resolves.toMatchObject({ outcome: "presented" });
  await expect(f.owner.deliver(intent, telegramBinding)).resolves.toMatchObject({ outcome: "presented" });
  expect(attempts).toEqual([1_000, 2_100]);
});

it("queues retirement and unpin even when the old status just used the pacing slot", async () => {
  const calls: string[] = [];
  const sent = { chat: { id: -100777, type: "supergroup" as const }, message_id: 8 };
  const f = telegramFixture({
    sendMessage: async () => { calls.push("present"); return sent; },
    editMessageText: async () => { calls.push("retire"); return sent; },
    unpinChatMessage: async () => { calls.push("unpin"); return true; },
  });
  const targetSurface = { channel: "telegram" as const, id: "8", state: { opaque: { chatId: -100777, messageId: 8 } } };
  await f.owner.deliver(intent, telegramBinding);
  await f.owner.deliver({
    id: "status-retire:fixture", kind: "status", createdAt: 1_000,
    text: "Retired", status: "idle", actions: [], targetSurface, delivery: { mode: "update" },
  }, telegramBinding);
  await f.owner.deliver({
    id: "status-unpin:fixture", kind: "dismiss", createdAt: 1_000, targetSurface, delivery: { mode: "dismiss", unpin: true },
  }, telegramBinding);
  expect(calls).toEqual(["present", "retire", "unpin"]);
});

it("releases the chat slot when Telegram throttles a preview before it reaches the API", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1_100, max: 1_999 }), async (spacing) => {
    const calls: number[] = [];
    const f = telegramFixture({
      sendMessage: async () => {
        calls.push(f.now());
        return { chat: { id: -100777, type: "supergroup" }, message_id: calls.length };
      },
    });
    const preview: MessagingSurfaceIntent = {
      id: "preview", createdAt: 1_000, kind: "stream_update", role: "assistant", policy: "enabled",
      text: "Working", stream: { key: "preview", sequence: 1, isFinal: false },
    };
    for (let index = 0; index < 3; index++) {
      await f.owner.deliver({ ...preview, stream: { ...preview.stream, key: String(index) } }, telegramBinding);
      await f.options.sleepUntil(f.now() + spacing, f.now);
    }
    const finalAt = f.now();
    await expect(f.owner.deliver(preview, telegramBinding)).resolves.toMatchObject({ outcome: "discarded" });
    await f.owner.deliver(intent, telegramBinding);
    expect(calls).toHaveLength(4);
    expect(calls.at(-1)).toBe(finalAt);
  }));
});

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
