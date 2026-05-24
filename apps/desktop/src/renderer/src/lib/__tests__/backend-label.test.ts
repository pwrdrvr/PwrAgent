import { describe, expect, it } from "vitest";
import type { BackendSummary } from "@pwragent/shared";
import { formatBackendLabel } from "../backend-label";

describe("formatBackendLabel", () => {
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
    expect(formatBackendLabel("grok")).toBe("Grok");
    expect(formatBackendLabel("acp:gemini")).toBe("Gemini");
    expect(formatBackendLabel("acp:kimi")).toBe("Kimi");
    expect(formatBackendLabel("acp:unknown")).toBe("unknown");
  });
});
