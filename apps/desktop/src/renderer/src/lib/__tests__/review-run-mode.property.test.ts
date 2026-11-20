import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { AppServerBackendKind } from "@pwragent/shared/contracts/normalized-app-server";
import type { BackendSummary } from "@pwragent/shared/contracts/backend";
import type { NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import type { ReviewRunMode } from "@pwragent/shared/contracts/agent";
import { PULL_REQUEST_SET_RUN_MODE_REASON, resolveReviewRunMode } from "../review-run-mode";

function thread(source: AppServerBackendKind): NavigationThreadSummary {
  return {
    id: "thread-1", title: "Review me", titleSource: "explicit", source,
    executionMode: "default",
    linkedDirectories: [{ id: "/repo", kind: "local", label: "repo", path: "/repo" }],
    inbox: { inInbox: false },
  };
}

function summary(kind: AppServerBackendKind, capabilities: Partial<BackendSummary["capabilities"]>): BackendSummary {
  return {
    kind, label: kind, available: true, methods: [], executionModes: [],
    capabilities: capabilities as BackendSummary["capabilities"],
  };
}

const input = fc.record({
  source: fc.constantFrom<AppServerBackendKind>("codex", "claude", "acp:grok"),
  claudeCapability: fc.boolean(),
  runModeCapability: fc.boolean(),
  requested: fc.option(
    fc.constantFrom<ReviewRunMode>("codex-sub-agent", "pwragent-sub-agent", "claude-code-review"),
    { nil: undefined },
  ),
  reviewerChosen: fc.boolean(),
  reviewer: fc.constantFrom<AppServerBackendKind>("codex", "claude", "acp:grok"),
  pullRequestSet: fc.boolean(),
});

describe("resolveReviewRunMode", () => {
  it("runs Claude Code only on a Claude thread whose owner runs it, by choice or as the default", () => {
    fc.assert(fc.property(input, (case_) => {
      const decision = resolveReviewRunMode({
        ownerSummary: summary(case_.source, {
          reviewRunMode: case_.runModeCapability,
          reviewClaudeCodeReview: case_.claudeCapability,
          reviewCodexSubAgent: case_.source === "codex",
        }),
        pullRequestSet: case_.pullRequestSet,
        requestedRunMode: case_.requested,
        reviewerChosen: case_.reviewerChosen,
        reviewerBackend: case_.reviewer,
        reviewerSummary: summary(case_.reviewer, { reviewRunner: true }),
        thread: thread(case_.source),
      });
      const claude = case_.source === "claude" && case_.claudeCapability
        && (case_.requested === "claude-code-review"
          || (case_.requested === undefined && !case_.reviewerChosen));
      expect(decision.runMode === "claude-code-review").toBe(claude);
      // Claude Code is offered on, and only on, a Claude thread.
      expect(Boolean(decision.claudeCodeReviewOffered)).toBe(case_.source === "claude");
      // Codex's own reviewer takes one target, so Together never runs on it.
      if (case_.pullRequestSet && !claude) {
        expect(decision.runMode).toBe("pwragent-sub-agent");
      }
    }), { numRuns: 300 });
  });

  it("says why Together moved a Codex review to the PwrAgent Sub Agent", () => {
    const decision = resolveReviewRunMode({
      ownerSummary: summary("codex", { reviewRunMode: true, reviewCodexSubAgent: true }),
      pullRequestSet: true,
      requestedRunMode: "codex-sub-agent",
      reviewerBackend: "codex",
      reviewerSummary: summary("codex", { reviewRunner: true }),
      thread: thread("codex"),
    });
    expect(decision).toMatchObject({ runMode: "pwragent-sub-agent", controlDisabled: true });
    expect(decision.helpText).toContain(PULL_REQUEST_SET_RUN_MODE_REASON);
  });
});
