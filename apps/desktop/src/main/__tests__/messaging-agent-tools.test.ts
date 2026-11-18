import { describe, expect, it } from "vitest";
import { agentMessagingTurnKey } from "../messaging/core/messaging-backend-event-helpers";
import { MessagingAgentTools } from "../messaging/core/messaging-agent-tools";
import type { MessagingAgentToolContext } from "../messaging/core/messaging-agent-tool-context";
import { messagingModules } from "./fixtures/messaging-controller-modules";
import { messagingInboundHarness } from "./fixtures/messaging-inbound-harness";

const context = { backend: "codex" as const, threadId: "fixture-thread", turnId: "fixture-turn-1" };

describe("Agent messaging tool owner ports", () => {
  it("constructs and validates arguments without reading any collaborators", async () => {
    const unavailable = (): never => { expect.fail("Eager collaborator read"); };
    const owner = new MessagingAgentTools({
      get store() { return unavailable(); }, get backend() { return unavailable(); }, get adapter() { return unavailable(); },
      get capabilityProfile() { return unavailable(); }, get privateResponses() { return unavailable(); },
      get toolUpdatePolicy() { return unavailable(); }, get pdfAttachmentStore() { return unavailable(); },
      get config() { return unavailable(); }, get now() { return unavailable(); }, get logger() { return unavailable(); },
      get host() { return unavailable(); },
    } satisfies MessagingAgentToolContext);
    await expect(owner.handlePwrAgentMessagingRequest({ operation: "send_private_response", context, args: { text: "" } }))
      .resolves.toMatchObject({ ok: false, error: { code: "invalid_arguments" } });
  });

  it("uses the replacement wrapped store and preserves the facade clock receiver", async () => {
    const receivers: unknown[] = [];
    const f = await messagingInboundHarness({ clock: function (this: unknown) { receivers.push(this); return 1_000; } });
    try {
      await f.controller.handleInboundEvent(f.event());
      receivers.length = 0;
      let writes = 0;
      f.controllerOptions.store = new Proxy(f.store, { get(target, property) {
        if (property === "upsertBinding") return async (...args: Parameters<typeof target.upsertBinding>) => {
          writes++; return await target.upsertBinding({ ...args[0], displayName: "Current wrapped store" });
        };
        const value = Reflect.get(target, property, target); return typeof value === "function" ? value.bind(target) : value;
      } });
      f.controllerOptions.adapter.setConversationTitle = async request => ({ outcome: "updated", channel: "telegram",
        conversation: request.channel.conversation, title: request.title, updatedAt: 1_000 });
      expect((await f.controller.handlePwrAgentMessagingRequest({ operation: "rename_current_messaging_conversation", context,
        args: { title: "Wrapped store fixture" } })).ok).toBe(true);
      expect(writes).toBeGreaterThan(0);
      await expect(f.controller.handlePwrAgentMessagingRequest({ operation: "get_current_messaging_surface", context, args: {} }))
        .resolves.toMatchObject({ ok: true, data: { location: { binding: { displayName: "Current wrapped store" } } } });
      expect((await f.store.getBinding("fixture-binding"))?.channel.conversation.title).toBe("Wrapped store fixture");
      f.controllerOptions.adapter.resolvePrivateConversation = async () => ({ outcome: "resolved", channel: "telegram",
        conversation: { id: "fixture-private", kind: "dm", isDirectMessage: true }, updatedAt: 1_000 });
      expect((await f.controller.handlePwrAgentMessagingRequest({ operation: "send_private_response", context, args: { text: "Private fixture" } })).ok).toBe(true);
      expect(receivers.length).toBeGreaterThan(0);
      expect(receivers.every(receiver => receiver === f.controller)).toBe(true);
    } finally { await f.close(); }
  });

  it("keeps optional backend getters inside target-resolution catch boundaries", async () => {
    const f = await messagingInboundHarness();
    try {
      Object.defineProperty(f.controllerOptions.backend, "resolveThreadTarget", { configurable: true,
        get() { throw new Error("Fixture target getter"); } });
      await expect(messagingModules(f.controller).agentTools.resolveAttachTarget({ backend: "codex", threadId: "fixture-thread", includeRemote: false }))
        .resolves.toMatchObject({ ok: false, error: { code: "internal_error", message: expect.stringContaining("Fixture target getter") } });
    } finally { await f.close(); }
  });

  it("preserves the separate private resolver precheck and invocation error boundaries", async () => {
    const f = await messagingInboundHarness();
    try {
      await f.controller.handleInboundEvent(f.event());
      let reads = 0;
      Object.defineProperty(f.controllerOptions.adapter, "resolvePrivateConversation", { configurable: true, get() {
        if (++reads === 1) return async () => { throw new Error("Unexpected invocation"); };
        throw new Error("Fixture invocation getter");
      } });
      await expect(f.controller.handlePwrAgentMessagingRequest({ operation: "send_private_response", context, args: { text: "Private fixture" } }))
        .resolves.toMatchObject({ ok: false, error: { code: "internal_error", message: expect.stringContaining("Fixture invocation getter") } });
      expect(reads).toBe(2);
      Object.defineProperty(f.controllerOptions.adapter, "resolvePrivateConversation", { configurable: true,
        get() { throw new Error("Fixture precheck getter"); } });
      await expect(f.controller.handlePwrAgentMessagingRequest({ operation: "send_private_response", context, args: { text: "Private fixture" } }))
        .rejects.toThrow("Fixture precheck getter");
      expect(messagingModules(f.controller).privateResponses.state(agentMessagingTurnKey("codex", "fixture-thread", "fixture-turn-1"))?.pending).toBe(0);
    } finally { await f.close(); }
  });

  it("reads outbound configuration at call time outside the navigation fallback catch", async () => {
    const f = await messagingInboundHarness();
    try {
      Object.defineProperty(f.controllerOptions, "outboundFileAccess", { configurable: true,
        get() { throw new Error("Fixture configuration getter"); } });
      await expect(messagingModules(f.controller).agentTools.resolveOutboundFileAccess(context)).rejects.toThrow("Fixture configuration getter");
      Object.defineProperty(f.controllerOptions, "outboundFileAccess", { configurable: true,
        value: () => ({ allowedRoots: ["/fixture/allowed"], privateStorageRoots: ["/fixture/private"] }) });
      Object.defineProperty(f.controllerOptions.backend, "getNavigationSelectedDetail", { configurable: true,
        get() { throw new Error("Fixture navigation getter"); } });
      const result = await messagingModules(f.controller).agentTools.resolveOutboundFileAccess(context);
      expect(result.allowedRoots).toContain("/fixture/allowed");
      expect(result.privateStorageRoots).toEqual(["/fixture/private"]);
    } finally { await f.close(); }
  });
});
