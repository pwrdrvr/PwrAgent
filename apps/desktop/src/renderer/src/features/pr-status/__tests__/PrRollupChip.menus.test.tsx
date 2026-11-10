import "@testing-library/jest-dom/vitest";
import fc from "fast-check";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrSummary } from "@pwragent/shared";
import { TOOLTIP_HOVER_DELAY_MS } from "../../../lib/useViewportTooltip";
import { HOVER_TRANSITION_GRACE_MS } from "../../../lib/useHoverTransitionGrace";
import { PrRollupChip } from "../PrRollupChip";

afterEach(() => {
  cleanup();
  document.querySelectorAll(".thread-context-menu").forEach((menu) => menu.remove());
  vi.useRealTimers();
});

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
    reviewState: "ready_for_review",
    mergeState: "mergeable",
    ...overrides,
  };
}

const newest = pr(10, { createdAt: 3_000 });
const failing = pr(11, { checkState: "failing", state: "failing", createdAt: 1_000 });
const merged = pr(12, { lifecycleState: "merged", state: "merged", mergedAt: 2_000 });

/** Stands in for the sidebar's PR menu, which renders outside the list. */
function mountMenu(): HTMLElement {
  const menu = document.createElement("div");
  menu.className = "thread-context-menu";
  menu.tabIndex = -1;
  document.body.append(menu);
  return menu;
}

function renderInRow(props: Partial<Parameters<typeof PrRollupChip>[0]> = {}) {
  // The thread row's own right-click opens the thread menu.
  const onRowContextMenu = vi.fn();
  const onOpenContextMenu = vi.fn();
  const onDetachAll = vi.fn();
  render(
    <div onContextMenu={onRowContextMenu}>
      <PrRollupChip
        prs={[newest, failing]}
        repoPrefixedUrls=""
        threadTitle="Orbit refactor"
        onOpen={vi.fn()}
        onOpenContextMenu={onOpenContextMenu}
        onDetach={vi.fn()}
        onDetachAll={onDetachAll}
        {...props}
      />
    </div>,
  );
  return { onRowContextMenu, onOpenContextMenu, onDetachAll };
}

const list = (): HTMLElement => screen.getByRole("group", { name: "Pull requests for Orbit refactor" });

describe("PrRollupChip right-click in the list", () => {
  it("opens that PR's menu, keeps the list, and never reaches the thread row", () => {
    const { onRowContextMenu, onOpenContextMenu } = renderInRow();
    fireEvent.click(screen.getByRole("button", { name: /2 pull requests/ }));
    const rows = within(list()).getAllByRole("listitem");

    fireEvent.contextMenu(rows[1]!, { clientX: 40, clientY: 60 });

    expect(onRowContextMenu).not.toHaveBeenCalled();
    expect(onOpenContextMenu).toHaveBeenCalledExactlyOnceWith(
      failing,
      expect.objectContaining({ x: 40, y: 60 }),
    );
    expect(list()).toBeInTheDocument();
    expect(rows[1]).toHaveClass("is-menu-target");
  });

  it("keeps a hover-opened list once a row's menu opens", () => {
    vi.useFakeTimers();
    renderInRow();
    const chip = screen.getByRole("button", { name: /2 pull requests/ });
    fireEvent.mouseEnter(chip);
    act(() => { vi.advanceTimersByTime(TOOLTIP_HOVER_DELAY_MS); });
    fireEvent.contextMenu(within(list()).getAllByRole("listitem")[0]!);
    // The pointer moves off the list to the menu.
    fireEvent.mouseLeave(list());
    act(() => { vi.advanceTimersByTime(HOVER_TRANSITION_GRACE_MS * 2); });
    expect(list()).toBeInTheDocument();
  });

  it("stays open through a menu choice and drops the outline when focus returns", () => {
    renderInRow();
    fireEvent.click(screen.getByRole("button", { name: /2 pull requests/ }));
    const row = within(list()).getAllByRole("listitem")[0]!;
    fireEvent.contextMenu(row);
    const menu = mountMenu();
    act(() => menu.focus());

    fireEvent.pointerDown(menu);
    expect(list()).toBeInTheDocument();
    expect(row).toHaveClass("is-menu-target");

    // The menu closes and hands focus back to the row it opened from.
    menu.remove();
    act(() => within(row).getByRole("button").focus());
    expect(row).not.toHaveClass("is-menu-target");
    expect(list()).toBeInTheDocument();
  });

  it("opens no menu from the heading or footer", () => {
    const { onRowContextMenu, onOpenContextMenu } = renderInRow();
    fireEvent.click(screen.getByRole("button", { name: /2 pull requests/ }));
    fireEvent.contextMenu(within(list()).getByText("2 pull requests"));
    fireEvent.contextMenu(within(list()).getByRole("button", { name: "Detach all" }));
    expect(onRowContextMenu).not.toHaveBeenCalled();
    expect(onOpenContextMenu).not.toHaveBeenCalled();
  });
});

describe("PrRollupChip right-click rule", () => {
  /**
   * For any list and any row: the right-click opens that row's PR menu, never
   * the thread row's, keeps the list open, and outlines that row alone.
   */
  it("opens the clicked row's menu for every list size and row", () => {
    fc.assert(fc.property(
      fc.integer({ min: 2, max: 8 }).chain((count) =>
        fc.tuple(fc.constant(count), fc.nat(count - 1), fc.constantFrom<"open" | "merged">("open", "merged"))),
      ([count, index, lifecycle]) => {
        const prs = Array.from({ length: count }, (_, i) => pr(20 + i, {
          createdAt: 1_000 + i,
          ...(lifecycle === "merged" && i % 2 === 1
            ? { lifecycleState: "merged" as const, state: "merged" as const, mergedAt: 5_000 + i }
            : {}),
        }));
        const { onRowContextMenu, onOpenContextMenu } = renderInRow({ prs });
        try {
          fireEvent.click(screen.getByRole("button", { name: /pull requests/ }));
          const rows = within(list()).getAllByRole("listitem");
          expect(rows).toHaveLength(count);
          fireEvent.contextMenu(rows[index]!);
          expect(onRowContextMenu).not.toHaveBeenCalled();
          expect(onOpenContextMenu).toHaveBeenCalledOnce();
          const target = onOpenContextMenu.mock.calls[0]![0] as PrSummary;
          // The menu is for the PR the clicked row shows.
          expect(within(rows[index]!).getByRole("button").getAttribute("aria-label"))
            .toContain(`#${target.number}`);
          expect(list()).toBeInTheDocument();
          expect(rows.filter((row) => row.classList.contains("is-menu-target"))).toEqual([rows[index]]);
        } finally {
          cleanup();
        }
      },
    ), { numRuns: 40 });
  });

  it("shows no card when the menu hands focus back to its row", () => {
    renderInRow();
    fireEvent.click(screen.getByRole("button", { name: /2 pull requests/ }));
    const row = within(list()).getAllByRole("listitem")[0]!;
    fireEvent.contextMenu(row);
    const menu = mountMenu();
    act(() => menu.focus());
    menu.remove();
    act(() => within(row).getByRole("button").focus());
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});

describe("PrRollupChip overflow variant", () => {
  it("counts and wears the state of the PRs the lead chip leaves out", () => {
    renderInRow({ prs: [newest, failing, merged], variant: "overflow" });
    // Two open PRs: the lead is the newest one, #10, drawn beside this chip.
    const chip = screen.getByRole("button", { name: /^\+2 PRs: 2 more pull requests,/ });
    expect(chip).toHaveTextContent("+2 PRs");
    expect(chip).toHaveClass("pr-chip--overflow", "pr-chip--failing");
  });

  it("opens the list of every PR, with Detach all for all of them", () => {
    const { onDetachAll } = renderInRow({ prs: [newest, failing, merged], variant: "overflow" });
    fireEvent.click(screen.getByRole("button", { name: /more pull requests/ }));
    expect(within(list()).getByText("3 pull requests")).toBeInTheDocument();
    expect(within(list()).getAllByRole("listitem")).toHaveLength(3);
    fireEvent.click(within(list()).getByRole("button", { name: "Detach all" }));
    expect(onDetachAll).toHaveBeenCalledExactlyOnceWith([newest, failing, merged]);
  });

  it("names one hidden PR in the singular", () => {
    renderInRow({ prs: [newest, merged], variant: "overflow" });
    expect(screen.getByRole("button", { name: /^\+1 PR: 1 more pull request,/ }))
      .toHaveTextContent("+1 PR");
  });

  it("draws nothing for a lone PR", () => {
    renderInRow({ prs: [newest], variant: "overflow" });
    expect(screen.queryByRole("button")).toBeNull();
  });
});
