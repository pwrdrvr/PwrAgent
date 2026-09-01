import type {
  AppServerReviewOutput,
  AppServerThreadReviewEntry,
} from "@pwragent/shared";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TranscriptReview } from "../TranscriptReview";

afterEach(() => {
  cleanup();
});

describe("TranscriptReview", () => {
  it("renders review summary metadata and prioritized findings", () => {
    render(
      <TranscriptReview
        directoryPaths={["/repo/apps/desktop/src/renderer"]}
        entry={{
          type: "review",
          id: "review-1",
          review: "The patch has one review issue.",
          displayText: "Review changes against main",
          reviewer: {
            backend: "codex",
            model: "gpt-5.6-sol",
            reasoningEffort: "high",
          },
          output: {
            findings: [
              {
                title: "Hydrate review transcript items",
                body: "The live transcript should show review cards instead of assistant text.",
                confidence_score: 0.91,
                priority: 1,
                code_location: {
                  absolute_file_path:
                    "/repo/apps/desktop/src/renderer/src/lib/useThreadSessionState.ts",
                  line_range: {
                    start: 845,
                    end: 848,
                  },
                },
              },
            ],
            overall_correctness: "patch is incorrect",
            overall_explanation: "The live review result is currently rendered as plain text.",
            overall_confidence_score: 0.87,
          },
        }}
      />
    );

    expect(screen.getByText("Review")).toBeInTheDocument();
    expect(screen.getByText("Review changes against main")).toBeInTheDocument();
    expect(screen.getByText("Patch needs work · 87%")).toBeInTheDocument();
    expect(screen.getByText("1 finding")).toBeInTheDocument();
    const runtime = screen.getByLabelText("Review runtime");
    expect(runtime).toHaveTextContent("OpenAI");
    expect(runtime).toHaveTextContent("gpt-5.6-sol");
    expect(runtime).toHaveTextContent("high");
    expect(screen.getByText("P1")).toBeInTheDocument();
    expect(screen.getByText("P1")).toHaveClass("transcript-review__priority--p1");
    expect(screen.getByText("Hydrate review transcript items")).toBeInTheDocument();
    const fileLink = screen.getByRole("link", {
      name: "src/lib/useThreadSessionState.ts",
    });
    expect(fileLink).toHaveAttribute(
      "href",
      "file:///repo/apps/desktop/src/renderer/src/lib/useThreadSessionState.ts:845"
    );
    expect(screen.getByText("Lines 845-848")).toBeInTheDocument();
  });

  it("hides raw entered-review protocol text when it matches the display label", () => {
    render(
      <TranscriptReview
        entry={{
          type: "review",
          id: "review-entered-1",
          review: "changes against 'main'",
          displayText: "Review changes against main",
        }}
      />
    );

    expect(screen.getByText("Review changes against main")).toBeInTheDocument();
    expect(screen.queryByText("changes against 'main'")).not.toBeInTheDocument();
  });

  it("renders plain Codex review comments as review findings", () => {
    render(
      <TranscriptReview
        directoryPaths={["/repo/apps/desktop/src/renderer/src"]}
        entry={{
          type: "review",
          id: "review-exited-1",
          review:
            "The change fixes the covered scenario, but one edge case remains.\n\nReview comment:\n\n- [P2] Preserve async pasted images for launchpad scopes — /repo/apps/desktop/src/renderer/src/features/composer/Composer.tsx:971-979\n  When an image paste starts from a new-thread launchpad and the user switches away before normalization finishes, the completed attachment is dropped.",
        }}
      />
    );

    expect(screen.getByText("Code review")).toBeInTheDocument();
    expect(
      screen.getByText("The change fixes the covered scenario, but one edge case remains.")
    ).toBeInTheDocument();
    expect(screen.getByText("P2")).toBeInTheDocument();
    expect(screen.getByText("P2")).toHaveClass("transcript-review__priority--p2");
    expect(
      screen.getByText("Preserve async pasted images for launchpad scopes")
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "features/composer/Composer.tsx" })
    ).toHaveAttribute(
      "href",
      "file:///repo/apps/desktop/src/renderer/src/features/composer/Composer.tsx:971"
    );
    expect(screen.getByText("Lines 971-979")).toBeInTheDocument();
  });

  it("renders full review comments as separate finding cards", () => {
    render(
      <TranscriptReview
        directoryPaths={["/repo/apps/desktop/src/renderer/src"]}
        entry={{
          type: "review",
          id: "review-exited-2",
          review:
            "The patch can lose pending steer drafts in realistic active-turn races.\n\nFull review comments:\n\n- [P2] Only clear steer after it has actually been sent — /repo/apps/desktop/src/renderer/src/features/composer/Composer.tsx:618-622\n  Gate confirmation on the steering status so pre-injection events cannot acknowledge the steer.\n\n- [P2] Preserve pending steer when a queued turn already exists — /repo/apps/desktop/src/renderer/src/features/composer/Composer.tsx:660-667\n  Keep the pending steer visible instead of dropping it when a queued turn already exists.",
        }}
      />
    );

    expect(
      screen.getByText("The patch can lose pending steer drafts in realistic active-turn races.")
    ).toBeInTheDocument();
    expect(screen.getByText("Only clear steer after it has actually been sent")).toBeInTheDocument();
    expect(
      screen.getByText("Preserve pending steer when a queued turn already exists")
    ).toBeInTheDocument();
    expect(screen.getAllByText("P2")).toHaveLength(2);
    expect(screen.getByText("Lines 618-622")).toBeInTheDocument();
    expect(screen.getByText("Lines 660-667")).toBeInTheDocument();
    expect(screen.queryByText("Full review comments:")).not.toBeInTheDocument();
  });

  it("colors every supported review severity and preserves absolute outside paths", () => {
    render(
      <TranscriptReview
        directoryPaths={["/repo"]}
        entry={{
          type: "review",
          id: "review-severity-paths",
          displayText: "Code review",
          review: "Review severities.\n\nFull review comments:\n\n- [P0] Critical issue — /outside/repository/VeryLongOutsideFileName.ts:1\n  Critical body.\n\n- [P1] High issue — /repo/packages/app/high.ts:2\n  High body.\n\n- [P2] Medium issue — /repo/packages/app/medium.ts:3\n  Medium body.\n\n- [P3] Low issue — /repo/packages/app/low.ts:4\n  Low body.",
        }}
      />
    );

    for (const priority of [0, 1, 2, 3]) {
      expect(screen.getByText(`P${priority}`)).toHaveClass(
        `transcript-review__priority--p${priority}`
      );
    }

    expect(
      screen.getByRole("link", { name: "/outside/repository/VeryLongOutsideFileName.ts" })
    ).toHaveAttribute("href", "file:///outside/repository/VeryLongOutsideFileName.ts:1");
    expect(screen.getByRole("link", { name: "packages/app/high.ts" })).toBeInTheDocument();
  });
});

describe("TranscriptReview provenance", () => {
  const context = {
    workspacePath: "/Users/dev/.codex/worktrees/mti5p133/PwrAgent",
    projectLabel: "PwrAgent",
    repositoryPath: "/Users/dev/pwrdrvr/PwrAgent",
    gitBranch: "fix/macos-dock-icon-safe-area",
    baseBranch: "origin/main",
    pullRequest: {
      provider: "github.com",
      org: "pwrdrvr",
      repo: "PwrAgent",
      number: 1918,
      // GitHub reports the bare branch name. Writing `origin/main` here was
      // what let the raw string comparison in `formatBranchLabel` pass.
      baseRefName: "main",
      url: "https://github.com/pwrdrvr/PwrAgent/pull/1918",
    },
  } as const;

  function renderReview(
    entry: Partial<AppServerThreadReviewEntry> = {},
  ): void {
    render(
      <TranscriptReview
        entry={{
          type: "review",
          id: "review-provenance",
          review: "",
          displayText: "Review changes against origin/main",
          ...entry,
        }}
      />
    );
  }

  it("names the project, branch, and pull request the review ran against", () => {
    renderReview({ context });

    const row = screen.getByLabelText("What was reviewed");
    expect(row).toHaveTextContent("PwrAgent");
    expect(row).toHaveTextContent("fix/macos-dock-icon-safe-area");
    expect(row).toHaveTextContent("pwrdrvr/PwrAgent#1918");
    expect(
      screen.getByRole("link", { name: /pwrdrvr\/PwrAgent#1918/ })
    ).toHaveAttribute("href", "https://github.com/pwrdrvr/PwrAgent/pull/1918");
  });

  it("offers the full workspace path to copy", () => {
    renderReview({ context });

    expect(
      screen.getByLabelText("Copy workspace path for PwrAgent")
    ).toBeInTheDocument();
  });

  it("treats a remote-qualified target as the pull request's own base", () => {
    // The ordinary review: target `origin/main`, GitHub base `main`. The
    // summary line already says it, so the chip does not repeat it.
    renderReview({ context });

    expect(screen.getByLabelText("What was reviewed")).not.toHaveTextContent(
      "→"
    );
  });

  it("shows the base when the review skipped past the pull request's own", () => {
    renderReview({
      context: {
        ...context,
        gitBranch: "feat/star-map-float",
        pullRequest: {
          ...context.pullRequest,
          baseRefName: "feat/star-map-layer",
        },
      },
    });

    expect(screen.getByLabelText("What was reviewed")).toHaveTextContent(
      "feat/star-map-float → origin/main"
    );
  });

  it("says the branch carried no pull request rather than listing others", () => {
    renderReview({
      context: { ...context, pullRequest: null, gitBranch: "main" },
    });

    expect(screen.getByText("no PR at review time")).toBeInTheDocument();
  });

  it("shows no pull-request chip at all when none could be checked", () => {
    const { pullRequest: _pullRequest, ...unchecked } = context;
    renderReview({ context: unchecked });

    expect(screen.queryByText("no PR at review time")).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("renders no row for a review that predates the capture", () => {
    renderReview();

    expect(screen.queryByLabelText("What was reviewed")).not.toBeInTheDocument();
  });
});

describe("TranscriptReview verdict", () => {
  function renderVerdict(
    output: Partial<AppServerReviewOutput> = {},
  ): void {
    render(
      <TranscriptReview
        entry={{
          type: "review",
          id: "review-verdict",
          review: "",
          reviewer: { backend: "codex", model: "gpt-5.6-sol" },
          output: {
            findings: [],
            overall_correctness: "patch is correct",
            overall_explanation: "Nothing regressed.",
            ...output,
          },
        }}
      />
    );
  }

  it("fuses the confidence into the verdict it modifies", () => {
    renderVerdict({ overall_confidence_score: 0.98 });

    expect(screen.getByText("Patch correct · 98%")).toBeInTheDocument();
  });

  it("describes what the number is a confidence in, on focus", async () => {
    renderVerdict({ overall_confidence_score: 0.98 });

    const badge = screen.getByText("Patch correct · 98%");
    // Standing alone the number names no subject, so the explanation has to be
    // reachable — and as a description, not by renaming the badge.
    expect(badge).not.toHaveAccessibleDescription();
    act(() => {
      badge.focus();
    });
    expect(badge).toHaveAccessibleDescription(
      /its own verdict — the patch is correct/
    );
    expect(badge).toHaveAccessibleDescription(/not a score for the code/);
  });

  it("shows the verdict alone when the reviewer reported no confidence", () => {
    renderVerdict();

    expect(screen.getByText("Patch correct")).toBeInTheDocument();
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
  });
});
