import { describe, expect, it, vi } from "vitest";
import { MessagingMonitorWorkflow } from "../messaging/core/messaging-monitor-workflow";
import type { MessagingMonitorContext } from "../messaging/core/messaging-monitor-context";
import { messagingModules } from "./fixtures/messaging-controller-modules";
import { messagingMonitorHarness } from "./fixtures/messaging-monitor-harness";

function contextFor(f: Awaited<ReturnType<typeof messagingMonitorHarness>>): MessagingMonitorContext {
  return { get store() { return f.controllerOptions.store; }, get backend() { return f.controllerOptions.backend; },
    get adapter() { return f.controllerOptions.adapter; }, capabilityProfile: f.controllerOptions.adapter.capabilityProfile,
    turns: messagingModules(f.controller).turns, disposed: false, config: f.controllerOptions,
    now: f.controllerOptions.now ?? Date.now, logger: f.controllerOptions.logger ?? {}, host: messagingModules(f.controller).monitorHost };
}

describe("monitor workflow owner ports", () => {
  it("constructs without reading collaborators", () => {
    const unavailable = (): never => { expect.fail("Eager monitor collaborator read"); };
    expect(new MessagingMonitorWorkflow({
      get store() { return unavailable(); }, get backend() { return unavailable(); }, get adapter() { return unavailable(); },
      get capabilityProfile() { return unavailable(); }, get turns() { return unavailable(); }, get disposed() { return unavailable(); },
      get config() { return unavailable(); }, get now() { return unavailable(); }, get logger() { return unavailable(); }, get host() { return unavailable(); },
    })).toBeInstanceOf(MessagingMonitorWorkflow);
  });

  it("uses the replacement wrapped store's returned configuration and preserves clock receivers", async () => {
    const receivers: unknown[] = [];
    const f = await messagingMonitorHarness({ clock: function (this: unknown) { receivers.push(this); return 1_000; } });
    try {
      f.controllerOptions.store = new Proxy(f.store, { get(target, key) {
        if (key === "upsertMonitorSubscription") return async (...args: Parameters<typeof target.upsertMonitorSubscription>) =>
          target.upsertMonitorSubscription({ ...args[0], monitor: { ...args[0].monitor, intervalMs: 30_000 } });
        const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
      } });
      await f.command();
      expect((await f.subscription())?.monitor.intervalMs).toBe(30_000);
      expect([...f.timers.values()].map(timer => timer.delay)).toEqual([30_000]);
      expect(receivers.length).toBeGreaterThan(0);
      expect(receivers.every(receiver => receiver === f.controller)).toBe(true);
    } finally { await f.close(); }
  });

  it("keeps the query getter outside catches and each status invocation getter inside its catch", async () => {
    const f = await messagingMonitorHarness();
    try {
      const owner = messagingModules(f.controller).monitors;
      const navigation = await owner.readMonitorRows();
      const debug = vi.fn(); f.controllerOptions.logger!.debug = debug;
      let reads = 0;
      Object.defineProperty(f.backend, "readThreadStatus", { configurable: true, get() {
        if (++reads === 1) return async () => "idle";
        throw new Error("Fixture status getter");
      } });
      expect((await owner.resolveMonitorActiveTurns(navigation)).size).toBe(0);
      expect(reads).toBe(1 + navigation.threads.length);
      expect(debug).toHaveBeenCalledWith("messaging monitor thread status read failed", expect.objectContaining({ error: "Fixture status getter" }));
      Object.defineProperty(f.backend, "getNavigationQueryPage", { configurable: true,
        get() { throw new Error("Fixture query getter"); } });
      await expect(owner.readMonitorRows()).rejects.toThrow("Fixture query getter");
    } finally { await f.close(); }
  });

  it("awaits continuation cleanup before reading monitor storage on startup", async () => {
    const f = await messagingMonitorHarness();
    try {
      const failure = new Error("Fixture cleanup failure");
      const actual = contextFor(f);
      const owner = new MessagingMonitorWorkflow({ ...actual,
        get store() { return expect.fail("No monitor storage before cleanup"); },
        host: () => ({ ...actual.host(), cleanupExpiredPrivateReplyContinuations: async () => { throw failure; } }),
      });
      await expect(owner.startMonitoringForEnabledBindings()).rejects.toBe(failure);
    } finally { await f.close(); }
  });

  it("disposes bound and subscription timer resources through the actual facade", async () => {
    const f = await messagingMonitorHarness();
    try {
      const row = f.rows[0]!;
      const binding = await f.store.upsertBinding({ id: "monitor-binding", backend: row.source, threadId: row.id, channel: f.channel,
        authorizedActorIds: ["fixture-actor"], createdAt: 1_000, updatedAt: 1_000 });
      const owner = messagingModules(f.controller).monitors;
      await owner.enableAndRenderMonitor(binding); await f.command();
      expect(f.timers.size).toBe(2);
      f.controller.dispose(); expect(f.timers.size).toBe(0);
      await owner.runMonitorTick(binding.id); expect(f.timers.size).toBe(0);
    } finally { await f.close(); }
  });

  it("routes startup to the actual owner without duplicating armed timers", async () => {
    const f = await messagingMonitorHarness();
    try {
      const row = f.rows[0]!;
      const binding = await f.store.upsertBinding({ id: "startup-monitor-binding", backend: row.source, threadId: row.id, channel: f.channel,
        authorizedActorIds: ["fixture-actor"], createdAt: 1_000, updatedAt: 1_000 });
      const owner = messagingModules(f.controller).monitors;
      await owner.enableAndRenderMonitor(binding); await f.command();
      owner.clearMonitorTimer(binding.id); owner.clearMonitorSubscriptionTimer((await f.subscription())!.id);
      expect(f.timers.size).toBe(0);
      await f.controller.startMonitoringForEnabledBindings(); expect(f.timers.size).toBe(2);
      await f.controller.startMonitoringForEnabledBindings(); expect(f.timers.size).toBe(2);
    } finally { await f.close(); }
  });

});
