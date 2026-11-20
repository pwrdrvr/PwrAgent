import { setImmediate } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { type MessagingPermissionId } from "@pwragent/shared/contracts/rbac";

import { messagingAccessHarness as fixture } from "./fixtures/messaging-access-harness";

const grants = ["message.reply", "thread.status.view", "tools.thread_inspection", "federation.remote_control", "tools.instance_management", "tools.instance_lifecycle", "thread.settings.model", "thread.settings.execution_mode", "thread.execution.full_access", "thread.control.organize", "thread.control.handoff"] satisfies MessagingPermissionId[];


describe("observable messaging access protocol", () => {
  it("re-resolves changed grants and admission paths before each reply without auditing allows", async () => {
    type Real = Awaited<ReturnType<typeof fixture>>;
    type Model = { enforcing: boolean; named: boolean; permissions: readonly MessagingPermissionId[]; bucket: readonly MessagingPermissionId[] };
    const configure = fc.record({ enforcing: fc.boolean(), named: fc.boolean(), permissions: fc.subarray(grants), bucket: fc.subarray(grants) }).map(value => ({
      check: () => true,
      run: async (model: Model, real: Real) => {
        Object.assign(model, value);
        real.policy.enforcing = value.enforcing;
        real.policy.named = new Set(value.permissions); real.policy.bucket = new Set(value.bucket);
        real.controller.updateAuthorizedActorIds(value.named ? ["fixture-actor"] : []);
      },
      toString: () => `configure(${JSON.stringify(value)})`,
    }));
    const reply = fc.boolean().map(media => ({
      check: () => true,
      run: async (model: Model, real: Real) => {
        // Actor attachments always add grants; only the provider's unnamed
        // admission path makes bucket attachments eligible as well.
        const permissions = [...model.permissions, ...(model.named ? [] : model.bucket)];
        const admitted = model.enforcing ? permissions.length > 0 : model.named;
        const allowed = admitted && (!model.enforcing || permissions.includes("message.reply"));
        const before = real.starts.length;
        const row = real.activity.list().at(0)?.id ?? 0;
        const deliveryCount = real.deliveries.length;
        const event = real.event();
        await real.controller.handleInboundEvent(media ? { ...event, kind: "media", attachments: [], disposition: "available" } : event);
        expect(real.starts.length - before).toBe(allowed ? 1 : 0);
        const denials = real.activity.list({ sinceId: row }).filter(entry => entry.payload?.reason === "unauthorized-capability");
        expect(denials).toHaveLength(model.enforcing && !allowed ? 1 : 0);
        if (model.enforcing && admitted && !allowed) {
          expect(denials[0]!.payload?.permission).toBe("message.reply");
          expect(real.deliveries.slice(deliveryCount).some(intent => intent.kind === "error")).toBe(false);
        }
        if (allowed) await real.finish("completed");
      },
      toString: () => `reply(${media ? "media" : "text"})`,
    }));
    await fc.assert(fc.asyncProperty(fc.constantFrom("telegram", "discord"), fc.boolean(), fc.commands([configure, reply], { maxCommands: 9 }), async (channel, shared, commands) => {
      const real = await fixture(channel, shared);
      try { await fc.asyncModelRun(() => ({ model: { enforcing: true, named: true, permissions: [], bucket: [] }, real }), commands); }
      finally { await real.close(); }
    }), { numRuns: 30 });
  });

  it("checks tool fields, explicit remote scope and lifecycle grants against the attributable actor", async () => {
    await fc.assert(fc.asyncProperty(fc.subarray(grants), fc.boolean(), fc.boolean(), fc.constantFrom("inspect", "remote", "manage", "noop", "model", "full-access", "organize", "handoff"), async (permissions, enforcing, attributable, action) => {
      const f = await fixture();
      try {
        f.policy.named = new Set(permissions); f.policy.enforcing = enforcing;
        const context = { backend: "codex" as const, threadId: "fixture-thread", turnId: "fixture-turn" };
        const result = f.controller.checkDynamicToolPermission({ ...context, category: action === "manage" ? "app_management" : "thread_inspection",
          tool: action === "manage" ? "manage_pwragent" : ["noop", "model", "full-access", "organize", "handoff"].includes(action) ? "mutate_thread" : "read_thread",
          arguments: action === "remote" ? { instanceId: "fixture-peer" } : action === "model" ? { model: "fixture-model" }
            : action === "full-access" ? { executionMode: "full-access" } : action === "organize" ? { pinned: true } : action === "handoff" ? { locked: true } : {},
        }, attributable ? f.source : undefined);
        const required: MessagingPermissionId[] = action === "manage" ? ["tools.instance_management", "tools.instance_lifecycle"]
          : action === "model" ? ["thread.settings.model"] : action === "full-access" ? ["thread.settings.execution_mode", "thread.execution.full_access"]
          : action === "organize" ? ["thread.control.organize"] : action === "handoff" ? ["thread.control.handoff"] : action === "noop" ? [] : action === "remote" ? ["tools.thread_inspection", "federation.remote_control"] : ["tools.thread_inspection"];
        const allowed = !attributable || (enforcing ? required.every(permission => f.policy.named.has(permission)) : action !== "manage");
        expect(result).toMatchObject({ owns: attributable, allowed });
        const denials = f.activity.list().filter(entry => entry.payload?.reason === "unauthorized-capability");
        expect(denials).toHaveLength(attributable && enforcing && !allowed ? 1 : 0);
        expect(f.deliveries).toHaveLength(0);
        expect(f.reads.includes("enforcing")).toBe(false);
      } finally { await f.close(); }
    }), { numRuns: 40 });
  });

  it("requires explicit remote-tool scope even when inspection is already granted", async () => {
    await fc.assert(fc.asyncProperty(fc.boolean(), async remoteGrant => {
      const f = await fixture();
      try {
        f.policy.named = new Set(remoteGrant ? ["tools.thread_inspection", "federation.remote_control"] : ["tools.thread_inspection"]);
        const check = { backend: "codex" as const, threadId: "fixture-thread", category: "thread_inspection" as const, tool: "read_thread" };
        expect(f.controller.checkDynamicToolPermission(check, f.source)).toEqual({ owns: true, allowed: true });
        const result = f.controller.checkDynamicToolPermission({ ...check, arguments: { instanceId: "fixture-peer" } }, f.source);
        expect(result).toEqual(remoteGrant ? { owns: true, allowed: true } : { owns: true, allowed: false, permission: "federation.remote_control" });
      } finally { await f.close(); }
    }), { numRuns: 25 });
  });

  it("verifies retained connection and current binding after provider authorization yields", async () => {
    await fc.assert(fc.asyncProperty(fc.scheduler(), fc.constantFrom("valid", "revoked", "rebound", "provider-denied", "unknown", "connection"), async (scheduler, outcome) => {
      const f = await fixture();
      const entered = Promise.withResolvers<void>();
      const modes: Array<boolean | undefined> = [];
      const nativeReceivers: boolean[] = [];
      let pending: ReturnType<typeof f.controller.authorizeRetainedTool> | undefined;
      try {
        f.policy.named = new Set(["message.reply"]);
        f.controllerOptions.adapter.retainedSourceConnectionId = () => outcome === "connection" ? "replacement" : "fixture-connection";
        f.controllerOptions.adapter.authorizeRetainedSource = async function (_event, verifyAccess) {
          modes.push(verifyAccess); nativeReceivers.push(this === f.controllerOptions.adapter);
          entered.resolve(); await scheduler.schedule(Promise.resolve(), "provider authorization");
          return outcome === "provider-denied" ? false : outcome === "unknown" ? undefined : true;
        };
        const context = { backend: "codex" as const, threadId: "fixture-thread", causalMessagingSource: f.source.ref };
        pending = f.controller.authorizeRetainedTool(context, { ...context, category: "messaging_context", tool: "send_messaging_file" });
        if (outcome !== "connection") {
          await entered.promise;
          const binding = (await f.store.getBinding("fixture-binding"))!;
          if (outcome === "revoked") await f.store.revokeBinding({ bindingId: binding.id, revokedAt: 2_000 });
          if (outcome === "rebound") await f.store.upsertBinding({ ...binding, threadId: "another-thread" });
        }
        await scheduler.waitAll();
        expect(await pending).toMatchObject({ owns: true, allowed: outcome === "valid" });
        expect(modes).toEqual(outcome === "connection" ? [] : [false]);
        expect(nativeReceivers).toEqual(outcome === "connection" ? [] : [true]);
        await setImmediate();
      } finally { await scheduler.waitAll(); await pending; await f.close(); }
    }), { numRuns: 30 });
  });

  it("keeps retained sources isolated by provider and rejects ambiguous attribution before provider calls", async () => {
    await fc.assert(fc.asyncProperty(fc.constantFrom("telegram", "discord"), fc.boolean(), async (channel, ambiguous) => {
      const f = await fixture(channel);
      try {
        const other = channel === "telegram" ? "discord" : "telegram";
        const source = f.requests.remember({ agent: f.source.agent, bindingId: "fixture-binding", connectionId: "fixture-connection",
          event: { ...f.event(), channel: { ...f.channel, channel: other } },
        })!;
        let calls = 0;
        f.controllerOptions.adapter.retainedSourceConnectionId = () => "fixture-connection";
        f.controllerOptions.adapter.authorizeRetainedSource = async () => { calls++; return true; };
        const context = { backend: "codex" as const, threadId: "fixture-thread", causalMessagingSource: ambiguous ? f.source.ref : source.ref,
          causalMessagingAmbiguous: ambiguous,
        };
        expect(await f.controller.authorizeRetainedTool(context, { ...context, category: "messaging_context", tool: "send_private_response" }))
          .toEqual({ owns: false, allowed: false });
        expect(calls).toBe(0);
      } finally { await f.close(); }
    }), { numRuns: 25 });
  });

  it("attributes a real Default Agent turn only to the controller that accepted the human reply", async () => {
    await fc.assert(fc.asyncProperty(fc.constantFrom("telegram", "discord"), async channel => {
      const f = await fixture(channel, false, "default-agent");
      try {
        f.policy.named = new Set(["message.reply"]);
        f.controllerOptions.adapter.retainedSourceConnectionId = () => "fixture-connection";
        f.controllerOptions.adapter.authorizeRetainedSource = async () => true;
        const check = { backend: "codex" as const, threadId: "fixture-thread", turnId: "fixture-turn-1", category: "thread_inspection" as const, tool: "read_thread" };
        expect(f.controller.checkDynamicToolPermission(check)).toEqual({ owns: false, allowed: true });
        await f.controller.handleInboundEvent(f.event());
        expect(f.starts).toHaveLength(1);
        expect(f.controller.checkDynamicToolPermission(check)).toEqual({ owns: true, allowed: false, permission: "tools.thread_inspection" });
        f.policy.named.add("tools.thread_inspection");
        expect(f.controller.checkDynamicToolPermission(check)).toEqual({ owns: true, allowed: true });
        await f.finish("completed");
      } finally { await f.close(); }
    }), { numRuns: 25 });
  });
});
