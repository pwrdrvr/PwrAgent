import { describe, expect, it } from "vitest";
import type {
  AppServerBackendKind,
  BackendSummary,
  NavigationThreadSummary,
} from "@pwragent/shared";
import { resolveReviewRunMode } from "../review-run-mode";

function thread(
  source: AppServerBackendKind = "codex",
): NavigationThreadSummary {
  return {
    id: "thread-1",
    title: "Review me",
    titleSource: "explicit",
    source,
    executionMode: "default",
    linkedDirectories: [{
      id: "/repo/primary",
      kind: "local",
      label: "primary",
      path: "/repo/primary",
    }],
    inbox: { inInbox: false },
  };
}

function reviewer(
  kind: AppServerBackendKind,
  reviewRunner: boolean,
): BackendSummary {
  return {
    kind,
    label: kind === "codex" ? "Codex" : "Grok",
    available: true,
    methods: [],
    capabilities: { reviewRunner } as BackendSummary["capabilities"],
    executionModes: [],
  };
}

describe("resolveReviewRunMode", () => {
  it("defaults same-provider reviews to this thread", () => {
    expect(resolveReviewRunMode({
      reviewerBackend: "codex",
      reviewerSummary: reviewer("codex", true),
      thread: thread(),
    })).toEqual({
      controlDisabled: false,
      runMode: "inline",
      separateThreadDisabled: false,
    });
  });

  it("honors an optional separate-thread choice", () => {
    expect(resolveReviewRunMode({
      requestedRunMode: "managed-child",
      reviewerBackend: "codex",
      reviewerSummary: reviewer("codex", true),
      thread: thread(),
    }).runMode).toBe("managed-child");
  });

  it("forces another provider into a managed child with a concrete reason", () => {
    const decision = resolveReviewRunMode({
      requestedRunMode: "inline",
      reviewerBackend: "acp:grok",
      reviewerSummary: reviewer("acp:grok", true),
      thread: thread(),
    });

    expect(decision.runMode).toBe("managed-child");
    expect(decision.controlDisabled).toBe(true);
    expect(decision.helpText).toMatch(/Grok, a different provider/);
  });

  it("forces a selected secondary workspace into a managed child", () => {
    const parent = thread();
    parent.linkedDirectories.push({
      id: "/repo/secondary",
      kind: "local",
      label: "secondary",
      path: "/repo/secondary",
    });
    const decision = resolveReviewRunMode({
      reviewerBackend: "codex",
      reviewerSummary: reviewer("codex", true),
      thread: parent,
      workspaceCwd: "/repo/secondary",
    });

    expect(decision.runMode).toBe("managed-child");
    expect(decision.helpText).toMatch(/not this thread's primary workspace/);
  });

  it("forces ACP review providers into managed children", () => {
    const decision = resolveReviewRunMode({
      reviewerBackend: "acp:grok",
      reviewerSummary: reviewer("acp:grok", true),
      thread: thread("acp:grok"),
    });

    expect(decision.runMode).toBe("managed-child");
    expect(decision.helpText).toMatch(/Grok runs reviews as managed child threads/);
  });

  it("disables separate thread when the reviewer cannot run a managed child", () => {
    const decision = resolveReviewRunMode({
      reviewerBackend: "codex",
      reviewerSummary: reviewer("codex", false),
      thread: thread(),
    });

    expect(decision.runMode).toBe("inline");
    expect(decision.separateThreadDisabled).toBe(true);
    expect(decision.helpText).toBe(
      "Codex cannot run a managed review in a separate thread.",
    );
  });
});
