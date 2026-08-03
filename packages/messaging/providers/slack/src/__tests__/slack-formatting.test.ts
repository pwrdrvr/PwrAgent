import { describe, expect, it } from "vitest";
import type { MessagingCapabilityProfile, MessagingSurfaceIntent } from "@pwragent/messaging-interface";
import {
  buildSlackActionBlocks,
  buildSlackBlocksForIntent,
  markdownToSlackMrkdwn,
  sanitizeSlackActionId,
  splitSlackStandardMarkdown,
  splitSlackTextForDelivery,
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

  it("hands canonical assistant Markdown tables to Slack without translation", () => {
    const text = [
      "The Ruby cluster has recovered.",
      "",
      "| Signal | Alert period | Current/post-recovery |",
      "|---|---:|---:|",
      "| Search rejections | Two sharp increments | [Monitor](https://example.com) is `OK` |",
      "| Ruby CPU | Hottest node 80% | Hottest node 63% |",
      "",
      "No immediate resource adjustment is needed.",
    ].join("\n");
    const intent: MessagingSurfaceIntent = {
      id: "assistant-table",
      kind: "message",
      createdAt: 1,
      role: "assistant",
      parts: [{ type: "text", text, markdown: "markdown" }],
    };

    expect(buildSlackBlocksForIntent({ intent, text })).toEqual([
      {
        type: "markdown",
        text,
      },
    ]);
  });

  it("keeps non-Markdown surface text on Slack mrkdwn sections", () => {
    const intent: MessagingSurfaceIntent = {
      id: "plain-message",
      kind: "message",
      createdAt: 1,
      role: "assistant",
      parts: [{ type: "text", text: "Literal **asterisks**", markdown: "plain" }],
    };

    expect(buildSlackBlocksForIntent({ intent, text: "Literal **asterisks**" })).toEqual([
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "Literal *asterisks*",
        },
      },
    ]);
  });

  it("clamps remote image alt text to Slack's plain-text limit", () => {
    const alt = "a".repeat(2_500);
    const intent: MessagingSurfaceIntent = {
      id: "remote-image",
      kind: "message",
      createdAt: 1,
      role: "assistant",
      parts: [{ type: "image", url: "https://example.com/image.png", alt }],
    };

    const [block] = buildSlackBlocksForIntent({ intent, text: "" });
    expect(block).toMatchObject({
      type: "image",
      alt_text: `${"a".repeat(1_999)}…`,
      title: expect.objectContaining({ text: `${"a".repeat(1_999)}…` }),
    });
  });

  it("splits legacy text by its escaped mrkdwn length", () => {
    const text = "<".repeat(3_000);
    const intent: MessagingSurfaceIntent = {
      id: "plain-escaped-message",
      kind: "message",
      createdAt: 1,
      role: "assistant",
      parts: [{ type: "text", text, markdown: "plain" }],
    };
    const chunks = splitSlackTextForDelivery(intent, text);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(text);
    for (const chunk of chunks) {
      expect(markdownToSlackMrkdwn(chunk).length).toBeLessThanOrEqual(3_000);
    }
  });

  it("repeats table structure and reference definitions across Markdown chunks", () => {
    const header = "| Signal | Current/post-recovery |";
    const delimiter = "|---|---|";
    const rows = Array.from(
      { length: 18 },
      (_, index) =>
        `| Signal ${index + 1} | [Monitor][monitor] ${"healthy ".repeat(4)}|`,
    );
    const definition = "[monitor]: https://example.com/monitor";
    const markdown = [header, delimiter, ...rows, "", definition].join("\n");
    const chunks = splitSlackStandardMarkdown(markdown, 240);
    const tableChunks = chunks.filter((chunk) => chunk.startsWith(header));

    expect(tableChunks.length).toBeGreaterThan(1);
    expect(
      tableChunks.flatMap((chunk) =>
        chunk.split("\n").filter((line) => /^\| Signal \d+ /.test(line))
      ),
    ).toHaveLength(rows.length);
    for (const chunk of tableChunks) {
      expect(chunk.split("\n")[1]).toBe(delimiter);
      expect(chunk).toContain(definition);
      expect(chunk.length).toBeLessThanOrEqual(240);
    }
  });

  it("keeps a single oversized table row inside repeated table structure", () => {
    const header = "| Signal | Detail |";
    const delimiter = "|---|---|";
    const markdown = [
      header,
      delimiter,
      `| Search queue | ${"x".repeat(600)} |`,
    ].join("\n");
    const chunks = splitSlackStandardMarkdown(markdown, 180);

    expect(chunks.length).toBeGreaterThan(1);
    expect(
      chunks
        .flatMap((chunk) => chunk.split("\n").slice(2))
        .join("")
        .match(/x/g),
    ).toHaveLength(600);
    for (const chunk of chunks) {
      expect(chunk.split("\n").slice(0, 2)).toEqual([header, delimiter]);
      expect(chunk.length).toBeLessThanOrEqual(180);
    }
  });

  it("closes and reopens oversized fenced code across Markdown chunks", () => {
    const codeLines = Array.from(
      { length: 24 },
      (_, index) => `console.log("line-${index + 1}");`,
    );
    const markdown = [
      "Before the code.",
      "",
      "```ts",
      ...codeLines,
      "```",
      "",
      "After the code.",
    ].join("\n");
    const chunks = splitSlackStandardMarkdown(markdown, 160);
    const codeChunks = chunks.filter((chunk) => chunk.includes("console.log"));

    expect(codeChunks.length).toBeGreaterThan(1);
    expect(
      codeChunks.flatMap((chunk) =>
        chunk.split("\n").filter((line) => line.startsWith("console.log"))
      ),
    ).toHaveLength(codeLines.length);
    for (const chunk of codeChunks) {
      expect(chunk).toMatch(/^```ts$/m);
      expect(chunk).toMatch(/^```$/m);
      expect(chunk.length).toBeLessThanOrEqual(160);
    }
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

  it("keeps picker fallback copy out of the visible Block Kit section", () => {
    const intent: MessagingSurfaceIntent = {
      id: "picker-1",
      kind: "project_picker",
      createdAt: 1,
      fallbackText: "Choose a project.\n1. PwrAgent\nReply with a number.",
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
      },
      prompt: "Choose a project.",
    };

    expect(textForSlackIntent(intent)).toBe("Choose a project.");
  });
});
