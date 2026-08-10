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
