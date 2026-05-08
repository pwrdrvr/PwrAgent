import { describe, expect, it } from "vitest";
import type { MessagingCapabilityProfile, MessagingSurfaceIntent } from "@pwragent/messaging-interface";
import {
  buildSlackActionBlocks,
  markdownToSlackMrkdwn,
  sanitizeSlackActionId,
  textForSlackIntent,
} from "../slack-formatting.ts";

const profile: MessagingCapabilityProfile = {
  actions: {
    maxActions: 25,
    maxActionsPerRow: 5,
    maxRows: 5,
    maxLabelLength: 75,
    supportsStyles: true,
    supportsDisabled: false,
    supportsLayoutHints: true,
    maxCallbackPayloadBytes: 2_000,
  },
  text: {
    maxLength: 40_000,
    encoding: "characters",
    markdownDialect: "slack-mrkdwn",
    supportsCodeBlocks: true,
    supportsBold: true,
    supportsItalic: true,
    supportsLinks: true,
    supportsInlineCode: true,
    supportsMessageEdit: true,
  },
};

describe("Slack formatting", () => {
  it("translates common Markdown to Slack mrkdwn", () => {
    expect(
      markdownToSlackMrkdwn("Read **this** at [PwrAgent](https://example.com?a=1&b=2) <ok>"),
    ).toBe(
      "Read *this* at <https://example.com?a=1&b=2|PwrAgent> &lt;ok&gt;",
    );
  });

  it("sanitizes action IDs for Block Kit", () => {
    expect(sanitizeSlackActionId("command:resume/thread")).toBe("command_resume_thread");
    expect(sanitizeSlackActionId("!!!")).toBe("act_3");
  });

  it("builds explicit action rows and filters disabled actions", () => {
    const blocks = buildSlackActionBlocks({
      actions: [
        { id: "a", label: "Alpha", value: "a", layout: { row: 0 } },
        { id: "b", label: "Beta", value: "b", layout: { row: 1 } },
        { id: "c", label: "Gamma", value: "c", disabled: true },
      ],
      buildCallbackValue: (action) => String(action.value),
      capabilityProfile: profile,
    });

    expect(blocks).toEqual([
      {
        type: "actions",
        block_id: "actions_0",
        elements: [
          expect.objectContaining({ action_id: "a_0", value: "a" }),
        ],
      },
      {
        type: "actions",
        block_id: "actions_1",
        elements: [
          expect.objectContaining({ action_id: "b_1", value: "b" }),
        ],
      },
    ]);
  });

  it("renders status text from intents", () => {
    const intent: MessagingSurfaceIntent = {
      id: "i1",
      kind: "status",
      createdAt: 1,
      status: "working",
      text: "Working",
    };
    expect(textForSlackIntent(intent)).toBe("Working");
  });
});
