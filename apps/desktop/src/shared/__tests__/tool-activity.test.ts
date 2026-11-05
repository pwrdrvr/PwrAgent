import { describe, expect, it } from "vitest";
import {
  formatDynamicToolOutput, formatMcpToolOutput, formatToolIdentifier, formatToolInvocation,
} from "../tool-activity";

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

describe("formatToolIdentifier", () => {
  it("names a connection PwrAgent manages by its own name, and any other server as itself", () => {
    expect(formatToolIdentifier("pwragent_builtin_sandboxer_e96ab96f1443b1279de4ece773af16df", "exec"))
      .toBe("sandboxer/exec");
    expect(formatToolIdentifier("pwragent_datadog_a3f9c2e1b8d47f60a1c2e3d4b5a6f708", "query")).toBe("datadog/query");
    expect(formatToolIdentifier("builtin_tools", "run")).toBe("builtin_tools/run");
    expect(formatToolIdentifier("pwragent", "attach_thread_pull_request")).toBe("pwragent/attach_thread_pull_request");
    expect(formatToolIdentifier(undefined, "ToolSearch")).toBe("ToolSearch");
  });
});
