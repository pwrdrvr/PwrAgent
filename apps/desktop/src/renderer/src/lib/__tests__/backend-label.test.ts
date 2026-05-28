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
    // Legacy direct-xAI provider is rendered with the experimental
    // disambiguator. The Grok CLI ACP backend gets the bare "Grok".
    expect(formatBackendLabel("grok")).toBe("AgentCore - Grok");
    expect(formatBackendLabel("acp:gemini")).toBe("Gemini");
    expect(formatBackendLabel("acp:kimi")).toBe("Kimi");
    expect(formatBackendLabel("acp:grok")).toBe("Grok");
    expect(formatBackendLabel("acp:unknown")).toBe("unknown");
  });

  it("uses the canonical Grok label for the ACP Grok backend even when no summary is provided", () => {
    // ThreadHeader.tsx and ThreadMetaChips.tsx call formatBackendLabel
    // WITHOUT the summaries array, so the canonical label must come from
    // the hardcoded branch — otherwise the chip falls through to the
    // bare registry id and reads "grok" (lowercase). Regression test
    // for #579 follow-up reported on 2026-05-28.
    expect(formatBackendLabel("acp:grok")).toBe("Grok");
    expect(formatBackendLabel("acp:grok", [])).toBe("Grok");
  });
});
