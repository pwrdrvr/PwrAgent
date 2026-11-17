import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { describe, it } from "vitest";
import fc from "fast-check";
import { messagingBindingHarness } from "./fixtures/messaging-binding-harness";

type Interleaving = {
  beforeDetach: ("metadata" | "other-status")[];
  rebind: boolean;
  otherCompletion: boolean;
  fixedClock?: boolean;
};

// Revocation is terminal for an in-flight retirement. Provider completion is
// not authority to restore either the route or a pre-detach record snapshot.
async function retirementAcrossDetach(
  scheduler: fc.Scheduler,
  channel: "telegram" | "discord",
  interleaving: Interleaving,
) {
  const f = await messagingBindingHarness({ channel, ...(interleaving.fixedClock ? { clock: () => 1_000 } : {}) });
  const other = interleaving.otherCompletion || interleaving.beforeDetach.includes("other-status")
    ? await messagingBindingHarness({ channel: channel === "telegram" ? "discord" : "telegram", store: f.store })
    : undefined;
  const entered = Promise.withResolvers<void>();
  let status: Promise<void> | undefined;
  let otherStatus: Promise<void> | undefined;
  let held = false;
  // Bind/detach alone change route ownership. Completing a provider delivery
  // never changes it. A rebind creates a fresh incarnation, even for thread-a.
  const model = { active: true, title: "Fixture conversation", createdAt: 0 };
  const assertModel = async () => {
    const active = await f.active();
    assert.equal(active !== undefined, model.active);
    if (active) {
      assert.equal(active.threadId, "thread-a");
      assert.equal(active.createdAt, model.createdAt);
      assert.equal(active.channel.conversation.title, model.title);
    }
    if (other) assert.equal((await other.active())?.threadId, "thread-b");
  };
  try {
    const binding = await f.bind("thread-a");
    model.createdAt = binding.createdAt;
    await other?.bind("thread-b");
    assert.ok(binding.statusSurface);
    f.hooks.beforeDelivery = async intent => {
      if (held || !intent.id.startsWith("status-retire:")) return;
      held = true;
      const delivery = scheduler.schedule(Promise.resolve(), "retirement accepted by provider");
      entered.resolve();
      await delivery;
    };
    status = f.command("status");
    await entered.promise;
    for (const [index, operation] of interleaving.beforeDetach.entries()) {
      if (operation === "metadata") {
        model.title = `Fixture title ${index}`;
        await f.metadata(model.title);
      } else {
        // This must finish while retirement on the other lane is still held.
        await other!.command("status");
      }
      await assertModel();
    }
    assert.equal(await f.controller.handleBindingRevokeRequest(binding), true);
    model.active = false;
    assert.equal(await f.active(), undefined);
    const revoked = await f.store.getBinding(binding.id);
    assert.ok(revoked?.revokedAt);
    await assertModel();
    if (interleaving.rebind) {
      const rebound = await f.bind("thread-a");
      model.active = true;
      model.createdAt = rebound.createdAt;
      model.title = "Rebound fixture";
      await f.metadata(model.title);
      await assertModel();
    }
    if (interleaving.otherCompletion) {
      const otherEntered = Promise.withResolvers<void>();
      other!.hooks.beforeDelivery = async intent => {
        const delivery = scheduler.schedule(Promise.resolve(), `other provider ${intent.kind}`);
        otherEntered.resolve();
        await delivery;
      };
      otherStatus = other!.command("status");
      await otherEntered.promise;
    }
    await scheduler.waitFor(Promise.all([status, otherStatus]));
    await setImmediate();
    await assertModel();
    if (!model.active) assert.deepEqual(await f.store.getBinding(binding.id), revoked);
  } finally {
    try {
      await scheduler.waitFor(Promise.all([status, otherStatus]));
    } finally {
      await other?.close();
      await f.close();
    }
  }
}

describe("status retirement crossing committed detach", () => {
  it("keeps revocation and its metadata through interleaved provider completions", async () => {
    await fc.assert(fc.asyncProperty(
      fc.scheduler(),
      fc.constantFrom("telegram", "discord"),
      fc.record({
        beforeDetach: fc.array(fc.constantFrom("metadata", "other-status"), { maxLength: 3 }),
        rebind: fc.boolean(),
        otherCompletion: fc.boolean(),
        fixedClock: fc.boolean(),
      }),
      retirementAcrossDetach,
    ), { numRuns: 25 });
  });

  it("preserves the shrunk Telegram regression with one held retirement", async () => {
    await retirementAcrossDetach(fc.schedulerFor([1]), "telegram", {
      beforeDetach: [], rebind: false, otherCompletion: false,
    });
  });
});
