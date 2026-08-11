import { describe, expect, it } from "vitest";
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
