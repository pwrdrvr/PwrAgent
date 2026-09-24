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

/** The card element, which carries the verdict for every figure inside it. */
function card(): HTMLElement | null {
  return document.querySelector(".token-miser-summary-card");
}

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

    expect(screen.getByText("$0.050 net overhead")).toBeInTheDocument();
    // 5.3% more is past the even band: orange, not gray.
    expect(card()).toHaveAttribute("data-savings-tier", "over");
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
    // Tokens kept out are not yet a verdict on the bill: no color at all.
    expect(card()).not.toHaveAttribute("data-savings-tier");
    expect(
      screen.getByText(
        "Dollar terms appear once the gate's usage line is priced.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("Savings terms")).not.toBeInTheDocument();
  });

  it("names an overhead the tokens show as clearly as the dollars would", () => {
    /* A gate whose summaries ran longer than the payloads they replaced put
       more in the parent's context, not less. Before pricing lands the token
       figure is the only figure, and it read as a win. */
    render(
      <TokenMiserSummaryCard
        summary={{
          decisionCount: 4,
          pricedDecisionCount: 0,
          avoidedParentTokens: -12_000,
        }}
      />,
    );

    expect(screen.getByText("12k added to context")).toBeInTheDocument();
    expect(card()).toHaveAttribute("data-savings-tier", "over");
  });

  it("drops the unfiltered comparison when the overhead swallows the bill", () => {
    /* An overhead larger than the thread's own bill leaves nothing to compare
       against; "$0.00 unfiltered" would read as a measurement. */
    render(
      <TokenMiserSummaryCard
        observedCostMicros={40_000}
        summary={{
          ...summary,
          terms: { ...terms, savingsMicros: -40_000 },
        }}
      />,
    );

    expect(
      screen.getByText("Estimated same-trajectory overhead"),
    ).toBeInTheDocument();
    // No percentage to judge by, so the sign alone decides.
    expect(card()).toHaveAttribute("data-savings-tier", "over");
  });

  it("summarizes a Code Mode thread that reached no reducer decision", () => {
    const onOpenSavings = vi.fn();
    render(
      <TokenMiserSummaryCard
        onOpenSavings={onOpenSavings}
        summary={{
          decisionCount: 0,
          pricedDecisionCount: 0,
          codeModeCallCount: 12,
        }}
      />,
    );

    expect(screen.getByText("12 Code Mode calls")).toBeInTheDocument();
    expect(rowValue("Code Mode calls")).toBe("12");
    expect(
      screen.getByText("No reducer decision was recorded."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Token Miser Savings" }),
    ).toBeInTheDocument();
  });

  it("says how much of the thread a partial total covers", () => {
    render(
      <TokenMiserSummaryCard
        summary={{ ...summary, pricedDecisionCount: 4 }}
      />,
    );

    expect(screen.getByText("Savings terms · 4 of 9 priced")).toBeInTheDocument();
  });

  it("is proud by degrees", () => {
    /* $1.00 unfiltered each time, so each saving is its own percentage. */
    const tierAt = (savingsMicros: number) => {
      cleanup();
      render(
        <TokenMiserSummaryCard
          observedCostMicros={1_000_000 - savingsMicros}
          summary={{ ...summary, terms: { ...terms, savingsMicros } }}
        />,
      );
      return card()?.getAttribute("data-savings-tier");
    };

    expect(tierAt(20_000)).toBe("even");
    expect(tierAt(70_000)).toBe("good");
    expect(tierAt(200_000)).toBe("great");
    expect(tierAt(400_000)).toBe("exceptional");
    expect(tierAt(-20_000)).toBe("even");
    expect(tierAt(-70_000)).toBe("over");
  });

  it("marks the percentage so a great result can wear its pill", () => {
    render(
      <TokenMiserSummaryCard
        observedCostMicros={800_000}
        summary={{ ...summary, terms: { ...terms, savingsMicros: 200_000 } }}
      />,
    );

    expect(card()).toHaveAttribute("data-savings-tier", "great");
    expect(screen.getByText("20.0% less")).toHaveClass(
      "token-miser-summary-card__percent",
    );
    // The bar is exceptional's alone.
    expect(
      document.querySelector(".token-miser-summary-card__split"),
    ).not.toBeInTheDocument();
  });

  it("draws where an exceptional saving came from", () => {
    // $0.80 off a $2.00 unfiltered bill is 40%.
    render(
      <TokenMiserSummaryCard
        observedCostMicros={1_200_000}
        summary={summary}
      />,
    );

    expect(card()).toHaveAttribute("data-savings-tier", "exceptional");
    const bar = document.querySelector(".token-miser-summary-card__split");
    expect(bar).toHaveAttribute("aria-hidden", "true");
    // Shares of the $1.20 the gate could touch, like the window's bar.
    expect(
      [...bar!.querySelectorAll("i")].map((part) => [
        part.getAttribute("data-part"),
        (part as HTMLElement).style.width,
      ]),
    ).toEqual([
      ["avoided", `${800_000 / 1_200_000 * 100}%`],
      ["gate", `${150_000 / 1_200_000 * 100}%`],
      ["revealed", `${250_000 / 1_200_000 * 100}%`],
    ]);
    expect(
      document.querySelector(".token-miser-summary-card__split-caption"),
    ).toHaveTextContent("67% avoided · 13% gate · 20% revealed");
  });
});
