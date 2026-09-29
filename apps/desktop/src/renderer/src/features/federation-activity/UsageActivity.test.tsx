import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ReadFederationActivityResponse, UsageLimitObservation } from "@pwragent/shared";
import { UsageActivity } from "./UsageActivity";
import { usageFixture } from "./usage-activity-fixture";
import { chooseSelectOption } from "../../test/select";

const HOUR = 3_600_000;

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function choosePeriod(label: string) {
  fireEvent.click(within(screen.getByRole("group", { name: "Period" })).getByRole("button", { name: label }));
}

function chooseCustomRange(from: string, to: string) {
  choosePeriod("Custom");
  fireEvent.change(screen.getByLabelText("From"), { target: { value: from } });
  fireEvent.change(screen.getByLabelText("To"), { target: { value: to } });
}

const peers = (list: Array<{ id: string; label: string; status: string }>) =>
  vi.fn(async () => ({ health: { localLabel: "Local", peers: list } }) as ReadFederationActivityResponse);

it("reads on open, skips offline peers, names outdated ones, and analyzes the selected turn on its owner", async () => {
  const now = new Date(2026, 8, 28, 12).getTime();
  vi.spyOn(Date, "now").mockReturnValue(now);
  const readUsageActivity = vi.fn(async (request) => {
    if (request.federationTarget?.instanceId === "old") {
      throw new Error("Error invoking remote method 'usage-activity:readUsageActivity': Error: method_not_found: No federation handler registered for backend.readUsageActivity");
    }
    return { rows: request.federationTarget?.scope === "local" ? []
      : [usageFixture({ createdAt: now - 2 * HOUR, startedAt: now - 2 * HOUR, completedAt: now - HOUR })],
    readAt: now, rateLimits: [], truncated: false };
  });
  const analyzeUsageActivity = vi.fn(async () => ({ analysis: "A bounded diagnosis.", model: "gpt-6-luna", entries: 4, characters: 8000,
    truncated: true, hasEarlierHistory: true, scope: "turn" as const, pagesRead: 1 }));
  const readFederationActivity = peers([
    { id: "owner", label: "Owner", status: "connected" },
    { id: "old", label: "Old", status: "connected" },
    { id: "offline", label: "Offline", status: "disconnected" },
  ]);
  render(<UsageActivity desktopApi={{ readUsageActivity, analyzeUsageActivity, readFederationActivity }} />);
  expect(await screen.findByRole("button", { name: "Inspect Fixture thread" })).toBeInTheDocument();
  // Discovery settles before the first read, so peers are read once, and an offline peer not at all.
  expect(readUsageActivity).toHaveBeenCalledTimes(3);
  expect(readUsageActivity).not.toHaveBeenCalledWith(expect.objectContaining({ federationTarget: { scope: "remote", instanceId: "offline" } }));
  expect(screen.getByRole("button", { name: "Offline" })).toBeDisabled();
  expect(screen.getByRole("status")).toHaveTextContent("Not included: Old needs a PwrAgent update to share usage · Offline is offline.");
  expect(analyzeUsageActivity).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Dismiss notice" }));
  expect(screen.queryByText(/Not included/)).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Inspect Fixture thread" }));
  expect(screen.getByText(/This is a model call of its own, and it uses your limit/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Analyze turn" }));
  await screen.findByText("A bounded diagnosis.");
  expect(screen.getByRole("button", { name: "Analyze turn again" })).toBeEnabled();
  expect(analyzeUsageActivity).toHaveBeenCalledExactlyOnceWith({ backend: "codex", threadId: "thread", turnId: "turn",
    federationTarget: { scope: "remote", instanceId: "owner" }, model: "gpt-6-luna", entryLimit: 40, characterLimit: 20000 });

  fireEvent.click(within(screen.getByRole("group", { name: "Analysis scope" })).getByRole("button", { name: "Recent entries" }));
  fireEvent.click(screen.getByRole("button", { name: "Analyze thread" }));
  await waitFor(() => expect(analyzeUsageActivity).toHaveBeenCalledTimes(2));
  expect(analyzeUsageActivity).toHaveBeenLastCalledWith({ backend: "codex", threadId: "thread",
    federationTarget: { scope: "remote", instanceId: "owner" }, model: "gpt-6-luna", entryLimit: 40, characterLimit: 20000 });
});

it("keeps the list usable while an analysis runs, and keeps its answer with the turn it read", async () => {
  const now = new Date(2026, 8, 28, 12).getTime();
  vi.spyOn(Date, "now").mockReturnValue(now);
  const rows = ["first", "second"].map((id, index) => ({ ...usageFixture({ threadId: id, usageLineId: id, turnId: `${id}-turn`,
    createdAt: now - 3 * HOUR, startedAt: now - 3 * HOUR, completedAt: now - HOUR, totalCostMicros: (2 - index) * 1_000_000 }), title: `${id} thread` }));
  let fail!: (cause: Error) => void;
  const analyzeUsageActivity = vi.fn(() => new Promise<never>((_resolve, reject) => { fail = reject; }));
  const readUsageActivity = vi.fn(async () => ({ rows, readAt: now, rateLimits: [], truncated: false }));
  render(<UsageActivity desktopApi={{ readUsageActivity, analyzeUsageActivity }} />);
  fireEvent.click(await screen.findByRole("button", { name: "Inspect first thread" }));
  fireEvent.click(screen.getByRole("button", { name: "Analyze turn" }));
  expect(screen.getByText(/Reading on This instance and asking GPT-6-Luna · 0 s/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Analyzing…" })).toBeDisabled();

  // Other threads stay open to inspection; only a second analysis waits.
  fireEvent.click(screen.getByRole("button", { name: "Inspect second thread" }));
  expect(screen.getByText("Another thread's analysis is still running.")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Analyze turn" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled();

  await act(async () => { fail(new Error("Error invoking remote method 'usage-activity:analyzeUsageActivity': Error: turn_control permission required")); });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Analyze turn" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Inspect first thread" }));
  expect(screen.getByRole("alert")).toHaveTextContent("Analysis failedturn_control permission required");
});

it("warns when the pace reaches the limit before its reset and draws that ahead of now", async () => {
  const now = new Date(2026, 8, 28, 12).getTime();
  vi.spyOn(Date, "now").mockReturnValue(now);
  // Four days into the week at 80%: 100% a day from now, two days before the reset.
  const observation: UsageLimitObservation = { observedAt: now, accountKey: "acct", planType: "plus",
    limits: [{ name: "Weekly limit", windowKey: "secondary", usedPercent: 80, resetAt: now + 3 * 24 * HOUR, windowMinutes: 10_080 }] };
  const readUsageActivity = vi.fn(async () => ({ rows: [], readAt: now, rateLimits: [], truncated: false, limitObservation: observation }));
  render(<UsageActivity desktopApi={{ readUsageActivity }} />);
  expect(await screen.findByText(/On pace to reach 100% .*, 2 days before the reset/)).toBeInTheDocument();
  expect(screen.getByText("At this pace")).toBeInTheDocument();
  expect(screen.getByText("Now")).toBeInTheDocument();
  // The reset lies past the 40% cap; the 100% crossing a day out is inside it.
  expect(screen.getByText(/^100% /)).toBeInTheDocument();
  expect(screen.queryByText(/^Resets /)).not.toBeInTheDocument();

  // A clock window is history only.
  choosePeriod("7 days");
  await waitFor(() => expect(screen.queryByText("Now")).not.toBeInTheDocument());
  expect(screen.getByText(/On pace to reach 100%/)).toBeInTheDocument();
});

it("rereads when the period or instances change, and on focus once the data is stale", async () => {
  let now = new Date(2026, 8, 28, 12).getTime();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const readUsageActivity = vi.fn(async () => ({ rows: [], readAt: now, rateLimits: [], truncated: false }));
  render(<UsageActivity desktopApi={{ readUsageActivity, readFederationActivity: peers([{ id: "owner", label: "Owner", status: "connected" }]) }} />);
  await waitFor(() => expect(readUsageActivity).toHaveBeenCalledTimes(2));

  choosePeriod("7 days");
  await waitFor(() => expect(readUsageActivity).toHaveBeenCalledTimes(4));
  expect(readUsageActivity).toHaveBeenLastCalledWith(expect.objectContaining({ from: now - 7 * 24 * HOUR, to: now }));

  // Turning an instance off rereads the rest; the last one cannot be turned off.
  fireEvent.click(screen.getByRole("button", { name: "Owner" }));
  await waitFor(() => expect(readUsageActivity).toHaveBeenCalledTimes(5));
  expect(readUsageActivity).toHaveBeenLastCalledWith(expect.objectContaining({ federationTarget: { scope: "local" } }));
  fireEvent.click(screen.getByRole("button", { name: "Local" }));
  expect(screen.getByRole("button", { name: "Local" })).toHaveAttribute("aria-pressed", "true");

  // Fresh data survives a focus; stale data is reread.
  act(() => { window.dispatchEvent(new Event("focus")); });
  expect(readUsageActivity).toHaveBeenCalledTimes(5);
  now += 2 * 60_000;
  act(() => { window.dispatchEvent(new Event("focus")); });
  await waitFor(() => expect(readUsageActivity).toHaveBeenCalledTimes(6));
});

it("filters and ranks threads without rereading or launching analysis", async () => {
  const at = new Date(2026, 8, 28, 10).getTime();
  const row = usageFixture({ createdAt: at, startedAt: at, completedAt: at + 1000 });
  const later = { ...usageFixture({ threadId: "other", usageLineId: "other", completedAt: at + HOUR, createdAt: at, startedAt: at, totalCostMicros: 900, inputTokens: 20, uncachedInputTokens: 10, cachedInputTokens: 10, outputTokens: 10 }), title: "Later thread" };
  const readUsageActivity = vi.fn(async () => ({ rows: [row, later], readAt: at, rateLimits: [], truncated: false }));
  const analyzeUsageActivity = vi.fn();
  render(<UsageActivity desktopApi={{ readUsageActivity, analyzeUsageActivity }} />);
  chooseCustomRange("2026-09-28T09:00", "2026-09-28T12:00");
  await waitFor(() => expect(readUsageActivity).toHaveBeenLastCalledWith(expect.objectContaining({ from: new Date(2026, 8, 28, 9).getTime() })));
  await screen.findByRole("button", { name: "Inspect Later thread" });
  const reads = readUsageActivity.mock.calls.length;
  expect(screen.getAllByRole("button", { name: /^Inspect / })[0]).toHaveAccessibleName("Inspect Later thread");
  chooseSelectOption(screen.getByLabelText("Sort threads"), "Most tokens");
  expect(screen.getAllByRole("button", { name: /^Inspect / })[0]).toHaveAccessibleName("Inspect Fixture thread");
  fireEvent.change(screen.getByLabelText("Find a thread"), { target: { value: "Later" } });
  expect(screen.queryByRole("button", { name: "Inspect Fixture thread" })).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Find a thread"), { target: { value: "" } });
  const plot = screen.getByRole("group", { name: "Filter threads by completion time" });
  // Three hours draw as quarter-hour bars on the clock.
  expect(within(plot).getAllByRole("button")).toHaveLength(12);
  fireEvent.click(within(plot).getByRole("button", { name: /^10\sAM–10:15\sAM:/ }));
  expect(screen.queryByRole("button", { name: "Inspect Later thread" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Inspect Fixture thread" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /Clear time filter/ }));
  expect(screen.getByRole("button", { name: "Inspect Later thread" })).toBeInTheDocument();
  expect(readUsageActivity).toHaveBeenCalledTimes(reads);
  expect(analyzeUsageActivity).not.toHaveBeenCalled();
});

it("opens a charted thread in the main window, on its owner", async () => {
  const now = new Date(2026, 8, 28, 12).getTime();
  vi.spyOn(Date, "now").mockReturnValue(now);
  const readUsageActivity = vi.fn(async (request) => ({ readAt: now, rateLimits: [], truncated: false,
    rows: request.federationTarget?.scope === "remote"
      ? [{ ...usageFixture({ threadId: "peer-thread", createdAt: now - 2 * HOUR, startedAt: now - 2 * HOUR, completedAt: now - HOUR }), title: "Peer thread" }]
      : [] }));
  const openUsageThreadInMainWindow = vi.fn(async () => undefined);
  render(<UsageActivity desktopApi={{ readUsageActivity, openUsageThreadInMainWindow,
    readFederationActivity: peers([{ id: "owner", label: "Owner", status: "connected" }]) }} />);
  fireEvent.click(await screen.findByRole("button", { name: "Open Peer thread" }));
  expect(openUsageThreadInMainWindow).toHaveBeenCalledExactlyOnceWith({ backend: "codex", threadId: "peer-thread",
    federationTarget: { scope: "remote", instanceId: "owner" } });
  fireEvent.click(screen.getByRole("button", { name: "Inspect Peer thread" }));
  fireEvent.click(screen.getByRole("button", { name: "Open thread ↗" }));
  expect(openUsageThreadInMainWindow).toHaveBeenCalledTimes(2);
});

it("says why work is not counted", async () => {
  const now = new Date(2026, 8, 28, 12).getTime();
  vi.spyOn(Date, "now").mockReturnValue(now);
  const running = { ...usageFixture({ threadId: "running", usageLineId: "running", createdAt: now - HOUR, startedAt: now - HOUR, completedAt: undefined }), title: "Running thread" };
  const earlier = { ...usageFixture({ threadId: "earlier", usageLineId: "earlier", createdAt: now - 30 * HOUR, startedAt: now - 30 * HOUR, completedAt: now - 20 * HOUR }), title: "Earlier thread" };
  const readUsageActivity = vi.fn(async () => ({ rows: [running, earlier], readAt: now, rateLimits: [], truncated: false }));
  render(<UsageActivity desktopApi={{ readUsageActivity }} />);
  choosePeriod("24 h");
  fireEvent.click(await screen.findByRole("button", { name: "2 not counted" }));
  expect(within(screen.getByRole("button", { name: "Inspect Running thread" })).getByText("Still running, or its end was never recorded")).toBeInTheDocument();
  expect(within(screen.getByRole("button", { name: "Inspect Earlier thread" })).getByText("Started before this period")).toBeInTheDocument();
});

it("starts Since reset at an unexpected reset and says so", async () => {
  const now = new Date(2026, 8, 28, 12).getTime();
  vi.spyOn(Date, "now").mockReturnValue(now);
  // The weekly schedule says the window began days ago; a reset at 9:30 restarted it.
  const resetAt = now + 4 * 24 * HOUR;
  const reading = (at: number, usedPercent: number): UsageLimitObservation => ({ observedAt: at, accountKey: "acct", planType: "plus",
    limits: [{ name: "Weekly limit", windowKey: "secondary", usedPercent, resetAt, windowMinutes: 10_080 }] });
  const before = { ...usageFixture({ threadId: "before", usageLineId: "before", createdAt: now - 5 * HOUR, startedAt: now - 5 * HOUR, completedAt: now - 4 * HOUR }), title: "Before the reset" };
  const after = { ...usageFixture({ threadId: "after", usageLineId: "after", createdAt: now - HOUR, startedAt: now - HOUR, completedAt: now - 30 * 60_000 }), title: "After the reset" };
  const readUsageActivity = vi.fn(async () => ({ rows: [before, after], readAt: now, rateLimits: [], truncated: false,
    limitObservation: reading(now - 10 * 60_000, 7),
    limitHistory: [reading(now - 4 * HOUR, 62), reading(now - 2.5 * HOUR, 1), reading(now - 10 * 60_000, 7)] }));
  render(<UsageActivity desktopApi={{ readUsageActivity }} />);
  expect(within(screen.getByRole("group", { name: "Period" })).getByRole("button", { name: "Since reset" })).toHaveAttribute("aria-pressed", "true");
  expect(await screen.findByText(/Unexpected reset seen/)).toBeInTheDocument();
  // The window was known to be shorter than the provisional read, so nothing is read twice.
  expect(readUsageActivity).toHaveBeenCalledTimes(1);
  expect(readUsageActivity).toHaveBeenCalledWith(expect.objectContaining({ from: now - 8 * 24 * HOUR, to: now }));
  expect(screen.getByRole("img", { name: "Weekly limit 7% used" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Inspect After the reset" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Inspect Before the reset" })).not.toBeInTheDocument();
  // A turn that finished before the reset is outside the window, not work left uncounted.
  expect(screen.queryByRole("button", { name: /not counted/ })).not.toBeInTheDocument();
});

it("reads a monthly credit limit from its start, once more, within the 31-day bound", async () => {
  const now = new Date(2026, 8, 28, 12).getTime();
  vi.spyOn(Date, "now").mockReturnValue(now);
  const credit: UsageLimitObservation = { observedAt: now - HOUR, accountKey: "work", planType: "business", limits: [
    { name: "Individual limit", windowKey: "individual", usedPercent: 37.2, used: 37_223, limit: 100_000, resetAt: new Date(2026, 8, 30).getTime() },
    { name: "Credits", windowKey: "credits", hasCredits: true },
  ] };
  const readUsageActivity = vi.fn(async () => ({ rows: [], readAt: now, rateLimits: [], truncated: false, limitObservation: credit }));
  render(<UsageActivity desktopApi={{ readUsageActivity }} />);
  expect(await screen.findByRole("img", { name: "Individual limit 37% used" })).toBeInTheDocument();
  expect(screen.getByText(/37.2K of 100K used/)).toBeInTheDocument();
  expect(screen.getByText("Available")).toBeInTheDocument();
  expect(readUsageActivity).toHaveBeenCalledTimes(2);
  expect(readUsageActivity).toHaveBeenLastCalledWith(expect.objectContaining({ from: new Date(2026, 7, 30).getTime(), to: now }));
});
