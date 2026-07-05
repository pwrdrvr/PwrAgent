import { describe, expect, it } from "vitest";
import { sanitizeRendererPayload } from "../renderer-payload-boundary";

describe("renderer payload boundary", () => {
  it("truncates oversized arbitrary strings", () => {
    const payload = {
      notification: {
        method: "turn/diff/updated",
        params: {
          diff: "x".repeat(80_000),
        },
      },
    };

    const sanitized = sanitizeRendererPayload(payload);

    expect(sanitized.notification.params.diff).toContain(
      "PwrAgent renderer boundary: truncated",
    );
    expect(sanitized.notification.params.diff).toContain(
      "$.notification.params.diff",
    );
    expect(sanitized.notification.params.diff).not.toContain(
      "x".repeat(60_000),
    );
  });

  it("preserves renderer image URLs on image message parts", () => {
    const imageUrl = `data:image/png;base64,${"a".repeat(80_000)}`;
    const payload = {
      replay: {
        entries: [
          {
            type: "message",
            parts: [
              {
                type: "image",
                url: imageUrl,
                alt: "Thread rename focus screenshot",
              },
            ],
          },
        ],
      },
    };

    const sanitized = sanitizeRendererPayload(payload);

    expect(sanitized.replay.entries[0]?.parts[0]?.url).toBe(imageUrl);
  });

  it("still truncates image-looking strings outside explicit image fields", () => {
    const dataUrl = `data:image/png;base64,${"a".repeat(80_000)}`;

    const sanitized = sanitizeRendererPayload({
      fileDiff: {
        diff: dataUrl,
      },
    });

    expect(sanitized.fileDiff.diff).toContain(
      "PwrAgent renderer boundary: truncated",
    );
  });
});
