import { setImmediate } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { messagingBindingHarness } from "./fixtures/messaging-binding-harness";

describe("observable messaging binding protocol", () => {
  it("keeps one current binding through bind, replacement, metadata, status and detach sessions", async () => {
    type Model = { thread?: string; title: string };
    type Real = Awaited<ReturnType<typeof messagingBindingHarness>>;
    const bind = fc.constantFrom("thread-a", "thread-b").map(thread => ({
      check: () => true,
      run: async (model: Model, real: Real) => {
        const previous = await real.active();
        const binding = await real.bind(thread);
        expect(binding.threadId).toBe(thread);
        if (previous && previous.threadId !== thread) expect((await real.store.getBinding(previous.id))?.revokedAt).toBeDefined();
        model.thread = thread;
      },
      toString: () => `bind(${thread})`,
    }));
    const metadata = fc.constantFrom("Renamed fixture", "Fixture conversation").map(title => ({
      check: (model: Model) => model.thread !== undefined,
      run: async (model: Model, real: Real) => { await real.metadata(title); model.title = title; },
      toString: () => `metadata(${title})`,
    }));
    const detach = fc.boolean().map(ui => ({
      check: (model: Model) => model.thread !== undefined,
      run: async (model: Model, real: Real) => {
        const binding = (await real.active())!;
        real.trace.length = 0;
        if (ui) expect(await real.revoke(binding)).toBe(true);
        else await real.command("detach");
        // Every origin retires the surface before revoking, then broadcasts
        // the committed change before its provider-visible confirmation.
        expect(real.trace.filter(x => ["activity:closed", "status:retired", "revoke", "changed", "confirmed"].includes(x)))
          .toEqual(["activity:closed", "status:retired", "revoke", "changed", "confirmed"]);
        expect((await real.store.getBinding(binding.id))?.revokedAt).toBeDefined();
        model.thread = undefined;
      },
      toString: () => ui ? "revoke(ui)" : "detach(command)",
    }));
    const status = fc.constant({
      check: (model: Model) => model.thread !== undefined,
      run: async (_model: Model, real: Real) => { await real.command("status"); expect((await real.active())?.statusSurface).toBeDefined(); },
      toString: () => "status",
    });
    await fc.assert(fc.asyncProperty(fc.constantFrom("telegram", "discord"), fc.commands([bind, metadata, detach, status], { maxCommands: 12 }), async (channel, commands) => {
      const real = await messagingBindingHarness({ channel });
      const model: Model = { title: "Fixture conversation" };
      try {
        await fc.asyncModelRun(() => ({ model, real }), commands);
        const current = await real.active();
        expect(current?.threadId).toBe(model.thread);
        if (current) expect(current.channel.conversation.title).toBe(model.title);
      } finally { await real.close(); }
    }), { numRuns: 30 });
  });

  it("never revives a revoked binding when a status delivery finishes late", async () => {
    await fc.assert(fc.asyncProperty(fc.scheduler(), fc.constantFrom("telegram", "discord"), async (scheduler, channel) => {
      const f = await messagingBindingHarness({ channel });
      let status: Promise<void> | undefined;
      try {
        const binding = await f.bind("thread-a");
        const entered = Promise.withResolvers<void>();
        let held = false;
        f.hooks.beforeDelivery = async intent => {
          // This oracle holds the normal render after retirement completes.
          // Retirement crossing revoke is a separate pre-existing counterexample.
          if (!intent.id.startsWith("status:") || held) return;
          held = true; entered.resolve();
          await scheduler.schedule(Promise.resolve(), "status accepted by provider");
        };
        status = f.command("status");
        await entered.promise;
        expect(await f.revoke(binding)).toBe(true);
        expect(await f.active()).toBeUndefined();
        const writesAtRevoke = f.trace.filter(x => x === "persist").length;
        await scheduler.waitAll();
        await status;
        await setImmediate();
        expect(await f.active()).toBeUndefined();
        expect((await f.store.getBinding(binding.id))?.revokedAt).toBeDefined();
        expect(f.trace.filter(x => x === "persist")).toHaveLength(writesAtRevoke);
      } finally { await scheduler.waitAll(); await status; await f.close(); }
    }), { numRuns: 25 });
  });

  it("isolates provider ownership while retiring pinned status surfaces", async () => {
    await fc.assert(fc.asyncProperty(fc.constantFrom("telegram", "discord"), async channel => {
      const f = await messagingBindingHarness({ channel });
      const other = await messagingBindingHarness({ channel: channel === "telegram" ? "discord" : "telegram", store: f.store });
      try {
        const accepted = f.bind("thread-a");
        await expect(accepted).resolves.toMatchObject({ threadId: "thread-a" });
        const binding = await accepted;
        const otherBinding = await other.bind("thread-b");
        expect(await other.revoke(binding)).toBe(false);
        expect((await f.active())?.id).toBe(binding.id);
        const pinned = await f.store.upsertBinding({ ...binding, pinnedStatusSurface: binding.statusSurface });
        f.trace.length = 0;
        expect(await f.revoke(pinned)).toBe(true);
        expect(f.trace.indexOf("unpin")).toBeLessThan(f.trace.indexOf("revoke"));
        expect(f.trace).toContain("unpin");
        expect((await other.active())?.id).toBe(otherBinding.id);
      } finally { await other.close(); await f.close(); }
    }), { numRuns: 25 });
  });

  it("keeps best-effort cleanup, audit and notification failures outside binding acceptance", async () => {
    await fc.assert(fc.asyncProperty(fc.constantFrom("cleanup", "audit", "listener"), async fault => {
      const f = await messagingBindingHarness();
      try {
        f.faults[fault] = true;
        const accepted = f.bind("thread-a");
        await expect(accepted).resolves.toMatchObject({ threadId: "thread-a" });
        const binding = await accepted;
        expect((await f.active())?.id).toBe(binding.id);
        expect(f.trace).toContain("changed");
        await f.command("status");
        expect((await f.active())?.statusSurface).toBeDefined();
      } finally { await f.close(); }
    }), { numRuns: 25 });
  });

  it("uses the adapter's optional name-sync capability without changing thread identity", async () => {
    await fc.assert(fc.asyncProperty(fc.boolean(), async rename => {
      const f = await messagingBindingHarness({ rename });
      try {
        const binding = await f.bind("thread-a");
        await f.controller.handleInboundEvent({ ...f.event("status"), kind: "callback", actionId: "status:sync-name",
          interaction: { channel: f.channel.channel, id: "fixture-status" },
        });
        const current = await f.active();
        expect(current?.id).toBe(binding.id);
        expect(current?.channel.conversation.title).toBe(rename ? "Fixture thread-a" : "Fixture conversation");
        expect(f.deliveries.some(intent => intent.kind === (rename ? "confirmation" : "error") && intent.title === (rename ? "Name synced" : "Name sync unavailable"))).toBe(true);
      } finally { await f.close(); }
    }), { numRuns: 25 });
  });

  it("uses the current wrapped store for post-construction metadata updates", async () => {
    const f = await messagingBindingHarness();
    try {
      await f.bind("thread-a");
      let merges = 0;
      f.controllerOptions.store = new Proxy(f.controllerOptions.store, { get: (target, key) => {
        if (key === "mergeBindingChannelMetadata") return async () => { merges++; return undefined; };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      } });
      await f.metadata("Replacement wrapper fixture");
      expect(merges).toBe(1);
      expect((await f.active())?.channel.conversation.title).toBe("Fixture conversation");
    } finally { await f.close(); }
  });

  it("continues an in-flight name sync through the replacement adapter after shutdown", async () => {
    await fc.assert(fc.asyncProperty(fc.scheduler(), async scheduler => {
      const f = await messagingBindingHarness({ rename: true });
      let pending: Promise<void> | undefined;
      try {
        await f.bind("thread-a");
        const entered = Promise.withResolvers<void>();
        const read = f.backend.getNavigationSelectedDetail;
        let held = false;
        f.backend.getNavigationSelectedDetail = async request => {
          if (!held) { held = true; entered.resolve(); await scheduler.schedule(Promise.resolve(), "name sync thread read"); }
          return await read(request);
        };
        let renamed = 0;
        const replacement: typeof f.controllerOptions.adapter = { ...f.controllerOptions.adapter,
          setConversationTitle: async request => {
            renamed++;
            return { outcome: "updated", title: request.title, channel: request.channel.channel,
              conversation: request.channel.conversation, updatedAt: 2_000 };
          },
        };
        pending = f.controller.handleInboundEvent({ ...f.event("status"), kind: "callback", actionId: "status:sync-name",
          interaction: { channel: f.channel.channel, id: "fixture-status" },
        });
        await entered.promise;
        f.controllerOptions.replacementAdapter = { now: () => replacement, settled: async () => replacement };
        f.controller.dispose();
        await scheduler.waitAll();
        await pending;
        expect(renamed).toBe(1);
        expect((await f.active())?.channel.conversation.title).toBe("Fixture thread-a");
      } finally { await scheduler.waitAll(); await pending; await f.close(); }
    }), { numRuns: 25 });
  });

  it("preserves configuration callback receivers and optional getter reads", async () => {
    const clocks: unknown[] = [];
    const f = await messagingBindingHarness({ clock: function(this: unknown) { clocks.push(this); return 1_000; } });
    try {
      let reads = 0;
      let sameReceiver = false;
      Object.defineProperty(f.controllerOptions, "onBindingChanged", { configurable: true, get() {
        reads++;
        return function(this: unknown) { sameReceiver = this === f.controllerOptions; };
      } });
      const binding = await f.bind("thread-a");
      expect(sameReceiver).toBe(true);
      expect(reads).toBe(2);
      clocks.length = 0;
      await f.revoke(binding);
      expect(clocks.length).toBeGreaterThan(0);
      expect(clocks.every(receiver => receiver === f.controller)).toBe(true);
    } finally { await f.close(); }
  });
});
