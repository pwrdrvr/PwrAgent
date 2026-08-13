import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { PrSummary } from "@pwragent/shared";
import { PrStatusCard } from "../PrStatusCard";

afterEach(cleanup);

const NOW = Date.parse("2026-08-08T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

function basePr(overrides: Partial<PrSummary> = {}): PrSummary {
  return {
    provider: "github.com",
    number: 1372,
    org: "pwrdrvr",
    repo: "PwrAgent",
    title: "refactor(agent-core): remove legacy backend",
    state: "pending",
    checkState: "pending",
    lifecycleState: "open",
    reviewState: "draft",
    mergeState: "mergeable",
    url: "https://github.com/pwrdrvr/PwrAgent/pull/1372",
    ...overrides,
  };
}

function renderCard(pr: PrSummary, withStatusPills = false) {
  const { container } = render(
    <div className="pr-status-card">
      <PrStatusCard pr={pr} now={NOW} withStatusPills={withStatusPills} />
    </div>,
  );
  return container;
}

function text(container: HTMLElement, selector: string): string | undefined {
  return container.querySelector(selector)?.textContent ?? undefined;
}

describe("PrStatusCard", () => {
  it("renders changes, commits, and opened age", () => {
    const container = renderCard(basePr({
      additions: 412,
      deletions: 198,
      changedFiles: 18,
      commitCount: 7,
      createdAt: NOW - (8 * DAY) - (4 * 60 * 60 * 1000),
    }));

    expect(container.querySelector(".diff-stat__added")).toHaveTextContent("+412");
    expect(container.querySelector(".diff-stat__removed")).toHaveTextContent("-198");
    expect(container.querySelector(".pr-status-card__files")).toHaveTextContent("18 files");
    expect(container.querySelector(".pr-status-card__caption")).toHaveTextContent("7 commits");
    expect(container.querySelector(".pr-status-card__row-value")).toHaveTextContent("8d 4h ago");
  });

  it("splits the diff meter proportionally and keeps a small segment visible", () => {
    const proportional = renderCard(basePr({ additions: 300, deletions: 100 }));
    expect(
      proportional.querySelector<HTMLElement>(".pr-status-card__diff-fill--additions")
        ?.style.width,
    ).toBe("75%");

    cleanup();
    const lopsided = renderCard(basePr({ additions: 2, deletions: 900 }));
    expect(
      lopsided.querySelector<HTMLElement>(".pr-status-card__diff-fill--additions")
        ?.style.width,
    ).toBe("2%");
  });

  it("shows opened and terminal events with one timeline grammar", () => {
    const container = renderCard(basePr({
      state: "merged",
      lifecycleState: "merged",
      createdAt: NOW - (5 * DAY),
      mergedAt: NOW - (2 * 60 * 60 * 1000),
    }));
    expect(
      [...container.querySelectorAll(".pr-status-card__row-label")]
        .map((node) => node.textContent),
    ).toEqual(["Opened", "Merged"]);
    expect(
      [...container.querySelectorAll(".pr-status-card__row-value")]
        .map((node) => node.textContent),
    ).toEqual(["5d ago", "2h ago"]);
  });

  it("omits unknown and malformed optional sections", () => {
    const missing = renderCard(basePr());
    expect(missing.querySelector(".pr-status-card__section")).toBeNull();

    cleanup();
    const malformed = renderCard(basePr({
      additions: -5,
      deletions: Number.NaN,
      changedFiles: Number.POSITIVE_INFINITY,
      commitCount: -1,
      createdAt: 0,
    }));
    expect(malformed.querySelector(".pr-status-card__section")).toBeNull();
  });

  it("uses the chip's conflict and status-pill dot rules", () => {
    const conflicting = renderCard(basePr({ mergeState: "conflicting" }));
    expect(conflicting.querySelector(".pr-status-card__dot--conflicting")).not.toBeNull();

    cleanup();
    const withPills = renderCard(basePr({ mergeState: "conflicting" }), true);
    expect(withPills.querySelector(".pr-status-card__dot--pending")).not.toBeNull();
  });
});

describe("PrStatusCard branch", () => {
  it("exposes the branch to assistive tech as one unbroken string", () => {
    // Flex items are blockified, so the two visual halves surface as SEPARATE
    // accessibility nodes and get announced as two branch names. Asserting
    // `textContent` on the row would not catch that — it concatenates whatever
    // spans exist regardless of box structure. What has to hold is that the
    // split is hidden and exactly one node carries the whole name.
    const container = renderCard(basePr({
      headRefName: "claude/agent/backport-pr-status-hover-1.0",
    }));

    expect(container.querySelector(".pr-status-card__branch-name"))
      .toHaveAttribute("aria-hidden", "true");
    expect(text(container, ".pr-status-card__branch-full"))
      .toBe("claude/agent/backport-pr-status-hover-1.0");
  });

  it("splits so the ellipsis falls in the middle, not at either end", () => {
    // Branches on one thread share a prefix and often a suffix convention, so
    // the discriminating characters live at both ends. The head span is the
    // only one CSS lets shrink, which is what puts the ellipsis between them.
    const container = renderCard(basePr({
      headRefName: "claude/agent/backport-pr-status-hover-1.0",
    }));

    expect(text(container, ".pr-status-card__branch-head"))
      .toBe("claude/agent/backport-pr-stat");
    expect(text(container, ".pr-status-card__branch-tail")).toBe("us-hover-1.0");
  });

  it("never hands the non-truncating tail more than half a short name", () => {
    // The tail is `flex: 0 0 auto` — it cannot shrink, so a fixed 12 characters
    // on a short branch would leave nothing for the head to give up.
    const container = renderCard(basePr({ headRefName: "main" }));

    expect(text(container, ".pr-status-card__branch-head")).toBe("ma");
    expect(text(container, ".pr-status-card__branch-tail")).toBe("in");
  });

  it("splits on grapheme clusters, not code points", () => {
    // macOS normalizes filenames to NFD and a loose git ref IS a file, so this
    // name really does arrive with `a` + a separate U+0300. A code-point split
    // lands between them: the head loses the accent (`déja`) and the tail opens
    // with a bare combining mark that renders on the ellipsis.
    const container = renderCard(basePr({
      headRefName: "chore/déjà-vu-dedupe".normalize("NFD"),
    }));

    expect(text(container, ".pr-status-card__branch-head"))
      .toBe("chore/déjà".normalize("NFD"));
    expect(text(container, ".pr-status-card__branch-tail")).toBe("-vu-dedupe");

    cleanup();

    // Same tear, ZWJ flavor: a code-point split leaves the tail leading with a
    // zero-width joiner and the head holding a lone body part.
    const zwj = renderCard(basePr({ headRefName: "fix/family-👨‍👩‍👧-avatar" }));

    expect(text(zwj, ".pr-status-card__branch-head")).toBe("fix/family");
    expect(text(zwj, ".pr-status-card__branch-tail")).toBe("-👨‍👩‍👧-avatar");
  });

  it("omits the row when no provider reported a head branch", () => {
    // Same rule as every other section: absent is "not known", and the card has
    // to look finished without it.
    const container = renderCard(basePr({ headRefName: "   " }));
    expect(container.querySelector(".pr-status-card__branch")).toBeNull();

    cleanup();

    expect(
      renderCard(basePr()).querySelector(".pr-status-card__branch"),
    ).toBeNull();
  });
});
