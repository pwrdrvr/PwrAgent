import type { AgentEvent } from "@pwragent/shared/contracts/agent";
import type { ManageAgentNotificationsRequest } from "@pwragent/shared/contracts/scheduled-thread-actions";
import { describe, expect, it, vi } from "vitest";
import {
  FEDERATION_AGENT_NOTIFICATION_CAPABILITIES,
  FEDERATION_AGENT_NOTIFICATION_METHODS,
  registerFederationAgentNotificationHandlers,
} from "../federation/federation-agent-notifications";
import type { FederationRouter } from "../federation/federation-router";
import {
  eventMatchesThreadSelection,
  federationEventClassForMethod,
  navigationInvalidationForLocalEvent,
} from "../federation/federation-runtime";

/**
 * A notice belongs to its owner, not to one thread, so a viewer follows an
 * owner's notices without following its threads or its navigation.
 */
describe("agent notices across federation", () => {
  const event: AgentEvent = {
    backend: "codex",
    notification: { method: "agentNotifications/updated", params: { threadId: "thread-a" } },
  };

  it("reaches agent_notifications subscribers whatever threads they follow", () => {
    expect(federationEventClassForMethod(event.notification.method)).toBe("agent_notifications");
    expect(eventMatchesThreadSelection(event, "agent_notifications", { kind: "threads", threads: [] })).toBe(true);
    expect(eventMatchesThreadSelection(event, "agent_notifications", {
      kind: "threads", threads: [{ backend: "codex", threadId: "elsewhere" }],
    })).toBe(true);
    expect(navigationInvalidationForLocalEvent(event)).toBeUndefined();
  });

  it("reads notices with thread_detail and changes them with turn_control", () => {
    expect(FEDERATION_AGENT_NOTIFICATION_CAPABILITIES).toEqual({
      [FEDERATION_AGENT_NOTIFICATION_METHODS.snapshot]: "thread_detail",
      [FEDERATION_AGENT_NOTIFICATION_METHODS.manage]: "turn_control",
    });
  });

  it("answers on the owner, with thread titles, and never routes further", async () => {
    const handlers = new Map<string, (envelope: { params?: unknown }) => unknown>();
    const router = { registerHandler: (method: string, handler: (envelope: { params?: unknown }) => unknown) => {
      handlers.set(method, handler);
    } } as unknown as FederationRouter;
    const local = vi.fn(async (_request: ManageAgentNotificationsRequest, _options: { titled: true }) => ({
      ok: true as const, snapshot: { unread: [], scheduled: [], earlier: [] },
    }));
    registerFederationAgentNotificationHandlers(router, local);

    await handlers.get(FEDERATION_AGENT_NOTIFICATION_METHODS.snapshot)!({});
    expect(local).toHaveBeenLastCalledWith({ action: "snapshot" }, { titled: true });
    await handlers.get(FEDERATION_AGENT_NOTIFICATION_METHODS.manage)!({ params: { action: "cancel", id: "n1" } });
    expect(local).toHaveBeenLastCalledWith({ action: "cancel", id: "n1" }, { titled: true });

    const manage = handlers.get(FEDERATION_AGENT_NOTIFICATION_METHODS.manage)!;
    expect(() => manage({ params: { action: "dismiss", id: "n1", federationTarget: { scope: "remote", instanceId: "x" } } }))
      .toThrow("terminate at their owner");
    // A read takes the read method, so it is authorized as a read.
    expect(() => manage({ params: { action: "snapshot" } })).toThrow("agentNotifications.snapshot");
    expect(local).toHaveBeenCalledTimes(2);
  });
});
