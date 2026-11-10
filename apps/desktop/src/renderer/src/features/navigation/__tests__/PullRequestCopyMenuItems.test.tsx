import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NavigationThreadSummary, PrSummary } from "@pwragent/shared";
import { resolvePrRollup } from "../../pr-status/pr-rollup";
import { PR_COPY_MENU_LIMIT, PullRequestCopyMenuItems } from "../PullRequestCopyMenuItems";

afterEach(cleanup);

function pr(number: number, overrides: Partial<PrSummary> = {}): PrSummary {
  return {
    provider: "github.com",
    number,
    org: "acme",
    repo: "orbit",
    title: `Change ${number}`,
    url: `https://github.com/acme/orbit/pull/${number}`,
    state: "passing",
    checkState: "passing",
    lifecycleState: "open",
    createdAt: 1_000 + number,
    ...overrides,
  };
}

const thread: NavigationThreadSummary = {
  id: "thread-copy",
  source: "codex",
  title: "Copy PR URLs",
  titleSource: "explicit",
  updatedAt: 1,
  inbox: { inInbox: false },
  linkedDirectories: [],
  gitOriginUrl: "git@github.com:acme/orbit.git",
};

function renderMenu(prs: PrSummary[]) {
  const onCopy = vi.fn();
  render(
    <div role="menu">
      <PullRequestCopyMenuItems thread={thread} prs={prs} onCopy={onCopy} />
    </div>,
  );
  return onCopy;
}

describe("PullRequestCopyMenuItems", () => {
  it("copies a lone PR's URL from a plain item", () => {
    const onCopy = renderMenu([pr(7)]);
    const item = screen.getByRole("menuitem", { name: "Copy Pull Request URL" });
    expect(item).not.toHaveAttribute("aria-haspopup");
    fireEvent.click(item);
    expect(onCopy).toHaveBeenCalledExactlyOnceWith(pr(7).url);
  });

  it("lists several PRs in the PR list's order, each copying its own URL", () => {
    const prs = [
      pr(1, { lifecycleState: "merged", state: "merged", mergedAt: 5_000 }),
      pr(2),
      pr(3, { org: "elsewhere", url: "https://github.com/elsewhere/orbit/pull/3" }),
    ];
    const onCopy = renderMenu(prs);
    fireEvent.click(screen.getByRole("menuitem", { name: /Copy Pull Request URL/ }));
    const flyout = screen.getByRole("menu", { name: "3 pull requests" });
    const items = within(flyout).getAllByRole("menuitem");
    const ordered = resolvePrRollup(prs)!.ordered;
    expect(items.slice(0, -1).map((item) => item.getAttribute("title")))
      .toEqual(ordered.map((entry) => entry.url));
    // A PR from another repository names it, as its chip does.
    expect(within(flyout).getByText("elsewhere/orbit#3")).toBeInTheDocument();
    fireEvent.click(items[1]!);
    expect(onCopy).toHaveBeenCalledExactlyOnceWith(ordered[1]!.url);
  });

  it("stops at the limit and copies every URL from Copy All", () => {
    const prs = Array.from({ length: PR_COPY_MENU_LIMIT + 2 }, (_, index) => pr(index + 1));
    const onCopy = renderMenu(prs);
    fireEvent.click(screen.getByRole("menuitem", { name: /Copy Pull Request URL/ }));
    const flyout = screen.getByRole("menu", { name: `${prs.length} pull requests` });
    const items = within(flyout).getAllByRole("menuitem");
    expect(items).toHaveLength(PR_COPY_MENU_LIMIT + 1);
    const copyAll = within(flyout).getByRole("menuitem", { name: `Copy All ${prs.length} URLs` });
    fireEvent.click(copyAll);
    expect(onCopy).toHaveBeenCalledExactlyOnceWith(
      resolvePrRollup(prs)!.ordered.map((entry) => entry.url).join("\n"),
    );
  });

  it("draws nothing without PRs", () => {
    renderMenu([]);
    expect(screen.queryByRole("menuitem")).toBeNull();
  });
});
