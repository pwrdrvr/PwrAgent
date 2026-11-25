import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import fc from "fast-check";
import { afterEach, expect, it, vi } from "vitest";
import type { NavigationThreadSummary, PrSummary } from "@pwragent/shared/contracts/navigation";
import { compactStackMembership, type StackSummary } from "@pwragent/shared/stacks/stack-status";
import { PrRollupChip } from "../PrRollupChip";
import { resolvePrRollup } from "../pr-rollup";

afterEach(cleanup);

/** Stacks of 2 to 5 layers, each with some layers attached to the thread, beside loose PRs. */
const scenario: fc.Arbitrary<Scenario> = fc.record({
  stacks: fc.array(fc.integer({ min: 2, max: 5 }).chain((height) => fc.record({
    height: fc.constant(height),
    attached: fc.uniqueArray(fc.integer({ min: 1, max: height }), { minLength: 1, maxLength: height }),
  })), { maxLength: 2 }),
  loose: fc.integer({ min: 0, max: 3 }),
  merged: fc.array(fc.boolean(), { minLength: 13, maxLength: 13 }),
  ages: fc.uniqueArray(fc.integer({ min: 1, max: 1_000 }), { minLength: 13, maxLength: 13 }),
}).filter(({ stacks, loose }) => stacks.reduce((sum, { attached }) => sum + attached.length, loose) >= 2);

type Scenario = { stacks: { height: number; attached: number[] }[]; loose: number; merged: boolean[]; ages: number[] };

function build({ stacks, loose, merged, ages }: Scenario) {
  const now = Date.now();
  let next = 0;
  const pr = (number: number, base: string, head: string): PrSummary => {
    const index = next++;
    return {
      provider: "github.com", org: "example", repo: "ledger", number,
      url: `https://github.com/example/ledger/pull/${number}`,
      title: `Ledger change ${number}`, state: "passing",
      lifecycleState: merged[index] ? "merged" : "open",
      baseRefName: base, headRefName: head, createdAt: now - ages[index]! * 1_000,
    };
  };
  const prs: PrSummary[] = [];
  const memberships = [];
  const placed = new Map<string, { stack: string; position: number; height: number }>();
  for (const [index, { height, attached }] of stacks.entries()) {
    const layers = Array.from({ length: height }, (_, layer) => ({
      number: 100 * (index + 1) + layer + 1,
      branch: `stack-${index}-${layer + 1}`,
      parent: layer ? `stack-${index}-${layer}` : "main",
    }));
    const stack: StackSummary = {
      key: `stack-${index}`, name: `stack-${index}-1`, repository: "github.com:example/ledger", trunk: "main", inferred: true,
      layers: layers.map(({ number, branch, parent }) => ({
        branch, parent, health: "in_sync", role: "holder", pullRequest: { number, lifecycleState: "open" },
      })),
    };
    for (const position of attached) {
      const layer = layers[position - 1]!;
      const attachedPr = pr(layer.number, layer.parent, layer.branch);
      prs.push(attachedPr);
      memberships.push(compactStackMembership(stack, position)!);
      placed.set(attachedPr.url, { stack: stack.key, position, height });
    }
  }
  for (let index = 0; index < loose; index++) prs.push(pr(300 + index, "main", `loose-${index}`));
  const thread: NavigationThreadSummary = {
    id: "mixed", title: "Mixed pull requests", titleSource: "explicit", source: "codex",
    inbox: { inInbox: false }, linkedDirectories: [], prs, stackMemberships: memberships,
  };
  return { prs, thread, placed };
}

it("lists every attached PR as the same kind of row, with its stack position on the stacked ones", () => {
  fc.assert(fc.property(scenario, (input) => {
    const { prs, thread, placed } = build(input);
    const view = render(<PrRollupChip stackThread={thread} prs={prs} onOpen={vi.fn()} threadTitle={thread.title}
      repoPrefixedUrls="" />);
    try {
      fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${prs.length} pull requests`) }));
      const list = screen.getByRole("group", { name: /^Pull requests for/ }).querySelector(".pr-rollup-popover__list")!;
      const rows = [...list.children];

      // One flat list: no nested stack box, heading or trunk, and every row
      // draws its chip the same way, status dot included.
      expect(rows).toHaveLength(prs.length);
      for (const row of rows) {
        expect(row.matches("li.pr-rollup-popover__item")).toBe(true);
        expect(row.querySelectorAll(".pr-rollup-popover__chip > .pr-chip__dot")).toHaveLength(1);
        expect(row.querySelector(".stack-display__node, .stack-display__head, .stack-display__trunk, ol")).toBeNull();
      }

      // Oracle: the rollup's own order, with each stack's attached PRs run
      // together top first from where its first one falls.
      const runs = new Map<string, PrSummary[]>();
      const slots: PrSummary[][] = [];
      for (const pr of resolvePrRollup(prs)!.ordered) {
        const member = placed.get(pr.url);
        if (!member) {
          slots.push([pr]);
          continue;
        }
        if (!runs.has(member.stack)) {
          runs.set(member.stack, []);
          slots.push(runs.get(member.stack)!);
        }
        runs.get(member.stack)!.push(pr);
      }
      for (const run of runs.values()) run.sort((a, b) => placed.get(b.url)!.position - placed.get(a.url)!.position);
      const urls = rows.map((row) => row.querySelector("[data-pr-rollup-url]")!.getAttribute("data-pr-rollup-url"));
      expect(urls).toEqual(slots.flat().map(({ url }) => url));

      // A stacked row names its position among all the stack's layers, attached
      // or not, so a missing layer shows in the numbers; a loose row has none.
      for (const row of rows) {
        const button = row.querySelector("[data-pr-rollup-url]")!;
        const member = placed.get(button.getAttribute("data-pr-rollup-url")!);
        const status = row.querySelector(".pr-rollup-popover__status")!.textContent!;
        if (member) {
          expect(status.split(" · ")[0]).toBe(`${member.position}/${member.height}`);
          expect(button.getAttribute("aria-label")).toContain(`stack layer ${member.position} of ${member.height}`);
        } else {
          expect(status).not.toMatch(/^\d+\/\d+/);
          expect(button.getAttribute("aria-label")).not.toContain("stack layer");
        }
      }
    } finally {
      view.unmount();
    }
  }), {
    numRuns: 40,
    examples: [
      // Layers 2-4 of a 4-layer stack, its bottom layer on another thread.
      [{ stacks: [{ height: 4, attached: [4, 3, 2] }], loose: 0, merged: Array(13).fill(false), ages: Array.from({ length: 13 }, (_, i) => i + 1) }],
      // A partial stack beside loose PRs.
      [{ stacks: [{ height: 4, attached: [2, 3] }], loose: 2, merged: Array(13).fill(false), ages: Array.from({ length: 13 }, (_, i) => 13 - i) }],
      // Two stacks and a loose PR.
      [{ stacks: [{ height: 3, attached: [1, 2, 3] }, { height: 2, attached: [2] }], loose: 1,
        merged: Array(13).fill(false), ages: Array.from({ length: 13 }, (_, i) => i + 1) }],
    ],
  });
});
