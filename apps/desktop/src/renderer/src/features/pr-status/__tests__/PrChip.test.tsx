import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrSummary } from "@pwragent/shared";
import { TOOLTIP_HOVER_DELAY_MS } from "../../../lib/useViewportTooltip";
import { PrChip } from "../PrChip";
import { pullRequestCopyTargets } from "../PrChipContextMenu";

const copyText = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../../../lib/copy-text", () => ({ copyText }));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  copyText.mockClear();
});

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
  it("is a non-draggable atomic control", () => {
    const chip = renderChip(basePr());
    expect(chip).toHaveAttribute("draggable", "false");
    expect(chip).toHaveAttribute("aria-haspopup", "menu");
  });

  it("replaces the browser selection menu with PR copy actions", () => {
    const fullUrl =
      "https://github.com/pwrdrvr/PwrAgent/pull/743#discussion_r1234";
    const chip = renderChip(basePr({ url: fullUrl }));
    const contextMenuEvent = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 120,
      clientY: 80,
    });

    fireEvent(chip, contextMenuEvent);

    expect(contextMenuEvent.defaultPrevented).toBe(true);
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.getByRole("menuitem", {
      name: "Copy Full Comment URL",
    })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", {
      name: "Copy Pull Request URL",
    })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", {
      name: "Copy Pull Request Number",
    })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", {
      name: "Copy Repository URL",
    })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("menuitem", {
      name: "Copy Full Comment URL",
    }));
    expect(copyText).toHaveBeenCalledWith(fullUrl);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("derives canonical copy values for deep pull request links", () => {
    expect(pullRequestCopyTargets(basePr({
      url: "https://github.com/pwrdrvr/PwrAgent/pull/743/files?diff=split",
    }))).toEqual([
      {
        label: "Copy Full Code Review URL",
        copyValue: "https://github.com/pwrdrvr/PwrAgent/pull/743/files?diff=split",
      },
      {
        label: "Copy Pull Request URL",
        copyValue: "https://github.com/pwrdrvr/PwrAgent/pull/743",
        separated: true,
      },
      {
        label: "Copy Pull Request Number",
        copyValue: "743",
      },
      {
        label: "Copy Repository URL",
        copyValue: "https://github.com/pwrdrvr/PwrAgent",
      },
    ]);
  });

  it("ignores marker-like owner and repository names when deriving PR URLs", () => {
    expect(pullRequestCopyTargets(basePr({
      org: "pull",
      repo: "merge_requests",
      url: "https://github.com/pull/merge_requests/pull/743/files?diff=split",
    }))).toEqual([
      {
        label: "Copy Full Code Review URL",
        copyValue: "https://github.com/pull/merge_requests/pull/743/files?diff=split",
      },
      {
        label: "Copy Pull Request URL",
        copyValue: "https://github.com/pull/merge_requests/pull/743",
        separated: true,
      },
      {
        label: "Copy Pull Request Number",
        copyValue: "743",
      },
      {
        label: "Copy Repository URL",
        copyValue: "https://github.com/pull/merge_requests",
      },
    ]);
  });

  it("colors the dot by check state with no draft affordance for a ready PR", () => {
    const chip = renderChip(basePr({ checkState: "passing" }));
    expect(chip).toHaveClass("pr-chip--passing");
    expect(chip).not.toHaveClass("pr-chip--draft");
    expect(chip).not.toHaveClass("pr-chip--conflicting");
    expect(chip.querySelector(".pr-chip__draft-bar")).toBeNull();
    expect(chip).toHaveAttribute("aria-label", expect.stringContaining("checks passing"));
  });

  it("pulses only a failed-check dot while sibling checks are still running", () => {
    const chip = renderChip(basePr({
      state: "failing",
      checkState: "failing",
      checksStillRunning: true,
    }));

    expect(chip).toHaveClass("pr-chip--failing");
    expect(chip).toHaveClass("pr-chip--checks-running");
    expect(chip).toHaveAttribute(
      "aria-label",
      expect.stringContaining("checks failing · checks still running"),
    );
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

  it("opens a structured status card on hover", () => {
    vi.useFakeTimers();
    const chip = renderChip(basePr({
      title: "fix(desktop): honor selected review project cwd",
      additions: 38,
      deletions: 1204,
      changedFiles: 44,
      commitCount: 23,
      createdAt: Date.now() - (21 * 24 * 60 * 60 * 1000),
    }));

    fireEvent.mouseEnter(chip);
    act(() => vi.advanceTimersByTime(TOOLTIP_HOVER_DELAY_MS));

    const card = document.querySelector(".pr-status-card") as HTMLElement;
    expect(card).not.toBeNull();
    expect(card).toHaveAttribute("role", "tooltip");
    expect(card.textContent).toContain("fix(desktop): honor selected review project cwd");
    expect(card.textContent).toContain("pwrdrvr/PwrAgent#743");
    expect(card.textContent).toContain("+38");
    expect(card.textContent).toContain("1,204");
    expect(card.textContent).toContain("44 files");
    expect(card.textContent).toContain("23 commits");
    expect(card.textContent).toContain("21d ago");

    fireEvent.mouseLeave(chip);
    expect(document.querySelector(".pr-status-card")).toBeNull();
  });

  it("mounts no card at all until the chip is hovered", () => {
    vi.useFakeTimers();
    // A sidebar renders hundreds of these. The card element is built on every
    // render but must stay an inert object — nothing in the document — until
    // `show` hands it to the portal.
    const chip = renderChip(basePr({
      additions: 412,
      deletions: 198,
      changedFiles: 18,
      commitCount: 7,
    }));
    expect(document.querySelector(".pr-status-card")).toBeNull();

    fireEvent.mouseEnter(chip);
    act(() => vi.advanceTimersByTime(TOOLTIP_HOVER_DELAY_MS));
    expect(document.querySelector(".pr-status-card")).not.toBeNull();

    fireEvent.mouseLeave(chip);
    expect(document.querySelector(".pr-status-card")).toBeNull();
  });

  it("describes the chip with the card rather than inflating its name", () => {
    // The numbers are a description, not this control's identity: a name
    // carrying them makes every chip in a list read like a paragraph. The
    // portal lives outside the chip's subtree, so the id reference is what
    // makes the card audible at all.
    const chip = renderChip(basePr({ additions: 412, deletions: 198 }));

    expect(chip).toHaveAttribute(
      "aria-label",
      "Open pwrdrvr/PwrAgent#743 (ready for review · checks passing) in browser",
    );
    // Nothing to point at while hidden — a dangling reference is worse than none.
    expect(chip).not.toHaveAttribute("aria-describedby");

    fireEvent.focus(chip);

    const describedBy = chip.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    const card = document.getElementById(describedBy!);
    expect(card).toHaveClass("pr-status-card");
    expect(card?.textContent).toContain("412");

    fireEvent.blur(chip);
    expect(chip).not.toHaveAttribute("aria-describedby");
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
