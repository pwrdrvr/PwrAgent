import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { CodexEnvironmentActionRun } from "@pwragent/shared";
import { agentCommandDirectoryLabel } from "../BackgroundTerminalsView";
import { ActionRunsPanel } from "../context-panels/ActionRunsPanel";

afterEach(cleanup);

const terminal = {
  itemId: "item-1", processId: "codex-session-1", command: "pnpm dev", cwd: "/fixture/worktree",
  osPid: 123, cpuPercent: 2, memoryKb: 2048, output: "Ready on port 3000",
};

it("shows agent commands without requiring a configured environment and stops by session", () => {
  const onStop = vi.fn(async () => undefined);
  const { rerender } = render(<ActionRunsPanel dock="sidebar" onDockChange={vi.fn()} runs={[]}
    terminals={[terminal]} onStop={onStop} />);
  expect(screen.getByRole("heading", { name: "Agent commands" })).toBeInTheDocument();
  expect(screen.getByText("/fixture/worktree")).toBeInTheDocument();
  expect(screen.getByText("Ready on port 3000")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Stop pnpm dev" }));
  expect(onStop).toHaveBeenCalledWith(terminal);
  rerender(<ActionRunsPanel dock="sidebar" onDockChange={vi.fn()} runs={[]}
    terminals={[terminal]} stopping="codex-session-1" onStop={onStop} />);
  expect(screen.getByRole("button", { name: "Stop pnpm dev" })).toBeDisabled();
  expect(screen.getByText("Stopping")).toBeInTheDocument();
});

it("names each command's worktree and PID in the collapsed row, once", () => {
  const second = { ...terminal, itemId: "item-2", processId: "codex-session-2", cwd: "/fixture/main", osPid: 456, output: undefined };
  render(<ActionRunsPanel dock="sidebar" onDockChange={vi.fn()} runs={[]} terminals={[terminal, second]} />);
  const [first, other] = screen.getAllByRole("group");
  expect(within(first).getByText("worktree")).toHaveAttribute("title", "/fixture/worktree");
  expect(first).toHaveTextContent("worktree · PID 123");
  expect(other).toHaveTextContent("main · PID 456");
  // The command is the row's title; the body does not repeat it.
  expect(within(first).getAllByText("pnpm dev")).toHaveLength(1);
  expect(within(other).getByText("No output yet.")).toBeInTheDocument();
  expect(within(first).getByText("CPU 2.0% · 2.0 MiB")).toBeInTheDocument();
});

it("keeps the dock toggle beside the environment rows it moves", () => {
  const run = {
    runId: "run-1", actionId: "preview", actionName: "Start preview", status: "started", pid: 4100,
  } as CodexEnvironmentActionRun;
  const onDockChange = vi.fn();
  const { rerender } = render(<ActionRunsPanel dock="sidebar" onDockChange={onDockChange} runs={[]} terminals={[terminal]} />);
  expect(screen.queryByRole("button", { name: "Show above composer" })).toBeNull();

  rerender(<ActionRunsPanel dock="sidebar" onDockChange={onDockChange} runs={[run]} terminals={[terminal]} />);
  const environment = screen.getByRole("heading", { name: "Environment" }).closest(".actions-panel__group");
  fireEvent.click(within(environment as HTMLElement).getByRole("button", { name: "Show above composer" }));
  expect(onDockChange).toHaveBeenCalledWith("above");
  // The group label carries "Environment", so the rail row keeps only the state.
  expect(within(environment as HTMLElement).getByText("Running")).toBeInTheDocument();
  expect(screen.getByLabelText("Env action running")).toHaveTextContent("PID 4100");
});

it("labels a command by its working directory's last segment", () => {
  expect(agentCommandDirectoryLabel("/projects/atlas/worktrees/search-fix")).toBe("search-fix");
  expect(agentCommandDirectoryLabel("/projects/atlas/")).toBe("atlas");
  expect(agentCommandDirectoryLabel("C:\\work\\atlas")).toBe("atlas");
  expect(agentCommandDirectoryLabel("/")).toBe("/");
});
