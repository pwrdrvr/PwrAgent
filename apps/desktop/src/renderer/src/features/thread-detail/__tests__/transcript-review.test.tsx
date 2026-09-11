import type {
  AppServerReviewOutput,
  AppServerThreadReviewEntry,
  NavigationThreadSummary,
  PrSummary,
} from "@pwragent/shared";
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PullRequestLinkProvider } from "../../../lib/pull-request-links";
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
  const pullRequest: PrSummary = {
    provider: "github.com",
    org: "pwrdrvr",
    repo: "PwrAgent",
    number: 1918,
    state: "passing",
    checkState: "passing",
    lifecycleState: "open",
    reviewState: "ready_for_review",
    mergeState: "mergeable",
    headRefName: "fix/macos-dock-icon-safe-area",
    baseRefName: "main",
    title: "Keep the dock icon inside its safe area",
    url: "https://github.com/pwrdrvr/PwrAgent/pull/1918",
  };
  const thread: NavigationThreadSummary = {
    id: "thread-review-provenance",
    title: "Review provenance",
    titleSource: "explicit",
    summary: "Review provenance",
    source: "codex",
    linkedDirectories: [],
    inbox: { inInbox: false },
    prs: [pullRequest],
    updatedAt: 1,
  };
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
      headRefName: "fix/macos-dock-icon-safe-area",
      title: "Keep the dock icon inside its safe area",
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
      <PullRequestLinkProvider activeThread={thread} threads={[thread]}>
        <TranscriptReview
          entry={{
            type: "review",
            id: "review-provenance",
            review: "",
            displayText: "Review changes against origin/main",
            ...entry,
          }}
        />
      </PullRequestLinkProvider>
    );
  }

  it("names the project, branch, and pull request the review ran against", () => {
    renderReview({ context });

    const row = screen.getByLabelText("What was reviewed");
    expect(row).toHaveTextContent("PwrAgent");
    expect(row).toHaveTextContent("fix/macos-dock-icon-safe-area");
    expect(row).toHaveTextContent("pwrdrvr/PwrAgent#1918");
    expect(
      screen.getByRole("button", {
        name: /Open pwrdrvr\/PwrAgent#1918 .* in browser/,
      })
    ).toBeInTheDocument();
  });

  it("offers the full workspace path to copy", () => {
    renderReview({ context });

    expect(
      screen.getByLabelText("Copy workspace path for PwrAgent")
    ).toBeInTheDocument();
  });

  it("uses the shared copyable branch and pull-request status chips", () => {
    renderReview({ context });

    expect(
      screen.getByRole("button", {
        name: "Copy branch fix/macos-dock-icon-safe-area",
      })
    ).toHaveClass("path-copy-target");

    const pullRequest = screen.getByRole("button", {
      name: /Open pwrdrvr\/PwrAgent#1918 .* in browser/,
    });
    expect(pullRequest).toHaveAttribute("data-pr-chip");
    fireEvent.focus(pullRequest);

    expect(screen.getByText("Pull request")).toBeInTheDocument();
    expect(
      screen.getByText("Keep the dock icon inside its safe area")
    ).toBeInTheDocument();
    expect(screen.getByText("ready for review · checks passing")).toBeInTheDocument();
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
    expect(
      screen.queryByRole("button", { name: /Open .* in browser/ })
    ).not.toBeInTheDocument();
  });

  it("renders no row for a review that predates the capture", () => {
    renderReview();

    expect(screen.queryByLabelText("What was reviewed")).not.toBeInTheDocument();
  });

  it("names the commit that was reviewed, and the diff base behind it", () => {
    renderReview({
      context: {
        ...context,
        headCommit: "489d16ff09abcdef0123456789abcdef01234567",
        baseCommit: "0f12ab34cd56ef7890abcdef1234567890abcdef",
      },
    });

    // A branch name alone does not identify a diff, so the chip abbreviates
    // the tip and copies the whole hash.
    const chip = screen.getByRole("button", {
      name: "Copy reviewed commit 489d16ff09abcdef0123456789abcdef01234567",
    });
    expect(chip).toHaveTextContent("489d16ff09");
    act(() => {
      chip.focus();
    });
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      "Diff base 0f12ab34cd56ef7890abcdef1234567890abcdef",
    );
  });

  it("shows no commit chip for a review that could not read one", () => {
    renderReview({ context });

    expect(
      screen.queryByRole("button", { name: /Copy reviewed commit/ }),
    ).not.toBeInTheDocument();
  });
});

describe("TranscriptReview copy affordances", () => {
  const context = {
    workspacePath: "/Users/dev/pwrdrvr/PwrAgent",
    projectLabel: "PwrAgent",
    gitBranch: "fix/macos-dock-icon-safe-area",
    baseBranch: "origin/main",
    headCommit: "489d16ff09abcdef0123456789abcdef01234567",
    baseCommit: "0f12ab34cd56ef7890abcdef1234567890abcdef",
    pullRequest: null,
  } as const;

  function renderCopyable(): {
    copyRichText: ReturnType<typeof vi.fn>;
    copyText: ReturnType<typeof vi.fn>;
  } {
    const copyRichText = vi.fn(async () => undefined);
    const copyText = vi.fn(async () => undefined);
    render(
      <TranscriptReview
        desktopApi={{ copyRichText, copyText }}
        entry={{
          type: "review",
          id: "review-copy",
          review: "",
          displayText: "Review changes against origin/main",
          createdAt: Date.parse("2026-09-11T20:39:00.000Z"),
          context,
          reviewer: { backend: "codex", model: "gpt-5.6-sol" },
          output: {
            findings: [
              {
                title: "Pad the icon to Apple's template",
                body: "The mark sits 824-in-1024 rather than full bleed.",
                confidence_score: 0.9,
                priority: 1,
                code_location: {
                  absolute_file_path:
                    "/Users/dev/pwrdrvr/PwrAgent/apps/desktop/build/icon.png",
                  line_range: { start: 12, end: 18 },
                },
              },
              {
                title: "Keep the legacy icns out of the bundle",
                body: "macOS 26 normalizes it onto a light plate.",
                confidence_score: 0.8,
                priority: 2,
                code_location: {
                  absolute_file_path:
                    "/Users/dev/pwrdrvr/PwrAgent/apps/desktop/electron-builder.yml",
                  line_range: { start: 41, end: 41 },
                },
              },
            ],
            overall_correctness: "patch is incorrect",
            overall_explanation: "The dock icon is padded to the wrong template.",
            overall_confidence_score: 0.87,
          },
        }}
      />,
    );
    return { copyRichText, copyText };
  }

  it("copies the whole review with the commits and pull-request state it was taken against", async () => {
    const { copyRichText } = renderCopyable();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Copy review with what was reviewed",
      }),
    );

    await waitFor(() => {
      expect(copyRichText).toHaveBeenCalledTimes(1);
    });
    const { html, text } = copyRichText.mock.calls[0]?.[0] as {
      html: string;
      text: string;
    };
    expect(text).toContain("# Review changes against origin/main");
    expect(text).toContain(
      "**Verdict:** Patch needs work (87% reviewer confidence) · 2 findings",
    );
    expect(text).toContain(
      "- **Tip commit:** 489d16ff09abcdef0123456789abcdef01234567",
    );
    expect(text).toContain(
      "- **Base commit:** 0f12ab34cd56ef7890abcdef1234567890abcdef",
    );
    expect(text).toContain("- **Branch:** fix/macos-dock-icon-safe-area");
    expect(text).toContain("- **Pull request:** none at review time");
    expect(text).toContain("- **Reviewer:** OpenAI · gpt-5.6-sol");
    expect(text).toContain("### 1. [P1] Pad the icon to Apple's template");
    expect(text).toContain("### 2. [P2] Keep the legacy icns out of the bundle");
    // A rich-text target pastes the rendered structure rather than the source.
    expect(html).toContain("<h1>Review changes against origin/main</h1>");
  });

  it("copies one finding stamped with the commit it was found on", async () => {
    const { copyRichText } = renderCopyable();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Copy finding: Keep the legacy icns out of the bundle",
      }),
    );

    await waitFor(() => {
      expect(copyRichText).toHaveBeenCalledTimes(1);
    });
    const { text } = copyRichText.mock.calls[0]?.[0] as { text: string };
    expect(text).toContain("### [P2] Keep the legacy icns out of the bundle");
    expect(text).toContain("`apps/desktop/electron-builder.yml:41`");
    expect(text).toContain(
      "_Review changes against origin/main · PwrAgent ·"
        + " fix/macos-dock-icon-safe-area @ 489d16ff09_",
    );
    // One finding, not the card it came from.
    expect(text).not.toContain("Pad the icon to Apple's template");
    expect(text).not.toContain("## What was reviewed");
  });

  it("gives every finding its own control", () => {
    renderCopyable();

    expect(
      screen.getAllByRole("button", { name: /^Copy finding: / }),
    ).toHaveLength(2);
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
