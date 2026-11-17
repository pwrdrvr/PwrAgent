import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { describe, it } from "vitest";
import fc from "fast-check";
import { messagingBindingHarness } from "./fixtures/messaging-binding-harness";

async function recreateAcrossMetadata(
  scheduler: fc.Scheduler,
  channel: "telegram" | "discord",
  titles: string[],
  fixedClock: boolean,
) {
  const f = await messagingBindingHarness({ channel, pinStatus: true, ...(fixedClock ? { clock: () => 1_000 } : {}) });
  let status: Promise<void> | undefined;
  try {
    const binding = await f.bind("thread-a");
    assert.ok(binding.pinnedStatusSurface);
    const entered = Promise.withResolvers<void>();
    let held = false;
    f.hooks.beforeDelivery = async intent => {
      if (held || !intent.id.startsWith("status-retire:")) return;
      held = true;
      const delivery = scheduler.schedule(Promise.resolve(), "retire old pinned status");
      entered.resolve();
      await delivery;
    };
    const beforeRefresh = f.deliveries.length;
    status = f.command("status");
    await entered.promise;
    for (const title of titles) await f.metadata(title);
    assert.equal((await f.active())?.channel.conversation.title, titles.at(-1));
    await scheduler.waitFor(status);
    await setImmediate();
    const current = await f.active();
    assert.equal(current?.id, binding.id);
    assert.equal(current?.createdAt, binding.createdAt);
    assert.equal(current?.channel.conversation.title, titles.at(-1));
    assert.ok(current?.statusSurface);
    // Retirement unpins the old card. An unrelated metadata merge cannot
    // keep it as the target: /status must create and pin a replacement.
    assert.notDeepEqual(current.statusSurface, binding.statusSurface);
    assert.deepEqual(current.pinnedStatusSurface, current.statusSurface);
    const replacement = f.deliveries.slice(beforeRefresh).find(intent => intent.id.startsWith("status:"));
    assert.ok(replacement);
    assert.equal(replacement.targetSurface, undefined);
    assert.equal(replacement.delivery?.pin, true);
  } finally {
    try { await scheduler.waitFor(status ?? Promise.resolve()); }
    finally { await f.close(); }
  }
}

describe("status retirement crossing unrelated metadata", () => {
  it("preserves metadata and creates a newly pinned card on the same binding incarnation", async () => {
    await fc.assert(fc.asyncProperty(
      fc.scheduler(),
      fc.constantFrom("telegram", "discord"),
      fc.array(fc.nat({ max: 100 }).map(value => `Fixture title ${value}`), { minLength: 1, maxLength: 3 }),
      fc.boolean(),
      recreateAcrossMetadata,
    ), { numRuns: 25 });
  });

  it("recreates the Telegram card after one concurrent title update", async () => {
    await recreateAcrossMetadata(fc.schedulerFor([1]), "telegram", ["Renamed fixture"], false);
  });
});
