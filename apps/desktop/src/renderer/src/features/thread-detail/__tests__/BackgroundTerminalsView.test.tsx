import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { CodexEnvironmentActionRun } from "@pwragent/shared";
import { agentCommandDirectoryLabel, agentCommandPreview } from "../BackgroundTerminalsView";
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

const heredoc = [
  "python3 - <<'PY'",
  "from pathlib import Path",
  "print(Path('.local/audit').exists())",
  "PY",
].join("\n");

it("names a multi-line command by its first line and shows the whole command only when open", () => {
  const onStop = vi.fn(async () => undefined);
  const script = { ...terminal, command: heredoc, osPid: 58970 };
  render(<ActionRunsPanel dock="sidebar" onDockChange={vi.fn()} runs={[]} terminals={[script]} onStop={onStop} />);
  const row = screen.getByRole("group", { name: "Agent command: python3 - <<'PY' …" });
  const summary = row.querySelector("summary") as HTMLElement;
  expect(within(summary).getByText("python3 - <<'PY' …")).toBeInTheDocument();
  expect(summary).toHaveTextContent("worktree · PID 58970 · 4 lines");
  expect(summary).not.toHaveTextContent("from pathlib import Path");
  // The open body carries the script with its line breaks.
  const full = row.querySelector(".agent-command-run__command-text") as HTMLElement;
  expect(full.textContent).toBe(heredoc);
  const stop = screen.getByRole("button", { name: "Stop python3 - <<'PY' …" });
  fireEvent.click(stop);
  expect(onStop).toHaveBeenCalledWith(script);
});

it("repeats a long one-line command in the open row but not a short one", () => {
  const long = `rg --files ${"-g '!generated' ".repeat(8)}| xargs wc -l`;
  render(<ActionRunsPanel dock="sidebar" onDockChange={vi.fn()} runs={[]}
    terminals={[terminal, { ...terminal, processId: "codex-session-2", command: long }]} />);
  const [short, longRow] = screen.getAllByRole("group");
  expect(short.querySelector(".agent-command-run__command-text")).toBeNull();
  expect(longRow.querySelector(".agent-command-run__command-text")).toHaveTextContent(long);
  // A single line has no line count.
  expect(longRow.querySelector(".agent-command-run__meta")).not.toHaveTextContent("lines");
});

it("previews a command by its first non-blank line", () => {
  expect(agentCommandPreview("pnpm dev")).toEqual({ text: "pnpm dev", lineCount: 1, cut: false });
  expect(agentCommandPreview(heredoc)).toEqual({ text: "python3 - <<'PY' …", lineCount: 4, cut: true });
  expect(agentCommandPreview("\n  bash -lc 'set -e  \r\necho hi'\n")).toEqual({
    text: "bash -lc 'set -e …", lineCount: 2, cut: true,
  });
  expect(agentCommandPreview("x".repeat(80)).cut).toBe(false);
  expect(agentCommandPreview("x".repeat(81))).toEqual({ text: "x".repeat(81), lineCount: 1, cut: true });
});
