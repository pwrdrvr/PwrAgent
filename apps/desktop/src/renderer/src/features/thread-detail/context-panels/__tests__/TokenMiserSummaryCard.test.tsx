import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  TokenMiserSavingsSummary,
  TokenMiserSavingsTerms,
} from "../../token-miser-savings-summary";
import { TokenMiserSummaryCard } from "../TokenMiserSummaryCard";

afterEach(() => {
  cleanup();
});

const terms: TokenMiserSavingsTerms = {
  withoutGateCostMicros: 1_200_000,
  gateCostMicros: 150_000,
  revealedCostMicros: 250_000,
  savingsMicros: 800_000,
};

const summary: TokenMiserSavingsSummary = {
  decisionCount: 9,
  pricedDecisionCount: 9,
  helperDecisionCount: 6,
  passThroughCount: 2,
  summarizedCount: 7,
  avoidedParentTokens: 93_000,
  terms,
};

function rowValue(label: string): string {
  const row = screen.getByText(label).closest(".rail-summary-card__row");
  return row?.querySelector(".rail-summary-card__row-value")?.textContent ?? "";
}

describe("TokenMiserSummaryCard", () => {
  it("states the savings window's three terms and its headline", () => {
    render(
      <TokenMiserSummaryCard
        observedCostMicros={1_200_000}
        summary={summary}
      />,
    );

    expect(screen.getByText("$0.80 saved")).toBeInTheDocument();
    expect(screen.getByText("40.0% less")).toBeInTheDocument();
    expect(
      screen.getByText("Estimated same-trajectory savings · $2.00 unfiltered"),
    ).toBeInTheDocument();
    expect(rowValue("1 · Without the gate")).toBe("$1.20");
    expect(rowValue("2 · Gate compute")).toBe("$0.15");
    expect(rowValue("3 · Revealed to parent")).toBe("$0.25");
  });

  it("breaks the decisions down in the window's vocabulary", () => {
    render(<TokenMiserSummaryCard summary={summary} />);

    expect(screen.getByText("9 decisions")).toBeInTheDocument();
    expect(rowValue("Summarized")).toBe("7");
    expect(rowValue("Passed through")).toBe("2");
    expect(rowValue("Luna evaluations")).toBe("6");
    expect(rowValue("Parent context avoided")).toBe("93k");
  });

  it("opens the savings window from the card", () => {
    const onOpenSavings = vi.fn();
    render(
      <TokenMiserSummaryCard onOpenSavings={onOpenSavings} summary={summary} />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Token Miser Savings" }),
    );
    expect(onOpenSavings).toHaveBeenCalledOnce();
  });

  it("omits the action when no window can be opened", () => {
    render(<TokenMiserSummaryCard summary={summary} />);

    expect(
      screen.queryByRole("button", { name: "Token Miser Savings" }),
    ).not.toBeInTheDocument();
  });

  it("names an overhead instead of printing a negative saving", () => {
    render(
      <TokenMiserSummaryCard
        observedCostMicros={1_000_000}
        summary={{
          ...summary,
          terms: { ...terms, savingsMicros: -50_000 },
        }}
      />,
    );

    const headline = screen.getByText("$0.050 net overhead");
    expect(headline).toHaveAttribute("data-negative", "true");
    expect(screen.getByText("5.3% more")).toBeInTheDocument();
    expect(
      screen.getByText("Estimated same-trajectory overhead · $0.95 unfiltered"),
    ).toBeInTheDocument();
  });

  it("waits for prices rather than reporting a $0.00 saving", () => {
    /* A live turn has real decisions and no rates yet. Dollars that have not
       arrived must not read as dollars that came to nothing. */
    render(
      <TokenMiserSummaryCard
        observedCostMicros={1_200_000}
        summary={{
          decisionCount: 4,
          pricedDecisionCount: 0,
          avoidedParentTokens: 93_000,
        }}
      />,
    );

    expect(screen.getByText("93k kept out")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Dollar terms appear once each gate's usage line is priced",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("Savings terms")).not.toBeInTheDocument();
  });

  it("says how much of the thread a partial total covers", () => {
    render(
      <TokenMiserSummaryCard
        summary={{ ...summary, pricedDecisionCount: 4 }}
      />,
    );

    expect(screen.getByText("Savings terms · 4 of 9 priced")).toBeInTheDocument();
  });
});
