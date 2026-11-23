import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import fc from "fast-check";
import { afterEach, expect, it, vi } from "vitest";
import type { NavigationThreadSummary, PrSummary } from "@pwragent/shared/contracts/navigation";
import { compactStackMembership, type StackSummary } from "@pwragent/shared/stacks/stack-status";
import { ThreadRow } from "../../navigation/ThreadRow";
import { PrChip } from "../../pr-status/PrChip";
import { PrRollupChip } from "../../pr-status/PrRollupChip";
import { PullRequestsPanel } from "../../thread-detail/context-panels/PullRequestsPanel";

afterEach(cleanup);

function fixture(height: number, newestFirst: boolean) {
  const now = Date.now();
  const prs: PrSummary[] = Array.from({ length: height }, (_, index) => ({
    provider: "github.com", org: "example", repo: "ledger", number: 10 + index,
    url: `https://github.com/example/ledger/pull/${10 + index}`,
    title: `Ledger change ${index + 1}`, state: "passing", lifecycleState: "open",
    baseRefName: index ? `ledger-${index}` : "main",
    headRefName: `ledger-${index + 1}`,
    createdAt: now - (newestFirst ? index : height - index) * 1_000,
  }));
  const stack: StackSummary = {
    key: "ledger-stack", name: "ledger-1", repository: "github.com:example/ledger", trunk: "main", inferred: true,
    layers: prs.map((pr) => ({
      branch: pr.headRefName!, parent: pr.baseRefName!, health: "in_sync", role: "holder",
      pullRequest: { number: pr.number, lifecycleState: "open" },
      thread: { key: "codex:ledger", title: "Ledger stack" },
    })),
  };
  const stacks = prs.map((_, index) => ({ stack, position: index + 1 }));
  const thread: NavigationThreadSummary = {
    id: "ledger", title: "Ledger stack", titleSource: "explicit", source: "codex",
    inbox: { inInbox: false }, linkedDirectories: [], prs, stacks,
    stackMemberships: stacks.map(({ position }) => compactStackMembership(stack, position)!),
  };
  return { prs, thread };
}

it("draws every position top first, with position one directly above trunk, on all three surfaces", () => {
  fc.assert(fc.property(fc.integer({ min: 2, max: 24 }), fc.boolean(), (height, newestFirst) => {
    const { prs, thread } = fixture(height, newestFirst);
    const top = prs.at(-1)!;
    const open = vi.fn();
    const detachAll = vi.fn();
    const view = render(
      <>
        <PrChip stackThread={thread} pr={top} onOpen={open} showRepoPrefix={false} showStackTag />
        <PrRollupChip stackThread={thread} prs={prs} onOpen={open} threadTitle={thread.title}
          repoPrefixedUrls="" onDetachAll={detachAll} />
        <PullRequestsPanel thread={thread} />
      </>,
    );
    try {
      fireEvent.click(screen.getByRole("button", { name: /^Stack position/ }));
      const popover = screen.getByRole("dialog", { name: /^Stack for/ });
      const rollupTrigger = screen.getByRole("button", { name: /^\d+ pull requests/ });
      fireEvent.click(rollupTrigger);
      const rollup = screen.getByRole("group", { name: /^Pull requests for/ });
      const rail = view.container.querySelector(".stack-rail-card")!;
      const expected = Array.from({ length: height }, (_, index) => String(height - index)).concat("main");
      for (const surface of [popover, rollup, rail]) {
        const list = surface.querySelector(".stack-display__list")!;
        expect(Array.from(list.children, (row) => row.getAttribute("data-position") ?? row.textContent)).toEqual(expected);
      }
      fireEvent.click(within(rollup).getByRole("button", { name: "Detach all" }));
      expect(detachAll).toHaveBeenCalledWith(prs.toReversed());
    } finally {
      view.unmount();
    }
  }), { numRuns: 25 });
});

it("puts stack positions only inside their PR chips, including duplicate memberships", () => {
  fc.assert(fc.property(fc.integer({ min: 2, max: 24 }), fc.boolean(), (height, duplicate) => {
    const { prs, thread } = fixture(height, false);
    // This thread holds the top PR. Repeated membership can arise when two
    // linked clones each supply a stack for the same repository and number.
    const top = prs.at(-1)!;
    const member = thread.stackMemberships!.at(-1)!;
    const view = render(<ThreadRow thread={{
      ...thread, prs: [top],
      stackMemberships: duplicate ? [member, { ...member, key: "other-clone" }] : [member],
    }} onSelectThread={vi.fn()} onOpenContextMenu={vi.fn()} />);
    try {
      const positions = within(view.container).getAllByText(`${height}/${height}`, { exact: true });
      expect(positions).toHaveLength(1);
      expect(positions[0]!.closest(".pr-chip")?.textContent ?? "").toContain(`#${top.number}`);
    } finally {
      view.unmount();
    }
  }), { numRuns: 25 });
});

it("keeps a held lead visible with its warning on the tag", () => {
  const { prs, thread } = fixture(2, false);
  const top = prs[1]!;
  const member = {
    ...thread.stackMemberships![1]!,
    heldBy: { branch: "ledger-1", number: prs[0]!.number, reason: "needs sync" as const },
  };
  const view = render(<ThreadRow thread={{ ...thread, prs: [top], stackMemberships: [member] }}
    onSelectThread={vi.fn()} onOpenContextMenu={vi.fn()} />);
  const tag = screen.getByRole("button", { name: "Stack position 2 of 2 for #11" });
  expect(tag.getAttribute("data-warning")).toBe("true");
  expect(tag.closest(".pr-chip")?.querySelector("[data-pr-url]")?.getAttribute("data-pr-url")).toBe(top.url);
  expect(view.container.querySelector(".stack-position-chip")).toBeNull();
});
