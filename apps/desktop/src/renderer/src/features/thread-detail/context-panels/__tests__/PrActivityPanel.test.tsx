import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { PrActivitySnapshot, NavigationThreadSummary } from "@pwragent/shared";
import { ThreadLinkProvider } from "../../../../lib/thread-links";
import { PrActivityPanel } from "../PrActivityPanel";

afterEach(cleanup);
const thread: NavigationThreadSummary = { id: "one", source: "codex", title: "Fixture", titleSource: "explicit", linkedDirectories: [], inbox: { inInbox: false }, prAutoDispatchEnabled: true };
const other: NavigationThreadSummary = { ...thread, id: "two", title: "Other fixture" };
const snapshot: PrActivitySnapshot = {
  startedAt: 1, droppedEvents: 0,
  events: [
    { id: 4, occurredAt: 4000, category: "budget", source: "background poll", message: "PR check allowed", threadKeys: ["codex:one"], prKeys: ["github.com/acme/widgets#128"], budget: "polling", delta: -1, availableTokens: 11 },
    { id: 3, occurredAt: 3000, category: "check", source: "background poll", message: "Merge conflict, checks passing", threadKeys: ["codex:one"], prKeys: ["github.com/acme/widgets#128"], tone: "error" },
    { id: 2, occurredAt: 2000, category: "budget", source: "Auto-fix", message: "Used a repair for another thread", threadKeys: ["codex:two"], prKeys: [], budget: "repair", delta: -1, availableTokens: 0 },
    { id: 1, occurredAt: 1000, category: "budget", source: "Auto-fix", message: "Thread busy: repair refunded", threadKeys: ["codex:one"], prKeys: [], budget: "repair", delta: 1 },
  ],
};

it("switches between this thread, every thread, and the budget ledger", async () => {
  const getPrActivity = vi.fn(async () => snapshot);
  render(<PrActivityPanel desktopApi={{ getPrActivity }} thread={thread} />);
  const conflict = await screen.findByText("Merge conflict, checks passing");
  expect(conflict.closest("li")).toHaveClass("pr-activity__event--error");
  expect(within(conflict.closest("li")!).getByText("#128")).toBeInTheDocument();
  expect(within(conflict.closest("li")!).getByText("Background check")).toBeInTheDocument();
  expect(screen.queryByText("Used a repair for another thread")).not.toBeInTheDocument();
  // Routine admissions are ledger entries, not decisions.
  expect(screen.queryByText("PR check allowed")).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "All threads" }));
  expect(screen.getByText("Used a repair for another thread")).toBeInTheDocument();
  expect(screen.getByText("acme/widgets#128")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Budget" }));
  expect(screen.queryByText("Merge conflict, checks passing")).not.toBeInTheDocument();
  expect(screen.getByText("PR check allowed")).toBeInTheDocument();
  expect(screen.getByText("+1")).toBeInTheDocument();
  expect(screen.getByText("−1 · 0 left")).toBeInTheDocument();
  expect(getPrActivity).toHaveBeenCalledTimes(1);
});

it("shows a read failure instead of a false empty history", async () => {
  render(<PrActivityPanel desktopApi={{ getPrActivity: async () => { throw new Error("disconnected"); } }} thread={thread} />);
  expect(await screen.findByText("Could not refresh activity. Retrying…")).toBeInTheDocument();
});

it("traces a blocked repair to the budget use before it, across threads", async () => {
  const history: PrActivitySnapshot = { ...snapshot, events: [
    { ...snapshot.events[2]!, id: 6, message: "Later debit" },
    { ...snapshot.events[1]!, id: 5, category: "budget", budget: "repair", delta: 0, availableTokens: 0, message: "Repair blocked: budget empty", tone: "warning" },
    ...snapshot.events,
  ] };
  render(<PrActivityPanel desktopApi={{ getPrActivity: async () => history }} thread={thread} />);
  fireEvent.click(await screen.findByRole("button", { name: "What used it?" }));
  expect(screen.getByRole("button", { name: "Budget" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByText("Used a repair for another thread")).toBeInTheDocument();
  expect(screen.queryByText("Later debit")).not.toBeInTheDocument();
  expect(screen.queryByText("Merge conflict, checks passing")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Show the latest budget activity" }));
  expect(screen.getByText("Later debit")).toBeInTheDocument();
});

it("offers Resume and the budget trace when the repair budget pauses Auto-fix", async () => {
  let paused = true;
  const getPrActivity = vi.fn(async () => ({ ...snapshot, monitoring: {
    backgroundPollingEnabled: true, autoFixAllowed: true, repairBudgetPaused: paused,
  } }));
  const resumePrAutoDispatchBudget = vi.fn(async () => {
    paused = false;
    return { availableTokens: 3, capacity: 3, refillPerMinute: 1, paused: false };
  });
  render(<PrActivityPanel desktopApi={{ getPrActivity, resumePrAutoDispatchBudget }} thread={thread} />);
  expect(await screen.findByText("Auto-fix PR is paused")).toBeInTheDocument();
  expect(screen.getByText("Auto-fix paused")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Resume" }));
  expect(resumePrAutoDispatchBudget).toHaveBeenCalledTimes(1);
  expect(await screen.findByText("Auto-fix on")).toBeInTheDocument();
  expect(screen.queryByText("Auto-fix PR is paused")).not.toBeInTheDocument();
  expect(getPrActivity).toHaveBeenCalledTimes(2);
});

it("reads the live PR check balance and the last recorded repair balance", async () => {
  const history: PrActivitySnapshot = {
    ...snapshot,
    monitoring: {
      backgroundPollingEnabled: true, autoFixAllowed: true, repairBudgetPaused: false,
      pollingBudget: { availableTokens: 17, capacity: 20, refillPerMinute: 20 },
      repairBudget: { capacity: 3, refillPerMinute: 1 },
    },
    events: [
      // Neither a balance-less refund nor a balance-less block erases the
      // last recorded repair balance.
      { ...snapshot.events[3]!, id: 7, message: "Thread busy: repair refunded", delta: 1 },
      { ...snapshot.events[3]!, id: 6, message: "Repair blocked: budget paused", delta: 0 },
      { ...snapshot.events[2]!, id: 5, availableTokens: 2 },
      { ...snapshot.events[0]!, id: 4, availableTokens: 4 },
    ],
  };
  render(<PrActivityPanel desktopApi={{ getPrActivity: async () => history }} thread={thread} />);
  const checks = (await screen.findByText("PR checks")).closest(".pr-activity__budget")!;
  expect(checks).toHaveTextContent("17/20");
  expect(screen.getByText("Repairs").closest(".pr-activity__budget")).toHaveTextContent("2/3");
});

it("names other threads and opens them from the timeline", async () => {
  const onShowThread = vi.fn();
  render(
    <ThreadLinkProvider onShowThread={onShowThread} threads={[thread, other]}>
      <PrActivityPanel desktopApi={{ getPrActivity: async () => snapshot }} thread={thread} />
    </ThreadLinkProvider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "All threads" }));
  fireEvent.click(screen.getByRole("button", { name: "Other fixture" }));
  expect(onShowThread).toHaveBeenCalledWith(expect.objectContaining({ backend: "codex", threadId: "two" }));
});
