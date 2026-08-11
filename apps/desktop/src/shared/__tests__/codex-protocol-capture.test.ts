import { describe, expect, it } from "vitest";
import {
  buildCodexProtocolCaptureHandoffMessage,
  formatCodexProtocolCaptureSize,
} from "../codex-protocol-capture";

describe("Codex protocol capture details", () => {
  it("formats compact file sizes", () => {
    expect(formatCodexProtocolCaptureSize(0)).toBe("0 B");
    expect(formatCodexProtocolCaptureSize(1536)).toBe("1.5 KB");
    expect(formatCodexProtocolCaptureSize(2 * 1024 * 1024)).toBe("2.0 MB");
  });

  it("builds a privacy-aware handoff with the path and exact size", () => {
    const message = buildCodexProtocolCaptureHandoffMessage({
      captureFilePath: "/diagnostics/protocol-captures/snippet.jsonl",
      sizeBytes: 1536,
      startedAt: "2026-08-10T12:00:00.000Z",
      stoppedAt: "2026-08-10T12:00:05.000Z",
    });

    expect(message).toContain(
      "Capture path: /diagnostics/protocol-captures/snippet.jsonl",
    );
    expect(message).toContain("Capture size: 1.5 KB (1536 bytes)");
    expect(message).toContain("Review the file before sharing it.");
  });
});
