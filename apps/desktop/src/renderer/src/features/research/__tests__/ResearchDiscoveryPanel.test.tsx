// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import fc from "fast-check";
import { expect, it } from "vitest";
import type { ResearchDiscoverySnapshot } from "@pwragent/shared";
import { discoveryOutline, ResearchDiscoveryPanel } from "../ResearchDiscoveryPanel";

type Node = NonNullable<ResearchDiscoverySnapshot["tree"]>["nodes"][number];
const node = (id: number, parent: number | null, extra: Partial<Node> = {}): Node => ({ id, parent, round: 0, score: 0, sourceVerified: null, excerpt: `Invented candidate ${id}`, elapsedMs: 0, ...extra });

it("keeps a thousand source nodes paged and searchable without claiming local verification", () => {
  const snapshot: ResearchDiscoverySnapshot = { observedAt: 1_000, state: "done", finished: 1, solved: 1, tokensIn: 100, tokensOut: 200,
    problems: [{ id: "example", state: "done", rounds: 10, nodes: 999, solved: true, stop: "solved" }], tree: {
      problem: "example", state: "done", truncated: true, nodes: Array.from({ length: 1_000 }, (_, id) => node(id, id === 0 ? null : id - 1,
        { round: id, score: id / 999, sourceVerified: id === 999 ? true : null, elapsedMs: id * 10 })),
    } };
  render(<ResearchDiscoveryPanel snapshot={snapshot} />);
  const list = () => screen.getByLabelText("Recorded candidate ancestry");
  expect(within(list()).getAllByRole("listitem")).toHaveLength(25);
  expect(screen.getByText(/The source truncated this tree/)).toBeInTheDocument();
  expect(screen.getByText(/PwrAgent has not independently verified/)).toBeInTheDocument();
  expect(within(screen.getByRole("table", { name: "Recorded problems" })).getByText("reported solved")).toBeInTheDocument();
  expect(screen.getByText("300 tokens")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Previous nodes" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Next nodes" }));
  expect(within(list()).getByText("#25")).toBeInTheDocument();
  expect(within(list()).getByText(/parent #24 · round 25/)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Filter discovery nodes"), { target: { value: "candidate 999" } });
  expect(within(list()).getAllByRole("listitem")).toHaveLength(1);
  expect(screen.getByText(/parent #998 · round 999/)).toBeInTheDocument();
  expect(screen.getByText("passed (source report)")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Next nodes" })).not.toBeInTheDocument();
  // The plot draws every recorded node with the same identities as the outline.
  const plot = screen.getByRole("img", { name: /Score by round for 1,000 recorded nodes|Score by round for 1000 recorded nodes/ });
  expect(plot.querySelectorAll("[data-node-id]")).toHaveLength(1_000);
  expect(plot.querySelector('[data-node-id="999"]')).toHaveAttribute("data-parent-id", "998");
  fireEvent.click(plot.querySelector('[data-node-id="40"]')!);
  const detail = screen.getByRole("region", { name: "Discovery node 40" });
  expect(detail).toHaveTextContent("Invented candidate 40");
  fireEvent.click(within(detail).getByRole("button", { name: "#39" }));
  expect(screen.getByRole("region", { name: "Discovery node 39" })).toBeInTheDocument();
});

it("shows scores at two decimals and keeps the full value available", () => {
  render(<ResearchDiscoveryPanel snapshot={{ observedAt: 1, state: "running", finished: 0, solved: 0, tokensIn: 0, tokensOut: 0, problems: [],
    tree: { problem: "p", state: "running", truncated: false, nodes: [node(0, null, { score: 0.032258064516129 })] } }} />);
  expect(screen.getByTitle("Score 0.032258064516129")).toHaveTextContent("0.03");
});

/**
 * The outline is the keyboard and screen-reader path to the tree, so it must
 * account for every recorded node exactly once and nest each only under its
 * recorded parent, including when the snapshot lacks a parent or the source
 * records a parent loop.
 */
it("places every recorded node once, after its recorded parent, at one level deeper", () => {
  const nodes = fc.uniqueArray(fc.nat(60), { minLength: 1, maxLength: 40 }).chain((ids) =>
    fc.tuple(...ids.map((id) => fc.oneof(fc.constant(null), fc.constantFrom(...ids), fc.nat(80)).map((parent) => node(id, parent)))));
  fc.assert(fc.property(nodes, (input) => {
    const rows = discoveryOutline(input);
    expect(rows.map((row) => row.node.id).toSorted((a, b) => a - b)).toEqual(input.map((n) => n.id).toSorted((a, b) => a - b));
    const ids = new Set(input.map((n) => n.id));
    const position = new Map(rows.map((row, index) => [row.node.id, index]));
    for (const [index, row] of rows.entries()) {
      expect(row.orphan).toBe(row.node.parent !== null && !ids.has(row.node.parent));
      if (row.depth > 0) {
        const parent = rows[position.get(row.node.parent!)!]!;
        expect(position.get(row.node.parent!)!).toBeLessThan(index);
        expect(row.depth).toBe(parent.depth + 1);
      }
      expect(row.children).toBe(rows.filter((other) => other.depth > 0 && other.node.parent === row.node.id).length);
    }
  }), { numRuns: 300 });
});
