import { describe, expect, it } from "vitest";
import type { MessagingInboundTextEvent } from "@pwragent/messaging-interface";
import type { AutomationRecord } from "../automations/automation-store";
import {
  buildSourceEventKey,
  matchAutomationInboundEvent,
} from "../automations/automation-trigger-matcher";

describe("automation trigger matcher", () => {
  it("matches a configured Slack bot sender and literal text filter", () => {
    const [match] = matchAutomationInboundEvent({
      automations: [automation()],
      event: slackTextEvent(),
    });

    expect(match).toMatchObject({
      automation: {
        id: "automation-1",
      },
      trigger: {
        id: "datadog-error",
      },
      source: {
        sourceEventKey: "slack:C123:1710000000.000100::B123",
        matchedTriggerId: "datadog-error",
        actor: {
          platformUserId: "B123",
          isBot: true,
        },
        conversation: {
          channel: "slack",
          conversationId: "C123",
        },
        message: {
          text: "ERROR api latency high",
        },
      },
    });
  });

  it("uses literal equals matching with explicit case sensitivity", () => {
    expect(
      matchAutomationInboundEvent({
        automations: [
          automation({
            textFilter: {
              mode: "equals",
              text: "ERROR api latency high",
              caseSensitive: true,
            },
          }),
        ],
        event: slackTextEvent({ text: "error api latency high" }),
      }),
    ).toEqual([]);

    expect(
      matchAutomationInboundEvent({
        automations: [
          automation({
            textFilter: {
              mode: "equals",
              text: "ERROR api latency high",
              caseSensitive: false,
            },
          }),
        ],
        event: slackTextEvent({ text: "error api latency high" }),
      }),
    ).toHaveLength(1);
  });

  it("requires sender and bot filters to match", () => {
    expect(
      matchAutomationInboundEvent({
        automations: [automation()],
        event: slackTextEvent({
          actor: {
            platformUserId: "U999",
            isBot: false,
          },
        }),
      }),
    ).toEqual([]);
  });

  it("can include or exclude source thread replies", () => {
    const threadEvent = slackTextEvent({
      channel: {
        channel: "slack",
        conversation: {
          id: "1710000000.000000",
          kind: "thread",
          parentId: "C123",
        },
      },
      routingState: {
        opaque: {
          channelId: "C123",
          threadTs: "1710000000.000000",
          ts: "1710000001.000000",
        },
      },
    });

    expect(
      matchAutomationInboundEvent({
        automations: [automation({ includeThreadReplies: false })],
        event: threadEvent,
      }),
    ).toEqual([]);

    expect(
      matchAutomationInboundEvent({
        automations: [automation({ includeThreadReplies: true })],
        event: threadEvent,
      }),
    ).toHaveLength(1);
  });

  it("produces stable source keys for duplicate provider events", () => {
    const first = slackTextEvent({ id: "local-random-1" });
    const second = slackTextEvent({ id: "local-random-2" });

    expect(buildSourceEventKey(first)).toBe(buildSourceEventKey(second));
  });

  it("does not throw on missing routing state", () => {
    expect(
      matchAutomationInboundEvent({
        automations: [automation()],
        event: slackTextEvent({ routingState: undefined }),
      }),
    ).toHaveLength(1);
  });
});

function automation(
  overrides: Partial<
    Extract<AutomationRecord["triggers"][number], { kind: "inbound_message" }>
  > = {},
): AutomationRecord {
  return {
    id: "automation-1",
    backend: "codex",
    threadId: "thread-1",
    name: "Datadog alert triage",
    taskPrompt: "Investigate.",
    status: "enabled",
    triggers: [
      {
        id: "datadog-error",
        kind: "inbound_message",
        conversation: {
          channel: "slack",
          conversationId: "C123",
          conversationKind: "channel",
        },
        sender: {
          platformUserId: "B123",
          isBot: true,
        },
        textFilter: {
          mode: "contains",
          text: "ERROR",
        },
        ...overrides,
      },
    ],
    scheduleSummary: "inbound message",
    backlogPolicy: "coalesce",
    outputActions: [{ id: "agent-context", kind: "agent_context" }],
    createdAt: 1_000,
    updatedAt: 1_000,
  };
}

function slackTextEvent(
  overrides: Partial<MessagingInboundTextEvent> & {
    actor?: Partial<MessagingInboundTextEvent["actor"]>;
    channel?: {
      conversation?: Partial<MessagingInboundTextEvent["channel"]["conversation"]>;
    };
  } = {},
): MessagingInboundTextEvent {
  return {
    id: overrides.id ?? "slack-text:local",
    kind: "text",
    actor: {
      platformUserId: "B123",
      isBot: true,
      ...overrides.actor,
    },
    channel: {
      channel: "slack",
      conversation: {
        id: "C123",
        kind: "channel",
        ...overrides.channel?.conversation,
      },
    },
    receivedAt: overrides.receivedAt ?? 2_000,
    routingState:
      overrides.routingState === undefined && "routingState" in overrides
        ? undefined
        : overrides.routingState ?? {
            opaque: {
              channelId: "C123",
              ts: "1710000000.000100",
            },
          },
    text: overrides.text ?? "ERROR api latency high",
  };
}
