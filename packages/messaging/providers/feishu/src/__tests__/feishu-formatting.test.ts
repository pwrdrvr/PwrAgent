import { describe, expect, it } from "vitest";
import type { MessagingCapabilityProfile, MessagingSurfaceIntent } from "@pwragent/messaging-interface";
import {
  buildFeishuActionElements,
  markdownToFeishuMarkdown,
  textForFeishuIntent,
  truncateFeishuPlainText,
} from "../feishu-formatting.ts";

const profile: MessagingCapabilityProfile = {
  actions: {
    maxActions: 20,
    maxActionsPerRow: 4,
    maxRows: 5,
    maxLabelLength: 20,
    supportsStyles: true,
    supportsDisabled: false,
    supportsLayoutHints: true,
    maxCallbackPayloadBytes: 2_000,
  },
  text: {
    maxLength: 30_000,
    encoding: "characters",
    markdownDialect: "feishu-md",
    supportsCodeBlocks: true,
    supportsBold: true,
    supportsItalic: true,
    supportsLinks: true,
    supportsInlineCode: true,
    supportsMessageEdit: true,
  },
};

describe("Feishu formatting", () => {
  it("keeps explicit markdown links for lark_md", () => {
    expect(markdownToFeishuMarkdown("Read [PwrAgent](https://example.com)")).toBe(
      "Read [PwrAgent](https://example.com)",
    );
  });

  it("truncates button labels to the platform profile cap", () => {
    expect(truncateFeishuPlainText("Approve for this session", 12)).toBe(
      "Approve f...",
    );
  });

  it("builds action modules and filters disabled actions", () => {
    const elements = buildFeishuActionElements({
      actions: [
        { id: "a", label: "Alpha", value: "a", layout: { row: 0 } },
        { id: "b", label: "Beta", value: "b", disabled: true },
        { id: "c", label: "Gamma", value: "c", layout: { row: 1 } },
      ],
      buildCallbackValue: (action) => String(action.value),
      capabilityProfile: profile,
    });

    expect(elements).toEqual([
      {
        tag: "action",
        actions: [
          expect.objectContaining({
            tag: "button",
            value: { handle: "a" },
          }),
        ],
        layout: "bisected",
      },
      {
        tag: "action",
        actions: [
          expect.objectContaining({
            tag: "button",
            value: { handle: "c" },
          }),
        ],
        layout: "bisected",
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
    expect(textForFeishuIntent(intent)).toBe("Working");
  });
});
