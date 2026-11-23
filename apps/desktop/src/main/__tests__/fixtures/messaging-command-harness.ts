import type { MessagingBindingRecord, MessagingInboundCommandEvent, MessagingSurfaceIntent } from "@pwragent/messaging-interface";
import { PERMISSIVE_CAPABILITY_PROFILE } from "@pwragent/messaging-interface/testing";
import type { MessagingCommandContext, MessagingCommandHost } from "../../messaging/core/messaging-command-context";
import { MessagingCommandHandlers } from "../../messaging/core/messaging-command-handlers";

export const commandBinding: MessagingBindingRecord = {
  id: "binding", backend: "claude", threadId: "thread", createdAt: 1_000, updatedAt: 1_000,
  authorizedActorIds: ["actor"], channel: { channel: "telegram", conversation: { id: "source", kind: "dm", isDirectMessage: true } },
};

export function commandEvent(command: string, args: string[] = []): MessagingInboundCommandEvent {
  return {
    id: "event", kind: "command", receivedAt: 1_000, command, args,
    rawText: `/${command} ${args.join(" ")}`, actor: { platformUserId: "actor" }, channel: commandBinding.channel,
  };
}

export function commandHarness(overrides: Partial<MessagingCommandHost> = {}) {
  const trace: string[] = [];
  const delivered: MessagingSurfaceIntent[] = [];
  const unexpected = (): never => { throw new Error("Unexpected workflow port"); };
  const host: MessagingCommandHost = {
    admitBoundAgentTrust: async () => true,
    requirePermission: async () => { trace.push("permission"); return true; },
    requireRemoteScopeForBinding: async () => { trace.push("scope"); return true; },
    handleStatusCallback: async () => { trace.push("handoff"); },
    presentStatus: async () => { trace.push("status"); },
    detachBinding: async () => { trace.push("detach"); },
    presentResumeBrowser: async event => { trace.push(event.args[0] === "--new" ? "new" : "resume"); },
    presentAgentBrowser: async () => { trace.push("agent"); },
    rememberHumanMessagingSource: () => undefined,
    deliver: async intent => {
      trace.push("deliver"); delivered.push(intent);
      return { outcome: "presented", channel: "telegram", deliveredAt: 1_000 };
    },
    newIntentId: prefix => prefix,
    shouldHandleAmbientSharedMessage: async () => true,
    admitTurnInput: async ({ event }) => { trace.push(`input:${"text" in event ? event.text : "media"}`); return true; },
    reviewSupportedForBinding: async () => true,
    claudeCodeReviewSupportedForBinding: async () => { trace.push("claude-code-review-supported"); return true; },
    deliverReviewUnsupported: async () => { trace.push("unsupported"); },
    submitMessagingReview: async () => { trace.push("review"); },
    presentReviewPicker: async () => { trace.push("review-picker"); },
    deliverDefaultAgentCommandError: async () => { trace.push("default-error"); },
    presentDefaultAgentAssignmentBrowser: async () => { trace.push("default-set"); },
    clearDefaultAgentAssignment: async () => { trace.push("default-clear"); },
    presentDefaultAgentStatus: async () => { trace.push("default-status"); },
    stopMonitoringForChannel: async () => { trace.push("monitor-stop"); return undefined; },
    enableAndRenderChannelMonitor: async () => unexpected(),
    resolveMonitorControlTopic: async () => undefined,
    eventForManagedTopic: () => unexpected(),
    renderTopicCleanupProposal: async () => unexpected(),
    runTopicMonitorFanout: async () => unexpected(),
    renderTopicControlStatus: async () => unexpected(),
    ...overrides,
  };
  const context: MessagingCommandContext = {
    store: { findActiveBindingForChannel: async () => { trace.push("binding"); return commandBinding; } },
    backend: {}, capabilityProfile: PERMISSIVE_CAPABILITY_PROFILE, now: () => 1_000, host: () => host,
  };
  return { trace, delivered, host, context, owner: new MessagingCommandHandlers(context) };
}
