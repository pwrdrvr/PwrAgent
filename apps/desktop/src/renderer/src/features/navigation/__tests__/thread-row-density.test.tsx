import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopAppearanceDensity, NavigationThreadSummary, PrSummary } from "@pwragent/shared";
import { ThreadRow } from "../ThreadRow";
import { ThreadRowDensityContext } from "../thread-row-density";

afterEach(cleanup);

function pr(number: number, overrides: Partial<PrSummary> = {}): PrSummary {
  return {
    provider: "github.com",
    number,
    org: "acme",
    repo: "orbit",
    url: `https://github.com/acme/orbit/pull/${number}`,
    state: "passing",
    checkState: "passing",
    lifecycleState: "open",
    reviewState: "ready_for_review",
    ...overrides,
  };
}

const thread: NavigationThreadSummary = {
  id: "thread-density",
  title: "Density row",
  titleSource: "explicit",
  summary: "",
  source: "codex",
  executionMode: "default",
  updatedAt: Date.now(),
  inbox: { inInbox: false },
  linkedDirectories: [],
  prs: [pr(1), pr(2, { mergeState: "conflicting" })],
};

function renderRow(density: DesktopAppearanceDensity) {
  return render(
    <ThreadRowDensityContext.Provider value={density}>
      <ThreadRow thread={thread} onOpenContextMenu={vi.fn()} onSelectThread={vi.fn()} />
    </ThreadRowDensityContext.Provider>,
  );
}

describe("ThreadRow density", () => {
  it("mounts the PR rollup on the title line only in Minimal", () => {
    for (const density of ["mission-control", "compact"] as const) {
      const { container, unmount } = renderRow(density);
      expect(container.querySelector(".thread-row__pr-rollup")).toBeNull();
      unmount();
    }
    const { container } = renderRow("minimal");
    const rollup = container.querySelector(".thread-row__header .thread-row__pr-rollup");
    expect(rollup).toHaveTextContent("2 PRs");
    expect(rollup?.querySelector("[data-pr-rollup]")).toHaveClass("pr-chip--conflicting");
    // The flow keeps its PR chips for X-ray; CSS hides them at rest.
    expect(container.querySelectorAll(".thread-row__chips [data-pr-chip]")).toHaveLength(2);
  });
});
