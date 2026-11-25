import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import fc from "fast-check";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { NavigationThreadSummary, PrSummary } from "@pwragent/shared/contracts/navigation";
import { compactStackMembership, type StackSummary } from "@pwragent/shared/stacks/stack-status";
import type { DesktopApi } from "../../../lib/desktop-api";
import { PrChip } from "../../pr-status/PrChip";
import { resetStackDetailCacheForTests, STACK_DETAIL_FRESH_MS, STACK_DETAIL_USABLE_MS } from "../stack-detail-cache";

type Read = NonNullable<DesktopApi["getNavigationSelectedDetail"]>;

beforeEach(resetStackDetailCacheForTests);
afterEach(() => {
  cleanup();
  delete (window as Window & { pwragent?: unknown }).pwragent;
});

/** One stack whose layers each belong to their own thread, as the owner projects it. */
function fixture(height: number) {
  const prs: PrSummary[] = Array.from({ length: height }, (_, index) => ({
    provider: "github.com", org: "example", repo: "ledger", number: 40 + index,
    url: `https://github.com/example/ledger/pull/${40 + index}`,
    title: `Ledger change ${index + 1}`, state: "passing", lifecycleState: "open",
    baseRefName: index ? `ledger-${index}` : "main", headRefName: `ledger-${index + 1}`,
  }));
  const stack: StackSummary = {
    key: "ledger-stack", name: "ledger-1", repository: "github.com:example/ledger", trunk: "main", inferred: true,
    layers: prs.map((pr, index) => ({
      branch: pr.headRefName!, parent: pr.baseRefName!, health: "in_sync", role: "holder",
      pullRequest: { number: pr.number, lifecycleState: "open" },
      thread: { key: `codex:layer-${index + 1}`, title: `Layer ${index + 1}` },
    })),
  };
  const thread = (position: number, detailRevision: string): NavigationThreadSummary => ({
    id: `layer-${position}`, title: `Layer ${position}`, titleSource: "explicit", source: "codex",
    inbox: { inInbox: false }, prs: [prs[position - 1]!],
    linkedDirectories: [{ id: "work", kind: "local", label: "Ledger", path: "/example/ledger" }],
    stackMemberships: [{ ...compactStackMembership(stack, position)!, detailRevision }],
  });
  return { prs, stack, thread };
}

/** The owner's selected-detail read: every layer of the one stack, on one page. */
function installOwner(stack: StackSummary) {
  const read = vi.fn<Read>(async ({ ref }) => ({
    protocol: 2, ref, revision: "stack-revision", readiness: "ready", identity: "present",
    collectionPage: {
      name: "stackLayers", revision: "stack-revision", complete: true,
      values: { stackLayers: stack.layers.map((layer, index) => ({
        stackKey: stack.key, position: index + 1, layer,
        ...(index === 0 ? { stack: { key: stack.key, name: stack.name, trunk: stack.trunk,
          repository: stack.repository, inferred: stack.inferred } } : {}),
      })) },
    },
  }));
  (window as Window & { pwragent?: Partial<DesktopApi> }).pwragent = { getNavigationSelectedDetail: read };
  return read;
}

function openStack(thread: NavigationThreadSummary, pr: PrSummary, hoverFirst: boolean) {
  const view = render(<PrChip stackThread={thread} pr={pr} onOpen={vi.fn()} showRepoPrefix={false} showStackTag />);
  const tag = screen.getByRole("button", { name: /^Stack position/ });
  if (hoverFirst) fireEvent.mouseEnter(tag);
  fireEvent.click(tag);
  const popover = screen.getByRole("dialog", { name: /^Stack for/ });
  const loadedRows = () => popover.querySelectorAll(".stack-display__layer:not([data-placeholder])").length;
  return { view, popover, loadedRows };
}

it("opens a stack another member already loaded at the same revision with every layer and no new read", async () => {
  await fc.assert(fc.asyncProperty(
    fc.integer({ min: 2, max: 8 }).chain((height) => fc.tuple(
      fc.constant(height),
      fc.integer({ min: 1, max: height }),
      fc.integer({ min: 1, max: height }),
      fc.boolean(),
    )),
    async ([height, first, second, hoverFirst]) => {
      // A failed run leaves its views mounted; shrinking must start clean.
      cleanup();
      resetStackDetailCacheForTests();
      const { prs, stack, thread } = fixture(height);
      const read = installOwner(stack);

      // The first member reads once, even when the hover prefetch and the
      // popover both want the rows.
      const opened = openStack(thread(first, "r1"), prs[first - 1]!, hoverFirst);
      await act(async () => {});
      expect(opened.loadedRows()).toBe(height);
      expect(read).toHaveBeenCalledTimes(1);
      opened.view.unmount();

      // Every member at that revision, including the first again, draws the
      // whole stack on its first frame: no loading state that grows later.
      for (const position of [second, first]) {
        const again = openStack(thread(position, "r1"), prs[position - 1]!, false);
        expect(again.loadedRows()).toBe(height);
        expect(again.popover.querySelector("[data-placeholder]")).toBeNull();
        again.view.unmount();
      }
      expect(read).toHaveBeenCalledTimes(1);

      // A new revision means the stack changed: read it again.
      const changed = openStack(thread(second, "r2"), prs[second - 1]!, false);
      expect(changed.loadedRows()).toBe(0);
      await act(async () => {});
      expect(changed.loadedRows()).toBe(height);
      expect(read).toHaveBeenCalledTimes(2);
      changed.view.unmount();
    },
  ), { numRuns: 20 });
});

it("holds one row per layer while loading, so the popover does not grow when the rows arrive", async () => {
  const { prs, stack, thread } = fixture(3);
  let finish: () => void = () => {};
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  const read = installOwner(stack);
  const answer = read.getMockImplementation()!;
  read.mockImplementation(async (request) => {
    await gate;
    return await answer(request);
  });
  const { popover, loadedRows } = openStack(thread(1, "r1"), prs[0]!, false);
  const placeholders = [...popover.querySelectorAll(".stack-display__layer[data-placeholder]")];
  expect(placeholders.map((row) => row.querySelector(".stack-display__position")?.textContent)).toEqual(["3/3", "2/3", "1/3"]);
  expect(placeholders.at(-1)).toHaveProperty("dataset.current", "true");
  expect(screen.getByRole("status").textContent).toBe("Loading stack…");
  await act(async () => { finish(); });
  expect(loadedRows()).toBe(3);
  expect(popover.querySelector("[data-placeholder]")).toBeNull();
});

it("draws an aging copy at once, reads it again behind it, and stops drawing it once it is too old", async () => {
  const { prs, stack, thread } = fixture(3);
  const read = installOwner(stack);
  let now = Date.now();
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  const titles = (popover: HTMLElement) => [...popover.querySelectorAll(".stack-display__layer:not([data-placeholder]) .stack-display__title")]
    .map((title) => title.textContent);
  try {
    const first = openStack(thread(1, "r1"), prs[0]!, false);
    await act(async () => {});
    expect(read).toHaveBeenCalledTimes(1);
    first.view.unmount();

    // Git moved with no new revision on the rows. Past the fresh window the
    // copy still draws whole on the first frame, and is read again behind it.
    now += STACK_DETAIL_FRESH_MS + 1;
    stack.layers[2] = { ...stack.layers[2]!, branch: "ledger-3-rebased" };
    const aging = openStack(thread(2, "r1"), prs[1]!, false);
    expect(titles(aging.popover)).toEqual(["ledger-3", "Ledger change 2", "ledger-1"]);
    await act(async () => {});
    expect(read).toHaveBeenCalledTimes(2);
    expect(titles(aging.popover)).toEqual(["ledger-3-rebased", "Ledger change 2", "ledger-1"]);
    aging.view.unmount();

    // That read is fresh for every member of the stack.
    const fresh = openStack(thread(3, "r1"), prs[2]!, false);
    expect(titles(fresh.popover)).toEqual(["Ledger change 3", "ledger-2", "ledger-1"]);
    await act(async () => {});
    expect(read).toHaveBeenCalledTimes(2);
    fresh.view.unmount();

    // Too old to draw at all.
    now += STACK_DETAIL_USABLE_MS + 1;
    const expired = openStack(thread(1, "r1"), prs[0]!, false);
    expect(expired.loadedRows()).toBe(0);
    await act(async () => {});
    expect(expired.loadedRows()).toBe(3);
    expect(read).toHaveBeenCalledTimes(3);
  } finally {
    clock.mockRestore();
  }
});
