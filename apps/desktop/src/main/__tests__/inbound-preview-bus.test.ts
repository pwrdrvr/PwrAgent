import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InboundPreviewMessage } from "@pwragent/shared";
import type { MessagingInboundEvent } from "@pwragent/messaging-interface";
import {
  activeInboundPreviewConversationIds,
  onInboundPreviewScopesChanged,
  publishInboundPreview,
  resetInboundPreview,
  setInboundPreviewSink,
  startInboundPreview,
  stopInboundPreview,
} from "../messaging/inbound-preview-bus";

function textEvent(params: {
  conversationId: string;
  parentId?: string;
  isBot?: boolean;
  provider?: string;
  text?: string;
}): MessagingInboundEvent {
  return {
    id: `evt-${params.conversationId}-${params.text ?? ""}`,
    kind: "text",
    actor: {
      platformUserId: "user-1",
      displayName: "Datadog",
      isBot: params.isBot ?? false,
    },
    channel: {
      channel: (params.provider ?? "telegram") as MessagingInboundEvent["channel"]["channel"],
      conversation: {
        id: params.conversationId,
        kind: params.parentId ? "topic" : "channel",
        ...(params.parentId ? { parentId: params.parentId, parentConversationId: params.parentId } : {}),
      },
    },
    receivedAt: 1,
    text: params.text ?? "hello",
  } as MessagingInboundEvent;
}

describe("inbound-preview-bus", () => {
  beforeEach(() => {
    resetInboundPreview();
  });

  it("forwards messages that match an active scope to the sink", () => {
    const sink = vi.fn<(message: InboundPreviewMessage) => void>();
    setInboundPreviewSink(sink);
    startInboundPreview("s1", { provider: "telegram", conversationId: "-100" });

    publishInboundPreview(textEvent({ conversationId: "-100", text: "ERROR x" }));

    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0]?.[0]).toMatchObject({
      conversationId: "-100",
      provider: "telegram",
      text: "ERROR x",
    });
  });

  it("matches topic messages by the group parent for whole-group scope", () => {
    const sink = vi.fn();
    setInboundPreviewSink(sink);
    startInboundPreview("s1", { provider: "telegram", conversationId: "-100" });

    publishInboundPreview(
      textEvent({ conversationId: "42", parentId: "-100", text: "topic msg" }),
    );

    expect(sink).toHaveBeenCalledTimes(1);
  });

  it("scopes to a single topic when conversationId is the topic id", () => {
    const sink = vi.fn();
    setInboundPreviewSink(sink);
    startInboundPreview("s1", { provider: "telegram", conversationId: "42" });

    publishInboundPreview(
      textEvent({ conversationId: "42", parentId: "-100", text: "in topic" }),
    );
    publishInboundPreview(
      textEvent({ conversationId: "99", parentId: "-100", text: "other topic" }),
    );

    expect(sink).toHaveBeenCalledTimes(1);
  });

  it("ignores events for other providers or conversations", () => {
    const sink = vi.fn();
    setInboundPreviewSink(sink);
    startInboundPreview("s1", { provider: "telegram", conversationId: "-100" });

    publishInboundPreview(textEvent({ conversationId: "-200" }));
    publishInboundPreview(
      textEvent({ conversationId: "-100", provider: "slack" }),
    );

    expect(sink).not.toHaveBeenCalled();
  });

  /**
   * Adapters forward a sender outside the actor allowlist only in observed
   * conversations. An open preview has to be one, or previewing `#alerts`
   * before saving shows nothing from the alert bot the automation is for.
   */
  it("reports open previews' shared conversations for observation", () => {
    const changed = vi.fn();
    const unsubscribe = onInboundPreviewScopesChanged(changed);
    startInboundPreview("s1", { provider: "discord", conversationId: "chan-1" });
    startInboundPreview("s2", { provider: "telegram", conversationId: "42", parentId: "-100" });
    // A contact DM is gated by its sender, not its conversation.
    startInboundPreview("s3", {
      provider: "discord",
      conversationId: "U1",
      conversationKind: "dm",
      recipientUserId: "U1",
    });

    expect(activeInboundPreviewConversationIds("discord")).toEqual(["chan-1"]);
    expect(activeInboundPreviewConversationIds("telegram")).toEqual(["42", "-100"]);

    stopInboundPreview("s1");
    // Stopping a scope that was never open is not a change.
    stopInboundPreview("never-started");
    expect(activeInboundPreviewConversationIds("discord")).toEqual([]);
    expect(changed).toHaveBeenCalledTimes(4);
    unsubscribe();
  });

  it("stops forwarding after the scope is removed", () => {
    const sink = vi.fn();
    setInboundPreviewSink(sink);
    startInboundPreview("s1", { provider: "telegram", conversationId: "-100" });
    stopInboundPreview("s1");

    publishInboundPreview(textEvent({ conversationId: "-100" }));

    expect(sink).not.toHaveBeenCalled();
  });
});
