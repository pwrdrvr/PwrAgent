import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { PrActivitySnapshot, NavigationThreadSummary } from "@pwragent/shared";
import { PrActivityPanel } from "../PrActivityPanel";

afterEach(cleanup);
const thread: NavigationThreadSummary = { id: "one", source: "codex", title: "Fixture", titleSource: "explicit", linkedDirectories: [], inbox: { inInbox: false } };
const snapshot: PrActivitySnapshot = {
  startedAt: 1, droppedEvents: 0,
  events: [
    { id: 3, occurredAt: 3000, category: "check", source: "background poll", message: "Checked: conflict", threadKeys: ["codex:one"], prKeys: [] },
    { id: 2, occurredAt: 2000, category: "budget", source: "Auto-fix", message: "Reserved for another thread", threadKeys: ["codex:two"], prKeys: [], budget: "repair", delta: -1, availableTokens: 0 },
    { id: 1, occurredAt: 1000, category: "budget", source: "Auto-fix", message: "Busy: token refunded", threadKeys: ["codex:one"], prKeys: [], budget: "repair", delta: 1 },
  ],
};

it("lets the operator trace profile token use beyond the selected thread", async () => {
  const getPrActivity = vi.fn(async () => snapshot);
  render(<PrActivityPanel desktopApi={{ getPrActivity }} thread={thread} />);
  expect(await screen.findByText("Checked: conflict")).toBeInTheDocument();
  expect(screen.queryByText("Reserved for another thread")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "All threads" }));
  expect(screen.getByText("Reserved for another thread")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Token history" }));
  expect(screen.queryByText("Checked: conflict")).not.toBeInTheDocument();
  expect(screen.getByText("Busy: token refunded")).toBeInTheDocument();
  expect(getPrActivity).toHaveBeenCalledTimes(1);
});

it("shows a read failure instead of a false empty history", async () => {
  render(<PrActivityPanel desktopApi={{ getPrActivity: async () => { throw new Error("disconnected"); } }} thread={thread} />);
  expect(await screen.findByText("Could not refresh activity. Retrying…")).toBeInTheDocument();
});

it("shows the token debits before a blocked repair across all threads", async () => {
  const history: PrActivitySnapshot = { ...snapshot, events: [
    { ...snapshot.events[1]!, id: 5, message: "Later debit" },
    { ...snapshot.events[0]!, id: 4, category: "budget", budget: "repair", delta: 0, message: "Repair blocked" },
    ...snapshot.events,
  ] };
  render(<PrActivityPanel desktopApi={{ getPrActivity: async () => history }} thread={thread} />);
  fireEvent.click(await screen.findByRole("button", { name: "Earlier token use" }));
  expect(screen.getByText("Reserved for another thread")).toBeInTheDocument();
  expect(screen.queryByText("Later debit")).not.toBeInTheDocument();
  expect(screen.queryByText("Checked: conflict")).not.toBeInTheDocument();
});

it("shows the global pause even when no new checks have run", async () => {
  render(<PrActivityPanel desktopApi={{ getPrActivity: async () => ({ ...snapshot, events: [], monitoring: {
    backgroundPollingEnabled: true, autoFixAllowed: true, repairBudgetPaused: true,
  } }) }} thread={thread} />);
  expect(await screen.findByText(/Auto-fix is paused by the repair budget/)).toBeInTheDocument();
});
