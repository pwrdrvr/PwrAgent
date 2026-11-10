import { expect, it } from "vitest";
import fc from "fast-check";
import { MessagingController } from "../messaging/core/messaging-controller";

// Execute the real controller admission method. Provider/RBAC approval alone
// cannot authorize a contained peer to use another thread's conversation.
it("authorizes contained messaging only for the live binding's exact owner and thread", async () => {
  await fc.assert(fc.asyncProperty(fc.record({ owner: fc.boolean(), thread: fc.boolean(), backend: fc.boolean(),
    revoked: fc.boolean(), binding: fc.boolean() }), async (match) => {
    const binding = { id: "binding", ...(match.revoked ? { revokedAt: 1 } : {}), federatedThread: {
      backend: match.backend ? "codex" : "claude", threadId: match.thread ? "own-thread" : "another-thread",
      target: { scope: "remote", instanceId: match.owner ? "outpost" : "another-peer" },
    } };
    const controller = Object.assign(Object.create(MessagingController.prototype), {
      options: { store: { findActiveBindingForChannel: async () => match.binding ? binding : undefined } },
      retainedRequestSource: () => ({ bindingId: "binding", event: { channel: {} } }),
      isChannelInScope: () => true, retainedRequestCanCrossInstance: () => true,
      retainedSourceIsAuthorized: async () => true, checkDynamicToolPermission: () => ({ owns: true, allowed: true }),
    }) as MessagingController;
    const context = { backend: "codex" as const, threadId: "own-thread", requestingInstanceId: "outpost", containedPeer: true };
    const result = await controller.authorizeRetainedTool(context, { ...context, category: "messaging_context", tool: "send_private_response" });
    expect(result.allowed).toBe(match.owner && match.thread && match.backend && !match.revoked && match.binding);
  }));
});
