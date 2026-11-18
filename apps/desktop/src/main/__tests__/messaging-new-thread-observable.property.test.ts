import { setImmediate } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { messagingNewThreadHarness } from "./fixtures/messaging-new-thread-harness";

describe("observable messaging new-thread protocol", () => {
  it("keeps provider and launch choices in the session until a first prompt or cancellation", async () => {
    type Model = { provider: "codex" | "claude"; model: number; effort: "low" | "high" };
    type Real = Awaited<ReturnType<typeof messagingNewThreadHarness>>;
    const project = async (model: Model, real: Real) => {
      expect(await real.session()).toMatchObject({ backend: model.provider, mode: "new_thread_options" });
      expect(real.latest()).toMatchObject({ kind: "confirmation", title: "Ready to start",
        body: expect.stringContaining(`Provider: ${model.provider}`) });
      expect(real.latest()).toHaveProperty("body", expect.stringContaining(`Model: ${model.provider}-${model.model}`));
      expect(real.latest()).toHaveProperty("body", expect.stringContaining(`Reasoning: ${model.effort}`));
      expect(real.requests).toEqual([]);
      expect(await real.store.findActiveBindingForChannel(real.channel)).toBeUndefined();
    };
    const provider = fc.constantFrom("codex" as const, "claude" as const).map(value => ({
      check: () => true,
      run: async (model: Model, real: Real) => {
        await real.click("browse:new:backend"); await real.choose("browse:new:set-backend", "backend", value);
        if (model.provider !== value) { model.provider = value; model.model = 0; model.effort = "low"; }
        await project(model, real);
      }, toString: () => `provider(${value})`,
    }));
    const modelChoice = fc.integer({ min: 0, max: 1 }).map(index => ({
      check: () => true,
      run: async (model: Model, real: Real) => {
        await real.click("browse:new:model"); await real.choose("browse:new:set-model", "model", `${model.provider}-${index}`);
        model.model = index; await project(model, real);
      }, toString: () => `model(${index})`,
    }));
    const effort = fc.constantFrom("low" as const, "high" as const).map(value => ({
      check: () => true,
      run: async (model: Model, real: Real) => {
        await real.click("browse:new:reasoning"); await real.choose("browse:new:set-reasoning", "reasoningEffort", value);
        model.effort = value; await project(model, real);
      }, toString: () => `effort(${value})`,
    }));
    await fc.assert(fc.asyncProperty(fc.constantFrom("telegram" as const, "discord" as const), fc.boolean(),
      fc.commands([provider, modelChoice, effort], { maxCommands: 8, size: "max" }), async (channel, cancel, commands) => {
        const real = await messagingNewThreadHarness({ channel });
        try {
          await real.open();
          const model: Model = { provider: "codex", model: 0, effort: "low" };
          await project(model, real);
          // Always cross catalogs after an explicit model choice; shrinking
          // cannot turn provider isolation into an unvisited branch.
          await real.click("browse:new:model");
          expect(real.latest()).toMatchObject({ kind: "confirmation", title: "Select model" });
          await real.choose("browse:new:set-model", "model", "codex-1");
          await real.click("browse:new:backend"); await real.choose("browse:new:set-backend", "backend", "claude");
          model.provider = "claude";
          await project(model, real);
          await fc.asyncModelRun(() => ({ model, real }), commands);
          if (cancel) {
            await real.click("browse:cancel");
            expect(real.requests).toEqual([]);
            expect(await real.session()).toBeUndefined();
            expect(await real.store.findActiveBindingForChannel(real.channel)).toBeUndefined();
          } else {
            await real.send(); await setImmediate();
            expect(real.requests).toHaveLength(1);
            // The fixture explicitly saves Codex Default Access. Claude has
            // no saved access choice and uses its documented Auto default.
            expect(real.requests[0]).toMatchObject({ launchpad: { backend: model.provider, model: `${model.provider}-${model.model}`,
              reasoningEffort: model.effort, executionMode: model.provider === "claude" ? "auto" : "default", workMode: "local" },
              input: [{ type: "text", text: "Fixture first prompt" }] });
            expect(await real.store.findActiveBindingForChannel(real.channel)).toMatchObject({ backend: model.provider, threadId: "fixture-created" });
            expect(await real.session()).toBeUndefined();
            expect(real.trace.indexOf("binding:write")).toBeGreaterThan(real.trace.indexOf("create:accepted"));
          }
          expect(real.sticky.every(request => request.stickySettingsChanged === true)).toBe(true);
        } finally { await real.close(); }
      }), { numRuns: 25 });
  });

  it("waits for backend acceptance before binding and reporting a created thread", async () => {
    await fc.assert(fc.asyncProperty(fc.scheduler(), fc.boolean(), async (scheduler, fail) => {
      const real = await messagingNewThreadHarness();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let sending: Promise<void> | undefined;
      try {
        await real.open(); real.trace.length = 0; real.controls.failCreate = fail;
        real.hooks.create = async () => { entered.resolve(); await scheduler.schedule(release.promise, "backend acceptance"); };
        sending = real.send(); await entered.promise; await setImmediate();
        expect(await real.store.findActiveBindingForChannel(real.channel)).toBeUndefined();
        expect(real.trace).toEqual(["create:issued"]);
        release.resolve(); await scheduler.waitAll(); await sending; await setImmediate();
        if (fail) {
          expect(await real.store.findActiveBindingForChannel(real.channel)).toBeUndefined();
          expect(real.latest()).toMatchObject({ kind: "error" });
        } else {
          expect(await real.store.findActiveBindingForChannel(real.channel)).toMatchObject({ backend: "codex", threadId: "fixture-created" });
          expect(real.trace.indexOf("binding:write")).toBeGreaterThan(real.trace.indexOf("create:accepted"));
        }
      } finally { release.resolve(); await scheduler.waitAll(); await sending; await real.close(); }
    }), { numRuns: 25 });
  });

  it("persists selected settings before delivery and commits its returned surface afterward", async () => {
    await fc.assert(fc.asyncProperty(fc.scheduler(), async scheduler => {
      const real = await messagingNewThreadHarness();
      const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
      let choosing: Promise<void> | undefined;
      try {
        await real.open(); await real.click("browse:new:model");
        const before = (await real.session())!;
        real.hooks.deliver = async intent => {
          if (intent.kind === "confirmation" && intent.title === "Ready to start") {
            entered.resolve(); await scheduler.schedule(release.promise, "provider delivery");
          }
        };
        choosing = real.choose("browse:new:set-model", "model", "codex-1"); await entered.promise; await setImmediate();
        expect(await real.session()).toMatchObject({ preferences: { model: "codex-1" }, surface: before.surface });
        release.resolve(); await scheduler.waitAll(); await choosing;
        const updated = (await real.session())!;
        expect(updated.surface).not.toEqual(before.surface);
        const pending = await real.store.findActivePendingIntentForChannel({ channel: real.channel, actorId: "fixture-actor", now: 1_000 });
        expect(pending?.surface).toEqual(updated.surface);
      } finally { release.resolve(); await scheduler.waitAll(); await choosing; await real.close(); }
    }), { numRuns: 25 });
  });

  it("revalidates provider availability at the first prompt and handles discovery failures", async () => {
    await fc.assert(fc.asyncProperty(fc.boolean(), async failDiscovery => {
      const real = await messagingNewThreadHarness();
      try {
        await real.open(); real.controls.unavailable = "codex"; real.controls.failDiscovery = failDiscovery;
        await real.send(); await setImmediate();
        expect(real.requests).toEqual([]);
        expect(await real.store.findActiveBindingForChannel(real.channel)).toBeUndefined();
        expect(real.latest()).toMatchObject({ kind: "error", title: failDiscovery ? "Backends unavailable" : "Backend unavailable", recoverable: true });
      } finally { await real.close(); }
    }), { numRuns: 25 });
  });

  it("reaches later base-branch pages within provider action limits", async () => {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 12, max: 16 }), fc.integer({ min: 8, max: 11 }), async (count, selected) => {
      const real = await messagingNewThreadHarness({ branches: count, maxActions: 8 });
      try {
        await real.open(); await real.click("browse:new:workspace:toggle"); await real.click("browse:new:base-branch");
        // Eight actions reserve four navigation controls on middle pages.
        for (let page = 0; page <= Math.floor(selected / 4); page++) {
          const intent = real.latest();
          const actions = "actions" in intent ? intent.actions ?? [] : [];
          expect(actions.length).toBeLessThanOrEqual(8);
          expect(actions.filter(action => action.id === "browse:new:set-base-branch").map(action => action.value))
            .toEqual(real.branches.slice(page * 4, page * 4 + 4).map(branchName => ({ branchName })));
          if (page < Math.floor(selected / 4)) await real.click("browse:new:branches:next", { pageIndex: page + 1 });
        }
        await real.choose("browse:new:set-base-branch", "branchName", real.branches[selected]!);
        await real.send(); await setImmediate();
        expect(real.requests).toHaveLength(1);
        expect(real.requests[0]?.launchpad).toMatchObject({ workMode: "worktree", branchName: real.branches[selected] });
      } finally { await real.close(); }
    }), { numRuns: 25 });
  });

  it("retains pending choices when the desktop sticky update fails", async () => {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 0, max: 1 }), async index => {
      const real = await messagingNewThreadHarness();
      try {
        await real.open(); real.controls.failSticky = true;
        await real.click("browse:new:model"); await real.choose("browse:new:set-model", "model", `codex-${index}`);
        expect(await real.session()).toMatchObject({ preferences: { model: `codex-${index}` } });
        await real.send(); await setImmediate();
        expect(real.requests).toHaveLength(1);
        expect(real.requests[0]?.launchpad).toMatchObject({ model: `codex-${index}` });
      } finally { await real.close(); }
    }), { numRuns: 25 });
  });
});
