import "@testing-library/jest-dom/vitest";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ThreadUsageLineRecord } from "@pwragent/shared";
import { ThreadContextPanel } from "../ThreadContextPanel";
import type { ComponentProps } from "react";
import { PricingPanel } from "../context-panels/PricingPanel";
import * as spend from "../pricing-spend-by-model";
import * as formatting from "../context-panels/subagent-format";
import * as rail from "../context-panels/context-rail-shared";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function buildMonitorLine(
  overrides: Partial<ThreadUsageLineRecord> = {},
): ThreadUsageLineRecord {
  return {
    backend: "codex",
    cachedInputCostMicros: 0,
    cachedInputTokens: 0,
    createdAt: 1_800_000_000_000,
    currency: "USD",
    inputTokens: 100,
    model: "gpt-5.5",
    outputCostMicros: 0,
    outputTokens: 10,
    priceStatus: "priced",
    provider: "openai",
    reasoningOutputTokens: 0,
    scope: "monitor",
    source: "monitor",
    sourceItemId: "mon-1",
    status: "finalized",
    threadId: "thread-1",
    totalCostMicros: 1_000,
    totalTokens: 110,
    uncachedInputCostMicros: 0,
    uncachedInputTokens: 100,
    usageLineId: "mon-line-1",
    ...overrides,
  };
}

it("ticks only live timestamps and keeps completed cards and pricing calculations static", () => {
  vi.useFakeTimers();
  const startedAt = 1_800_000_000_000;
  vi.setSystemTime(startedAt + 10_000);
  const calculate = vi.spyOn(spend, "buildPricingSpendByModel");
  const formatTokens = vi.spyOn(formatting, "formatTokenCount");
  const formatTimestamp = vi.spyOn(rail, "formatTimestamp");
  const active = buildMonitorLine({
    usageLineId: "active", scope: "turn", source: "live",
    turnId: "turn-active", startedAt, status: "pending",
  });
  const completed = buildMonitorLine({
    usageLineId: "completed", scope: "turn", source: "live",
    turnId: "turn-completed", startedAt: startedAt - 60_000,
    completedAt: startedAt - 50_000,
  });
  const pricing = { lines: [active, completed], summaries: [] };
  const view = render(<PricingPanel activeTurnId="turn-active" pricing={pricing} />);
  const durations = () => Array.from(view.container.querySelectorAll(".rail-card__duration"))
    .map((element) => element.textContent);
  const before = durations();
  calculate.mockClear();
  formatTokens.mockClear();
  formatTimestamp.mockClear();

  act(() => { vi.advanceTimersByTime(3_000); });
  expect(durations()).not.toEqual(before);
  expect(calculate).not.toHaveBeenCalled();
  expect(formatTokens).not.toHaveBeenCalled();
  expect(formatTimestamp.mock.calls.every(([timestamp]) => timestamp === startedAt)).toBe(true);

  // An unrelated parent update must not rebuild the pricing cards either.
  formatTimestamp.mockClear();
  view.rerender(<PricingPanel activeTurnId="turn-active" pricing={pricing} />);
  expect(formatTimestamp).not.toHaveBeenCalled();
  expect(formatTokens).not.toHaveBeenCalled();

  // A real usage update invalidates cached calculations and updates the cards.
  view.rerender(<PricingPanel activeTurnId="turn-active" pricing={{
    ...pricing,
    lines: [{ ...active, uncachedInputTokens: 987654 }, completed],
  }} />);
  expect(calculate).toHaveBeenCalledTimes(1);
  expect(formatTokens).toHaveBeenCalledWith(987654);

  view.rerender(<PricingPanel pricing={pricing} />);
  formatTimestamp.mockClear();
  act(() => { vi.advanceTimersByTime(3_000); });
  expect(formatTimestamp).not.toHaveBeenCalled();
});

it("keeps pricing cards cached across rail updates even with an Explorer callback", () => {
  const formatTokens = vi.spyOn(formatting, "formatTokenCount");
  const props: ComponentProps<typeof ThreadContextPanel> = {
    activeTab: "pricing",
    backends: [],
    onActiveTabChange: vi.fn(),
    onOpenToolOutputIncidentExplorer: vi.fn(),
    pinned: true,
    pricing: { lines: [buildMonitorLine()], summaries: [] },
    thread: {
      id: "thread-1", title: "Fixture", titleSource: "explicit", source: "codex",
      linkedDirectories: [], inbox: { inInbox: true },
    },
  };
  const view = render(<ThreadContextPanel {...props} width={380} />);
  expect(formatTokens).toHaveBeenCalled();
  formatTokens.mockClear();
  view.rerender(<ThreadContextPanel {...props} width={420} />);
  expect(formatTokens).not.toHaveBeenCalled();
});
