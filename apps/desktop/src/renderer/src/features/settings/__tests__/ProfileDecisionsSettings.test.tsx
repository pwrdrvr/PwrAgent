import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DecisionsProfileDecision } from "@pwragent/shared";
import { ProfileDecisionsSettings } from "../ProfileDecisionsSettings";

afterEach(cleanup);

const NOW = new Date(2026, 10, 19, 14, 4, 41).getTime();

const triage: DecisionsProfileDecision = {
  decisionId: "dec_1",
  name: "triage_relevance",
  version: 2,
  scope: "profile",
  provider: "openai",
  providerDisabled: false,
  questions: [
    { type: "predicate", name: "relevant" },
    { type: "choice", name: "severity", choices: ["low", "high"] },
  ],
  inputSchema: { type: "object", properties: { title: { type: "string" }, labels: { type: "array" } } },
  timing: { samples: 200, minMs: 120, maxMs: 2_100, meanMs: 410, p50Ms: 390 },
  createdAt: NOW - 3 * 3_600_000,
};

const presence: DecisionsProfileDecision = {
  decisionId: "dec_2",
  name: "operator_present",
  version: 4,
  scope: "profile",
  provider: "local",
  providerDisabled: true,
  questions: [{ type: "predicate", name: "present" }],
  inputSchema: { type: "string" },
  createdAt: NOW - 26 * 3_600_000,
};

function renderSettings(initial: DecisionsProfileDecision[] = [presence, triage]) {
  let decisions = initial;
  const readProfileDecisions = vi.fn(async () => ({ decisions }));
  const deleteProfileDecision = vi.fn(async ({ decisionId }: { decisionId: string }) => {
    decisions = decisions.filter((decision) => decision.decisionId !== decisionId);
    return { outcome: "deleted" as const };
  });
  render(<ProfileDecisionsSettings desktopApi={{ readProfileDecisions, deleteProfileDecision }} now={NOW} />);
  return { readProfileDecisions, deleteProfileDecision };
}

describe("ProfileDecisionsSettings", () => {
  it("lists the profile's decisions with provider, version and use", async () => {
    renderSettings();
    const list = await screen.findByRole("list", { name: "Profile decisions" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText("operator_present")).toBeInTheDocument();
    expect(within(rows[0]!).getByText("Local model · off")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("v2")).toBeInTheDocument();
    expect(within(rows[1]!).getByText(/2 questions · mean 410 ms over 200 requests · input/)).toBeInTheDocument();
    expect(within(rows[1]!).getByText("{ title, labels[] }")).toBeInTheDocument();
  });

  it("deletes a decision only after the operator confirms", async () => {
    const api = renderSettings();
    fireEvent.click(await screen.findByRole("button", { name: "Delete triage_relevance" }));
    const dialog = screen.getByRole("dialog", { name: "Delete triage_relevance?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(api.deleteProfileDecision).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Delete triage_relevance" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete decision" }));
    await waitFor(() => expect(api.deleteProfileDecision).toHaveBeenCalledWith({ decisionId: "dec_1" }));
    await waitFor(() => expect(screen.queryByText("triage_relevance")).not.toBeInTheDocument());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByText("operator_present")).toBeInTheDocument();
  });

  it("keeps the dialog open and says why when Delete fails", async () => {
    const api = renderSettings();
    api.deleteProfileDecision.mockRejectedValueOnce(new Error("Decisions are unavailable in this PwrAgent runtime"));
    fireEvent.click(await screen.findByRole("button", { name: "Delete triage_relevance" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete decision" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Decisions are unavailable in this PwrAgent runtime");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("says how a profile decision gets here when there is none", async () => {
    renderSettings([]);
    expect(await screen.findByText(/No profile decisions/)).toBeInTheDocument();
  });

  it("renders nothing without the decisions bridge", () => {
    const { container } = render(<ProfileDecisionsSettings />);
    expect(container).toBeEmptyDOMElement();
  });
});
