import { describe, expect, it } from "vitest";
import { formatMcpToolOutput } from "../tool-activity";

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
