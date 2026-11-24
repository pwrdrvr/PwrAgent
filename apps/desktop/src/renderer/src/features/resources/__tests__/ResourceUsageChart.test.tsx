import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ResourceUsageChart } from "../ResourceUsageChart";
import { usageChart } from "../resource-usage";

afterEach(cleanup);

const NOW = 1_800_000_015_000;

/**
 * Rule: every time the chart prints reads as English. An age under a minute
 * is "just now", never "now ago", in both the hover readout and the note
 * saying when recording began.
 */
describe("ResourceUsageChart", () => {
  it("says just now for ages under a minute", () => {
    const chart = usageChart({
      sharing: { mode: "counted", capacity: 4, inUse: 2, unitLabel: "slots" },
      usage: { observedSince: NOW - 40_000, points: [{ at: NOW - 40_000, held: 2, waiting: 1 }] },
    }, NOW)!;
    render(<ResourceUsageChart chart={chart} now={NOW} unitLabel="CPU slot" />);
    expect(screen.getByText(/Recording began just now/)).toBeInTheDocument();

    const plot = screen.getByTestId("resources-usage-plot");
    plot.getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, height: 60, right: 300, bottom: 60, x: 0, y: 0, toJSON: () => ({}) });
    // The second-to-last bar ended under a minute ago.
    fireEvent.pointerMove(plot, { clientX: 300 * (chart.bars.length - 1.5) / chart.bars.length });
    const readout = screen.getByTestId("resources-usage-readout");
    expect(readout).toHaveTextContent(/^just now/);
    expect(readout.textContent).not.toMatch(/now ago/);
  });
});
