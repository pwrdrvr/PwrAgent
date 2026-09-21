import type { AppServerReviewOutput } from "@pwragent/shared";
import { describe, expect, it } from "vitest";
import {
  formatReviewOutputText,
  withoutRedundantPriorityTag,
} from "../review-output";

type Finding = AppServerReviewOutput["findings"][number];

function finding(title: string, priority?: number): Finding {
  return {
    title,
    body: "The durable record is written after the function returns.",
    confidence_score: 0.9,
    ...(priority === undefined ? {} : { priority }),
    code_location: {
      absolute_file_path: "/repo/src/registry.ts",
      line_range: { start: 17646, end: 17657 },
    },
  };
}

describe("withoutRedundantPriorityTag", () => {
  it("drops a leading tag that repeats the finding's priority", () => {
    expect(withoutRedundantPriorityTag(finding("[P2] Persist provenance", 2)))
      .toMatchObject({ title: "Persist provenance", priority: 2 });
    expect(withoutRedundantPriorityTag(finding(" [p2]  Persist provenance", 2)).title)
      .toBe("Persist provenance");
  });

  it("takes the tag as the priority when the finding has none", () => {
    expect(withoutRedundantPriorityTag(finding("[P0] Data loss on retry")))
      .toMatchObject({ title: "Data loss on retry", priority: 0 });
  });

  it("leaves a tag that contradicts the field, and a title that is only a tag", () => {
    const contradicting = finding("[P1] Persist provenance", 3);
    expect(withoutRedundantPriorityTag(contradicting)).toBe(contradicting);
    const tagOnly = finding("[P2]", 2);
    expect(withoutRedundantPriorityTag(tagOnly)).toBe(tagOnly);
  });

  it("returns an untagged finding unchanged", () => {
    const plain = finding("Persist provenance", 2);
    expect(withoutRedundantPriorityTag(plain)).toBe(plain);
    const midTitle = finding("Handle the [P2] marker in titles", 2);
    expect(withoutRedundantPriorityTag(midTitle)).toBe(midTitle);
  });
});

describe("formatReviewOutputText", () => {
  it("prints a finding's priority once when the reviewer also typed it into the title", () => {
    const text = formatReviewOutputText({
      findings: [finding("[P2] Persist provenance", 2)],
      overall_correctness: "patch is incorrect",
      overall_explanation: "One regression.",
    });

    expect(text).toContain("- [P2] Persist provenance (/repo/src/registry.ts:17646-17657)");
    expect(text).not.toContain("[P2] [P2]");
  });
});
