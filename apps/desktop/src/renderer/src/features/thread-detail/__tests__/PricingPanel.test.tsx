import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentEvent, ThreadUsageLineRecord, NavigationThreadSummary, ThreadSubAgentSummary } from "@pwragent/shared";
import { ThreadContextPanel } from "../ThreadContextPanel";
import type { ComponentProps } from "react";
import type { DesktopApi } from "../../../lib/desktop-api";
import { PricingPanel } from "../context-panels/PricingPanel";
import * as spend from "@pwragent/shared";
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
  const calculate = vi.spyOn(spend, "buildThreadPricingDisplay");
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

// Recreate the IPC/federation boundary: every poll/notification has new
// objects, including unchanged finalized rows and nested accounting.
function wireCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

it("preserves historical DOM and formatting across remote snapshots, active updates and insertion", () => {
  const formatTokens = vi.spyOn(formatting, "formatTokenCount");
  const calculate = vi.spyOn(spend, "buildThreadPricingDisplay");
  const historical = buildMonitorLine({
    usageLineId: "historical", scope: "turn", source: "live", turnId: "old-turn",
    uncachedInputTokens: 123456, createdAt: 1_800_000_000_000,
    startedAt: 1_800_000_000_000, completedAt: 1_800_000_001_000,
  });
  const active = buildMonitorLine({
    usageLineId: "active", scope: "turn", source: "live", turnId: "active-turn",
    uncachedInputTokens: 234567, createdAt: 1_800_000_010_000, status: "pending",
  });
  const props = {
    activeTurnId: "active-turn",
    pricing: { lines: [active, historical], summaries: [] },
    displayOptions: { codexCredits: false, usd: true },
  };
  const view = render(<PricingPanel {...wireCopy(props)} />);
  const cards = () => Array.from(view.container.querySelectorAll("li.pricing-usage-row"));
  const [activeCard, historicalCard] = cards();
  for (let update = 0; update < 5; update += 1) {
    formatTokens.mockClear();
    calculate.mockClear();
    view.rerender(<PricingPanel {...wireCopy(props)} />);
    expect(calculate).not.toHaveBeenCalled();
    expect(formatTokens).not.toHaveBeenCalled();
    expect(cards()[0]).toBe(activeCard);
    expect(cards()[1]).toBe(historicalCard);
  }
  for (let update = 1; update <= 3; update += 1) {
    formatTokens.mockClear();
    view.rerender(<PricingPanel {...wireCopy({
      ...props,
      pricing: { ...props.pricing, lines: [{ ...active, uncachedInputTokens: 234567 + update }, historical] },
    })} />);
    expect(formatTokens).toHaveBeenCalledWith(234567 + update);
    expect(formatTokens).not.toHaveBeenCalledWith(123456);
    expect(cards()[0]).toBe(activeCard);
    expect(cards()[1]).toBe(historicalCard);
  }
  formatTokens.mockClear();
  const inserted = buildMonitorLine({
    usageLineId: "inserted", uncachedInputTokens: 345678, createdAt: 1_800_000_020_000,
  });
  view.rerender(<PricingPanel {...wireCopy({
    ...props, pricing: { ...props.pricing, lines: [inserted, active, historical] },
  })} />);
  expect(cards()).toHaveLength(3);
  expect(cards()[1]).toBe(activeCard);
  expect(cards()[2]).toBe(historicalCard);
  expect(formatTokens).toHaveBeenCalledWith(345678);
  expect(formatTokens).not.toHaveBeenCalledWith(123456);

  // A late historical correction also changes subsequent running totals.
  const previousActiveText = activeCard?.textContent;
  view.rerender(<PricingPanel {...wireCopy({
    ...props, pricing: { ...props.pricing, lines: [active, { ...historical, totalCostMicros: 9_000_000 }] },
  })} />);
  expect(cards()[0]).toBe(activeCard);
  expect(activeCard?.textContent).not.toBe(previousActiveText);
  expect(historicalCard).toHaveTextContent("$9");

  // IDs can be reused by another thread. Its cards must get fresh instances.
  view.rerender(<PricingPanel {...wireCopy({
    ...props, pricing: { ...props.pricing, lines: [active, historical].map((line) => ({ ...line, threadId: "other-thread" })) },
  })} />);
  expect(cards()[0]).not.toBe(activeCard);
  expect(cards()[1]).not.toBe(historicalCard);
});

it("retains expanded Token Miser cards and only reformats the changed gate", () => {
  const formatTokens = vi.spyOn(formatting, "formatTokenCount");
  const parent = buildMonitorLine({
    usageLineId: "parent", scope: "turn", source: "live", turnId: "parent-turn",
    uncachedInputTokens: 111111,
  });
  const gate = buildMonitorLine({
    usageLineId: "gate", sourceItemId: "system:token-miser:gate",
    createdAt: parent.createdAt + 1000, uncachedInputTokens: 222222,
  });
  const props: ComponentProps<typeof PricingPanel> = {
    pricing: { lines: [parent, gate], summaries: [] },
    subAgents: [{
      monitorId: gate.sourceItemId!, parentTurnId: "parent-turn", agentName: "Token Miser",
      status: "success", task: "Fixture gate", createdAt: gate.createdAt, updatedAt: gate.createdAt,
      tokenMiserAccounting: {
        baselineParentCostMicros: 500_000, baselineParentTokens: 10000,
        currency: "USD", gateCostMicros: 2000, gateModel: "gpt-5.6-luna",
        gateTotalTokens: 2100, originalModel: "gpt-5.6-sol",
        revealedParentCostMicros: 1500, revealedParentTokens: 300, savingsMicros: 496500,
      },
    }],
  };
  const sibling = { ...gate, usageLineId: "sibling-gate", sourceItemId: "system:token-miser:sibling", uncachedInputTokens: 333333 };
  props.pricing!.lines.push(sibling);
  props.subAgents!.push({ ...wireCopy(props.subAgents![0]!), monitorId: sibling.sourceItemId });
  const view = render(<PricingPanel {...wireCopy(props)} />);
  const fold = view.getByRole("button", { name: /Token Miser.*saved/ });
  act(() => { fold.click(); });
  const gateCard = view.container.querySelector(".pricing-token-miser li.pricing-usage-row");
  expect(gateCard).not.toBeNull();
  formatTokens.mockClear();
  view.rerender(<PricingPanel {...wireCopy(props)} />);
  expect(fold).toHaveAttribute("aria-expanded", "true");
  expect(view.container.querySelector(".pricing-token-miser li.pricing-usage-row")).toBe(gateCard);
  expect(formatTokens).not.toHaveBeenCalled();

  const changed = wireCopy(props);
  changed.subAgents![0]!.tokenMiserAccounting!.savingsMicros = 396500;
  view.rerender(<PricingPanel {...changed} />);
  expect(fold).toHaveAttribute("aria-expanded", "true");
  expect(fold).toHaveTextContent("$0.90 saved");
  expect(view.container.querySelector(".pricing-token-miser li.pricing-usage-row")).toBe(gateCard);
  expect(formatTokens).toHaveBeenCalledWith(222222);
  expect(formatTokens).not.toHaveBeenCalledWith(333333);

  const switched = wireCopy(changed);
  switched.pricing!.lines = switched.pricing!.lines.map((line) => ({ ...line, threadId: "other-thread" }));
  view.rerender(<PricingPanel {...switched} />);
  const newFold = view.getByRole("button", { name: /Token Miser.*saved/ });
  expect(newFold).not.toBe(fold);
  expect(newFold).toHaveAttribute("aria-expanded", "false");
});

it("keeps card formatting static when the transcript scroll callback changes, but invokes its latest handler", () => {
  const formatTokens = vi.spyOn(formatting, "formatTokenCount");
  const line = buildMonitorLine({ scope: "turn", source: "live", turnId: "turn-1" });
  const pricing = { lines: [line], summaries: [] };
  const first = vi.fn();
  const latest = vi.fn();
  const view = render(<PricingPanel pricing={pricing} onScrollToTurn={first} />);
  const button = view.getByRole("button", { name: /Scroll the transcript to this turn/ });
  formatTokens.mockClear();
  view.rerender(<PricingPanel pricing={wireCopy(pricing)} onScrollToTurn={latest} />);
  expect(formatTokens).not.toHaveBeenCalled();
  expect(view.getByRole("button", { name: /Scroll the transcript to this turn/ })).toBe(button);
  act(() => { button.click(); });
  expect(first).not.toHaveBeenCalled();
  expect(latest).toHaveBeenCalledWith("turn-1", line.createdAt);
  view.rerender(<PricingPanel pricing={wireCopy(pricing)} />);
  expect(view.queryByRole("button", { name: /Scroll the transcript to this turn/ })).toBeNull();
});

it("formats one changed card out of a full page of twenty remote usage rows", () => {
  const formatTokens = vi.spyOn(formatting, "formatTokenCount");
  const thread: NonNullable<ComponentProps<typeof PricingPanel>["thread"]> = { source: "codex", id: "thread-1", updatedAt: 0,
    federation: { ref: { backend: "codex", threadId: "thread-1", target: { scope: "remote", instanceId: "owner" } },
      instanceLabel: "Owner", capabilities: ["thread_detail", "event_subscriptions"] } };
  const lines = Array.from({ length: 20 }, (_, index) => buildMonitorLine({
    usageLineId: `row-${index}`, createdAt: 1_800_000_000_000 + index * 1000,
    scope: "turn", source: "live", turnId: `turn-${index}`,
    uncachedInputTokens: 1000 + index,
  }));
  const view = render(<PricingPanel thread={thread} activeTurnId="turn-19" pricing={{ lines, summaries: [] }} />);
  const before = Array.from(view.container.querySelectorAll("li.pricing-usage-row"));
  expect(before).toHaveLength(20);
  for (let update = 1; update <= 5; update += 1) {
    formatTokens.mockClear();
    const next = wireCopy(lines);
    next[19]!.uncachedInputTokens += update;
    next[19]!.totalCostMicros += update * 1000;
    view.rerender(<PricingPanel thread={{ ...wireCopy(thread), updatedAt: update }} activeTurnId="turn-19" pricing={{ lines: next, summaries: [] }} />);
    // Three token fields in the changed card; none of the 19 historical cards.
    expect(formatTokens).toHaveBeenCalledTimes(3);
    expect(formatTokens).toHaveBeenCalledWith(1019 + update);
    const after = Array.from(view.container.querySelectorAll("li.pricing-usage-row"));
    after.forEach((card, index) => { expect(card).toBe(before[index]); });
  }
});

it("renders owner-prepared pricing with the same visible values and no viewer ledger calculation", () => {
  const pricing = { lines: [buildMonitorLine({ scope: "turn", turnId: "turn-1", source: "live", completedAt: 1_800_000_000_999 })], summaries: [] };
  const display = spend.buildThreadPricingDisplay({ pricing });
  const legacy = render(<PricingPanel pricing={pricing} />);
  const text = legacy.container.textContent;
  legacy.unmount();
  const calculate = vi.spyOn(spend, "buildThreadPricingDisplay");
  const view = render(<PricingPanel display={display} />);
  expect(view.container.textContent).toBe(text);
  expect(calculate).not.toHaveBeenCalled();
});


it("loads and refreshes only expanded Pricing gate pages while preserving folded totals", async () => {
  const parent = buildMonitorLine({ scope: "turn", source: "live", usageLineId: "parent", turnId: "parent-turn" });
  const gates = Array.from({ length: 23 }, (_, index) => buildMonitorLine({
    usageLineId: `gate-${index}`, sourceItemId: `system:token-miser:${index}`, turnId: `helper-${index}`,
    createdAt: parent.createdAt + index + 1,
  }));
  const subAgents: ThreadSubAgentSummary[] = gates.map((gate, index) => ({
    monitorId: gate.sourceItemId!, parentTurnId: parent.turnId, createdAt: gate.createdAt, updatedAt: gate.createdAt + 500,
    task: "Hidden gate task", status: "success", preferredModel: "gpt-5.6-luna",
    tokenMiserAccounting: {
      currency: "USD", originalModel: "gpt-5.5", gateModel: "gpt-5.6-luna", baselineParentTokens: 1000, baselineParentCostMicros: 201_100,
      gateTotalTokens: 110, gateCostMicros: 1000, revealedParentTokens: 100, revealedParentCostMicros: 100,
      savingsMicros: index < 21 ? 200_000 : 1000,
    },
  }));
  const input = { pricing: { lines: [parent, ...gates], summaries: [] }, subAgents };
  const display = spend.buildThreadPricingDisplay({ ...input, deferGates: true });
  const legacy = render(<PricingPanel {...input} />);
  const visibleText = legacy.container.textContent;
  legacy.unmount();
  const listeners = new Set<(event: AgentEvent) => void>();
  const readThread = vi.fn<NonNullable<DesktopApi["readThread"]>>(async (request) => {
    const offset = Number(request.display?.cursor ?? 0);
    const pricingPage = spend.buildThreadPricingDisplay({ ...input, deferGates: true,
      gateSelection: request.display?.pricingGateGroup, offset, limit: 20 });
    return { backend: "codex", threadId: "thread-1", fetchedAt: 1, replay: { entries: [], messages: [], pagination: { supportsPagination: true, hasPreviousPage: false } },
      display: { pricing: pricingPage, pricingPage, revision: "r", nextCursor: offset + 20 < pricingPage.totalRows ? String(offset + 20) : undefined } };
  });
  const desktopApi: DesktopApi = { readThread, onAgentEvent: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; } };
  const thread: NavigationThreadSummary = { source: "codex", id: "thread-1", title: "Fixture", titleSource: "explicit", linkedDirectories: [], inbox: { inInbox: false },
    federation: { ref: { backend: "codex", threadId: "thread-1", target: { scope: "remote", instanceId: "owner" } }, instanceLabel: "Owner", capabilities: ["thread_detail", "event_subscriptions"] } };
  const view = render(<PricingPanel display={display} thread={thread} desktopApi={desktopApi} />);
  expect(view.container.textContent).toBe(visibleText);
  expect(readThread).not.toHaveBeenCalled();
  const fold = view.getByRole("button", { name: /Token Miser.*saved/ });
  act(() => fold.click());
  await waitFor(() => expect(view.container.querySelectorAll(".pricing-token-miser li.pricing-usage-row")).toHaveLength(20));
  expect(readThread.mock.calls[0]![0]).toMatchObject({ federationTarget: { scope: "remote", instanceId: "owner" },
    display: { resource: "pricing", deferPricingGates: true, limit: 20, pricingGateGroup: { usageLineId: "parent", filter: "primary" } } });
  act(() => view.getByRole("button", { name: "Show more gates" }).click());
  await waitFor(() => expect(view.container.querySelectorAll(".pricing-token-miser li.pricing-usage-row")).toHaveLength(21));
  expect(fold).toHaveTextContent("$4.21 saved");
  expect(fold).toHaveTextContent("23 gates");
  act(() => view.getByRole("button", { name: /Show 2 smaller gates/ }).click());
  await waitFor(() => expect(view.container.querySelectorAll(".pricing-token-miser li.pricing-usage-row")).toHaveLength(23));
  expect(readThread.mock.calls[2]![0].display?.pricingGateGroup?.filter).toBe("small");
  vi.useFakeTimers();
  const invalidate = () => {
    for (const listener of listeners) listener({ backend: "codex", federationTarget: { scope: "remote", instanceId: "owner" },
      notification: { method: "thread/pricing/updated", params: { threadId: "thread-1", displayInvalidated: true, pricing: { lines: [], summaries: [] } } } });
  };
  await act(async () => { invalidate(); invalidate(); await vi.advanceTimersByTimeAsync(250); });
  // The two opened primary pages and one smaller-gate page are revalidated once.
  expect(readThread).toHaveBeenCalledTimes(6);
  expect(fold).toHaveAttribute("aria-expanded", "true");
  act(() => fold.click());
  expect(listeners.size).toBe(0);
  await act(async () => { invalidate(); await vi.advanceTimersByTimeAsync(250); });
  expect(readThread).toHaveBeenCalledTimes(6);
});
