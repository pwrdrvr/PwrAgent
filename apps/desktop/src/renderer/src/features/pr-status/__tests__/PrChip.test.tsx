import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrSummary } from "@pwragent/shared";
import { PrChip } from "../PrChip";

afterEach(cleanup);

// New-shape row (post #734): `state` stays check-only while review / lifecycle
// / merge dimensions ride on their own fields. The chip layers draft + conflict
// affordances on top of the check-state dot.
function basePr(overrides: Partial<PrSummary> = {}): PrSummary {
  return {
    provider: "github.com",
    number: 743,
    org: "pwrdrvr",
    repo: "PwrAgent",
    state: "passing",
    checkState: "passing",
    lifecycleState: "open",
    reviewState: "ready_for_review",
    mergeState: "mergeable",
    url: "https://github.com/pwrdrvr/PwrAgent/pull/743",
    ...overrides,
  };
}

function renderChip(pr: PrSummary, opts: { withStatusPills?: boolean } = {}) {
  const { container } = render(
    <PrChip
      pr={pr}
      showRepoPrefix={false}
      onOpen={vi.fn()}
      withStatusPills={opts.withStatusPills}
    />,
  );
  return container.querySelector(".pr-chip") as HTMLElement;
}

describe("PrChip", () => {
  it("colors the dot by check state with no draft affordance for a ready PR", () => {
    const chip = renderChip(basePr({ checkState: "passing" }));
    expect(chip).toHaveClass("pr-chip--passing");
    expect(chip).not.toHaveClass("pr-chip--draft");
    expect(chip).not.toHaveClass("pr-chip--conflicting");
    expect(chip.querySelector(".pr-chip__draft-bar")).toBeNull();
    expect(chip).toHaveAttribute("aria-label", expect.stringContaining("checks passing"));
  });

  it("keeps the check-state dot color and adds a bar for an open draft", () => {
    const chip = renderChip(
      basePr({ reviewState: "draft", checkState: "passing" }),
    );
    // Dot color still reflects checks; draft is a separate affordance.
    expect(chip).toHaveClass("pr-chip--passing");
    expect(chip).toHaveClass("pr-chip--draft");
    expect(chip.querySelector(".pr-chip__draft-bar")).not.toBeNull();
    expect(chip).toHaveAttribute("aria-label", expect.stringContaining("draft · checks passing"));
  });

  it("recolors the dot red and labels the conflict for a conflicting PR", () => {
    const chip = renderChip(basePr({ mergeState: "conflicting" }));
    expect(chip).toHaveClass("pr-chip--conflicting");
    expect(chip).toHaveAttribute("aria-label", expect.stringContaining("merge conflict"));
  });

  it("renders a closed PR distinctly and without a draft affordance", () => {
    // A PR closed while still a draft must NOT show the draft bar — the bar is
    // gated on an OPEN lifecycle.
    const chip = renderChip(
      basePr({ lifecycleState: "closed", reviewState: "draft" }),
    );
    expect(chip).toHaveClass("pr-chip--closed");
    expect(chip).not.toHaveClass("pr-chip--draft");
    expect(chip.querySelector(".pr-chip__draft-bar")).toBeNull();
    expect(chip).toHaveAttribute("aria-label", expect.stringContaining("closed without merge"));
  });

  it("opens a structured card and keeps it unmounted while hidden", () => {
    const chip = renderChip(basePr({
      title: "fix(desktop): honor selected review project cwd",
      additions: 38,
      deletions: 1204,
      changedFiles: 44,
      commitCount: 23,
      createdAt: Date.now() - (21 * 24 * 60 * 60 * 1000),
    }));
    expect(document.querySelector(".pr-status-card")).toBeNull();

    fireEvent.mouseEnter(chip);
    const card = document.querySelector(".pr-status-card") as HTMLElement;
    expect(card).toHaveAttribute("role", "tooltip");
    expect(card.textContent).toContain("fix(desktop): honor selected review project cwd");
    expect(card.textContent).toContain("+38");
    expect(card.textContent).toContain("1,204");
    expect(card.textContent).toContain("44 files");
    expect(card.textContent).toContain("23 commits");
    expect(card.textContent).toContain("21d ago");

    fireEvent.mouseLeave(chip);
    expect(document.querySelector(".pr-status-card")).toBeNull();
  });

  it("links the visible card with aria-describedby", () => {
    const chip = renderChip(basePr({ additions: 412, deletions: 198 }));
    expect(chip).not.toHaveAttribute("aria-describedby");

    fireEvent.mouseEnter(chip);
    const describedBy = chip.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)).toHaveClass("pr-status-card");

    fireEvent.mouseLeave(chip);
    expect(chip).not.toHaveAttribute("aria-describedby");
  });

  it("refreshes an open card when its head branch changes", () => {
    const onOpen = vi.fn();
    const { container, rerender } = render(
      <PrChip
        pr={basePr({ headRefName: "agent/backport-pr-status-card" })}
        showRepoPrefix={false}
        onOpen={onOpen}
      />,
    );
    const chip = container.querySelector(".pr-chip") as HTMLElement;
    fireEvent.mouseEnter(chip);
    expect(document.querySelector(".pr-status-card__branch-full"))
      .toHaveTextContent("agent/backport-pr-status-card");

    rerender(
      <PrChip
        pr={basePr({ headRefName: "agent/backport-pr-status-card-v2" })}
        showRepoPrefix={false}
        onOpen={onOpen}
      />,
    );

    expect(document.querySelector(".pr-status-card__branch-full"))
      .toHaveTextContent("agent/backport-pr-status-card-v2");
  });

  it("defers draft + conflict to sibling pills when withStatusPills is set", () => {
    // In the Pull Requests card the chip sits next to explicit pills, so the
    // dot must stay the check-state color (agreeing with the "Checks …" pill)
    // and drop the draft bar — no competing inline status.
    const pr = basePr({
      reviewState: "draft",
      mergeState: "conflicting",
      checkState: "passing",
    });

    const standalone = renderChip(pr);
    expect(standalone).toHaveClass("pr-chip--draft");
    expect(standalone).toHaveClass("pr-chip--conflicting");
    expect(standalone.querySelector(".pr-chip__draft-bar")).not.toBeNull();

    cleanup();

    const withPills = renderChip(pr, { withStatusPills: true });
    expect(withPills).toHaveClass("pr-chip--passing");
    expect(withPills).not.toHaveClass("pr-chip--draft");
    expect(withPills).not.toHaveClass("pr-chip--conflicting");
    expect(withPills.querySelector(".pr-chip__draft-bar")).toBeNull();
    // The accessible name still reports the full status for screen readers.
    expect(withPills).toHaveAttribute("aria-label", expect.stringContaining("draft · merge conflict"));
  });
});
