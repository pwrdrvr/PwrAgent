import { describe, expect, it } from "vitest";
import { formatMcpToolOutput, formatDynamicToolOutput, formatToolInvocation } from "../tool-activity";

describe("formatMcpToolOutput", () => {
  it("replaces embedded image resource blobs with a compact placeholder", () => {
    const blob = "AQID".repeat(10_000);

    const output = formatMcpToolOutput({
      error: null,
      result: {
        content: [
          {
            type: "resource",
            resource: {
              uri: "capture://overview",
              mimeType: "image/png",
              blob,
            },
          },
        ],
      },
    });

    expect(output).toBe("[image/png image resource]");
    expect(output).not.toContain(blob);
  });
});

describe("complete tool transcript content", () => {
  const markdown = "| Finding | Test |\n| --- | --- |\n"
    + "| Preserve content | Keep this complete row |\n".repeat(1_000)
    + "\nEnd of audit.";

  it("preserves cross-thread message arguments as valid complete JSON", () => {
    const args = { threadId: "fixture-thread", prompt: markdown };
    const invocation = formatToolInvocation("send_message_to_thread", args);
    expect(invocation === `send_message_to_thread\n${JSON.stringify(args, null, 2)}`).toBe(true);
  });

  it("preserves MCP result Markdown", () => {
    const output = formatMcpToolOutput({
      error: null,
      result: { content: [{ type: "text", text: markdown }] },
    });
    expect(output === markdown).toBe(true);
  });

  it("preserves dynamic tool result Markdown", () => {
    expect(formatDynamicToolOutput([{ type: "inputText", text: markdown }]) === markdown).toBe(true);
  });
});
