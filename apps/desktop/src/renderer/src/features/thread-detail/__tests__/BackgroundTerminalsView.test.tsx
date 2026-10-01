import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ActionRunsPanel } from "../context-panels/ActionRunsPanel";

afterEach(cleanup);

it("shows agent commands without requiring a configured environment and stops by session", () => {
  const terminal = {
    itemId: "item-1", processId: "codex-session-1", command: "pnpm dev", cwd: "/fixture/worktree",
    osPid: 123, cpuPercent: 2, memoryKb: 2048, output: "Ready on port 3000",
  };
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
});
