import { describe, expect, it } from "vitest";
import { MessagingMarkdownFileAttachmentSelector } from "../messaging/core/messaging-markdown-file-attachment-selector.js";

describe("MessagingMarkdownFileAttachmentSelector", () => {
  it("selects one added markdown file under the size limit", () => {
    const selector = new MessagingMarkdownFileAttachmentSelector();
    const selection = selector.selectFromCompletedItem({
      type: "fileChange",
      changes: [
        {
          path: "/repo/docs/plan.md",
          kind: {
            type: "add",
            content: "# Plan\n\nShip the feature.\n",
          },
        },
      ],
    });

    expect(selection).toMatchObject({
      attachmentName: "plan.md",
      markdown: "# Plan\n\nShip the feature.\n",
      path: "/repo/docs/plan.md",
      previewMarkdown: "# Plan\n\nShip the feature.",
      previewTruncated: false,
    });
  });

  it("caps previews by both line count and character count", () => {
    const selector = new MessagingMarkdownFileAttachmentSelector({
      maxPreviewChars: 1_000,
      maxPreviewLines: 20,
    });
    const longLine = "x".repeat(1_200);
    const manyLines = Array.from({ length: 25 }, (_, index) => `line ${index + 1}`).join("\n");

    const longLineSelection = selector.selectFromCompletedItem({
      type: "fileChange",
      changes: [
        {
          path: "LONG.md",
          kind: {
            type: "add",
            content: longLine,
          },
        },
      ],
    });
    const manyLinesSelection = selector.selectFromCompletedItem({
      type: "fileChange",
      changes: [
        {
          path: "LINES.md",
          kind: {
            type: "add",
            content: manyLines,
          },
        },
      ],
    });

    expect(longLineSelection?.previewMarkdown).toHaveLength(1_000);
    expect(longLineSelection?.previewTruncated).toBe(true);
    expect(manyLinesSelection?.previewMarkdown.split("\n")).toHaveLength(20);
    expect(manyLinesSelection?.previewMarkdown).not.toContain("line 21");
    expect(manyLinesSelection?.previewTruncated).toBe(true);
  });

  it("skips multiple changes, non-markdown files, updates, and oversized files", () => {
    const selector = new MessagingMarkdownFileAttachmentSelector();

    expect(
      selector.selectFromCompletedItem({
        type: "fileChange",
        changes: [
          { path: "one.md", kind: { type: "add", content: "one" } },
          { path: "two.md", kind: { type: "add", content: "two" } },
        ],
      }),
    ).toBeUndefined();
    expect(
      selector.selectFromCompletedItem({
        type: "fileChange",
        changes: [{ path: "notes.txt", kind: { type: "add", content: "notes" } }],
      }),
    ).toBeUndefined();
    expect(
      selector.selectFromCompletedItem({
        type: "fileChange",
        changes: [{ path: "notes.md", kind: { type: "update", content: "notes" } }],
      }),
    ).toBeUndefined();
    expect(
      selector.selectFromCompletedItem({
        type: "fileChange",
        changes: [
          {
            path: "large.md",
            kind: { type: "add", content: "x".repeat(50 * 1024) },
          },
        ],
      }),
    ).toBeUndefined();
  });

  it("reconstructs added markdown from a unified diff", () => {
    const selector = new MessagingMarkdownFileAttachmentSelector();
    const selection = selector.selectFromCompletedItem({
      type: "fileChange",
      changes: [
        {
          path: "docs/result.md",
          kind: { type: "add" },
          diff: [
            "new file mode 100644",
            "--- /dev/null",
            "+++ b/docs/result.md",
            "@@ -0,0 +1,3 @@",
            "+# Result",
            "+",
            "+Done.",
          ].join("\n"),
        },
      ],
    });

    expect(selection?.markdown).toBe("# Result\n\nDone.");
    expect(selection?.previewMarkdown).toBe("# Result\n\nDone.");
  });
});
