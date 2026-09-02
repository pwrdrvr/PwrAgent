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
  reviewRunMode = true,
): BackendSummary {
  return {
    kind,
    label: kind === "codex" ? "Codex" : "Grok",
    available: true,
    methods: [],
    capabilities: {
      reviewRunner,
      reviewRunMode,
    } as BackendSummary["capabilities"],
    executionModes: [],
  };
}

describe("resolveReviewRunMode", () => {
  it("defaults same-provider reviews to this thread", () => {
    expect(resolveReviewRunMode({
      ownerSummary: reviewer("codex", true),
      reviewerBackend: "codex",
      reviewerSummary: reviewer("codex", true),
      thread: thread(),
    })).toEqual({
      controlDisabled: false,
      explicitRunModeSupported: true,
      runMode: "inline",
      subagentDisabled: false,
    });
  });

  it("honors an optional subagent choice", () => {
    expect(resolveReviewRunMode({
      ownerSummary: reviewer("codex", true),
      requestedRunMode: "managed-child",
      reviewerBackend: "codex",
      reviewerSummary: reviewer("codex", true),
      thread: thread(),
    }).runMode).toBe("managed-child");
  });

  it("forces another provider into a managed child with a concrete reason", () => {
    const decision = resolveReviewRunMode({
      ownerSummary: reviewer("codex", true),
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
      ownerSummary: reviewer("codex", true),
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
      ownerSummary: reviewer("acp:grok", true),
      reviewerBackend: "acp:grok",
      reviewerSummary: reviewer("acp:grok", true),
      thread: thread("acp:grok"),
    });

    expect(decision.runMode).toBe("managed-child");
    expect(decision.helpText).toMatch(/Grok runs reviews in a managed subagent/);
  });

  it("disables the subagent when the reviewer cannot run one", () => {
    const decision = resolveReviewRunMode({
      ownerSummary: reviewer("codex", false),
      reviewerBackend: "codex",
      reviewerSummary: reviewer("codex", false),
      thread: thread(),
    });

    expect(decision.runMode).toBe("inline");
    expect(decision.subagentDisabled).toBe(true);
    expect(decision.helpText).toBe(
      "Codex cannot run this review in a subagent.",
    );
  });

  it("uses the owner default when a federated owner predates explicit run modes", () => {
    const decision = resolveReviewRunMode({
      ownerSummary: reviewer("codex", true, false),
      requestedRunMode: "managed-child",
      reviewerBackend: "codex",
      reviewerSummary: reviewer("codex", true),
      thread: thread(),
    });

    expect(decision.runMode).toBe("inline");
    expect(decision.controlDisabled).toBe(true);
    expect(decision.explicitRunModeSupported).toBe(false);
    expect(decision.helpText).toMatch(/owner's configured default/);
  });
});
