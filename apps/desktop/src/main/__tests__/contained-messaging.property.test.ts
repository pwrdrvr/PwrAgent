import { expect, it } from "vitest";
import fc from "fast-check";
import { messagingAccessHarness } from "./fixtures/messaging-access-harness";

// Execute the real controller admission method. Provider/RBAC approval alone
// cannot authorize a contained peer to use another thread's conversation.
it("authorizes contained messaging only for the live binding's exact owner and thread", async () => {
  await fc.assert(fc.asyncProperty(fc.record({ owner: fc.boolean(), thread: fc.boolean(), backend: fc.boolean(),
    revoked: fc.boolean(), binding: fc.boolean() }), async (match) => {
    const f = await messagingAccessHarness();
    try {
      f.policy.named = new Set(["message.reply", "federation.remote_control"]);
      f.controllerOptions.adapter.retainedSourceConnectionId = () => "fixture-connection";
      f.controllerOptions.adapter.authorizeRetainedSource = async () => true;
      const original = (await f.store.getBinding("fixture-binding"))!;
      const backend = match.backend ? "codex" : "claude";
      const threadId = match.thread ? "fixture-thread" : "another-thread";
      await f.store.upsertBinding({ ...original, backend, threadId, federatedThread: {
        backend, threadId, target: { scope: "remote", instanceId: match.owner ? "outpost" : "another-peer" },
      } });
      if (match.revoked || !match.binding) await f.store.revokeBinding({ bindingId: original.id, revokedAt: 2_000 });
      const context = { backend: "codex" as const, threadId: "fixture-thread", requestingInstanceId: "outpost", containedPeer: true,
        causalMessagingSource: f.source.ref,
      };
      const result = await f.controller.authorizeRetainedTool(context, { ...context, category: "messaging_context", tool: "send_private_response" });
      expect(result.allowed).toBe(match.owner && match.thread && match.backend && !match.revoked && match.binding);
    } finally { await f.close(); }
  }), { numRuns: 35 });
});
