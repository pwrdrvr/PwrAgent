import { setImmediate } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { MessagingBindingService } from "../messaging/core/messaging-binding-service";
import type { MessagingBindingContext, MessagingBindingHost } from "../messaging/core/messaging-binding-context";
import { messagingModules } from "./fixtures/messaging-controller-modules";
import { messagingBindingHarness } from "./fixtures/messaging-binding-harness";

function context(f: Awaited<ReturnType<typeof messagingBindingHarness>>, host: () => MessagingBindingHost): MessagingBindingContext {
  return {
    store: f.controllerOptions.store, backend: f.backend, adapter: f.controllerOptions.adapter,
    capabilityProfile: f.controllerOptions.adapter.capabilityProfile, now: () => 1_000, logger: {}, config: {}, host,
  };
}

describe("messaging binding owner ports and effects", () => {
  it("constructs without reading any collaborator or optional configuration getter", async () => {
    const f = await messagingBindingHarness();
    try {
      const base = context(f, () => messagingModules(f.controller).bindingHost());
      let reads = 0;
      new MessagingBindingService({
        get store() { reads++; return base.store; },
        get backend() { reads++; return base.backend; },
        get adapter() { reads++; return base.adapter; },
        get capabilityProfile() { reads++; return base.capabilityProfile; },
        get now() { reads++; return base.now; },
        get logger() { reads++; return base.logger; },
        get config() { reads++; return base.config; },
        host: () => { reads++; return base.host(); },
      });
      expect(reads).toBe(0);
    } finally { await f.close(); }
  });

  it("resolves the replacement store and host after binding permission completes", async () => {
    const f = await messagingBindingHarness();
    const other = await messagingBindingHarness();
    try {
      const original = messagingModules(f.controller).bindingHost();
      let store: MessagingBindingContext["store"] = f.store;
      const effects: string[] = [];
      let host: MessagingBindingHost = { ...original, requireRemoteScope: async () => {
        await setImmediate();
        store = other.store;
        host = { ...original, desktopActivityLog: () => { effects.push("replacement"); return undefined; } };
        return true;
      } };
      const owner = new MessagingBindingService({ ...context(f, () => host), get store() { return store; } });
      const bound = await owner.bindChannelToThread(f.event("resume"), { backend: "codex", threadId: "thread-a" });
      expect(await f.active()).toBeUndefined();
      expect((await other.active())?.id).toBe(bound.id);
      expect(effects).toEqual(["replacement"]);
    } finally { await other.close(); await f.close(); }
  });

  it("preserves the optional audit getter outside the method's best-effort catch", async () => {
    const f = await messagingBindingHarness();
    try {
      const failure = new Error("Fixture optional getter failure");
      const owner = new MessagingBindingService({ ...context(f, () => messagingModules(f.controller).bindingHost()), backend: {
        ...f.backend, get recordMessagingBindingTransition(): MessagingBindingContext["backend"]["recordMessagingBindingTransition"] { throw failure; },
      } });
      await expect(owner.bindChannelToThread(f.event("resume"), { backend: "codex", threadId: "thread-a" })).rejects.toBe(failure);
      // Persistence precedes this optional audit read; the error boundary must
      // not roll back or silently move the read into its method-call catch.
      expect((await f.active())?.threadId).toBe("thread-a");
    } finally { await f.close(); }
  });

  it("keeps optional adapter method reads and their receiver at the call site", async () => {
    const f = await messagingBindingHarness();
    try {
      const binding = await f.bind("thread-a");
      let reads = 0;
      const adapter: MessagingBindingContext["adapter"] = { get setConversationTitle() {
        reads++;
        return async function(this: MessagingBindingContext["adapter"], request: Parameters<NonNullable<MessagingBindingContext["adapter"]["setConversationTitle"]>>[0]): ReturnType<NonNullable<MessagingBindingContext["adapter"]["setConversationTitle"]>> {
          expect(reads).toBe(2);
          expect(this).toBe(adapter);
          await setImmediate();
          return { outcome: "updated", channel: request.channel.channel, title: request.title,
            conversation: request.channel.conversation, updatedAt: 1_000 };
        };
      } };
      const owner = new MessagingBindingService({ ...context(f, () => messagingModules(f.controller).bindingHost()), adapter });
      await owner.syncConversationName(binding, f.event("status"));
      // The refreshed status card reads the setter to decide whether to offer Sync name.
      expect(reads).toBe(3);
      expect((await f.active())?.channel.conversation.title).toBe("Fixture thread-a");
    } finally { await f.close(); }
  });

  it("awaits detach effects and propagates the original error before revocation", async () => {
    const f = await messagingBindingHarness();
    try {
      const binding = await f.bind("thread-a");
      const failure = new Error("Fixture monitor cleanup failure");
      const effects: string[] = [];
      const host: MessagingBindingHost = { ...messagingModules(f.controller).bindingHost(),
        flushToolUpdatesForBinding: async () => { effects.push("flush"); await setImmediate(); },
        stopMonitoringForBinding: async () => { effects.push("monitor"); await setImmediate(); throw failure; },
      };
      const owner = new MessagingBindingService(context(f, () => host));
      await expect(owner.handleBindingRevokeRequest(binding)).rejects.toBe(failure);
      expect(effects).toEqual(["flush", "monitor"]);
      expect((await f.active())?.id).toBe(binding.id);
    } finally { await f.close(); }
  });

  it("uses one owner lock for overlapping status renders of the same binding", async () => {
    await fc.assert(fc.asyncProperty(fc.scheduler(), async scheduler => {
      const f = await messagingBindingHarness();
      const pending: Promise<unknown>[] = [];
      try {
        const binding = await f.bind("thread-a");
        const entered = Promise.withResolvers<void>();
        let count = 0;
        const original = messagingModules(f.controller).bindingHost();
        const host: MessagingBindingHost = { ...original, deliver: async (...args) => {
          count++;
          if (count === 1) { entered.resolve(); await scheduler.schedule(Promise.resolve(), "first status delivery"); }
          return await original.deliver(...args);
        } };
        const owner = new MessagingBindingService(context(f, () => host));
        pending.push(owner.renderBindingStatus(binding, f.event("status")));
        await entered.promise;
        pending.push(owner.renderBindingStatus(binding, f.event("status")));
        await setImmediate();
        expect(count).toBe(1);
        await scheduler.waitAll();
        await Promise.all(pending);
        expect(count).toBe(2);
        expect((await f.active())?.statusSurface).toBeDefined();
      } finally { await scheduler.waitAll(); await Promise.allSettled(pending); await f.close(); }
    }), { numRuns: 25 });
  });

  it("keeps the remote-scope backstop before any binding persistence", async () => {
    await fc.assert(fc.asyncProperty(fc.boolean(), async allowed => {
      const f = await messagingBindingHarness();
      try {
        const host = { ...messagingModules(f.controller).bindingHost(), requireRemoteScope: async () => allowed };
        const owner = new MessagingBindingService(context(f, () => host));
        const operation = owner.bindChannelToThread(f.event("resume"), { backend: "codex", threadId: "thread-a",
          federatedThread: { backend: "codex", threadId: "thread-a", target: { scope: "remote", instanceId: "fixture-peer" } },
        });
        if (allowed) {
          await expect(operation).resolves.toMatchObject({ federatedThread: { target: { instanceId: "fixture-peer" } } });
          expect((await f.active())?.federatedThread?.target).toEqual({ scope: "remote", instanceId: "fixture-peer" });
        } else {
          await expect(operation).rejects.toThrow(/another instance/);
          expect(await f.active()).toBeUndefined();
          expect(f.trace).not.toContain("persist");
        }
      } finally { await f.close(); }
    }), { numRuns: 25 });
  });
});
