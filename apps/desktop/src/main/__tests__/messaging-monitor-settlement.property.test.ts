import type { MessagingDeliveryResult } from "@pwragent/messaging-interface";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { NavigationQueryStore } from "../app-server/navigation-query-store";
import { messagingInboundHarness } from "./fixtures/messaging-inbound-harness";

async function monitorHarness(blockedRenders: number, route: "unbound" | "binding" = "unbound") {
  const fixture = await messagingInboundHarness({ route, shared: true, clock: () => 1_000 });
  const hooks: { beforeNavigation?: () => Promise<void>; stopConfirmation?: () => Promise<void> } = {};
  const query = new NavigationQueryStore();
  fixture.controllerOptions.backend = {
    ...fixture.backend,
    getNavigationQueryPage: async request => {
      await hooks.beforeNavigation?.();
      return query.readPage({
        request,
        scopeKey: "race",
        loadIndex: async () => ({ threads: [], directories: [] }),
      });
    },
  };
  const slots = Array.from({ length: blockedRenders }, () => ({
    entered: Promise.withResolvers<void>(),
    release: Promise.withResolvers<"success" | "permanent-failure" | "throw">(),
  }));
  const adapter = fixture.controllerOptions.adapter;
  const originalDeliver = adapter.deliver.bind(adapter);
  let renderIndex = 0;
  adapter.deliver = async (intent): Promise<MessagingDeliveryResult> => {
    if (intent.kind === "status" && intent.text.startsWith("Monitor:")) {
      const slot = slots[renderIndex++];
      if (slot) {
        slot.entered.resolve();
        const outcome = await slot.release.promise;
        if (outcome === "throw") throw new Error("Fixture delivery error");
        if (outcome === "permanent-failure") {
          return { outcome: "failed", channel: fixture.channel.channel, deliveredAt: 1, errorMessage: "chat not found" };
        }
      }
    }
    if (intent.kind === "confirmation" && intent.title === "Monitor stopped") {
      await hooks.stopConfirmation?.();
    }
    return await originalDeliver(intent);
  };
  const command = (verb: string, ...args: string[]) => fixture.controller.handleInboundEvent({
    ...fixture.event(),
    kind: "command",
    command: verb,
    args,
    rawText: `/${[verb, ...args].join(" ")}`,
  });
  return {
    ...fixture,
    command,
    slots,
    monitorHooks: hooks,
    renderAttempts: () => renderIndex,
    read: () => fixture.store.findActiveMonitorSubscriptionForChannel(fixture.channel),
    close: async (pending: Promise<void>[]) => {
      for (const slot of slots) slot.release.resolve("success");
      await Promise.allSettled(pending);
      await fixture.close();
    },
  };
}

describe("Monitor render settlement", () => {
  it("preserves Stop after the initial status delivery settles", async () => {
    const f = await monitorHarness(1);
    const timer = vi.spyOn(globalThis, "setTimeout");
    const initial = f.command("monitor");
    try {
      await f.slots[0]!.entered.promise;
      await f.command("monitor", "stop");
      expect((await f.read())?.monitor.enabled).toBe(false);
      f.slots[0]!.release.resolve("success");
      await initial;
      expect((await f.read())?.monitor.enabled, "a settled old render must preserve the stop").toBe(false);
      expect(timer.mock.calls.filter(([, delay]) => delay === 60_000)).toHaveLength(0);
    } finally {
      timer.mockRestore();
      await f.close([initial]);
    }
  });

  it("lets the latest monitor command own settlement", async () => {
    await fc.assert(fc.asyncProperty(
      fc.uniqueArray(fc.record({
        order: fc.integer(),
        outcome: fc.constantFrom("success", "permanent-failure", "throw"),
      }), { minLength: 1, maxLength: 4, selector: item => item.order }),
      fc.constantFrom("stop", "restart", "settings-after-stop", "settings-only"),
      async (renders, next) => {
        const f = await monitorHarness(renders.length);
        const pending: Promise<void>[] = [];
        try {
          for (const [index, slot] of f.slots.entries()) {
            pending.push(index === 0 ? f.command("monitor") : f.command("monitor", "interval", "30"));
            await slot.entered.promise;
          }
          if (next !== "settings-only") await f.command("monitor", "stop");
          if (next === "restart") await f.command("monitor");
          const setsInterval = next === "settings-after-stop" || next === "settings-only";
          if (setsInterval) await f.command("monitor", "interval", "300");

          // The latest command determines whether a surface exists and its refresh interval.
          const expected = await f.read();
          expect(expected?.monitor.enabled).toBe(next !== "stop");
          expect(Boolean(expected?.monitorSurface)).toBe(next !== "stop");
          if (setsInterval) expect(expected?.monitor.intervalMs).toBe(300_000);
          const order = renders.map((_, index) => index).sort((a, b) => renders[a]!.order - renders[b]!.order);
          for (const index of order) {
            f.slots[index]!.release.resolve(renders[index]!.outcome);
            await pending[index];
            expect(await f.read()).toEqual(expected);
          }
        } finally {
          await f.close(pending);
        }
      },
    ), { numRuns: 25 });
  });

  it("suppresses a render whose navigation was queued when Stop ran", async () => {
    const f = await monitorHarness(0);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    f.monitorHooks.beforeNavigation = () => {
      entered.resolve();
      return release.promise;
    };
    const initial = f.command("monitor");
    try {
      await entered.promise;
      await f.command("monitor", "stop");
      release.resolve();
      await initial;
      expect(f.renderAttempts()).toBe(0);
      expect((await f.read())?.monitor.enabled).toBe(false);
    } finally {
      release.resolve();
      await f.close([initial]);
    }
  });

  it("preserves a new Start while Stop's confirmation is pending", async () => {
    const f = await monitorHarness(0);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    f.monitorHooks.stopConfirmation = () => {
      entered.resolve();
      return release.promise;
    };
    let stop: Promise<void> | undefined;
    try {
      await f.command("monitor");
      stop = f.command("monitor", "stop");
      await entered.promise;
      expect((await f.read())?.monitor.enabled).toBe(false);
      await f.command("monitor");
      const restarted = await f.read();
      expect(restarted?.monitor.enabled).toBe(true);
      expect(restarted?.monitorSurface).toBeDefined();
      release.resolve();
      await stop;
      expect(await f.read()).toEqual(restarted);
    } finally {
      release.resolve();
      await f.close(stop ? [stop] : []);
    }
  });

  it.each(["replacement", "revocation", "disposal"] as const)(
    "ignores an in-flight channel delivery after %s",
    async transition => {
      const f = await monitorHarness(1);
      const pending = f.command("monitor");
      try {
        await f.slots[0]!.entered.promise;
        const active = await f.read();
        if (!active) throw new Error("Monitor was not admitted");
        if (transition === "replacement") {
          await f.store.upsertMonitorSubscription({
            ...active,
            id: "new-subscription",
            createdAt: active.createdAt + 1,
            updatedAt: active.updatedAt + 1,
          });
        } else if (transition === "revocation") {
          await f.store.revokeMonitorSubscription({ subscriptionId: active.id, revokedAt: active.updatedAt + 1 });
        } else {
          f.controller.dispose();
        }
        const expected = await f.read();
        const old = await f.store.getMonitorSubscription(active.id);
        f.slots[0]!.release.resolve(transition === "replacement" ? "permanent-failure" : "success");
        await pending;
        expect(await f.read()).toEqual(expected);
        expect(await f.store.getMonitorSubscription(active.id)).toEqual(old);
      } finally {
        await f.close([pending]);
      }
    },
  );

  it("preserves a bound monitor's detach from a late startup tick", async () => {
    const f = await monitorHarness(1, "binding");
    const revoke = vi.spyOn(f.store, "revokeBinding");
    let startup: Promise<void> | undefined;
    try {
      const binding = await f.store.findActiveBindingForChannel(f.channel);
      if (!binding) throw new Error("Fixture binding missing");
      await f.store.upsertBinding({
        ...binding,
        monitor: { enabled: true, intervalMs: 60_000, updatedAt: binding.updatedAt },
      });
      startup = f.controller.startMonitoringForEnabledBindings();
      await f.slots[0]!.entered.promise;
      await f.command("detach");
      const detached = await f.store.getBinding(binding.id);
      expect(detached?.monitor?.enabled).toBe(false);
      expect(detached?.revokedAt).toBeDefined();
      f.slots[0]!.release.resolve("permanent-failure");
      await startup;
      expect(await f.store.getBinding(binding.id)).toEqual(detached);
      expect(revoke).toHaveBeenCalledTimes(1);
    } finally {
      revoke.mockRestore();
      await f.close(startup ? [startup] : []);
    }
  });

});
