import { describe, expect, it } from "vitest";
import {
  automationConversationKey,
  buildAutomationInboundTriggerId,
  findAutomationConversationIndexForMessage,
  formatAutomationConversationLabel,
  formatAutomationConversationList,
} from "../contracts/automations";

describe("automation conversation helpers", () => {
  it("keys a conversation by provider, group, and id — not by its title", () => {
    const channel = { channel: "slack" as const, conversationId: "C1" };
    expect(automationConversationKey(channel)).toBe(
      automationConversationKey({ ...channel, title: "renamed" } as typeof channel),
    );
    // The same topic id in two groups is two conversations.
    expect(
      automationConversationKey({ channel: "telegram", conversationId: "42", parentId: "-100" }),
    ).not.toBe(
      automationConversationKey({ channel: "telegram", conversationId: "42", parentId: "-200" }),
    );
    expect(buildAutomationInboundTriggerId(channel)).toBe("inbound-message:slack::C1");
    // A contact's DMs key on the contact, never on a conversation ID.
    expect(
      automationConversationKey({
        channel: "slack",
        conversationId: "U1",
        recipientUserId: "U1",
      }),
    ).toBe("slack:dm:U1");
  });

  it("names a topic with its group, and falls back to raw ids", () => {
    expect(
      formatAutomationConversationLabel({
        channel: "telegram",
        conversationId: "42",
        conversationKind: "topic",
        parentId: "-100",
        parentTitle: "Ops Room",
        title: "Deploys",
      }),
    ).toBe("Ops Room / Deploys");
    expect(
      formatAutomationConversationLabel({
        channel: "telegram",
        conversationId: "42",
        conversationKind: "topic",
        parentId: "-100",
      }),
    ).toBe("-100 / 42");
    expect(
      formatAutomationConversationLabel({ channel: "slack", conversationId: "C1" }),
    ).toBe("C1");
    expect(
      formatAutomationConversationLabel({
        channel: "slack",
        conversationId: "U1",
        recipientUserId: "U1",
        title: "Avery",
      }),
    ).toBe("Avery (DM)");
  });

  it("lists up to three conversations and counts the rest", () => {
    const named = (title: string) => ({
      channel: "slack" as const,
      conversationId: title,
      title,
    });
    expect(formatAutomationConversationList([named("a"), named("b")])).toBe("a, b");
    expect(
      formatAutomationConversationList(["a", "b", "c", "d"].map(named)),
    ).toBe("a, b, c +1 more");
  });

  it("attributes a Slack thread reply to the thread, in either order", () => {
    // Slack reports a reply with the channel's ID and the thread in parentId.
    const channel = {
      channel: "slack" as const,
      conversationId: "C1",
      conversationKind: "channel" as const,
    };
    const thread = {
      channel: "slack" as const,
      conversationId: "C1",
      conversationKind: "thread" as const,
      parentId: "1712345678.000100",
    };
    const reply = {
      actor: { platformUserId: "U1" },
      provider: "slack" as const,
      conversationId: "C1",
      conversationKind: "thread" as const,
      parentId: "1712345678.000100",
      parentConversationId: "C1",
    };
    expect(findAutomationConversationIndexForMessage([channel, thread], reply)).toBe(1);
    expect(findAutomationConversationIndexForMessage([thread, channel], reply)).toBe(0);
    // A top-level post is the channel's alone.
    expect(
      findAutomationConversationIndexForMessage([thread, channel], {
        actor: { platformUserId: "U1" },
        provider: "slack",
        conversationId: "C1",
        conversationKind: "channel",
      }),
    ).toBe(1);
  });

  it("finds the watched conversation a message belongs to", () => {
    const watched = [
      { channel: "slack" as const, conversationId: "C1", conversationKind: "channel" as const },
      { channel: "slack" as const, conversationId: "T1", conversationKind: "thread" as const },
      { channel: "slack" as const, conversationId: "U9", recipientUserId: "U9" },
    ];
    const actor = { platformUserId: "U1" };
    // A thread watched in its own right wins over the channel it lives in.
    expect(
      findAutomationConversationIndexForMessage(watched, {
        actor,
        provider: "slack",
        conversationId: "T1",
        conversationKind: "thread",
        parentConversationId: "C1",
      }),
    ).toBe(1);
    // Any other reply in the channel belongs to the channel.
    expect(
      findAutomationConversationIndexForMessage(watched, {
        actor,
        provider: "slack",
        conversationId: "T2",
        conversationKind: "thread",
        parentConversationId: "C1",
      }),
    ).toBe(0);
    // A contact's DM is claimed by who sent it.
    expect(
      findAutomationConversationIndexForMessage(watched, {
        actor: { platformUserId: "U9" },
        provider: "slack",
        conversationId: "D-native",
        conversationKind: "dm",
      }),
    ).toBe(2);
    expect(
      findAutomationConversationIndexForMessage(watched, {
        actor,
        provider: "telegram",
        conversationId: "C1",
      }),
    ).toBe(-1);
  });
});
