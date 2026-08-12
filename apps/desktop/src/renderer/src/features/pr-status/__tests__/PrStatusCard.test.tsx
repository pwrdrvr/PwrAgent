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
    title: "refactor(agent-core): remove legacy Grok backend",
    state: "pending",
    checkState: "pending",
    lifecycleState: "open",
    reviewState: "draft",
    mergeState: "mergeable",
    url: "https://github.com/pwrdrvr/PwrAgent/pull/1372",
    ...overrides,
  };
}

function renderCard(pr: PrSummary, opts: { withStatusPills?: boolean } = {}) {
  // Wrapped in the class the portal supplies, because the card's dot-color
  // rules are descendant selectors of `.pr-status-card` — rendering the
  // fragment bare would test a DOM the app never produces.
  const { container } = render(
    <div className="pr-status-card">
      <PrStatusCard pr={pr} now={NOW} withStatusPills={opts.withStatusPills} />
    </div>,
  );
  return container;
}

function text(container: HTMLElement, selector: string): string | undefined {
  return container.querySelector(selector)?.textContent ?? undefined;
}

describe("PrStatusCard", () => {
  it("renders the full card when every field is present", () => {
    const container = renderCard(basePr({
      additions: 412,
      deletions: 198,
      changedFiles: 18,
      commitCount: 7,
      createdAt: NOW - (8 * DAY) - (4 * 60 * 60 * 1000),
    }));

    expect(text(container, ".pr-status-card__phase")).toBe("draft");
    expect(text(container, ".pr-status-card__identity")).toBe("pwrdrvr/PwrAgent#1372");
    expect(text(container, ".pr-status-card__status")).toContain("draft · checks pending");
    // Rendered by the shared DiffStat primitive, not a card-local copy.
    expect(text(container, ".diff-stat__added")).toBe("+412");
    expect(text(container, ".diff-stat__removed")).toBe("-198");
    expect(text(container, ".pr-status-card__files")).toBe("18 files");
    expect(text(container, ".pr-status-card__caption")).toBe("7 commits");
    expect(text(container, ".pr-status-card__row-label")).toBe("Opened");
    expect(text(container, ".pr-status-card__row-value")).toBe("8d 4h ago");
  });

  it("splits the diff meter proportionally", () => {
    const container = renderCard(basePr({ additions: 300, deletions: 100 }));
    const additions = container.querySelector<HTMLElement>(
      ".pr-status-card__diff-fill--additions",
    );
    const deletions = container.querySelector<HTMLElement>(
      ".pr-status-card__diff-fill--deletions",
    );

    expect(additions?.style.width).toBe("75%");
    expect(deletions?.style.width).toBe("25%");
  });

  it("keeps a lopsided diff's smaller side visible", () => {
    // +2 / −900 is 0.2% additions; the segment floors so the bar never reads as
    // a pure single color when both sides genuinely changed.
    const container = renderCard(basePr({ additions: 2, deletions: 900 }));
    expect(
      container.querySelector<HTMLElement>(".pr-status-card__diff-fill--additions")
        ?.style.width,
    ).toBe("2%");
  });

  it("drops the meter when a PR only deletes nothing and adds nothing", () => {
    const container = renderCard(basePr({ additions: 0, deletions: 0, changedFiles: 0 }));
    expect(container.querySelector(".pr-status-card__diff-meter")).toBeNull();
    // Reported zeros are still facts, unlike absent fields, so they render.
    expect(text(container, ".diff-stat__added")).toBe("+0");
  });

  it("drops the diff line when only one half of the pair arrived", () => {
    // Additions and deletions come from one fetch; one without the other is a
    // malformed answer, not half an answer worth rendering.
    const container = renderCard(basePr({ additions: 412, changedFiles: 18 }));
    expect(container.querySelector(".diff-stat")).toBeNull();
    expect(container.querySelector(".pr-status-card__diff-meter")).toBeNull();
    // The counts that DID arrive still show.
    expect(text(container, ".pr-status-card__files")).toBe("18 files");
  });

  it("adds the terminal event in the same grammar as the opened row", () => {
    // Both rows read "<event> <duration> ago" so "Opened" means the same thing
    // before and after the PR lands. Lifespan is the difference between them.
    const container = renderCard(basePr({
      lifecycleState: "merged",
      state: "merged",
      createdAt: NOW - (5 * DAY),
      mergedAt: NOW - (2 * 60 * 60 * 1000),
    }));

    const labels = [...container.querySelectorAll(".pr-status-card__row-label")]
      .map((node) => node.textContent);
    const values = [...container.querySelectorAll(".pr-status-card__row-value")]
      .map((node) => node.textContent);

    expect(labels).toEqual(["Opened", "Merged"]);
    expect(values).toEqual(["5d ago", "2h ago"]);
  });

  it("still reports when a closed PR was opened, and vice versa", () => {
    const openedOnly = renderCard(basePr({
      lifecycleState: "closed",
      state: "closed",
      createdAt: NOW - (2 * DAY),
    }));
    expect(
      [...openedOnly.querySelectorAll(".pr-status-card__row-label")]
        .map((node) => node.textContent),
    ).toEqual(["Opened"]);

    cleanup();

    const closedOnly = renderCard(basePr({
      lifecycleState: "closed",
      state: "closed",
      closedAt: NOW - (6 * 60 * 60 * 1000),
    }));
    expect(
      [...closedOnly.querySelectorAll(".pr-status-card__row-label")]
        .map((node) => node.textContent),
    ).toEqual(["Closed"]);
  });

  it("omits sections a peer did not send rather than showing zeros", () => {
    // A federated peer on an older build, or a PR that merged before the fields
    // existed — `collectPrPollTargets` drops terminal PRs, so that row never
    // refreshes and the card must look finished without them.
    const container = renderCard(basePr({ reviewState: "ready_for_review" }));

    expect(container.querySelector(".pr-status-card__section")).toBeNull();
    expect(container.textContent).not.toContain("+0");
    expect(container.textContent).not.toContain("unknown");
    expect(text(container, ".pr-status-card__status")).toContain(
      "ready for review · checks pending",
    );
  });

  it("ignores hostile counts and timestamps from a peer", () => {
    const container = renderCard(basePr({
      additions: -5,
      deletions: Number.NaN,
      changedFiles: Number.POSITIVE_INFINITY,
      commitCount: -1,
      createdAt: 0,
    }));

    expect(container.querySelector(".pr-status-card__section")).toBeNull();
    expect(container.textContent).not.toContain("NaN");
    expect(container.textContent).not.toContain("Infinity");
  });

  it("never reports a negative age when a peer's clock runs ahead", () => {
    const container = renderCard(basePr({ createdAt: NOW + (60 * 60 * 1000) }));
    expect(text(container, ".pr-status-card__row-value")).toBe("0s ago");
  });

  it("colors the dot for merge conflict, and defers to sibling pills", () => {
    const conflicting = renderCard(basePr({ mergeState: "conflicting" }));
    expect(
      conflicting.querySelector(".pr-status-card__dot--conflicting"),
    ).not.toBeNull();

    cleanup();

    // Next to explicit status pills the chip keeps the check-state color, so
    // the card must too — a card disagreeing with its own chip looks broken.
    const withPills = renderCard(
      basePr({ mergeState: "conflicting" }),
      { withStatusPills: true },
    );
    expect(withPills.querySelector(".pr-status-card__dot--pending")).not.toBeNull();
    expect(withPills.querySelector(".pr-status-card__dot--conflicting")).toBeNull();
  });

  it("renders a never-polled PR as identity plus status, nothing more", () => {
    const container = renderCard({
      provider: "github.com",
      number: 1401,
      org: "pwrdrvr",
      repo: "PwrAgent",
      state: "unknown",
      url: "https://github.com/pwrdrvr/PwrAgent/pull/1401",
    });

    expect(text(container, ".pr-status-card__status")).toContain("status unknown");
    expect(container.querySelector(".pr-status-card__phase")).toBeNull();
    expect(container.querySelector(".pr-status-card__title")).toBeNull();
    expect(container.querySelector(".pr-status-card__section")).toBeNull();
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

describe("PrStatusCard counts", () => {
  it("groups digits and matches the noun to the count", () => {
    const plural = renderCard(basePr({ changedFiles: 1204, commitCount: 2 }));
    expect(text(plural, ".pr-status-card__files")).toBe("1,204 files");
    expect(text(plural, ".pr-status-card__caption")).toBe("2 commits");

    cleanup();

    const singular = renderCard(basePr({ changedFiles: 1, commitCount: 1 }));
    expect(text(singular, ".pr-status-card__files")).toBe("1 file");
    expect(text(singular, ".pr-status-card__caption")).toBe("1 commit");
  });
});
