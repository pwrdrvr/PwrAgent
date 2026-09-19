import { describe, expect, it } from "vitest";
import { matchesAutomationConversation } from "@pwragent/shared";
import type {
  AutomationInboundCondition,
  AutomationInboundConditionJoin,
} from "@pwragent/shared";
import type { MessagingInboundTextEvent } from "@pwragent/messaging-interface";
import type { AutomationRecord } from "../automations/automation-store";
import {
  buildAutomationReplayCandidates,
  buildReplayRunSourceMetadata,
  buildSourceEventKey,
  matchAutomationInboundEvent,
  resolveInboundTriggerForMessage,
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
          parentConversationId: "C123",
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

  it.each([
    { channel: "telegram", conversationId: "123456789" },
    { channel: "line", conversationId: "U0123456789abcdef0123456789abcdef" },
  ] as const)("keeps legacy $channel contact triggers working", ({ channel, conversationId }) => {
    // Shape emitted by the previous editor: a contact ID mislabeled channel,
    // with no recipientUserId. Exercise the main-process entry point too.
    const record = automation({
      conversation: { channel, conversationId, conversationKind: "channel" },
      sender: undefined,
      includeThreadReplies: false,
    });
    const event = {
      ...slackTextEvent(),
      actor: { platformUserId: conversationId, isBot: false },
      channel: { channel, conversation: { id: conversationId, kind: "dm" as const } },
    };
    expect(matchAutomationInboundEvent({ automations: [record], event })).toHaveLength(1);
    expect(matchAutomationInboundEvent({
      automations: [record],
      event: { ...event, channel: { channel, conversation: { id: conversationId, kind: "channel" } } },
    })).toEqual([]);
    expect(matchAutomationInboundEvent({
      automations: [record],
      event: { ...event, channel: { channel, conversation: { id: "other-dm", kind: "dm" } } },
    })).toEqual([]);
  });

  it.each([undefined, "guild"])("matches an explicit Discord thread with parent scope %s", (parentId) => {
    const event: MessagingInboundTextEvent = {
      ...slackTextEvent(),
      channel: {
        channel: "discord",
        conversation: {
          id: "thread-id",
          kind: "thread",
          parentId: "guild",
          parentConversationId: "channel-id",
          parentConversationParentId: "guild",
        },
      },
    };
    const record = automation({
      conversation: { channel: "discord", conversationId: "thread-id", conversationKind: "channel", parentId },
      includeThreadReplies: false,
    });
    expect(matchAutomationInboundEvent({ automations: [record], event })).toHaveLength(1);
    expect(matchAutomationInboundEvent({
      automations: [automation({
        conversation: { channel: "discord", conversationId: "thread-id", conversationKind: "channel", parentId: "other-guild" },
        includeThreadReplies: false,
      })],
      event,
    })).toEqual([]);
    for (const includeThreadReplies of [false, true]) {
      expect(matchAutomationInboundEvent({
        automations: [automation({
          conversation: { channel: "discord", conversationId: "channel-id", conversationKind: "channel", parentId },
          includeThreadReplies,
        })],
        event,
      })).toHaveLength(includeThreadReplies ? 1 : 0);
    }
  });

  it.each(["slack", "mattermost"] as const)("still excludes %s replies sharing the channel ID", (channel) => {
    const target = { channel, conversationId: "channel-id", conversationKind: "channel" as const };
    expect(matchesAutomationConversation(target, {
      ...target,
      conversationKind: "thread",
      parentId: "root-message",
      parentConversationId: "channel-id",
    }, "peer", false)).toBe(false);
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

describe("automation inbound conditions", () => {
  it("requires every row to hold under an 'all' join", () => {
    const trigger = conditionAutomation("all", [
      condition({ field: "message_text", operator: "contains", values: ["ERROR"] }),
      condition({
        field: "message_text",
        operator: "not_contains",
        values: ["staging"],
      }),
    ]);

    expect(
      matchAutomationInboundEvent({
        automations: [trigger],
        event: slackTextEvent({ text: "ERROR api latency high" }),
      }),
    ).toHaveLength(1);

    expect(
      matchAutomationInboundEvent({
        automations: [trigger],
        event: slackTextEvent({ text: "ERROR in staging api" }),
      }),
    ).toEqual([]);
  });

  it("accepts a message when any row holds under an 'any' join", () => {
    const trigger = conditionAutomation("any", [
      condition({ field: "message_text", operator: "contains", values: ["ERROR"] }),
      condition({ field: "message_text", operator: "contains", values: ["FATAL"] }),
    ]);

    expect(
      matchAutomationInboundEvent({
        automations: [trigger],
        event: slackTextEvent({ text: "FATAL disk full" }),
      }),
    ).toHaveLength(1);

    expect(
      matchAutomationInboundEvent({
        automations: [trigger],
        event: slackTextEvent({ text: "deploy finished" }),
      }),
    ).toEqual([]);
  });

  it("treats is_one_of as membership across several senders", () => {
    const trigger = conditionAutomation("all", [
      condition({
        field: "sender",
        operator: "is_one_of",
        values: ["B123", "B456"],
      }),
    ]);

    expect(
      matchAutomationInboundEvent({
        automations: [trigger],
        event: slackTextEvent({ actor: { platformUserId: "B456", isBot: true } }),
      }),
    ).toHaveLength(1);

    expect(
      matchAutomationInboundEvent({
        automations: [trigger],
        event: slackTextEvent({ actor: { platformUserId: "U999", isBot: false } }),
      }),
    ).toEqual([]);
  });

  it("excludes senders with is_not_one_of", () => {
    const trigger = conditionAutomation("all", [
      condition({ field: "sender", operator: "is_not_one_of", values: ["B123"] }),
    ]);

    expect(
      matchAutomationInboundEvent({
        automations: [trigger],
        event: slackTextEvent({ actor: { platformUserId: "B123", isBot: true } }),
      }),
    ).toEqual([]);

    expect(
      matchAutomationInboundEvent({
        automations: [trigger],
        event: slackTextEvent({ actor: { platformUserId: "U999", isBot: false } }),
      }),
    ).toHaveLength(1);
  });

  it("honors per-row case sensitivity", () => {
    const sensitive = conditionAutomation("all", [
      condition({
        field: "message_text",
        operator: "contains",
        values: ["ERROR"],
        caseSensitive: true,
      }),
    ]);

    expect(
      matchAutomationInboundEvent({
        automations: [sensitive],
        event: slackTextEvent({ text: "error api latency" }),
      }),
    ).toEqual([]);

    expect(
      matchAutomationInboundEvent({
        automations: [
          conditionAutomation("all", [
            condition({
              field: "message_text",
              operator: "contains",
              values: ["ERROR"],
            }),
          ]),
        ],
        event: slackTextEvent({ text: "error api latency" }),
      }),
    ).toHaveLength(1);
  });

  it("matches and negates regular expressions", () => {
    expect(
      matchAutomationInboundEvent({
        automations: [
          conditionAutomation("all", [
            condition({
              field: "message_text",
              operator: "matches_regex",
              values: ["p99 .*above SLO"],
            }),
          ]),
        ],
        event: slackTextEvent({ text: "checkout p99 is above SLO" }),
      }),
    ).toHaveLength(1);

    expect(
      matchAutomationInboundEvent({
        automations: [
          conditionAutomation("all", [
            condition({
              field: "message_text",
              operator: "not_matches_regex",
              values: ["p99 .*above SLO"],
            }),
          ]),
        ],
        event: slackTextEvent({ text: "checkout p99 is above SLO" }),
      }),
    ).toEqual([]);
  });

  it("does not match on an unparseable regular expression", () => {
    expect(
      matchAutomationInboundEvent({
        automations: [
          conditionAutomation("all", [
            condition({
              field: "message_text",
              operator: "matches_regex",
              values: ["([unclosed"],
            }),
          ]),
        ],
        event: slackTextEvent({ text: "([unclosed" }),
      }),
    ).toEqual([]);
  });

  it("filters on sender type", () => {
    const humansOnly = conditionAutomation("all", [
      condition({ field: "sender_type", operator: "is_one_of", values: ["human"] }),
    ]);

    expect(
      matchAutomationInboundEvent({
        automations: [humansOnly],
        event: slackTextEvent({ actor: { platformUserId: "B123", isBot: true } }),
      }),
    ).toEqual([]);

    expect(
      matchAutomationInboundEvent({
        automations: [humansOnly],
        event: slackTextEvent({ actor: { platformUserId: "U999", isBot: false } }),
      }),
    ).toHaveLength(1);
  });

  it("accepts every message when the condition list is empty", () => {
    for (const join of ["all", "any"] as const) {
      expect(
        matchAutomationInboundEvent({
          automations: [conditionAutomation(join, [])],
          event: slackTextEvent({ text: "anything at all" }),
        }),
      ).toHaveLength(1);
    }
  });

  it("does not match a half-written row, in either sense", () => {
    expect(
      matchAutomationInboundEvent({
        automations: [
          conditionAutomation("all", [
            condition({ field: "message_text", operator: "contains", values: [""] }),
          ]),
        ],
        event: slackTextEvent({ text: "ERROR api latency" }),
      }),
    ).toEqual([]);

    // The negation of an unsatisfied empty row must not become "match all".
    expect(
      matchAutomationInboundEvent({
        automations: [
          conditionAutomation("all", [
            condition({
              field: "message_text",
              operator: "not_contains",
              values: [""],
            }),
          ]),
        ],
        event: slackTextEvent({ text: "ERROR api latency" }),
      }),
    ).toEqual([]);
  });

  it("ignores legacy sender and text filters once conditions are stored", () => {
    const record = automation({
      sender: { platformUserId: "B123", isBot: true },
      textFilter: { mode: "contains", text: "ERROR" },
      conditionGroup: {
        join: "all",
        conditions: [
          condition({ field: "message_text", operator: "contains", values: ["FATAL"] }),
        ],
      },
    });

    expect(
      matchAutomationInboundEvent({
        automations: [record],
        event: slackTextEvent({ text: "ERROR api latency" }),
      }),
    ).toEqual([]);

    expect(
      matchAutomationInboundEvent({
        automations: [record],
        event: slackTextEvent({ text: "FATAL disk full" }),
      }),
    ).toHaveLength(1);
  });
});

function condition(
  input: Omit<AutomationInboundCondition, "id"> & { id?: string },
): AutomationInboundCondition {
  return { id: input.id ?? `condition-${input.field}-${input.operator}`, ...input };
}

function conditionAutomation(
  join: AutomationInboundConditionJoin,
  conditions: AutomationInboundCondition[],
): AutomationRecord {
  return automation({
    sender: undefined,
    textFilter: undefined,
    conditionGroup: { join, conditions },
  });
}

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

describe("automation replay helpers", () => {
  const trigger = {
    id: "datadog-error",
    kind: "inbound_message" as const,
    conversation: {
      channel: "slack" as const,
      conversationId: "C123",
      conversationKind: "channel" as const,
      title: "#alerts-prod",
    },
    conditionGroup: {
      join: "all" as const,
      conditions: [
        {
          id: "text",
          field: "message_text" as const,
          operator: "contains" as const,
          values: ["ERROR"],
        },
      ],
    },
  };

  const message = (id: string, text: string) => ({
    id,
    provider: "slack" as const,
    conversationId: "C123",
    receivedAt: 5_000,
    actor: { platformUserId: "B123", displayName: "Datadog", isBot: true },
    text,
  });

  it("judges candidates with the same evaluator as live matching", () => {
    const candidates = buildAutomationReplayCandidates(trigger, [
      message("m1", "ERROR rate spike"),
      message("m2", "deploy finished"),
    ]);
    expect(candidates.map((candidate) => candidate.matches)).toEqual([true, false]);
  });

  it("namespaces the replay source key away from the original event", () => {
    const source = buildReplayRunSourceMetadata({
      trigger,
      message: message("m1", "ERROR rate spike"),
      now: 9_000,
    });
    // The real event's dedupe key must never collide with a replay: inbound
    // dispatch would otherwise treat a later genuine delivery as handled.
    expect(source.sourceEventKey).toBe("replay:m1:9000");
    expect(source.matchedTriggerId).toBe("datadog-error");
    expect(source.conversation.title).toBe("#alerts-prod");
    expect(source.message?.text).toBe("ERROR rate spike");
  });
});


describe("normalized automation conversation identity", () => {
  it.each(["telegram", "discord", "slack", "mattermost", "feishu", "line"] as const)(
    "%s contact matches only a 1:1 DM from that peer", (channel) => {
      const target = { channel, conversationId: "peer", recipientUserId: "peer", conversationKind: "dm" as const };
      const actual = { channel, conversationId: "native-dm-id", conversationKind: "dm" as const };
      expect(matchesAutomationConversation(target, actual, "peer")).toBe(true);
      expect(matchesAutomationConversation(target, actual, "other")).toBe(false);
      expect(matchesAutomationConversation(target, { ...actual, conversationKind: "channel", conversationId: "peer" }, "peer")).toBe(false);
      expect(matchesAutomationConversation(target, { ...actual, conversationKind: "thread", isDirectMessage: true }, "peer", true)).toBe(true);
      expect(matchesAutomationConversation(target, { ...actual, conversationKind: "thread", isDirectMessage: true }, "peer", false)).toBe(false);
      expect(matchesAutomationConversation({ channel, conversationId: "native-dm-id", conversationKind: "channel" }, actual, "peer")).toBe(false);
    },
  );

  it("scopes topics by both topic and group IDs", () => {
    const target = { channel: "telegram", conversationId: "42", parentId: "-1001", conversationKind: "topic" } as const;
    expect(matchesAutomationConversation(target, target, "peer")).toBe(true);
    expect(matchesAutomationConversation(target, { ...target, parentId: "-1002" }, "peer")).toBe(false);
  });

  it("uses Discord's parent conversation, never its guild, for child matching", () => {
    const child = { channel: "discord", conversationId: "thread", conversationKind: "thread", parentId: "guild", parentConversationId: "channel", parentConversationParentId: "guild" } as const;
    expect(matchesAutomationConversation({ channel: "discord", conversationId: "guild" }, child, "peer")).toBe(false);
    expect(matchesAutomationConversation({ channel: "discord", conversationId: "channel", parentId: "guild" }, child, "peer")).toBe(true);
  });

  it.each(["slack", "mattermost", "line"] as const)("%s shared conversations match by native conversation ID", (channel) => {
    const shared = { channel, conversationId: "shared", conversationKind: "channel" } as const;
    expect(matchesAutomationConversation(shared, shared, "peer")).toBe(true);
    expect(matchesAutomationConversation(shared, { ...shared, conversationId: "other" }, "peer")).toBe(false);
  });
});

describe("multi-source inbound triggers", () => {
  const source = (id: string, channel: "slack" | "telegram", conversationId: string) => ({
    id,
    kind: "inbound_message" as const,
    conversation: { channel, conversationId },
  });
  /** A captured message; a thread reply names the channel it was posted under. */
  const message = (
    provider: "slack" | "telegram",
    conversationId: string,
    parentConversationId?: string,
  ) => ({
    id: "m1",
    provider,
    conversationId,
    ...(parentConversationId
      ? { conversationKind: "thread" as const, parentConversationId }
      : {}),
    receivedAt: 1,
    actor: { platformUserId: "U1" },
    text: "ERROR",
  });

  it("fires for a message in any watched conversation, naming the one it came from", () => {
    const record = {
      ...automation(),
      triggers: [
        source("t-alerts", "slack", "C-ALERTS"),
        source("t-metrics", "slack", "C-METRICS"),
      ],
    };
    const [match] = matchAutomationInboundEvent({
      automations: [record],
      event: slackTextEvent({
        channel: {
          channel: "slack",
          conversation: { id: "C-METRICS", kind: "channel", title: "f-metrics" },
        },
      }),
    });
    expect(match?.trigger.id).toBe("t-metrics");
    expect(match?.source.conversation).toMatchObject({
      conversationId: "C-METRICS",
      title: "f-metrics",
    });
  });

  it("resolves the trigger that owns a replayed message by its conversation", () => {
    const triggers = [
      { id: "schedule", kind: "schedule" as const, schedule: { kind: "interval" as const, every: 5, unit: "minutes" as const } },
      source("t-alerts", "slack", "C-ALERTS"),
      source("t-metrics", "slack", "C-METRICS"),
      source("t-ops", "telegram", "C-METRICS"),
    ];
    expect(resolveInboundTriggerForMessage(triggers, message("slack", "C-METRICS"))?.id)
      .toBe("t-metrics");
    // Same conversation id on another provider is another conversation.
    expect(resolveInboundTriggerForMessage(triggers, message("telegram", "C-METRICS"))?.id)
      .toBe("t-ops");
    // A thread reply belongs to the channel it was posted under.
    expect(
      resolveInboundTriggerForMessage(triggers, message("slack", "T-1", "C-ALERTS"))?.id,
    ).toBe("t-alerts");
    expect(resolveInboundTriggerForMessage(triggers, message("slack", "C-OTHER")))
      .toBeUndefined();
  });

  it("prefers a thread watched in its own right over the channel it lives in", () => {
    const triggers = [
      source("t-channel", "slack", "C-ALERTS"),
      source("t-thread", "slack", "T-1"),
    ];
    expect(
      resolveInboundTriggerForMessage(triggers, message("slack", "T-1", "C-ALERTS"))?.id,
    ).toBe("t-thread");
  });
});
