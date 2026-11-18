import { describe, expect, it, vi } from "vitest";
import { MessagingReviewWorkflow } from "../messaging/core/messaging-review-workflow";
import type { MessagingReviewContext } from "../messaging/core/messaging-review-context";
import { MessagingController } from "../messaging/core/messaging-controller";
import { messagingModules } from "./fixtures/messaging-controller-modules";
import { messagingReviewHarness } from "./fixtures/messaging-review-harness";

function contextFor(real: Awaited<ReturnType<typeof messagingReviewHarness>>): MessagingReviewContext {
  return { get store() { return real.controllerOptions.store; }, get backend() { return real.controllerOptions.backend; },
    capabilityProfile: real.controllerOptions.adapter.capabilityProfile, now: real.controllerOptions.now ?? Date.now,
    logger: real.controllerOptions.logger ?? {}, host: messagingModules(real.controller).reviewHost };
}

describe("messaging review owner ports", () => {
  it("preserves the controller clock receiver through its lazy port", async () => {
    const real = await messagingReviewHarness();
    const receivers: unknown[] = [];
    let controller: MessagingController | undefined;
    try {
      controller = new MessagingController({ ...real.controllerOptions, now: function (this: unknown) { receivers.push(this); return 1_000; } });
      receivers.length = 0;
      const intent = messagingModules(controller).reviews.buildReviewIntent({ binding: (await real.store.getBinding("fixture-binding"))!,
        navigation: { kind: "thread", thread: real.thread }, phase: "summary" });
      expect(intent.createdAt).toBe(1_000);
      expect(receivers.length).toBeGreaterThan(0);
      expect(receivers.every(receiver => receiver === controller)).toBe(true);
    } finally { controller?.dispose(); await real.close(); }
  });

  it("constructs without reading collaborators and resolves a replacement clock at call time", async () => {
    const real = await messagingReviewHarness();
    try {
      const actual = contextFor(real);
      const reads: string[] = [];
      let now = () => 10;
      const owner = new MessagingReviewWorkflow({
        get store() { reads.push("store"); return actual.store; },
        get backend() { reads.push("backend"); return actual.backend; },
        get capabilityProfile() { reads.push("capabilities"); return actual.capabilityProfile; },
        get now() { reads.push("now"); return now; },
        get logger() { reads.push("logger"); return actual.logger; },
        get host() { reads.push("host"); return actual.host; },
      });
      expect(reads).toEqual([]);
      now = () => 9876;
      const intent = owner.buildReviewIntent({ binding: (await real.store.getBinding("fixture-binding"))!,
        navigation: { kind: "thread", thread: real.thread }, phase: "summary" });
      expect(intent.createdAt).toBe(9876);
      expect(reads).toContain("now");
    } finally { await real.close(); }
  });

  it("uses the current wrapped store for a pending picker update", async () => {
    const real = await messagingReviewHarness();
    try {
      await real.command();
      const pending = (await real.pending())!;
      expect(pending.intent.kind).toBe("review");
      let store = real.controllerOptions.store;
      const owner = new MessagingReviewWorkflow({ ...contextFor(real), get store() { return store; } });
      const calls: string[] = [];
      store = new Proxy(real.store, { get(target, property) {
        if (property === "getBinding") return async (id: string) => { calls.push("binding"); return target.getBinding(id); };
        if (property === "upsertPendingIntent") return async (record: typeof pending) => { calls.push("pending"); return target.upsertPendingIntent(record); };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      } });
      await owner.updateReviewPendingIntent(pending, real.event(), { phase: "custom" });
      expect(calls).toEqual(["binding", "pending"]);
      expect((await real.pending())?.intent).toMatchObject({ kind: "review", review: { phase: "custom" } });
    } finally { await real.close(); }
  });

  it("keeps submit getter failures outside the submission catch", async () => {
    const real = await messagingReviewHarness();
    try {
      const owner = new MessagingReviewWorkflow({ ...contextFor(real), backend: {
        get submitReview(): NonNullable<MessagingReviewContext["backend"]["submitReview"]> { throw new Error("Fixture submit getter"); },
      } });
      const binding = (await real.store.getBinding("fixture-binding"))!;
      await expect(owner.submitMessagingReview({ binding, event: real.event(), target: { type: "uncommittedChanges" } }))
        .rejects.toThrow("Fixture submit getter");
      await expect(owner.reviewSupportedForBinding(binding)).rejects.toThrow("Fixture submit getter");
      expect(real.deliveries).toEqual([]);
    } finally { await real.close(); }
  });

  it("reads list and summary getters inside their existing catch boundaries", async () => {
    const real = await messagingReviewHarness();
    try {
      const actual = contextFor(real);
      const debug = vi.fn();
      const owner = new MessagingReviewWorkflow({ ...actual, logger: { debug }, backend: {
        get listBackends(): NonNullable<MessagingReviewContext["backend"]["listBackends"]> { throw new Error("Fixture list getter"); },
      } });
      await expect(owner.listReviewerBackends()).resolves.toEqual([]);
      expect(debug).toHaveBeenCalledWith("messaging reviewer backend lookup failed", { error: "Fixture list getter" });
      const summaryOwner = new MessagingReviewWorkflow({ ...actual, host: () => ({ ...actual.host(),
        get getBackendSummary(): ReturnType<MessagingReviewContext["host"]>["getBackendSummary"] { throw new Error("Fixture summary getter"); },
      }) });
      await expect(summaryOwner.reviewSupportedForBinding((await real.store.getBinding("fixture-binding"))!)).resolves.toBe(false);
    } finally { await real.close(); }
  });

  it("rechecks support in the actual owner and preserves the backend list receiver", async () => {
    const real = await messagingReviewHarness();
    try {
      const actual = contextFor(real);
      const backend: MessagingReviewContext["backend"] = { listBackends: async function () {
        expect(this).toBe(backend);
        return { fetchedAt: 1_000, backends: [] };
      } };
      await expect(new MessagingReviewWorkflow({ ...actual, backend }).listReviewerBackends()).resolves.toEqual([]);
      real.controls.startReview = false;
      await messagingModules(real.controller).reviews.submitMessagingReview({ binding: (await real.store.getBinding("fixture-binding"))!,
        event: real.event(), target: { type: "uncommittedChanges" } });
      expect(real.requests).toEqual([]);
      expect(real.deliveries.at(-1)).toMatchObject({ kind: "error", title: "Review unavailable", recoverable: false });
    } finally { await real.close(); }
  });

  it.each(["modes", "autoFix"] as const)("blocks a downgraded %s capability before submission", async capability => {
    const real = await messagingReviewHarness();
    try {
      await real.command();
      expect(await real.pending()).toBeDefined();
      real.controls[capability] = false;
      await real.click("review:summary:start");
      expect(real.requests).toEqual([]);
      expect(await real.pending()).toBeDefined();
      expect(real.deliveries.at(-1)).toMatchObject({ kind: "error", body: expect.stringContaining("Update") });
    } finally { await real.close(); }
  });
});
