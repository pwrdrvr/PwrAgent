import { describe, expect, it } from "vitest";
import type { BackendSummary } from "@pwragent/shared";
import { formatBackendLabel } from "../backend-label";

describe("formatBackendLabel", () => {
  it("uses backend summaries for dynamic ACP labels", () => {
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
    ).toBe("Gemini CLI");
  });

  it("falls back to stable built-in and ACP labels", () => {
    expect(formatBackendLabel("codex")).toBe("OpenAI");
    expect(formatBackendLabel("grok")).toBe("Grok");
    expect(formatBackendLabel("acp:unknown")).toBe("unknown");
  });
});
