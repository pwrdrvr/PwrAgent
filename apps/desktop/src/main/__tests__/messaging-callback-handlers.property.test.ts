import { setImmediate } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { PERMISSIVE_CAPABILITY_PROFILE } from "@pwragent/messaging-interface/testing";
import { MessagingCallbackHandlers } from "../messaging/core/messaging-callback-handlers";
import type { MessagingCallbackContext, MessagingCallbackHost } from "../messaging/core/messaging-callback-context";
import { messagingModules } from "./fixtures/messaging-controller-modules";
import { messagingCallbackHarness } from "./fixtures/messaging-callback-harness";

function context(f: Awaited<ReturnType<typeof messagingCallbackHarness>>, host: () => MessagingCallbackHost): MessagingCallbackContext {
  return { store: f.store, backend: {}, adapter: {}, now: () => 1_000, logger: {}, capabilityProfile: PERMISSIVE_CAPABILITY_PROFILE, host };
}

describe("messaging callback owner protocol", () => {
  it("keeps access changes and repeated status interactions in their required order", async () => {
    type Access = { permission: boolean; scope: boolean };
    type Real = { access: Access; trace: string[]; click: (detach: boolean) => Promise<void> };
    const change = fc.record({ permission: fc.boolean(), scope: fc.boolean() }).map(next => ({
      check: () => true,
      run: async (model: Access, real: Real) => { model.permission = real.access.permission = next.permission; model.scope = real.access.scope = next.scope; },
      toString: () => `access(${JSON.stringify(next)})`,
    }));
    const click = fc.boolean().map(detach => ({
      check: () => true,
      run: async (model: Access, real: Real) => {
        real.trace.length = 0;
        await real.click(detach);
        const expected = ["permission"];
        if (model.permission) {
          if (detach) expected.push("detach");
          else {
            expected.push("scope");
            if (model.scope) expected.push("remember", "dismiss", "clear", "render");
          }
        }
        expect(real.trace).toEqual(expected);
      },
      toString: () => detach ? "detach" : "refresh",
    }));
    await fc.assert(fc.asyncProperty(fc.commands([change, click], { maxCommands: 12 }), async commands => {
      const f = await messagingCallbackHarness();
      try {
        const access = { permission: true, scope: true };
        const trace: string[] = [];
        // Supply the real facade's remaining owners, not a partial controller
        // whose missing methods could be swallowed by a production catch.
        const host: MessagingCallbackHost = {
          ...messagingModules(f.controller).callbackHost(),
          requirePermission: async () => { trace.push("permission"); return access.permission; },
          requireRemoteScopeForBinding: async () => { trace.push("scope"); return access.scope; },
          detachBinding: async () => { trace.push("detach"); },
          rememberHumanMessagingSource: () => { trace.push("remember"); return undefined; },
          dismissActiveSkillsWorkflow: async () => { trace.push("dismiss"); return false; },
          clearActiveBindingSubmodeIntent: async () => { trace.push("clear"); },
          renderBindingStatus: async binding => { trace.push("render"); return binding; },
        };
        const owner = new MessagingCallbackHandlers(context(f, () => host));
        await fc.asyncModelRun(() => ({ model: { permission: true, scope: true }, real: {
          access, trace, click: async (detach: boolean) => { await owner.handleCallback(f.event(detach ? "status:detach" : "status:refresh")); },
        } }), commands);
      } finally { await f.close(); }
    }), { numRuns: 30 });
  });

  it("constructs without reading stores, adapter getters, backend getters or hosts", async () => {
    const f = await messagingCallbackHarness();
    try {
      const base = context(f, () => messagingModules(f.controller).callbackHost());
      let reads = 0;
      new MessagingCallbackHandlers({
        get store() { reads += 1; return base.store; },
        get backend() { reads += 1; return base.backend; },
        get adapter() { reads += 1; return base.adapter; },
        get capabilityProfile() { reads += 1; return base.capabilityProfile; },
        get now() { reads += 1; return base.now; },
        get logger() { reads += 1; return base.logger; },
        host: () => { reads += 1; return base.host(); },
      });
      expect(reads).toBe(0);
    } finally { await f.close(); }
  });

  it("reads the current host and wrapped store after the permission await", async () => {
    const f = await messagingCallbackHarness();
    try {
      let store: MessagingCallbackContext["store"] = f.store;
      const original = messagingModules(f.controller).callbackHost();
      const observed: string[] = [];
      let host: MessagingCallbackHost = { ...original, requirePermission: async () => {
        await setImmediate();
        store = new Proxy(f.store, { get: (target, key) => {
          if (key === "findActiveBindingForChannel") return async () => ({ ...f.binding, threadId: "replacement-thread" });
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        } });
        host = { ...original,
          requireRemoteScopeForBinding: async (_event, binding) => { observed.push(`scope:${binding?.threadId}`); return true; },
          rememberHumanMessagingSource: () => undefined,
          presentSkillsBrowser: async binding => { observed.push(`skills:${binding.threadId}`); },
        };
        return true;
      } };
      const owner = new MessagingCallbackHandlers({ ...context(f, () => host), get store() { return store; } });
      await owner.handleCallback(f.event("status:skills"));
      expect(observed).toEqual(["scope:replacement-thread", "skills:replacement-thread"]);
    } finally { await f.close(); }
  });

  it("awaits workflow rejection without changing exception identity", async () => {
    const f = await messagingCallbackHarness();
    try {
      const failure = new Error("Fixture owner failure");
      const host = { ...messagingModules(f.controller).callbackHost(),
        requireRemoteScope: async () => true,
        readExactNavigationThread: async () => { await setImmediate(); throw failure; },
      } satisfies MessagingCallbackHost;
      const owner = new MessagingCallbackHandlers(context(f, () => host));
      await expect(owner.handleCallback(f.event("bind:codex:fixture", undefined, { backend: "codex", threadId: "fixture-thread" }))).rejects.toBe(failure);
    } finally { await f.close(); }
  });

  it("keeps a stale queue-cancel notice within its delivery error boundary", async () => {
    const f = await messagingCallbackHarness();
    try {
      const failure = new Error("Fixture notice failure");
      const logged: unknown[] = [];
      const owner = new MessagingCallbackHandlers({
        ...context(f, () => ({ ...messagingModules(f.controller).callbackHost(), deliver: async () => { throw failure; } })),
        logger: { debug: (_message, details) => { logged.push(details); } },
      });
      await expect(owner.handleCallback(f.event("permissions:queue:cancel:stale"))).resolves.toBeUndefined();
      expect(logged).toEqual([expect.objectContaining({ bindingId: f.binding.id, queueId: "stale", error: failure.message })]);
    } finally { await f.close(); }
  });
});
