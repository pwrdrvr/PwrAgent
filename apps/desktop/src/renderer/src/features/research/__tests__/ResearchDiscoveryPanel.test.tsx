// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, it } from "vitest";
import type { ResearchDiscoverySnapshot } from "@pwragent/shared";
import { ResearchDiscoveryPanel } from "../ResearchDiscoveryPanel";

it("keeps a thousand source nodes paged and searchable without claiming local verification", () => {
  const snapshot: ResearchDiscoverySnapshot = { observedAt: 1_000, state: "done", finished: 1, solved: 1, tokensIn: 100, tokensOut: 200,
    problems: [{ id: "example", state: "done", rounds: 10, nodes: 999, solved: true, stop: "solved" }], tree: {
      problem: "example", state: "done", truncated: true, nodes: Array.from({ length: 1_000 }, (_, id) => ({ id, parent: id === 0 ? null : id - 1,
        round: id, score: 1, sourceVerified: id === 999 ? true : null, excerpt: `Invented candidate ${id}`, elapsedMs: id * 10 })),
    } };
  render(<ResearchDiscoveryPanel snapshot={snapshot} />);
  expect(within(screen.getByLabelText("Recorded candidate ancestry")).getAllByRole("listitem")).toHaveLength(20);
  expect(screen.getByText(/Source tree truncated/)).toBeInTheDocument();
  expect(screen.getByText(/PwrAgent has not independently verified/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Previous nodes" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Next nodes" }));
  expect(screen.getByText(/Node 20 · parent 19/)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Filter discovery nodes"), { target: { value: "candidate 999" } });
  expect(within(screen.getByLabelText("Recorded candidate ancestry")).getAllByRole("listitem")).toHaveLength(1);
  expect(screen.getByText(/Node 999 · parent 998/)).toBeInTheDocument();
  expect(screen.getByText(/passed \(source report\)/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Next nodes" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Ancestry graph" }));
  const graph = screen.getByRole("img", { name: "Recorded discovery ancestry graph" });
  expect(graph.querySelectorAll("[data-node-id]")).toHaveLength(1);
  expect(graph.querySelector('[data-node-id="999"]')).toHaveAttribute("data-parent-id", "998");
});
