import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { setImmediate } from "node:timers/promises";
import { PERMISSIVE_CAPABILITY_PROFILE } from "@pwragent/messaging-interface/testing";
import { messagingCallbackHarness } from "./fixtures/messaging-callback-harness";

// The oracle is the visible proposal and the backend's submission boundary.
// Action names are reusable; only the delivered surface identifies a proposal.
// A stale button must not submit the newer request, even with valid permission.
describe("messaging callback observable protocol", () => {
  it("keeps proposal identity, denial and replay independent across valid sessions", async () => {
    await fc.assert(fc.asyncProperty(fc.constantFrom("telegram" as const, "discord" as const), fc.boolean(), fc.boolean(), async (channel, allowed, staleFirst) => {
      const f = await messagingCallbackHarness({ channel });
      try {
        const older = await f.approve("older-proposal");
        const current = await f.approve("current-proposal");
        const actionId = current.decisions.find(action => action.decision === "accept")?.id;
        if (!actionId) throw new Error("Fixture accept action is missing");
        if (!allowed) f.permissions.delete("approval.respond.escalation");
        if (staleFirst) {
          await f.click(actionId, older.surface);
          expect(f.submitted).toEqual([]);
        }
        await f.click(actionId, current.surface);
        expect(f.submitted.map(request => request.requestId)).toEqual(allowed ? ["current-proposal"] : []);
        await f.click(actionId, current.surface);
        expect(f.submitted.map(request => request.requestId)).toEqual(allowed ? ["current-proposal"] : []);
        if (!allowed) {
          f.permissions.add("approval.respond.escalation");
          await f.click(actionId, current.surface);
          expect(f.submitted.map(request => request.requestId)).toEqual(["current-proposal"]);
        }
      } finally { await f.close(); }
    }), { numRuns: 25 });
  });

  it("updates the clicked help surface and preserves dismissal markup", async () => {
    await fc.assert(fc.asyncProperty(fc.constantFrom("telegram" as const, "discord" as const), fc.constantFrom(4, 5, 12), fc.integer({ min: 1, max: 4 }), async (channel, maxActions, steps) => {
      const actions = PERMISSIVE_CAPABILITY_PROFILE.actions;
      if (!actions) throw new Error("Fixture needs action capabilities");
      const f = await messagingCallbackHarness({ channel, profile: { ...PERMISSIVE_CAPABILITY_PROFILE, actions: { ...actions, maxActions } } });
      try {
        const first = await f.help();
        const surface = first.surface;
        let current = first.intent;
        for (let index = 0; index < steps; index += 1) {
          expect(current.actions.length).toBeLessThanOrEqual(maxActions);
          const next = current.actions.find(action => action.id === "help:page:next")
            ?? current.actions.find(action => action.id === "help:page:prev");
          if (!next) break;
          await f.click(next.id, surface, next.value);
          const updated = f.deliveries.at(-1)?.intent;
          expect(updated).toMatchObject({
            kind: "confirmation", title: expect.stringContaining("PwrAgent commands"),
            delivery: { mode: "update", replaceMarkup: true }, targetSurface: surface,
          });
          if (updated?.kind !== "confirmation") throw new Error("Missing help update");
          current = updated;
        }
        await f.click("help:cancel", surface);
        expect(f.deliveries.at(-1)?.intent).toMatchObject({
          kind: "confirmation", title: "Help dismissed", actions: [],
          delivery: { mode: "update", replaceMarkup: true }, targetSurface: surface,
        });
      } finally { await f.close(); }
    }), { numRuns: 15 });
  });

  it("leaves the proposal live until acceptance while unrelated callbacks continue", async () => {
    await fc.assert(fc.asyncProperty(fc.scheduler(), async scheduler => {
      let entered!: () => void;
      const submitting = new Promise<void>(resolve => { entered = resolve; });
      const f = await messagingCallbackHarness({ beforeSubmit: async () => {
        entered();
        await scheduler.schedule(Promise.resolve(), "backend accepts approval");
      } });
      let click: Promise<void> | undefined;
      let returned = false;
      try {
        const proposal = await f.approve("pending-proposal");
        const action = proposal.decisions.find(decision => decision.decision === "accept")!;
        click = f.click(action.id, proposal.surface).then(() => { returned = true; });
        await Promise.race([submitting, click.then(() => { throw new Error("Fixture never reached backend submission"); })]);
        const pending = await f.store.findActivePendingIntentForChannel({ actorId: "fixture-actor", channel: f.binding.channel, now: 1_001 });
        expect(pending?.intent.requestContext?.requestId).toBe("pending-proposal");
        await f.click("help:cancel", { id: "other-help", channel: f.binding.channel.channel });
        await setImmediate();
        expect(f.deliveries.at(-1)?.intent).toMatchObject({ title: "Help dismissed" });
        expect(f.submitted).toEqual([]);
        expect(returned).toBe(false);
        expect(await f.store.findActivePendingIntentForChannel({ actorId: "fixture-actor", channel: f.binding.channel, now: 1_001 })).toBeDefined();
        await scheduler.waitFor(click);
        await setImmediate();
        expect(f.submitted.map(request => request.requestId)).toEqual(["pending-proposal"]);
        expect(await f.store.findActivePendingIntentForChannel({ actorId: "fixture-actor", channel: f.binding.channel, now: 1_001 })).toBeUndefined();
      } finally {
        await scheduler.waitAll();
        if (click) await Promise.allSettled([click]);
        await f.close();
      }
    }), { numRuns: 15 });
  });

  it("keeps proposals for two providers separate in the shared store", async () => {
    const telegram = await messagingCallbackHarness();
    const discord = await messagingCallbackHarness({ channel: "discord", store: telegram.store });
    try {
      const first = await telegram.approve("telegram-proposal");
      const second = await discord.approve("discord-proposal");
      const action = first.decisions.find(decision => decision.decision === "accept")!;
      await telegram.click(action.id, first.surface);
      expect(telegram.submitted.map(request => request.requestId)).toEqual(["telegram-proposal"]);
      expect(discord.submitted).toEqual([]);
      await discord.click(action.id, second.surface);
      expect(discord.submitted.map(request => request.requestId)).toEqual(["discord-proposal"]);
    } finally { await discord.close(); await telegram.close(); }
  });

  it("reads pending proposals through the current wrapped overlay store", async () => {
    const f = await messagingCallbackHarness();
    try {
      const proposal = await f.approve("overlaid-proposal");
      f.hidePendingIntentsInOverlay();
      await f.click(proposal.decisions.find(decision => decision.decision === "accept")!.id, proposal.surface);
      expect(f.submitted).toEqual([]);
      expect(f.deliveries.at(-1)?.intent).toMatchObject({ kind: "error", title: "Approval expired" });
    } finally { await f.close(); }
  });
});
