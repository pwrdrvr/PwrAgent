import { setImmediate } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { AppServerReviewTarget } from "@pwragent/shared/contracts/normalized-app-server";
import { messagingReviewHarness } from "./fixtures/messaging-review-harness";

describe("observable messaging review protocol", () => {
  it("models target, mode and Auto-fix choices through accepted, failed and cancelled sessions", async () => {
    type Model = { open: boolean; target: AppServerReviewTarget; managed: boolean; autoFix: boolean; submitted: number };
    type Real = Awaited<ReturnType<typeof messagingReviewHarness>>;
    const project = async (model: Model, real: Real) => {
      const pending = await real.pending();
      expect(Boolean(pending)).toBe(model.open);
      if (pending) expect(pending.surface).toEqual(real.receipts.get(pending.intent.id));
    };
    const open = fc.constant(null).map(() => ({
      check: (model: Model) => !model.open,
      run: async (model: Model, real: Real) => {
        await real.command();
        expect((await real.pending())?.intent.kind).toBe("review");
        model.open = true; model.target = { type: "baseBranch", branch: "main" }; model.managed = false; model.autoFix = true;
        expect(real.review().review).toMatchObject({ phase: "summary", target: model.target, runMode: "codex-sub-agent", afterReview: "auto-fix" });
        await project(model, real);
      }, toString: () => "open",
    }));
    const target = fc.constantFrom("changes", "custom", "branch", "commit").map(choice => ({
      check: (model: Model) => model.open,
      run: async (model: Model, real: Real) => {
        await real.click("review:summary:target");
        if (choice === "changes") {
          await real.click("review:target:current-changes");
          model.target = { type: "uncommittedChanges" };
        } else {
          await real.click(`review:target:${choice === "branch" ? "base-branch" : choice}`);
          if (choice === "branch") await real.click("review:summary:base-branch");
          expect(real.review().review.phase).toBe(choice === "branch" ? "base_branch" : choice);
          const answer = choice === "branch" ? "release" : choice === "commit" ? "abc123 Fixture commit" : "Inspect fixture behavior";
          await real.controller.handleInboundEvent(real.event(answer));
          model.target = choice === "branch" ? { type: "baseBranch", branch: "release" }
            : choice === "commit" ? { type: "commit", sha: "abc123", title: "Fixture commit" }
            : { type: "custom", instructions: "Inspect fixture behavior" };
        }
        expect(real.review().review).toMatchObject({ phase: "summary", target: model.target });
        await project(model, real);
      }, toString: () => `target(${choice})`,
    }));
    const mode = fc.boolean().map(managed => ({
      check: (model: Model) => model.open,
      run: async (model: Model, real: Real) => {
        await real.click("review:summary:mode");
        await real.click(`review:mode:${managed ? "pwragent-sub-agent" : "codex-sub-agent"}`);
        model.managed = managed;
        await project(model, real);
      }, toString: () => `managed(${managed})`,
    }));
    const autoFix = fc.constant(null).map(() => ({
      check: (model: Model) => model.open,
      run: async (model: Model, real: Real) => { await real.click("review:summary:auto-fix"); model.autoFix = !model.autoFix; await project(model, real); },
      toString: () => "toggleAutoFix",
    }));
    const finish = fc.constantFrom("start", "schedule", "refuse", "cancel").map(outcome => ({
      check: (model: Model) => model.open,
      run: async (model: Model, real: Real) => {
        real.trace.length = 0;
        if (outcome === "cancel") {
          await real.click("review:cancel"); model.open = false;
          expect(real.trace).toEqual(["pending:delete", "deliver:confirmation"]);
        } else {
          real.controls.refuse = outcome === "refuse";
          real.controls.outcome = outcome === "schedule" ? "scheduled" : "started";
          await real.click("review:summary:start");
          model.submitted++;
          expect(real.requests).toHaveLength(model.submitted);
          expect(real.requests.at(-1)).toEqual({ backend: "codex", threadId: "fixture-thread", target: model.target,
            delivery: "inline", cwd: "/fixture/project-0", runMode: model.managed ? "pwragent-sub-agent" : "codex-sub-agent",
            afterReview: model.autoFix ? "auto-fix" : "wait", model: "inherited-model", reasoningEffort: "high", serviceTier: "priority", fastMode: true });
          expect(real.trace).toEqual(outcome === "refuse" ? ["submit:issued", "deliver:error"]
            : ["submit:issued", "submit:accepted", "pending:delete", "deliver:confirmation"]);
          model.open = outcome === "refuse";
        }
        await project(model, real);
      }, toString: () => outcome,
    }));
    await fc.assert(fc.asyncProperty(fc.constantFrom("telegram", "discord"),
      fc.commands([open, target, mode, autoFix, finish], { maxCommands: 12, size: "max" }), async (channel, commands) => {
        const real = await messagingReviewHarness(channel);
        try {
          const model: Model = { open: true, target: { type: "uncommittedChanges" }, managed: false, autoFix: true, submitted: 0 };
          await real.command();
          expect((await real.pending())?.intent.kind).toBe("review");
          await real.click("review:summary:target"); await real.click("review:target:current-changes");
          expect(real.review().review.target).toEqual(model.target);
          await project(model, real);
          await fc.asyncModelRun(() => ({ model, real }), commands);
        } finally { await real.close(); }
      }), { numRuns: 25 });
  });

  it("keeps the pending picker until the backend accepts, including a scheduled review", async () => {
    await fc.assert(fc.asyncProperty(fc.scheduler(), fc.boolean(), async (scheduler, scheduled) => {
      const real = await messagingReviewHarness();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let submission: Promise<void> | undefined;
      try {
        await real.command();
        real.trace.length = 0;
        real.controls.outcome = scheduled ? "scheduled" : "started";
        real.hooks.submit = async () => { entered.resolve(); await scheduler.schedule(release.promise, "review acceptance"); };
        submission = real.click("review:summary:start");
        await entered.promise; await setImmediate();
        expect(await real.pending()).toBeDefined();
        expect(real.trace).toEqual(["submit:issued"]);
        release.resolve(); await scheduler.waitAll(); await submission;
        expect(await real.pending()).toBeUndefined();
        expect(real.trace).toEqual(["submit:issued", "submit:accepted", "pending:delete", "deliver:confirmation"]);
      } finally { release.resolve(); await scheduler.waitAll(); await submission; await real.close(); }
    }), { numRuns: 25 });
  });

  it("uses only the selected provider's model and effort instead of inheriting another catalog", async () => {
    await fc.assert(fc.asyncProperty(fc.constantFrom("telegram", "discord"), fc.boolean(), async (channel, switchBack) => {
      const real = await messagingReviewHarness(channel);
      try {
        await real.command();
        for (const provider of switchBack ? ["claude", "codex"] : ["claude", "codex", "claude"]) {
          await real.click("review:summary:reviewer");
          const option = real.review().actions.find(action => typeof action.value === "object" && action.value !== null
            && !Array.isArray(action.value) && action.value.backend === provider);
          expect(option).toBeDefined();
          await real.click(option!.id);
          expect(real.review().review.reviewer).toEqual({ backend: provider });
          const model = real.review().actions.find(action => typeof action.value === "object" && action.value !== null
            && !Array.isArray(action.value) && action.value.model === `${provider}-model`);
          expect(model).toBeDefined();
          await real.click(model!.id);
          const effort = real.review().actions.find(action => typeof action.value === "object" && action.value !== null
            && !Array.isArray(action.value) && action.value.reasoningEffort === "low");
          expect(effort).toBeDefined();
          await real.click(effort!.id);
        }
        await real.click("review:summary:start");
        const provider = switchBack ? "codex" : "claude";
        expect(real.requests).toEqual([{ backend: "codex", threadId: "fixture-thread", delivery: "inline", cwd: "/fixture/project-0",
          target: { type: "baseBranch", branch: "main" }, runMode: "pwragent-sub-agent", afterReview: "auto-fix",
          reviewBackend: provider, model: `${provider}-model`, reasoningEffort: "low" }]);
      } finally { await real.close(); }
    }), { numRuns: 25 });
  });

  it("honors advertised capabilities and rejects a downgrade before admission without losing the picker", async () => {
    await fc.assert(fc.asyncProperty(fc.boolean(), fc.boolean(), fc.boolean(), async (modes, autoFix, downgrade) => {
      const real = await messagingReviewHarness();
      try {
        real.controls.modes = downgrade || modes;
        real.controls.autoFix = downgrade || autoFix;
        await real.command();
        expect(real.review().actions.some(action => action.id === "review:summary:mode")).toBe(downgrade || modes);
        expect(real.review().actions.some(action => action.id === "review:summary:auto-fix")).toBe(downgrade || autoFix);
        real.controls.modes = modes;
        real.controls.autoFix = autoFix;
        await real.click("review:summary:start");
        if (downgrade && (!modes || !autoFix)) {
          expect(real.requests).toEqual([]);
          expect(await real.pending()).toBeDefined();
          expect(real.deliveries.at(-1)).toMatchObject({ kind: "error", body: expect.stringContaining("Update") });
        } else {
          expect(real.requests).toEqual([{ backend: "codex", threadId: "fixture-thread", delivery: "inline", cwd: "/fixture/project-0",
            target: { type: "baseBranch", branch: "main" }, ...(modes ? { runMode: "codex-sub-agent" } : {}),
            ...(autoFix ? { afterReview: "auto-fix" } : {}), model: "inherited-model", reasoningEffort: "high", serviceTier: "priority", fastMode: true }]);
        }
      } finally { await real.close(); }
    }), { numRuns: 25 });
  });

  it("reaches later workspace pages under a provider cap and submits the selected secondary project", async () => {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 8, max: 12 }), fc.integer({ min: 6, max: 10 }), async (count, index) => {
      const real = await messagingReviewHarness("telegram", count, 7);
      const selected = Math.min(index, count - 1);
      try {
        await real.command(); await real.click("review:summary:workspace");
        // Seven actions leave three project rows once paging controls and
        // Back/Cancel are reserved. This projection does not use the pager.
        for (let page = 0; page <= Math.floor(selected / 3); page++) {
          expect(real.review().actions.length).toBeLessThanOrEqual(7);
          expect(real.review().actions.filter(action => /^review:workspace:\d+$/.test(action.id)).map(action => action.id))
            .toEqual(Array.from({ length: Math.min(3, count - page * 3) }, (_, offset) => `review:workspace:${page * 3 + offset}`));
          if (page < Math.floor(selected / 3)) await real.click("review:workspace:next");
        }
        await real.click(`review:workspace:${selected}`);
        await real.click("review:summary:start");
        expect(real.requests).toHaveLength(1);
        expect(real.requests[0]).toMatchObject({ cwd: `/fixture/project-${selected}`, runMode: "pwragent-sub-agent" });
      } finally { await real.close(); }
    }), { numRuns: 25 });
  });

  it("submits direct review commands through the actual backend receiver", async () => {
    await fc.assert(fc.asyncProperty(fc.constantFrom("telegram", "discord"), fc.constantFrom("main", "release"), async (channel, branch) => {
      const real = await messagingReviewHarness(channel);
      try {
        await real.command([branch]);
        expect(real.requests).toEqual([{ backend: "codex", threadId: "fixture-thread", delivery: "inline",
          target: { type: "baseBranch", branch }, afterReview: "auto-fix", model: "inherited-model", reasoningEffort: "high", serviceTier: "priority", fastMode: true }]);
      } finally { await real.close(); }
    }), { numRuns: 25 });
  });
});
