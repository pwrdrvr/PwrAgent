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
    expect(screen.getByText("Hydrate review transcript items")).toBeInTheDocument();
    expect(screen.getByText("src/lib/useThreadSessionState.ts")).toBeInTheDocument();
    expect(screen.getByText("Lines 845-848")).toBeInTheDocument();
  });
});
