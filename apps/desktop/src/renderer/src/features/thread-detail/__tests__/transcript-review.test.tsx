import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
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
    expect(screen.getByText("Patch needs work")).toBeInTheDocument();
    expect(screen.getByText("1 finding")).toBeInTheDocument();
    expect(screen.getByText("87% confidence")).toBeInTheDocument();
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
