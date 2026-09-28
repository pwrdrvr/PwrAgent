import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-09-28T09:00" } });
  fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-09-28T11:00" } });
  chooseSelectOption(screen.getByLabelText("Instance"), "All known instances");
  fireEvent.click(screen.getByRole("button", { name: "Read usage" }));
  expect(await screen.findByText(/Unavailable — Error: Peer offline/)).toBeInTheDocument();
  expect(readUsageActivity).toHaveBeenCalledTimes(3);
  expect(analyzeUsageActivity).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Inspect" }));
  expect(screen.getByText(/This model call consumes usage/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Analyze" }));
  await screen.findByText("A bounded diagnosis.");
  expect(analyzeUsageActivity).toHaveBeenCalledExactlyOnceWith({ backend: "codex", threadId: "thread", federationTarget: { scope: "remote", instanceId: "owner" }, model: "gpt-6-luna", entryLimit: 40, characterLimit: 20000 });
});
