import { setImmediate } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { MessagingBrowseSessionRecord } from "@pwragent/messaging-interface";
import { MESSAGING_CALLBACK_HANDLE_TTL_MS } from "@pwragent/messaging-interface";
import { MessagingAccessControl } from "../messaging/core/messaging-access-control";
import { MessagingController, type MessagingControllerOptions } from "../messaging/core/messaging-controller";
import type { MessagingAccessContext, MessagingAccessHost } from "../messaging/core/messaging-access-context";
import { messagingAccessHarness } from "./fixtures/messaging-access-harness";
import { messagingModules } from "./fixtures/messaging-controller-modules";
import { SqliteMessagingStore } from "../state/messaging-store-sqlite";
import { openInMemoryStateDb } from "./sqlite-test-utils";

describe("messaging access owner", () => {
  it("adds remote scope only for resolved peer bindings and keeps render probes unaudited", async () => {
    await fc.assert(fc.asyncProperty(fc.boolean(), fc.boolean(), async (remote, grant) => {
      const f = await messagingAccessHarness();
      try {
        f.policy.named = new Set(grant ? ["message.reply", "federation.remote_control"] : ["message.reply"]);
        const owner = messagingModules(f.controller).access;
        expect(owner.actorHasPermission(f.event(), "federation.remote_control")).toBe(grant);
        expect(f.activity.list()).toHaveLength(0);
        const binding = (await f.store.getBinding("fixture-binding"))!;
        const target = { ...binding, ...(remote ? { federatedThread: { backend: binding.backend, threadId: binding.threadId,
          target: { scope: "remote" as const, instanceId: "fixture-peer" } } } : {}),
        };
        expect(await owner.requireRemoteScopeForBinding(f.event(), target, "fixture", { notify: false })).toBe(!remote || grant);
        expect(f.activity.list()).toHaveLength(remote && !grant ? 1 : 0);
        expect(f.deliveries).toHaveLength(0);
      } finally { await f.close(); }
    }), { numRuns: 25 });
  });

  it("reads no live collaborators at construction and resolves a replacement host at delivery time", async () => {
    await fc.assert(fc.asyncProperty(fc.scheduler(), async scheduler => {
      const f = await messagingAccessHarness();
      const reads: string[] = [];
      let host = messagingModules(f.controller).accessHost();
      const entered = Promise.withResolvers<void>();
      let pending: Promise<boolean> | undefined;
      try {
        const context: MessagingAccessContext = {
          get store() { reads.push("store"); return f.controllerOptions.store; },
          get adapter() { reads.push("adapter"); return f.controllerOptions.adapter; },
          get capabilityProfile() { reads.push("capabilities"); return f.controllerOptions.adapter.capabilityProfile; },
          get logger() { reads.push("logger"); return {}; },
          get config() { reads.push("config"); return f.controllerOptions; },
          now: () => 1_000,
          host: () => { reads.push("host"); return host; },
        };
        const owner = new MessagingAccessControl(context, ["fixture-actor"]);
        expect(reads).toEqual([]);
        f.policy.named = new Set(["thread.execution.full_access"]);
        f.controllerOptions.fullAccessControls = async () => {
          entered.resolve(); await scheduler.schedule(Promise.resolve(), "Full Access controls");
          return { allowEscalation: false, allowThreadResume: true, warningPolicy: "always" };
        };
        pending = owner.ensureFullAccessEscalationAllowed({ kind: "thread", backend: "codex", threadId: "fixture-thread" }, f.event());
        await entered.promise;
        let replacementDelivered = false;
        host = { ...host, deliver: async () => { replacementDelivered = true; return { outcome: "presented", channel: "telegram", deliveredAt: 1_000 }; } };
        await scheduler.waitAll();
        expect(await pending).toBe(false);
        expect(replacementDelivered).toBe(true);
        expect(f.deliveries).toHaveLength(0);
      } finally { await scheduler.waitAll(); await pending; await f.close(); }
    }), { numRuns: 25 });
  });

  it("double-gates Full Access and preserves denial, warning and acceptance effects in order", async () => {
    await fc.assert(fc.asyncProperty(fc.record({ permission: fc.boolean(), allow: fc.boolean(),
      policy: fc.constantFrom("always", "never", "dismissable"), dismissed: fc.boolean(), canDismiss: fc.boolean(),
    }), async value => {
      const f = await messagingAccessHarness();
      const trace: string[] = [];
      try {
        f.policy.named = new Set(value.permission ? ["thread.execution.full_access"] : ["message.reply"]);
        f.controllerOptions.fullAccessControls = () => {
          trace.push("controls");
          return { allowEscalation: value.allow, allowThreadResume: false, warningPolicy: value.policy,
            authorizedUsers: { telegram: [{ id: "fixture-actor", displayName: "Fixture actor", fullAccessWarningDismissed: value.dismissed }] },
            dismissWarning: async () => {}, canDismissWarning: async () => value.canDismiss,
          };
        };
        f.controllerOptions.onFullAccessPolicyViolation = function () { expect(this).toBe(f.controllerOptions); trace.push("violation"); };
        const native = messagingModules(f.controller).accessHost();
        const host: MessagingAccessHost = { ...native,
          storePendingIntent: async (...args) => { trace.push("pending"); return await native.storePendingIntent(...args); },
          deliver: async (...args) => { trace.push("deliver"); return await native.deliver(...args); },
        };
        const owner = new MessagingAccessControl({ store: f.store, adapter: f.controllerOptions.adapter,
          capabilityProfile: f.controllerOptions.adapter.capabilityProfile, now: () => 1_000, logger: {}, config: f.controllerOptions, host: () => host,
        }, ["fixture-actor"]);
        const warns = value.policy === "always" || (value.policy === "dismissable" && !value.dismissed);
        const allowed = value.permission && value.allow && !warns;
        expect(await owner.ensureFullAccessEscalationAllowed({ kind: "thread", backend: "codex", threadId: "fixture-thread" }, f.event())).toBe(allowed);
        if (!value.permission) {
          expect(trace).toEqual(["deliver"]);
          expect(f.activity.list()[0]?.payload?.permission).toBe("thread.execution.full_access");
        } else if (!value.allow) expect(trace).toEqual(["controls", "violation", "deliver"]);
        else if (!warns) expect(trace).toEqual(["controls"]);
        else {
          expect(trace).toEqual(["controls", "controls", "pending", "deliver"]);
          const warning = f.deliveries.find(intent => intent.kind === "confirmation");
          expect(warning?.actions?.some(action => action.id.endsWith("dismiss"))).toBe(value.policy === "dismissable" && value.canDismiss);
          expect(await f.store.findActivePendingIntentForChannel({ channel: f.channel, actorId: "fixture-actor", now: 1_000 })).toBeDefined();
        }
      } finally { await f.close(); }
    }), { numRuns: 40 });
  });

  it("keeps audit failures soft, delivery failures observable and policy logging inside its catch", async () => {
    const f = await messagingAccessHarness();
    try {
      const owner = messagingModules(f.controller).access;
      f.controllerOptions.activityLog = () => { throw new Error("Fixture audit getter"); };
      f.controllerOptions.adapter.deliver = async () => { throw new Error("Fixture delivery failure"); };
      await expect(owner.requirePermission(f.event(), "thread.new", "fixture", { notify: false })).resolves.toBe(false);
      await expect(owner.requirePermission(f.event(), "thread.new", "fixture")).rejects.toThrow("Fixture delivery failure");
      f.policy.named = new Set(["thread.execution.full_access"]);
      f.controllerOptions.fullAccessControls = { allowEscalation: false, allowThreadResume: true, warningPolicy: "always" };
      const trace: string[] = [];
      f.controllerOptions.onFullAccessPolicyViolation = () => { throw new Error("Fixture policy log failure"); };
      f.controllerOptions.logger!.debug = message => { trace.push(message); };
      await expect(owner.ensureFullAccessEscalationAllowed({ kind: "thread", backend: "codex", threadId: "fixture-thread" }, f.event())).rejects.toThrow("Fixture delivery failure");
      expect(trace).toContain("messaging full-access policy log failed");
    } finally { await f.close(); }
  });

  it("reads the replaced overlay after retained provider approval and uses the effective default route", async () => {
    await fc.assert(fc.asyncProperty(fc.scheduler(), fc.boolean(), async (scheduler, sameTarget) => {
      const f = await messagingAccessHarness();
      const db = openInMemoryStateDb();
      const replacement = new SqliteMessagingStore(db);
      const entered = Promise.withResolvers<void>();
      let pending: Promise<boolean | undefined> | undefined;
      try {
        f.controllerOptions.adapter.retainedSourceConnectionId = () => "fixture-connection";
        f.controllerOptions.adapter.authorizeRetainedSource = async () => {
          entered.resolve(); await scheduler.schedule(Promise.resolve(), "retained approval"); return true;
        };
        const source = { ...f.source, bindingId: undefined };
        await replacement.upsertDefaultAgentAssignment({ id: "fixture-default", scope: { kind: "conversation", channel: f.channel },
          target: { kind: "agent", backend: "codex", threadId: sameTarget ? "fixture-thread" : "another-thread" }, createdAt: 1_000, updatedAt: 1_000,
        });
        pending = messagingModules(f.controller).access.retainedSourceIsAuthorized(source);
        await entered.promise;
        f.controllerOptions.store = replacement;
        await scheduler.waitAll();
        expect(await pending).toBe(sameTarget);
        await setImmediate();
      } finally { await scheduler.waitAll(); await pending; await f.close(); db.close(); }
    }), { numRuns: 25 });
  });

  it("preserves optional policy getter boundaries and the native resolver receiver", async () => {
    const f = await messagingAccessHarness();
    try {
      const owner = messagingModules(f.controller).access;
      const policy = f.controllerOptions.rbacPolicy!;
      policy.resolveIfEnforcing = undefined;
      const native = policy.resolve;
      policy.resolve = function (input) { expect(this).toBe(policy); return native(input); };
      expect(owner.authorizeInboundAdmission(f.event())).toBe(false);
      expect(f.reads).toEqual(["enforcing", "resolve"]);
      Object.defineProperty(policy, "resolveIfEnforcing", { get: () => { throw new Error("Fixture optional policy getter"); } });
      expect(() => owner.authorizeInboundAdmission(f.event())).toThrow("Fixture optional policy getter");
    } finally { await f.close(); }
  });

  it("uses the facade's native clock and delivery ports when a public tool check is denied", async () => {
    const f = await messagingAccessHarness();
    let clockReads = 0;
    const options: MessagingControllerOptions = { ...f.controllerOptions, now() {
      expect(this).toBe(controller); clockReads++; return 2_000;
    } };
    const controller = new MessagingController(options);
    try {
      const result = controller.checkDynamicToolPermission({ backend: "codex", threadId: "fixture-thread", category: "thread_inspection", tool: "read_thread" }, f.source);
      expect(result).toEqual({ owns: true, allowed: false, permission: "tools.thread_inspection" });
      expect(clockReads).toBe(1);
      expect(f.activity.list()[0]?.createdAt).toBe(2_000);
      expect(await messagingModules(controller).access.requirePermission(f.event(), "thread.new", "fixture")).toBe(false);
      expect(f.deliveries.some(intent => intent.kind === "error" && intent.title === "Not permitted")).toBe(true);
      f.policy.named.add("thread.execution.full_access");
      options.fullAccessControls = { allowEscalation: false, allowThreadResume: true, warningPolicy: "always" };
      let logged = false;
      options.onFullAccessPolicyViolation = function () { expect(this).toBe(options); logged = true; };
      expect(await messagingModules(controller).access.ensureFullAccessEscalationAllowed({ kind: "thread", backend: "codex", threadId: "fixture-thread" }, f.event())).toBe(false);
      expect(logged).toBe(true);
    } finally { controller.dispose(); await controller.whenToolUpdatesSettled(); await f.close(); }
  });

  it("extends picker warnings through the callback lifetime before storing and delivering them", async () => {
    await fc.assert(fc.asyncProperty(fc.constantFrom("message", "surface"), fc.boolean(), async (presentationMode, resume) => {
      const f = await messagingAccessHarness();
      try {
        f.controllerOptions.fullAccessControls = { allowEscalation: true, allowThreadResume: true, warningPolicy: "always" };
        const session: MessagingBrowseSessionRecord = { id: "fixture-session", allowedActorIds: ["fixture-actor"], channel: f.channel,
          launchAction: "start_new_thread", mode: "projects", pageIndex: 0, pageSize: 5,
          createdAt: 1, updatedAt: 1, expiresAt: 2_000, surface: { channel: "telegram", id: "fixture-picker" },
        };
        await f.store.upsertBrowseSession(session);
        const owner = messagingModules(f.controller).access;
        const context = resume ? { kind: "resume-thread" as const, backend: "codex" as const, threadId: "fixture-thread", session }
          : { kind: "new-thread" as const, session };
        await owner.presentFullAccessRiskWarning(context, f.event(), { presentationMode });
        const updated = await f.store.getBrowseSession(session.id, { now: 1_000 });
        expect(updated?.expiresAt).toBeGreaterThanOrEqual(1_000 + MESSAGING_CALLBACK_HANDLE_TTL_MS);
        if (presentationMode === "message") expect(updated?.textInputExpiresAt).toBeGreaterThanOrEqual(1_000);
        const warning = f.deliveries.find(intent => intent.kind === "confirmation");
        expect(warning?.targetSurface?.id).toBe(presentationMode === "surface" ? "fixture-picker" : undefined);
      } finally { await f.close(); }
    }), { numRuns: 25 });
  });
});
