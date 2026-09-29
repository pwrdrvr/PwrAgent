import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ReadFederationActivityResponse, UsageLimitObservation } from "@pwragent/shared";
import { UsageActivity } from "./UsageActivity";
import { usageFixture } from "./usage-activity-fixture";
import { chooseSelectOption } from "../../test/select";

const HOUR = 3_600_000;

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function chooseCustomRange(from: string, to: string) {
  fireEvent.click(within(screen.getByRole("group", { name: "Period" })).getByRole("button", { name: "Custom" }));
  fireEvent.change(screen.getByLabelText("From"), { target: { value: from } });
  fireEvent.change(screen.getByLabelText("To"), { target: { value: to } });
}

it("reads only on demand, reports missing peers, and analyzes the selected turn on its owner", async () => {
  const at = new Date(2026, 8, 28, 10).getTime();
  const readUsageActivity = vi.fn(async (request) => {
    if (request.federationTarget?.instanceId === "offline") throw new Error("Peer offline");
    return { rows: request.federationTarget?.scope === "local" ? [] : [usageFixture({ createdAt: at, startedAt: at, completedAt: at + 1000 })],
      readAt: at + 2000, rateLimits: [], truncated: false };
  });
  const analyzeUsageActivity = vi.fn(async () => ({ analysis: "A bounded diagnosis.", model: "gpt-6-luna", entries: 4, characters: 8000,
    truncated: true, hasEarlierHistory: true, scope: "turn" as const, pagesRead: 1 }));
  const readFederationActivity = vi.fn(async () => ({ health: { localLabel: "Local", peers: [
    { id: "owner", label: "Owner", status: "connected" },
    { id: "offline", label: "Offline", status: "disconnected" },
  ] } }) as ReadFederationActivityResponse);
  render(<UsageActivity desktopApi={{ readUsageActivity, analyzeUsageActivity, readFederationActivity }} />);
  expect(readUsageActivity).not.toHaveBeenCalled();
  await waitFor(() => expect(within(screen.getByRole("group", { name: "Instances" })).getAllByRole("button")).toHaveLength(3));
  chooseCustomRange("2026-09-28T09:00", "2026-09-28T11:00");
  fireEvent.click(screen.getByRole("button", { name: "Load activity" }));
  expect(await screen.findByText("Offline is unavailable.")).toBeInTheDocument();
  expect(readUsageActivity).toHaveBeenCalledTimes(3);
  expect(analyzeUsageActivity).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Inspect Fixture thread" }));
  expect(screen.getByText(/This is a model call of its own, and it uses your limit/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Analyze turn" }));
  await screen.findByText("A bounded diagnosis.");
  expect(analyzeUsageActivity).toHaveBeenCalledExactlyOnceWith({ backend: "codex", threadId: "thread", turnId: "turn",
    federationTarget: { scope: "remote", instanceId: "owner" }, model: "gpt-6-luna", entryLimit: 40, characterLimit: 20000 });

  fireEvent.click(within(screen.getByRole("group", { name: "Analysis scope" })).getByRole("button", { name: "Recent entries" }));
  fireEvent.click(screen.getByRole("button", { name: "Analyze thread" }));
  await waitFor(() => expect(analyzeUsageActivity).toHaveBeenCalledTimes(2));
  expect(analyzeUsageActivity).toHaveBeenLastCalledWith({ backend: "codex", threadId: "thread",
    federationTarget: { scope: "remote", instanceId: "owner" }, model: "gpt-6-luna", entryLimit: 40, characterLimit: 20000 });
});

it("skips a disabled instance without reading it", async () => {
  const at = new Date(2026, 8, 28, 10).getTime();
  const readUsageActivity = vi.fn(async () => ({ rows: [], readAt: at, rateLimits: [], truncated: false }));
  const readFederationActivity = vi.fn(async () => ({ health: { localLabel: "Local", peers: [
    { id: "owner", label: "Owner", status: "connected" },
  ] } }) as ReadFederationActivityResponse);
  render(<UsageActivity desktopApi={{ readUsageActivity, readFederationActivity }} />);
  const owner = await screen.findByRole("button", { name: "Owner" });
  fireEvent.click(owner);
  expect(owner).toHaveAttribute("aria-pressed", "false");
  // The last enabled instance cannot be turned off.
  fireEvent.click(screen.getByRole("button", { name: "Local" }));
  expect(screen.getByRole("button", { name: "Local" })).toHaveAttribute("aria-pressed", "true");
  chooseCustomRange("2026-09-28T09:00", "2026-09-28T11:00");
  fireEvent.click(screen.getByRole("button", { name: "Load activity" }));
  await waitFor(() => expect(readUsageActivity).toHaveBeenCalledTimes(1));
  expect(readUsageActivity).toHaveBeenCalledWith(expect.objectContaining({ federationTarget: { scope: "local" } }));
});

it("filters and ranks threads without rereading or launching analysis", async () => {
  const at = new Date(2026, 8, 28, 10).getTime();
  const row = usageFixture({ createdAt: at, startedAt: at, completedAt: at + 1000 });
  const later = { ...usageFixture({ threadId: "other", usageLineId: "other", completedAt: at + HOUR, createdAt: at, startedAt: at, totalCostMicros: 900, inputTokens: 20, uncachedInputTokens: 10, cachedInputTokens: 10, outputTokens: 10 }), title: "Later thread" };
  const readUsageActivity = vi.fn(async () => ({ rows: [row, later], readAt: at, rateLimits: [], truncated: false }));
  const analyzeUsageActivity = vi.fn();
  render(<UsageActivity desktopApi={{ readUsageActivity, analyzeUsageActivity }} />);
  chooseCustomRange("2026-09-28T09:00", "2026-09-28T12:00");
  fireEvent.click(screen.getByRole("button", { name: "Load activity" }));
  await screen.findByRole("button", { name: "Inspect Later thread" });
  expect(screen.getAllByRole("button", { name: /^Inspect / })[0]).toHaveAccessibleName("Inspect Later thread");
  chooseSelectOption(screen.getByLabelText("Sort threads"), "Most tokens");
  expect(screen.getAllByRole("button", { name: /^Inspect / })[0]).toHaveAccessibleName("Inspect Fixture thread");
  fireEvent.change(screen.getByLabelText("Find a thread"), { target: { value: "Later" } });
  expect(screen.queryByRole("button", { name: "Inspect Fixture thread" })).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Find a thread"), { target: { value: "" } });
  const plot = screen.getByRole("group", { name: "Filter threads by completion time" });
  fireEvent.click(within(plot).getAllByRole("button")[8]);
  expect(screen.queryByRole("button", { name: "Inspect Later thread" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Inspect Fixture thread" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /Clear time filter/ }));
  expect(screen.getByRole("button", { name: "Inspect Later thread" })).toBeInTheDocument();
  expect(readUsageActivity).toHaveBeenCalledTimes(1);
  expect(analyzeUsageActivity).not.toHaveBeenCalled();
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
  fireEvent.click(screen.getByRole("button", { name: "Load activity" }));
  expect(await screen.findByText(/Unexpected reset seen/)).toBeInTheDocument();
  // The window was known to be shorter than the provisional read, so nothing is read twice.
  expect(readUsageActivity).toHaveBeenCalledTimes(1);
  expect(readUsageActivity).toHaveBeenCalledWith(expect.objectContaining({ from: now - 8 * 24 * HOUR, to: now }));
  expect(screen.getByRole("img", { name: "Weekly limit 7% used" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Inspect After the reset" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Inspect Before the reset" })).not.toBeInTheDocument();
  // A turn that finished before the reset is outside the window, not an excluded interval.
  expect(screen.queryByRole("button", { name: /excluded interval/ })).not.toBeInTheDocument();
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
  fireEvent.click(screen.getByRole("button", { name: "Load activity" }));
  expect(await screen.findByRole("img", { name: "Individual limit 37% used" })).toBeInTheDocument();
  expect(screen.getByText(/37.2K of 100K used/)).toBeInTheDocument();
  expect(screen.getByText("Available")).toBeInTheDocument();
  expect(readUsageActivity).toHaveBeenCalledTimes(2);
  expect(readUsageActivity).toHaveBeenLastCalledWith(expect.objectContaining({ from: new Date(2026, 7, 30).getTime(), to: now }));
});
