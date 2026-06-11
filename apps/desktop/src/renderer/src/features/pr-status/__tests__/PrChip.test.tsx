import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrSummary } from "@pwragent/shared";
import { PrChip } from "../PrChip";

afterEach(cleanup);

function basePr(overrides: Partial<PrSummary> = {}): PrSummary {
  return {
    number: 743,
    org: "pwrdrvr",
    repo: "PwrAgent",
    state: "passing",
    url: "https://github.com/pwrdrvr/PwrAgent/pull/743",
    ...overrides,
  };
}

function renderChip(pr: PrSummary) {
  const { container } = render(
    <PrChip pr={pr} showRepoPrefix={false} onOpen={vi.fn()} />,
  );
  return container.querySelector(".pr-chip") as HTMLElement;
}

describe("PrChip", () => {
  it("colors the dot by check status and renders no draft affordance when not a draft", () => {
    const chip = renderChip(basePr({ state: "passing" }));
    expect(chip).toHaveClass("pr-chip--passing");
    expect(chip).not.toHaveClass("pr-chip--draft");
    expect(chip.querySelector(".pr-chip__draft-bar")).toBeNull();
    expect(chip).toHaveAttribute("title", expect.stringContaining("all checks passing"));
  });

  it("treats draft as orthogonal — dot keeps the status color, plus a draft bar", () => {
    // An OPEN draft whose checks pass: green dot (passing) AND the draft bar.
    const chip = renderChip(basePr({ state: "passing", isDraft: true }));
    expect(chip).toHaveClass("pr-chip--passing");
    expect(chip).toHaveClass("pr-chip--draft");
    expect(chip.querySelector(".pr-chip__draft-bar")).not.toBeNull();
    // Tooltip surfaces both the draft and the underlying check status.
    expect(chip).toHaveAttribute("title", expect.stringContaining("draft · all checks passing"));
  });

  it("collapses an unknown-status draft tooltip to just 'draft'", () => {
    const chip = renderChip(basePr({ state: "unknown", isDraft: true }));
    expect(chip).toHaveClass("pr-chip--draft");
    const title = chip.getAttribute("title") ?? "";
    expect(title).toContain("— draft");
    expect(title).not.toContain("status unknown");
  });

  it("labels a conflicted PR as a merge conflict", () => {
    const chip = renderChip(basePr({ state: "conflicted" }));
    expect(chip).toHaveClass("pr-chip--conflicted");
    expect(chip).toHaveAttribute("title", expect.stringContaining("merge conflict"));
  });

  it("labels a closed-without-merge PR distinctly from unknown", () => {
    const chip = renderChip(basePr({ state: "closed" }));
    expect(chip).toHaveClass("pr-chip--closed");
    expect(chip).toHaveAttribute("title", expect.stringContaining("closed without merge"));
  });
});
