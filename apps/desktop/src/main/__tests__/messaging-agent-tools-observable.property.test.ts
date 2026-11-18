import { setImmediate } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { MessagingBackendBridge } from "../messaging/core/messaging-adapter";
import { messagingInboundHarness } from "./fixtures/messaging-inbound-harness";
import { messagingAccessHarness } from "./fixtures/messaging-access-harness";

// Observe provider promises and durable bindings, not workflow implementation
// state. Rename commits only after acknowledgement; file sends never suppress
// ordinary final prose; retained attachment claims cannot create twice.
describe("Agent messaging tool observable protocol", () => {
  it("commits renamed bindings only after the provider accepts, preserving its receiver", async () => {
    await fc.assert(fc.asyncProperty(fc.scheduler(), fc.constantFrom("telegram", "discord"), fc.boolean(), async (scheduler, channel, accepted) => {
      const f = await messagingInboundHarness({ channel });
      const entered = Promise.withResolvers<void>();
      try {
        await f.controller.handleInboundEvent(f.event());
        const before = (await f.store.getBinding("fixture-binding"))!;
        const adapter = f.controllerOptions.adapter;
        adapter.setConversationTitle = async function (request) {
          expect(this).toBe(adapter);
          entered.resolve();
          await scheduler.schedule(Promise.resolve(), "rename acknowledgement");
          return { outcome: accepted ? "updated" : "failed", channel, conversation: request.channel.conversation,
            title: request.title, updatedAt: 2_000 };
        };
        const result = f.controller.handlePwrAgentMessagingRequest({ operation: "rename_current_messaging_conversation",
          context: { backend: "codex", threadId: "fixture-thread", turnId: "fixture-turn-1" }, args: { title: "Chosen fixture title" } });
        await Promise.race([entered.promise, result.then(() => { expect.fail("Rename must reach provider acknowledgement"); })]);
        expect(await f.store.getBinding(before.id)).toEqual(before);
        await scheduler.waitFor(result);
        expect((await result).ok).toBe(accepted);
        expect((await f.store.getBinding(before.id))?.channel.conversation.title)
          .toBe(accepted ? "Chosen fixture title" : before.channel.conversation.title);
        await setImmediate();
      } finally { await f.close(); }
    }), { numRuns: 25 });
  });

  it("applies provider upload capability and byte limits before delivery and reports only visible acceptance", async () => {
    await fc.assert(fc.asyncProperty(fc.scheduler(), fc.record({ supported: fc.boolean(), cap: fc.integer({ min: 2, max: 10 }),
      size: fc.integer({ min: 8, max: 12 }), outcome: fc.constantFrom("presented", "failed", "discarded") }), async (scheduler, input) => {
      const f = await messagingInboundHarness();
      try {
        await f.controller.handleInboundEvent(f.event());
        Object.assign(f.controllerOptions.adapter.capabilityProfile!, { outboundAttachments: {
          supportsFileUpload: input.supported, supportsImageUpload: false, maxUploadBytes: input.cap,
        } });
        let calls = 0;
        const entered = Promise.withResolvers<void>();
        f.controllerOptions.adapter.deliver = async intent => {
          expect(intent.kind).toBe("message");
          expect(intent.delivery?.requireAttachments).toBe(true);
          if (intent.kind === "message") {
            const part = intent.parts.find(part => part.type === "file");
            expect(part?.type === "file" ? [...part.data!] : []).toEqual(Array(input.size).fill(65));
          }
          calls++;
          entered.resolve();
          await scheduler.schedule(Promise.resolve(), "file acknowledgement");
          return { outcome: input.outcome, channel: "telegram", deliveredAt: 2_000 };
        };
        let settled = false;
        const result = f.controller.handlePwrAgentMessagingRequest({ operation: "send_messaging_file",
          context: { backend: "codex", threadId: "fixture-thread", turnId: "fixture-turn-1" },
          args: { path: "/fixture/report.txt", mediaKind: "document" } }, new Uint8Array(input.size).fill(65))
          .then(value => { settled = true; return value; });
        const eligible = input.supported && input.size <= input.cap;
        if (eligible) {
          await Promise.race([entered.promise, result.then(() => { expect.fail("Eligible file must reach provider acknowledgement"); })]);
          expect(settled).toBe(false);
        }
        await scheduler.waitFor(result);
        expect((await result).ok).toBe(eligible && input.outcome === "presented");
        expect(calls).toBe(eligible ? 1 : 0);
      } finally { await f.close(); }
    }), { numRuns: 30 });
  });

  it("keeps source final prose after public and private file sends, including provider failures", async () => {
    await fc.assert(fc.asyncProperty(fc.boolean(), fc.boolean(), fc.boolean(), async (privateFile, privateSupported, delivered) => {
      const f = await messagingInboundHarness();
      try {
        await f.controller.handleInboundEvent(f.event());
        const destinations: string[] = [];
        const prose: string[] = [];
        if (privateSupported) f.controllerOptions.adapter.resolvePrivateConversation = async () => ({ outcome: "resolved", channel: "telegram",
          conversation: { id: "fixture-private", kind: "dm", isDirectMessage: true }, updatedAt: 2_000 });
        f.controllerOptions.adapter.deliver = async intent => {
          if (intent.kind === "message") {
            if (intent.parts.some(part => part.type === "file")) {
              destinations.push(intent.audit!.channel.conversation.id);
              return { outcome: delivered ? "presented" : "failed", channel: "telegram", deliveredAt: 2_000 };
            }
            prose.push(...intent.parts.filter(part => part.type === "text").map(part => part.text));
          }
          return { outcome: "presented", channel: "telegram", deliveredAt: 2_000 };
        };
        const result = await f.controller.handlePwrAgentMessagingRequest({ operation: "send_messaging_file",
          context: { backend: "codex", threadId: "fixture-thread", turnId: "fixture-turn-1" },
          args: { path: "/fixture/report.txt", private: privateFile } }, new Uint8Array([65, 66]));
        const canSend = !privateFile || privateSupported;
        expect(result.ok).toBe(canSend && delivered);
        expect(destinations).toEqual(canSend ? [privateFile ? "fixture-private" : f.channel.conversation.id] : []);
        await f.controller.handleBackendEvent({ backend: "codex", notification: { method: "item/completed", params: {
          threadId: "fixture-thread", turnId: "fixture-turn-1", item: { id: "fixture-final", type: "agentMessage", phase: "final", text: "Source final fixture" },
        } } });
        expect(prose).toContain("Source final fixture");
      } finally { await f.close(); }
    }), { numRuns: 25 });
  });

  it("reuses retained attachment results and refuses changed human revisions before rebinding", async () => {
    await fc.assert(fc.asyncProperty(fc.constantFrom("telegram", "discord"), fc.boolean(), fc.integer({ min: 2, max: 4 }), async (channel, staleRevision, repeats) => {
      const f = await messagingAccessHarness(channel);
      try {
        f.policy.enforcing = false;
        f.controllerOptions.adapter.retainedSourceConnectionId = () => "fixture-connection";
        f.controllerOptions.adapter.authorizeRetainedSource = async () => true;
        const resolveThreadTarget: NonNullable<MessagingBackendBridge["resolveThreadTarget"]> = async () => ({ thread: {
          id: "attached-thread", source: "codex", title: "Attached fixture", titleSource: "explicit", linkedDirectories: [], inbox: { inInbox: false },
        } });
        Object.assign(f.backend, { resolveThreadTarget });
        let creates = 0;
        f.controllerOptions.adapter.createManagedConversation = async () => {
          creates++;
          return { outcome: "created", channel, conversation: { id: "fixture-child", kind: "thread", parentConversationId: "fixture-conversation" }, updatedAt: 2_000 };
        };
        let writes = 0;
        const upsert = f.store.upsertBinding.bind(f.store);
        f.store.upsertBinding = async binding => { writes++; return await upsert(binding); };
        // Keep the causal parent bound: replacing that binding deliberately
        // revokes its old source and would make later attempts unauthorized.
        const request = { operation: "attach_thread_to_surface" as const,
          context: { backend: "codex" as const, threadId: "fixture-thread", causalMessagingSource: f.source.ref },
          args: { backend: "codex" as const, threadId: "attached-thread", placement: "new_child" as const,
            expectedRevision: staleRevision ? "unrelated-revision" : f.source.ref.requestId, idempotencyKey: "fixture-claim" } };
        const first = await f.controller.handlePwrAgentMessagingRequest(request);
        expect(first.ok).toBe(!staleRevision);
        const after = writes;
        for (let n = 1; n < repeats; n++) expect(await f.controller.handlePwrAgentMessagingRequest(request)).toEqual(first);
        expect(writes).toBe(after);
        expect(writes > 0).toBe(!staleRevision);
        expect(creates).toBe(staleRevision ? 0 : 1);
      } finally { await f.close(); }
    }), { numRuns: 25 });
  });

  it("checks resolved remote-owner authority before creating or attaching a destination", async () => {
    await fc.assert(fc.asyncProperty(fc.boolean(), async remoteGrant => {
      const f = await messagingAccessHarness();
      try {
        f.policy.named = new Set(["message.reply", "thread.resume", "tools.thread_inspection", ...(remoteGrant ? ["federation.remote_control" as const] : [])]);
        f.controllerOptions.adapter.retainedSourceConnectionId = () => "fixture-connection";
        f.controllerOptions.adapter.authorizeRetainedSource = async () => true;
        const resolveThreadTarget: NonNullable<MessagingBackendBridge["resolveThreadTarget"]> = async () => ({ thread: {
          id: "remote-thread", source: "codex", title: "Remote fixture", titleSource: "explicit", linkedDirectories: [], inbox: { inInbox: false },
        }, federatedThread: { backend: "codex", threadId: "remote-thread", target: { scope: "remote", instanceId: "fixture-peer" } } });
        Object.assign(f.backend, { resolveThreadTarget });
        let creates = 0;
        f.controllerOptions.adapter.createManagedConversation = async () => {
          creates++;
          return { outcome: "created", channel: "telegram", conversation: { id: "fixture-remote-child", kind: "thread" }, updatedAt: 2_000 };
        };
        const pending = f.controller.handlePwrAgentMessagingRequest({ operation: "attach_thread_to_surface",
          context: { backend: "codex", threadId: "fixture-thread", causalMessagingSource: f.source.ref },
          args: { backend: "codex", threadId: "remote-thread", placement: "new_child" } });
        await expect(pending).resolves.toMatchObject({ ok: remoteGrant });
        expect(creates).toBe(remoteGrant ? 1 : 0);
      } finally { await f.close(); }
    }), { numRuns: 25 });
  });

});
