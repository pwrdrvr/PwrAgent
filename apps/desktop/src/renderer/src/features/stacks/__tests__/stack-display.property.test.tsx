import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import fc from "fast-check";
import { afterEach, expect, it, vi } from "vitest";
import { buildPullRequestStatusKey, type NavigationThreadSummary, type PrSummary } from "@pwragent/shared/contracts/navigation";
import { compactStackMembership, type StackLayer, type StackSummary } from "@pwragent/shared/stacks/stack-status";
import { ThreadRow } from "../../navigation/ThreadRow";
import { PrChip } from "../../pr-status/PrChip";
import { PrRollupChip } from "../../pr-status/PrRollupChip";
import { PullRequestsPanel } from "../../thread-detail/context-panels/PullRequestsPanel";

afterEach(cleanup);

const amberStates = [
  { layer: { health: "parent_merged" }, text: "parent merged · needs sync" },
  { layer: { health: "needs_push" }, text: "needs push" },
  { layer: { health: "held", heldBy: { number: 10, branch: "ledger-1", reason: "needs sync" } },
    text: "merge held · #10 needs sync" },
] as const satisfies readonly { layer: Pick<StackLayer, "health" | "heldBy">; text: string }[];

function fixture(height: number, newestFirst: boolean, amber?: (typeof amberStates)[number], draft = false) {
  const now = Date.now();
  const prs: PrSummary[] = Array.from({ length: height }, (_, index) => ({
    provider: "github.com", org: "example", repo: "ledger", number: 10 + index,
    url: `https://github.com/example/ledger/pull/${10 + index}`,
    title: `Ledger change ${index + 1}`, state: "passing",
    lifecycleState: amber?.layer.health === "parent_merged" && index === height - 2 ? "merged" : "open",
    reviewState: draft && index === height - 1 ? "draft" : "ready_for_review",
    baseRefName: index ? `ledger-${index}` : "main",
    headRefName: `ledger-${index + 1}`,
    createdAt: now - (newestFirst ? index : height - index) * 1_000,
  }));
  const stack: StackSummary = {
    key: "ledger-stack", name: "ledger-1", repository: "github.com:example/ledger", trunk: "main", inferred: true,
    layers: prs.map((pr, index) => ({
      branch: pr.headRefName!, parent: pr.baseRefName!, health: "in_sync", role: "holder",
      pullRequest: { number: pr.number, lifecycleState: pr.lifecycleState },
      thread: { key: "codex:ledger", title: "Ledger stack" },
      ...(index === height - 1 ? amber?.layer : undefined),
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

it("draws the stack top first and keeps actionable status in the metadata on all three surfaces", () => {
  const heights = fc.integer({ min: 2, max: 24 });
  const amber = fc.constantFrom(...amberStates);
  fc.assert(fc.property(heights, fc.boolean(), amber, fc.boolean(), (height, newestFirst, warning, draft) => {
    const { prs, thread } = fixture(height, newestFirst, warning, draft);
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
        const meta = [...list.querySelectorAll(".stack-display__status, .pr-rollup-popover__status")];
        expect(meta).toHaveLength(height);
        for (const line of meta) expect(line.textContent?.trim()).not.toMatch(/^·/);
        const prefix = surface === rollup ? `${height}/${height}` : `#${top.number}`;
        expect(meta[0]!.textContent).toBe(`${prefix}${draft ? " · draft" : ""} · ${warning.text}`);
        expect(meta[0]!.querySelector(".stack-display__warning")?.textContent).toBe(warning.text);
        expect(meta[1]!.textContent).toContain(warning.layer.health === "parent_merged"
          ? "merged" : "ready for review · checks passing");
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

it("uses the owner's tagged lead when the preview omits newer held layers", () => {
  const { prs, thread } = fixture(9, false);
  const lead = prs[0]!;
  const stackMemberships = thread.stackMemberships!.slice(0, 8).map((member) => ({
    ...member,
    ...(member.position > 1 ? { heldBy: { number: lead.number, branch: "ledger-1", reason: "CI running" as const } } : {}),
  }));
  render(<ThreadRow thread={{ ...thread, stackMemberships, stackLeadPrKey: buildPullRequestStatusKey(lead) }}
    onSelectThread={vi.fn()} onOpenContextMenu={vi.fn()} />);
  expect(screen.getByRole("button", { name: "Stack position 1 of 9 for #10" })).toBeDefined();
});

it("matches the current PR after an earlier stack layer is removed", () => {
  const { prs, thread } = fixture(3, false);
  const pr = prs[1]!;
  const stack = thread.stacks![0]!.stack;
  render(<PrChip stackThread={{ ...thread, stacks: [{ stack: { ...stack, layers: stack.layers.slice(1) }, position: 1 }] }}
    pr={pr} onOpen={vi.fn()} showRepoPrefix={false} showStackTag />);
  fireEvent.click(screen.getByRole("button", { name: "Stack position 2 of 3 for #11" }));
  const popover = screen.getByRole("dialog", { name: /^Stack for/ });
  expect(within(popover).getByText("This PR").closest("li")?.textContent).toContain("#11");
});

it("draws the bottom PR's base as the trunk for older compact rows", () => {
  const { prs, thread } = fixture(2, false);
  render(<PrRollupChip stackThread={{
    ...thread, stacks: undefined,
    stackMemberships: thread.stackMemberships!.map((member) => ({ ...member, trunk: undefined })),
  }} prs={prs} threadTitle={thread.title} repoPrefixedUrls="" onOpen={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: /^2 pull requests/ }));
  const rollup = screen.getByRole("group", { name: /^Pull requests for/ });
  expect(rollup.querySelector(".stack-display__trunk")?.textContent).toBe("main");
});
