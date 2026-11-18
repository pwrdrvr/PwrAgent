import { describe, expect, it, vi } from "vitest";
import type { MessagingPendingRequestContext } from "../messaging/core/messaging-pending-request-context";
import { MessagingPendingRequestWorkflow } from "../messaging/core/messaging-pending-request-workflow";
import { messagingModules } from "./fixtures/messaging-controller-modules";
import { messagingPendingRequestHarness } from "./fixtures/messaging-pending-request-harness";

describe("pending request workflow owner ports", () => {
  it("constructs without reading collaborators", () => {
    const unavailable = (): never => expect.fail("Eager pending-request collaborator read");
    expect(new MessagingPendingRequestWorkflow({
      get store() { return unavailable(); }, get backend() { return unavailable(); },
      get capabilityProfile() { return unavailable(); }, get now() { return unavailable(); },
      get logger() { return unavailable(); }, get host() { return unavailable(); },
    })).toBeInstanceOf(MessagingPendingRequestWorkflow);
  });

  it("routes the public pending-request facade to the actual owner", async () => {
    const f = await messagingPendingRequestHarness();
    try {
      const owner = messagingModules(f.controller).pendingRequests;
      const spy = vi.spyOn(owner, "handleBackendPendingRequest");
      const request = f.request();
      await f.controller.handleBackendPendingRequest("codex", request);
      expect(spy).toHaveBeenCalledExactlyOnceWith("codex", request, undefined);
      expect(await f.pending()).toBeDefined();
    } finally { await f.close(); }
  });

  it("uses the replacement wrapped store's returned binding and preserves clock receivers", async () => {
    const receivers: unknown[] = [];
    const f = await messagingPendingRequestHarness({ clock: function (this: unknown) { receivers.push(this); return 1_000; } });
    try {
      await f.controller.handleBackendPendingRequest("codex", f.request(1));
      const row = await f.pending();
      if (row?.intent.kind !== "questionnaire") throw new Error("Missing fixture questionnaire");
      f.controllerOptions.store = new Proxy(f.store, { get(target, key) {
        if (key === "getBinding") return async (...args: Parameters<typeof target.getBinding>) => {
          const binding = await target.getBinding(...args);
          return binding && { ...binding, federatedThread: {
            backend: "codex" as const, threadId: binding.threadId, target: { scope: "remote" as const, instanceId: "wrapped-owner" },
          } };
        };
        const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
      } });
      await messagingModules(f.controller).pendingRequests.submitQuestionnaireIntent(row.intent);
      expect(f.submissions[0]).toMatchObject({ federationTarget: { scope: "remote", instanceId: "wrapped-owner" } });
      expect(receivers.length).toBeGreaterThan(0);
      expect(receivers.every(receiver => receiver === f.controller)).toBe(true);
    } finally { await f.close(); }
  });

  it("keeps optional submission getters outside catches and re-reads them after the binding await", async () => {
    const f = await messagingPendingRequestHarness();
    try {
      await f.controller.handleBackendPendingRequest("codex", f.request(1));
      const row = await f.pending();
      if (row?.intent.kind !== "questionnaire") throw new Error("Missing fixture questionnaire");
      let reads = 0;
      Object.defineProperty(f.backend, "submitServerRequest", { configurable: true, get() {
        if (++reads === 1) return async () => {};
        throw new Error("Fixture second submission getter");
      } });
      await expect(messagingModules(f.controller).pendingRequests.submitQuestionnaireIntent(row.intent))
        .rejects.toThrow("Fixture second submission getter");
      expect(reads).toBe(2);
      expect(f.submissions).toHaveLength(0);
    } finally { await f.close(); }
  });

  it("keeps the admission getter inside its error boundary and reports its exact failure", async () => {
    const f = await messagingPendingRequestHarness();
    try {
      Object.defineProperty(f.backend, "getThreadAdmissionState", { configurable: true,
        get() { throw new Error("Fixture admission getter"); } });
      const binding = await f.store.getBinding("fixture-binding");
      if (!binding) throw new Error("Missing fixture binding");
      await expect(messagingModules(f.controller).pendingRequests.sendAsyncQuestionReply({
        binding, event: f.event(), preview: "Fixture answer", text: "Fixture answer",
      })).resolves.toBe(false);
      expect(f.starts).toHaveLength(0);
      expect(f.deliveries.at(-1)).toMatchObject({ kind: "error", title: "Answer could not be sent", body: "Fixture admission getter" });
    } finally { await f.close(); }
  });

  it("forwards readonly host ports with the actual canonical owners", async () => {
    const f = await messagingPendingRequestHarness();
    try {
      const modules = messagingModules(f.controller);
      const context: MessagingPendingRequestContext = {
        get store() { return f.controllerOptions.store; }, get backend() { return f.controllerOptions.backend; },
        capabilityProfile: f.controllerOptions.adapter.capabilityProfile, now: () => 1_000, logger: {},
        host: modules.pendingRequestHost,
      };
      const owner = new MessagingPendingRequestWorkflow(context);
      await f.begin();
      await owner.handleBackendPendingRequest("codex", f.request(1, "fixture-request", "pending-turn"));
      const binding = await f.store.getBinding("fixture-binding");
      expect(binding).toBeDefined();
      expect(modules.turns.get(binding!)).toMatchObject({ turnId: "pending-turn", status: "waiting" });
      await owner.resumeBindingForPendingIntent((await f.pending())!, "fixture-owner-resume");
      expect(modules.turns.get(binding!)).toMatchObject({ turnId: "pending-turn", status: "working" });
    } finally { await f.close(); }
  });
});
