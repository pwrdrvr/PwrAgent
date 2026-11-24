import { describe, expect, it } from "vitest";
import type { BackendSummary } from "@pwragent/shared/contracts/backend";
import { formatBackendLabel } from "../backend-label";

describe("formatBackendLabel", () => {
  it("labels the native Claude provider without a backend summary", () => {
    expect(formatBackendLabel("claude")).toBe("Claude");
  });
  it("uses canonical labels for known ACP providers", () => {
    expect(
      formatBackendLabel("acp:gemini", [
        {
          kind: "acp:gemini",
          source: "acp",
          label: "Gemini CLI",
          available: true,
          methods: [],
          capabilities: {
            listThreads: true,
            createThread: true,
            resumeThread: true,
            renameThread: false,
            readThread: true,
            startTurn: true,
            interruptTurn: true,
            steerTurn: false,
            transcriptPagination: false,
            toolUse: true,
            approvalRequests: true,
            multiDirectoryThreads: true,
          },
          executionModes: [],
        } satisfies BackendSummary,
      ]),
    ).toBe("Gemini");
    expect(
      formatBackendLabel("acp:kimi", [
        {
          kind: "acp:kimi",
          source: "acp",
          label: "Kimi Code CLI",
          available: true,
          methods: [],
          capabilities: {
            listThreads: true,
            createThread: true,
            resumeThread: true,
            renameThread: false,
            readThread: true,
            startTurn: true,
            interruptTurn: true,
            steerTurn: false,
            transcriptPagination: false,
            toolUse: true,
            approvalRequests: true,
            multiDirectoryThreads: true,
          },
          executionModes: [],
        } satisfies BackendSummary,
      ]),
    ).toBe("Kimi");
  });

  it("uses backend summaries for unknown dynamic ACP labels", () => {
    expect(
      formatBackendLabel("acp:custom", [
        {
          kind: "acp:custom",
          source: "acp",
          label: "Custom ACP",
          available: true,
          methods: [],
          capabilities: {
            listThreads: true,
            createThread: true,
            resumeThread: true,
            renameThread: false,
            readThread: true,
            startTurn: true,
            interruptTurn: true,
            steerTurn: false,
            transcriptPagination: false,
            toolUse: true,
            approvalRequests: true,
            multiDirectoryThreads: true,
          },
          executionModes: [],
        } satisfies BackendSummary,
      ]),
    ).toBe("Custom ACP");
  });

  it("falls back to stable built-in and ACP labels", () => {
    expect(formatBackendLabel("codex")).toBe("OpenAI");
    expect(formatBackendLabel("acp:antigravity")).toBe("Antigravity");
    expect(formatBackendLabel("acp:gemini")).toBe("Gemini");
    expect(formatBackendLabel("acp:kimi")).toBe("Kimi");
    expect(formatBackendLabel("acp:grok")).toBe("Grok");
    expect(formatBackendLabel("acp:qwen")).toBe("Qwen");
    expect(formatBackendLabel("acp:unknown")).toBe("unknown");
  });

  it("uses canonical labels for built-in ACP backends even when no summary is provided", () => {
    // ThreadHeader.tsx, ThreadInfoCard.tsx, and ThreadMetaChips.tsx call
    // formatBackendLabel WITHOUT the summaries array, so canonical labels must
    // come from the hardcoded branches rather than falling through to bare
    // lowercase registry ids ("grok", "antigravity").
    expect(formatBackendLabel("acp:grok")).toBe("Grok");
    expect(formatBackendLabel("acp:grok", [])).toBe("Grok");
    expect(formatBackendLabel("acp:antigravity")).toBe("Antigravity");
    expect(formatBackendLabel("acp:antigravity", [])).toBe("Antigravity");
  });
});
