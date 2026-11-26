import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { messagingCanonicalQueueHarness } from "./fixtures/messaging-canonical-queue-harness";

describe("observable canonical messaging queue protocol", () => {
  it("projects accepted follow-ups from the actual owner FIFO through valid terminal and cancellation sequences", async () => {
    type Model = { active: boolean; held: boolean; accepted: string[]; waiting: string[]; next: number };
    type Real = Awaited<ReturnType<typeof messagingCanonicalQueueHarness>>;
    const project = (model: Model, real: Real) => {
      expect(real.starts.map(request => request.input[0])).toEqual(model.accepted.map(text => ({ type: "text", text })));
      expect(real.queued().map(entry => entry.input[0])).toEqual(model.waiting.map(text => ({ type: "text", text })));
    };
    const send = fc.constant(null).map(() => ({
      check: () => true,
      run: async (model: Model, real: Real) => {
        const text = `Fixture input ${++model.next}`;
        await real.controller.handleInboundEvent(real.event(text));
        if (model.active || model.held) model.waiting.push(text);
        else { model.accepted.push(text); model.active = true; }
        project(model, real);
      }, toString: () => "send",
    }));
    const finish = fc.constantFrom("completed", "failed", "cancelled").map(terminal => ({
      check: (model: Model) => model.active,
      run: async (model: Model, real: Real) => {
        await real.finishOwner(terminal);
        if (terminal === "failed") { model.held = model.waiting.length > 0; model.active = false; }
        else {
          const next = model.waiting.shift();
          if (next) model.accepted.push(next); else model.active = false;
        }
        project(model, real);
      }, toString: () => `terminal(${terminal})`,
    }));
    const cancel = fc.nat({ max: 3 }).map(index => ({
      check: (model: Model) => model.waiting.length > 0,
      run: async (model: Model, real: Real) => {
        const selected = index % model.waiting.length;
        const id = real.queued()[selected]!.id;
        await real.controller.handleInboundEvent(real.callback(`queued-turn:cancel:${id}`));
        await real.settleBus();
        model.waiting.splice(selected, 1);
        if (!model.waiting.length) model.held = false;
        project(model, real);
      }, toString: () => `cancel(${index})`,
    }));
    await fc.assert(fc.asyncProperty(fc.constantFrom("telegram", "discord"), fc.constantFrom("codex", "claude"), fc.boolean(),
        fc.commands([send, finish, cancel], { maxCommands: 10, size: "max" }), async (channel, backend, remote, commands) => {
        const real = await messagingCanonicalQueueHarness({ channel, backend, remote });
        try {
          await fc.asyncModelRun(() => ({ model: { active: false, held: false, accepted: [], waiting: [], next: 0 }, real }), commands);
          expect(real.requests.every(request => remote ? request.federationTarget?.scope === "remote" : request.federationTarget === undefined)).toBe(true);
          expect(real.requests.every(request => request.messageOrigin?.messaging?.actor?.platformUserId === "fixture-actor"
            && request.messageOrigin.messaging.platform === channel)).toBe(true);
        } finally { await real.close(); }
      }), { numRuns: 12 });
  });

  // Acceptance is the oracle: a pending/rejected steer must never look successful,
  // and an accepted one must remain retired across duplicate clicks and refreshes.
  it("labels only confirmed steering as steered and retires its queue controls", async () => {
    await fc.assert(fc.asyncProperty(fc.constantFrom("telegram", "discord"), fc.boolean(), fc.boolean(), fc.constantFrom(undefined, "steered" as const),
      async (channel, recovery, remote, disposition) => {
        const real = await messagingCanonicalQueueHarness({ channel, remote });
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        try {
          await real.controller.handleInboundEvent(real.event("first"));
          await real.controller.handleInboundEvent(real.event("follow-up"));
          let id = real.queued()[0]!.id;
          if (recovery) {
            real.queueHooks.steer = async () => { throw new Error("Fixture rejection"); };
            real.queueHooks.admit = async () => { throw new Error("Fixture unavailable"); };
            await real.controller.handleInboundEvent(real.callback(`queued-turn:steer:${id}`));
            await real.controller.whenQueuedTurnActionsSettled();
            const notice = real.deliveries.filter(intent => intent.kind === "confirmation" && intent.title === "Message queued").at(-1)!;
            const retry = "actions" in notice ? notice.actions?.find(action => action.id.startsWith("queued-turn:retry:")) : undefined;
            id = retry!.id.slice("queued-turn:retry:".length);
          }
          real.queueHooks.disposition = disposition;
          const before = real.steers.length;
          real.queueHooks.steer = async () => { entered.resolve(); await release.promise; };
          await real.controller.handleInboundEvent(real.callback(`queued-turn:steer:${id}`));
          await entered.promise;
          expect(real.deliveries.some(intent => intent.kind === "confirmation" && intent.title === "Message steered")).toBe(false);
          await real.controller.handleInboundEvent(real.callback(`queued-turn:steer:${id}`));
          expect(real.steers).toHaveLength(before + 1);
          release.resolve();
          await real.controller.whenQueuedTurnActionsSettled();
          await real.settleBus();
          expect(real.deliveries.at(-1)).toMatchObject({
            kind: "confirmation", title: "Message steered", body: "Sent to the current turn.", actions: [],
            delivery: { mode: "update", replaceMarkup: true },
          });
          await real.controller.handleInboundEvent(real.callback(`queued-turn:steer:${id}`));
          await real.finishOwner("completed");
          expect(real.steers).toHaveLength(before + 1);
          expect(real.queued()).toEqual([]);
          const updates = real.deliveries.filter(intent => intent.kind === "confirmation" && intent.delivery?.mode === "update");
          expect(updates.at(-1)).toMatchObject({ title: "Message steered", body: "Sent to the current turn." });
        } finally { release.resolve(); await real.close(); }
      }), { numRuns: 12 });
  });

  it.each(["held", "queued", "scheduled", "started"] as const)(
    "keeps an accepted %s disposition distinct from steering", async disposition => {
      const real = await messagingCanonicalQueueHarness();
      try {
        await real.controller.handleInboundEvent(real.event("first"));
        await real.controller.handleInboundEvent(real.event("follow-up"));
        real.queueHooks.disposition = disposition;
        await real.controller.handleInboundEvent(real.callback(`queued-turn:steer:${real.queued()[0]!.id}`));
        await real.controller.whenQueuedTurnActionsSettled();
        expect(real.deliveries.at(-1)).toMatchObject({ kind: "confirmation", actions: [] });
        expect(real.deliveries.some(intent => intent.kind === "confirmation" && intent.title === "Message steered")).toBe(false);
        expect(real.deliveries.some(intent => intent.kind === "confirmation" && intent.body === "Sent to the current turn.")).toBe(false);
        expect(real.steers).toHaveLength(1);
      } finally { await real.close(); }
    },
  );

  it.each(["unavailable", "cancelled", "queued fallback", "new turn fallback"] as const)(
    "does not label %s as confirmed steering", async outcome => {
      const real = await messagingCanonicalQueueHarness();
      try {
        await real.controller.handleInboundEvent(real.event("first"));
        await real.controller.handleInboundEvent(real.event("follow-up"));
        const entry = real.queued()[0]!;
        const notice = real.deliveries.filter(intent => intent.kind === "confirmation" && intent.title === "Message queued").at(-1)!;
        expect(notice).toMatchObject({ title: "Message queued", actions: expect.arrayContaining([
          expect.objectContaining({ label: "Steer" }), expect.objectContaining({ label: "Cancel" }),
        ]) });
        if (outcome === "unavailable") real.setThreadStatus("idle");
        real.queueHooks.steer = async () => {
          if (outcome === "new turn fallback") await real.finishOwner("completed");
          throw new Error("Fixture active turn ended");
        };
        await real.controller.handleInboundEvent(real.callback(`queued-turn:${outcome === "cancelled" ? "cancel" : "steer"}:${entry.id}`));
        await real.controller.whenQueuedTurnActionsSettled();
        await real.settleBus();
        expect(real.deliveries.some(intent => intent.kind === "confirmation" && intent.title === "Message steered")).toBe(false);
        expect(real.deliveries.some(intent => intent.kind === "confirmation" && intent.body === "Sent to the current turn.")).toBe(false);
        if (outcome === "unavailable") {
          expect(real.steers).toHaveLength(0);
          expect(real.queued().map(item => item.id)).toEqual([entry.id]);
        } else if (outcome === "cancelled") {
          expect(real.steers).toHaveLength(0);
          expect(real.queued()).toEqual([]);
        } else {
          expect(real.steers).toHaveLength(1);
          expect(real.requests).toHaveLength(3);
          expect(real.queued()).toHaveLength(outcome === "queued fallback" ? 1 : 0);
          expect(real.starts).toHaveLength(outcome === "queued fallback" ? 1 : 2);
        }
      } finally { await real.close(); }
    },
  );

  it("retires one notice when owner dispatch overtakes the queued acknowledgement", async () => {
    await fc.assert(fc.asyncProperty(fc.scheduler(), fc.constantFrom("telegram", "discord"), async (scheduler, channel) => {
      const real = await messagingCanonicalQueueHarness({ channel });
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let sending: Promise<void> | undefined;
      try {
        await real.controller.handleInboundEvent(real.event("first"));
        expect(real.starts).toHaveLength(1);
        real.queueHooks.lifecycle = async event => {
          if (event.type === "queued") { entered.resolve(); await scheduler.schedule(release.promise, "queued publication"); }
        };
        sending = real.controller.handleInboundEvent(real.event("second"));
        await entered.promise;
        await real.owner.releaseThread({ backend: "codex", threadId: "fixture-thread", turnId: "fixture-turn-1", status: "turn/completed" });
        expect(real.starts).toHaveLength(2);
        release.resolve(); await scheduler.waitAll(); await sending; await real.settleBus();
        expect(real.queued()).toEqual([]);
        expect(real.deliveries.filter(intent => intent.kind === "confirmation" && intent.body === "Queued message sent as the next turn.")).toHaveLength(1);
      } finally { release.resolve(); await scheduler.waitAll(); await sending; await real.close(); }
    }), { numRuns: 12 });
  });

  it("admits one explicit recovery Retry while duplicate clicks and cancellation interleave", async () => {
    await fc.assert(fc.asyncProperty(fc.scheduler(), async scheduler => {
      const real = await messagingCanonicalQueueHarness();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let retrying: Promise<void> | undefined;
      try {
        await real.controller.handleInboundEvent(real.event("first"));
        expect(real.starts).toHaveLength(1);
        await real.controller.handleInboundEvent(real.event("recover me"));
        real.queueHooks.steer = async () => { throw new Error("Fixture steer refusal"); };
        real.queueHooks.admit = async () => { throw new Error("Fixture owner unavailable"); };
        expect(real.queued()).toHaveLength(1);
        await real.controller.handleInboundEvent(real.callback(`queued-turn:steer:${real.queued()[0]!.id}`));
        await real.controller.whenQueuedTurnActionsSettled();
        const notice = real.deliveries.filter(intent => intent.kind === "confirmation" && intent.title === "Message queued").at(-1)!;
        const retry = "actions" in notice ? notice.actions?.find(action => action.id.startsWith("queued-turn:retry:")) : undefined;
        expect(retry).toBeDefined();
        expect(real.deliveries.some(intent => intent.kind === "confirmation" && intent.title === "Message steered")).toBe(false);
        await real.finishOwner("completed");
        const before = real.requests.length;
        real.queueHooks.admit = async () => { entered.resolve(); await scheduler.schedule(release.promise, "recovery admission"); };
        retrying = real.controller.handleInboundEvent(real.callback(retry!.id));
        await entered.promise;
        await real.controller.handleInboundEvent(real.callback(retry!.id));
        await real.controller.handleInboundEvent(real.callback(retry!.id.replace(":retry:", ":cancel:")));
        expect(real.requests).toHaveLength(before + 1);
        release.resolve(); await scheduler.waitAll(); await retrying;
        expect(real.starts.at(-1)?.input).toEqual([{ type: "text", text: "recover me" }]);
        await real.controller.handleInboundEvent(real.callback(retry!.id));
        expect(real.requests).toHaveLength(before + 1);
      } finally { release.resolve(); await scheduler.waitAll(); await retrying; await real.close(); }
    }), { numRuns: 12 });
  });

  it("retains the owner's edited input across failed steering, failed fallback and explicit Retry", async () => {
    await fc.assert(fc.asyncProperty(fc.constantFrom("telegram", "discord"), fc.integer({ min: 0, max: 2 }), async (channel, failures) => {
      const real = await messagingCanonicalQueueHarness({ channel });
      try {
        await real.controller.handleInboundEvent(real.event("first"));
        expect(real.starts).toHaveLength(1);
        await real.controller.handleInboundEvent(real.event("original"));
        expect(real.queued()).toHaveLength(1);
        const entry = real.queued()[0]!;
        real.owner.updateQueuedEntryInput(entry.id, [{ type: "text", text: "edited at the owner" }]);
        real.queueHooks.steer = async () => { throw new Error("Fixture steer rejected"); };
        real.queueHooks.admit = async () => { throw new Error("Fixture owner unavailable"); };
        await real.controller.handleInboundEvent(real.callback(`queued-turn:steer:${entry.id}`));
        await real.controller.whenQueuedTurnActionsSettled(); await real.settleBus();
        const notice = real.deliveries.filter(intent => intent.kind === "confirmation" && intent.title === "Message queued").at(-1);
        const retry = notice && "actions" in notice ? notice.actions?.find(action => action.id.startsWith("queued-turn:retry:")) : undefined;
        expect(retry).toBeDefined();
        expect(real.deliveries.some(intent => intent.kind === "confirmation" && intent.title === "Message steered")).toBe(false);
        expect(notice).toMatchObject({ body: expect.stringContaining("edited at the owner") });
        const beforeIdle = real.requests.length;
        await real.finishOwner("completed");
        expect(real.requests).toHaveLength(beforeIdle);
        for (let index = 0; index < failures; index++) {
          await real.controller.handleInboundEvent(real.callback(retry!.id));
          expect(real.queued()).toEqual([]);
        }
        real.queueHooks.admit = undefined;
        await real.controller.handleInboundEvent(real.callback(retry!.id));
        expect(real.starts.at(-1)?.input).toEqual([{ type: "text", text: "edited at the owner" }]);
      } finally { await real.close(); }
    }), { numRuns: 12 });
  });
});
