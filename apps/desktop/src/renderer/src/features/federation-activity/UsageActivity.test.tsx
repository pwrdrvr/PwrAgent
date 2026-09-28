import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ReadFederationActivityResponse } from "@pwragent/shared";
import { UsageActivity } from "./UsageActivity";
import { usageFixture } from "./usage-activity-fixture";
import { chooseSelectOption } from "../../test/select";

afterEach(cleanup);

it("reads only on demand, reports missing peers, and analyzes just the selected owner with explicit limits", async () => {
  const at = new Date(2026, 8, 28, 10).getTime();
  const readUsageActivity = vi.fn(async (request) => {
    if (request.federationTarget?.instanceId === "offline") throw new Error("Peer offline");
    return { rows: request.federationTarget?.scope === "local" ? [] : [usageFixture({ createdAt: at, startedAt: at, completedAt: at + 1000 })],
      readAt: at + 2000, rateLimits: [], truncated: false };
  });
  const analyzeUsageActivity = vi.fn(async () => ({ analysis: "A bounded diagnosis.", model: "gpt-6-luna", entries: 4, characters: 8000, truncated: true, hasEarlierHistory: true }));
  const readFederationActivity = vi.fn(async () => ({ health: { localLabel: "Local", peers: [
    { id: "owner", label: "Owner", status: "connected" },
    { id: "offline", label: "Offline", status: "disconnected" },
  ] } }) as ReadFederationActivityResponse);
  render(<UsageActivity desktopApi={{ readUsageActivity, analyzeUsageActivity, readFederationActivity }} />);
  expect(readUsageActivity).not.toHaveBeenCalled();
  await waitFor(() => expect(readFederationActivity).toHaveBeenCalled());
  chooseSelectOption(screen.getByLabelText("Period"), "Custom range");
  fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-09-28T09:00" } });
  fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-09-28T11:00" } });
  chooseSelectOption(screen.getByLabelText("Instance"), "All instances");
  fireEvent.click(screen.getByRole("button", { name: "Load activity" }));
  expect(await screen.findByText(/Unavailable — Error: Peer offline/)).toBeInTheDocument();
  expect(readUsageActivity).toHaveBeenCalledTimes(3);
  expect(analyzeUsageActivity).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Inspect Fixture thread" }));
  expect(screen.getByText(/This model call consumes usage/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Analyze thread" }));
  await screen.findByText("A bounded diagnosis.");
  expect(analyzeUsageActivity).toHaveBeenCalledExactlyOnceWith({ backend: "codex", threadId: "thread", federationTarget: { scope: "remote", instanceId: "owner" }, model: "gpt-6-luna", entryLimit: 40, characterLimit: 20000 });
});

it("filters and ranks threads without rereading or launching analysis", async () => {
  const at = new Date(2026, 8, 28, 10).getTime();
  const row = usageFixture({ createdAt: at, startedAt: at, completedAt: at + 1000 });
  const later = { ...usageFixture({ threadId: "other", usageLineId: "other", completedAt: at + 3_600_000, createdAt: at, startedAt: at, totalCostMicros: 900, inputTokens: 20, uncachedInputTokens: 10, cachedInputTokens: 10, outputTokens: 10 }), title: "Later thread" };
  const readUsageActivity = vi.fn(async () => ({ rows: [row, later], readAt: at, rateLimits: [], truncated: false }));
  const analyzeUsageActivity = vi.fn();
  render(<UsageActivity desktopApi={{ readUsageActivity, analyzeUsageActivity }} />);
  chooseSelectOption(screen.getByLabelText("Period"), "Custom range");
  fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-09-28T09:00" } });
  fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-09-28T12:00" } });
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
