import { describe, expect, it } from "vitest";
import { PERMISSIVE_CAPABILITY_PROFILE } from "@pwragent/messaging-interface/testing";
import {
  LINE_ACTION_LABEL_LIMIT,
  buildLineActionBubble,
  clampLineMessage,
} from "../line-formatting.ts";

describe("LINE formatting", () => {
  it("clamps text to LINE's 5000-character text-message limit", () => {
    expect(clampLineMessage("x".repeat(5_010))).toHaveLength(5_000);
  });

  it("renders postback buttons with 20-character labels", () => {
    const bubble = buildLineActionBubble({
      actions: [
        {
          id: "approve",
          label: "Approve this very long label",
        },
      ],
      buildPostbackData: () => "line:abc",
      capabilityProfile: {
        ...PERMISSIVE_CAPABILITY_PROFILE,
        actions: {
          ...PERMISSIVE_CAPABILITY_PROFILE.actions!,
          maxActions: 13,
          maxActionsPerRow: 4,
          maxLabelLength: LINE_ACTION_LABEL_LIMIT,
          maxCallbackPayloadBytes: 300,
        },
      },
      title: "Choose",
    });

    const row = bubble?.contents.footer?.contents[0];
    expect(row?.type).toBe("box");
    const button = row?.type === "box" ? row.contents[0] : undefined;
    expect(button?.type).toBe("button");
    expect(button?.type === "button" ? button.action.label : "").toBe(
      "Approve this very l…",
    );
  });
});
