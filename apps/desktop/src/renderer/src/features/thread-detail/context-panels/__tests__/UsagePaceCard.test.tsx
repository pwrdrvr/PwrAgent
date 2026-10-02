import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReadUsageActivityResponse, UsageLimitObservation } from "@pwragent/shared";
import { UsagePaceCard } from "../UsagePaceCard";
import { usageFixture } from "../../../federation-activity/usage-activity-fixture";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const HOUR = 3_600_000;
const NOW = new Date(2026, 9, 1, 21, 35).getTime();
/** Monday 8 AM to Monday 8 AM, read Thursday evening. */
const RESET_AT = NOW + 82.42 * HOUR;
const WEEKLY = { name: "Weekly limit", windowKey: "secondary" as const, windowMinutes: 10_080, resetAt: RESET_AT };

function reading(usedPercent: number, observedAt = NOW): UsageLimitObservation {
  return { observedAt, accountKey: "acct", planType: "pro", limits: [{ ...WEEKLY, usedPercent }] };
}

function reader(response: Partial<ReadUsageActivityResponse>) {
  return vi.fn(async () => ({ rows: [], readAt: NOW, rateLimits: [], truncated: false, ...response }));
}

describe("UsagePaceCard", () => {
  it("is the Pricing rail's link to Usage Activity before any limit is known", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const openUsageActivity = vi.fn(async () => undefined);
    const readUsageActivity = reader({});
    render(<UsagePaceCard desktopApi={{ openUsageActivity, readUsageActivity }} />);

    await vi.waitFor(() => expect(readUsageActivity).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: /Usage Activity/ }));

    expect(openUsageActivity).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Limits, pace, and spend for every instance.")).toBeInTheDocument();
  });

  it("renders nothing where Usage Activity cannot open", () => {
    const { container } = render(<UsagePaceCard desktopApi={{ readUsageActivity: reader({}) }} />);

    expect(container).toBeEmptyDOMElement();
  });

  it("warns when the weekly pace reaches 100% before the reset, with this machine's spend", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const windowStart = RESET_AT - 168 * HOUR;
    const readUsageActivity = reader({
      limitObservation: reading(53),
      limitHistory: [reading(13, windowStart + 24 * HOUR), reading(30, windowStart + 48 * HOUR)],
      rows: [
        usageFixture({ createdAt: NOW - 2 * HOUR, startedAt: NOW - 2 * HOUR, completedAt: NOW - HOUR }),
        // Finished before the window began, so outside its spend.
        usageFixture({ threadId: "earlier", turnId: "earlier", usageLineId: "earlier", createdAt: windowStart - 3 * HOUR,
          startedAt: windowStart - 3 * HOUR, completedAt: windowStart - 2 * HOUR }),
      ],
    });
    render(<UsagePaceCard desktopApi={{ openUsageActivity: vi.fn(), readUsageActivity }} />);

    const card = await screen.findByRole("button", { name: "Open Usage Activity. Weekly limit 53% used." });
    expect(card).toHaveClass("is-short");
    expect(card).toHaveAccessibleDescription(/On pace to reach 100% .*, 6 h 3\d m before the reset/);
    expect(card).toHaveTextContent("Weekly limit · OpenAI Pro");
    expect(card.querySelector(".usage-pace-card__hit")).toBeInTheDocument();
    // One $0.0003 turn inside the window; the one before it is not counted.
    expect(card.querySelector(".usage-pace-card__foot")).toHaveTextContent("This machine $0.0003 API-eq.");
  });

  it("stays quiet when the pace lands below 100% at the reset", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    render(<UsagePaceCard desktopApi={{ openUsageActivity: vi.fn(), readUsageActivity: reader({ limitObservation: reading(41) }) }} />);

    const card = await screen.findByRole("button", { name: "Open Usage Activity. Weekly limit 41% used." });
    expect(card).not.toHaveClass("is-short");
    expect(card).toHaveAccessibleDescription(/^\+0\.5%\/h On pace for about 80% at the .* reset$/);
    expect(card.querySelector(".usage-pace-card__hit")).not.toBeInTheDocument();
  });

  it("says the limit is reached instead of projecting past it", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    render(<UsagePaceCard desktopApi={{ openUsageActivity: vi.fn(), readUsageActivity: reader({ limitObservation: reading(100) }) }} />);

    const card = await screen.findByRole("button", { name: "Open Usage Activity. Weekly limit 100% used." });
    expect(card).toHaveClass("is-out");
    expect(card).toHaveAccessibleDescription(/^Limit reached\. Resets /);
    expect(card.querySelector(".usage-pace-card__projection")).not.toBeInTheDocument();
  });

  it("rereads when Codex reports new limits, at most once a minute", async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date", "setTimeout", "clearTimeout"] });
    try {
      const readUsageActivity = reader({ limitObservation: reading(41) });
      const backends = (usedPercent: number) => [{
        kind: "codex", label: "OpenAI", available: true, methods: [], executionModes: [],
        capabilities: {} as never, rateLimits: [{ ...WEEKLY, usedPercent }],
      }] as never;
      const { rerender } = render(
        <UsagePaceCard backends={backends(41)} desktopApi={{ openUsageActivity: vi.fn(), readUsageActivity }} />,
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(readUsageActivity).toHaveBeenCalledTimes(1);

      // A fraction of a percent is not a new reading.
      rerender(<UsagePaceCard backends={backends(41.2)} desktopApi={{ openUsageActivity: vi.fn(), readUsageActivity }} />);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(readUsageActivity).toHaveBeenCalledTimes(1);

      rerender(<UsagePaceCard backends={backends(42)} desktopApi={{ openUsageActivity: vi.fn(), readUsageActivity }} />);
      rerender(<UsagePaceCard backends={backends(43)} desktopApi={{ openUsageActivity: vi.fn(), readUsageActivity }} />);
      await vi.advanceTimersByTimeAsync(0);
      expect(readUsageActivity).toHaveBeenCalledTimes(2);
      rerender(<UsagePaceCard backends={backends(44)} desktopApi={{ openUsageActivity: vi.fn(), readUsageActivity }} />);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(readUsageActivity).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(readUsageActivity).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
