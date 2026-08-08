import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { PrSummary } from "@pwragent/shared";
import { PrStatusCard, prStatsAccessibleSummary } from "../PrStatusCard";

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
  const { container } = render(
    <PrStatusCard pr={pr} now={NOW} withStatusPills={opts.withStatusPills} />,
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
    expect(text(container, ".pr-status-card__additions")).toBe("+412");
    expect(text(container, ".pr-status-card__deletions")).toBe("−198");
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
    expect(text(container, ".pr-status-card__additions")).toBe("+0");
  });

  it("reports lifespan and recency once a PR is terminal", () => {
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

    expect(labels).toEqual(["Open for", "Merged"]);
    expect(values).toEqual(["4d 22h", "2h ago"]);
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

describe("prStatsAccessibleSummary", () => {
  it("speaks the card's data for screen readers", () => {
    expect(prStatsAccessibleSummary(
      basePr({
        additions: 1204,
        deletions: 8,
        changedFiles: 1,
        commitCount: 1,
        createdAt: NOW - (3 * DAY),
      }),
      NOW,
    )).toBe("1,204 added, 8 removed, 1 file, 1 commit, opened 3d ago");
  });

  it("is empty when there is nothing extra to say", () => {
    expect(prStatsAccessibleSummary(basePr(), NOW)).toBe("");
  });
});
