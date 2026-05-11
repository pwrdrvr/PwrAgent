import { describe, expect, it } from "vitest";
import { PERMISSIVE_CAPABILITY_PROFILE } from "@pwragent/messaging-interface/testing";
import {
  LINE_ACTION_LABEL_LIMIT,
  buildLineActionBubble,
  clampLineMessage,
  imageMessagesForLineIntent,
  textForLineIntent,
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
      buildPostbackData: () => signedLinePostbackData(),
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

  it("sets postback display text so button taps echo the selected action", () => {
    const bubble = buildLineActionBubble({
      actions: [
        {
          id: "status:detach",
          label: "Detach",
          fallbackText: "detach",
        },
      ],
      buildPostbackData: () => signedLinePostbackData(),
      capabilityProfile: PERMISSIVE_CAPABILITY_PROFILE,
      title: "Status",
    });

    const row = bubble?.contents.footer?.contents[0];
    const button = row?.type === "box" ? row.contents[0] : undefined;

    expect(button?.type).toBe("button");
    expect(button?.type === "button" ? button.action.displayText : undefined)
      .toBe("detach");
  });

  it("flows status-sized action sets into compact rows by default", () => {
    const bubble = buildLineActionBubble({
      actions: Array.from({ length: 13 }, (_, index) => ({
        id: `status:${index}`,
        label: `Action ${index + 1}`,
      })),
      buildPostbackData: () => signedLinePostbackData(),
      capabilityProfile: {
        ...PERMISSIVE_CAPABILITY_PROFILE,
        actions: {
          ...PERMISSIVE_CAPABILITY_PROFILE.actions!,
          maxActions: 13,
          maxActionsPerRow: 4,
          maxRows: 7,
          maxLabelLength: LINE_ACTION_LABEL_LIMIT,
          maxCallbackPayloadBytes: 300,
        },
      },
      title: "Status",
    });

    const rows = bubble?.contents.footer?.contents ?? [];
    const buttonCount = rows.reduce((count, row) => {
      return count + (row.type === "box" ? row.contents.length : 0);
    }, 0);

    expect(rows).toHaveLength(7);
    expect(buttonCount).toBe(13);
    expect(rows[0]?.type === "box" ? rows[0].contents : []).toHaveLength(2);
  });

  it("does not duplicate picker prompts in text fallback", () => {
    const prompt = "Showing recent PwrAgent threads. Page 1/7.";
    const fallbackText = [
      prompt,
      "1. First thread",
      "Reply with a number, or reply next, projects, new, or cancel.",
    ].join("\n");

    expect(textForLineIntent({
      id: "intent-picker",
      kind: "thread_picker",
      createdAt: 1,
      fallbackText,
      navigation: {
        backend: "all",
        fetchedAt: 1,
        unchanged: false,
      },
      page: {
        actions: [],
        items: [],
        pageIndex: 0,
        pageSize: 8,
        totalItems: 1,
      },
      prompt,
    })).toBe(fallbackText);
  });

  it("does not render activity as a LINE chat message", () => {
    expect(textForLineIntent({
      id: "activity-1",
      kind: "activity",
      activity: "typing",
      state: "active",
      createdAt: 1,
    })).toBe("");
  });

  it("requires postback button data to be opaque persisted handles", () => {
    expect(() =>
      buildLineActionBubble({
        actions: [{ id: "approve", label: "Approve" }],
        buildPostbackData: () => "confirm:yes",
        capabilityProfile: PERMISSIVE_CAPABILITY_PROFILE,
        title: "Choose",
      })
    ).toThrow(/opaque persisted handle/);
  });

  it("renders https image parts as LINE image messages", () => {
    expect(imageMessagesForLineIntent({
      id: "intent-1",
      kind: "message",
      parts: [
        { type: "text", text: "Result" },
        { type: "image", url: "https://example.com/image.png", alt: "Preview" },
        { type: "image", url: "data:image/png;base64,abc", alt: "Inline" },
      ],
      createdAt: 1,
    })).toEqual([{
      type: "image",
      originalContentUrl: "https://example.com/image.png",
      previewImageUrl: "https://example.com/image.png",
    }]);
  });
});

function signedLinePostbackData(): string {
  return JSON.stringify({
    v: 1,
    h: "line:abcDEF012_-xyz789A",
    t: 1234,
    s: "abcdefghijklmnopqrstuvwxyzABCDEF",
  });
}
