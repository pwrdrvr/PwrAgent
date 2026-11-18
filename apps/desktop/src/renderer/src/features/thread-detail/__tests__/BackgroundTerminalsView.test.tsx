import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import fc from "fast-check";
import { afterEach, expect, it, vi } from "vitest";
import type { CodexEnvironmentActionRun } from "@pwragent/shared";
import { copyText } from "../../../lib/copy-text";
import { agentCommandDirectoryLabel, agentCommandPreview } from "../BackgroundTerminalsView";
import { ActionRunsPanel } from "../context-panels/ActionRunsPanel";

vi.mock("../../../lib/copy-text", () => ({ copyText: vi.fn(async () => undefined) }));

afterEach(() => {
  cleanup();
  vi.mocked(copyText).mockReset();
  vi.mocked(copyText).mockImplementation(async () => undefined);
  vi.useRealTimers();
});

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

it("labels a sub-agent with its type and progress instead of command output", () => {
  const agent = {
    itemId: "tool-agent", processId: "agent-1", command: "Audit the SDK", cwd: "/fixture/worktree",
    kind: "agent" as const, agentType: "Explore", progress: "3 tool uses · last Grep",
  };
  const onStop = vi.fn(async () => undefined);
  render(<ActionRunsPanel dock="sidebar" onDockChange={vi.fn()} runs={[]} terminals={[agent]} onStop={onStop} />);
  const row = screen.getByRole("group", { name: "Sub-agent: Audit the SDK" });
  expect(row).toHaveTextContent("Sub-agent · Explore · worktree");
  expect(within(row).getByText("3 tool uses · last Grep")).toBeInTheDocument();
  expect(within(row).queryByText("No output yet.")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Stop Audit the SDK" }));
  expect(onStop).toHaveBeenCalledWith(agent);
});

it("copies exactly the command, every line, without opening or closing its row", async () => {
  // Any command an agent can start: blank lines, CRLF, heredocs, long lines.
  const line = fc.string({ maxLength: 120 });
  const command = fc.array(line, { minLength: 1, maxLength: 8 })
    .chain((lines) => fc.constantFrom("\n", "\r\n").map((eol) => lines.join(eol)))
    .filter((text) => text.trim().length > 0);
  await fc.assert(fc.asyncProperty(command, fc.boolean(), async (text, open) => {
    cleanup();
    vi.mocked(copyText).mockClear();
    render(<ActionRunsPanel dock="sidebar" onDockChange={vi.fn()} runs={[]}
      terminals={[{ ...terminal, command: text }]} />);
    const row = screen.getByRole("group") as HTMLDetailsElement;
    row.open = open;
    // Accessible names flatten runs of whitespace, so find the control by its
    // leading verb and check the raw label separately.
    const copy = within(row).getByRole("button", { name: /^Copy / });
    expect(copy).toHaveAttribute("aria-label", `Copy ${agentCommandPreview(text).text}`);
    let notCancelled = true;
    await act(async () => {
      // jsdom never toggles a <summary> from a click on a button inside it, so
      // check the press is cancelled: that is what keeps a browser from toggling.
      notCancelled = fireEvent.click(copy);
    });
    expect(notCancelled).toBe(false);
    expect(vi.mocked(copyText).mock.calls).toEqual([[text]]);
    expect(row.open).toBe(open);
  }), { numRuns: 60 });
});

it("confirms a copy for a moment and never claims one that failed", async () => {
  vi.useFakeTimers();
  const second = { ...terminal, processId: "codex-session-2", command: "pnpm test" };
  render(<ActionRunsPanel dock="sidebar" onDockChange={vi.fn()} runs={[]} terminals={[terminal, second]} />);
  const [first, other] = screen.getAllByRole("group");
  await act(async () => {
    fireEvent.click(within(first).getByRole("button", { name: "Copy pnpm dev" }));
  });
  expect(within(first).getByRole("button", { name: "Copied" })).toHaveClass("is-copied");
  // Only the row that was copied confirms.
  expect(within(other).getByRole("button", { name: "Copy pnpm test" })).not.toHaveClass("is-copied");
  act(() => {
    vi.advanceTimersByTime(1400);
  });
  expect(within(first).getByRole("button", { name: "Copy pnpm dev" })).not.toHaveClass("is-copied");

  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.mocked(copyText).mockRejectedValueOnce(new Error("clipboard unavailable"));
  await act(async () => {
    fireEvent.click(within(other).getByRole("button", { name: "Copy pnpm test" }));
  });
  expect(within(other).queryByRole("button", { name: "Copied" })).toBeNull();
  expect(error).toHaveBeenCalledWith("Failed to copy agent command", expect.any(Error));
  error.mockRestore();
});

it("does not arm a reset timer when a copy settles after its row is gone", async () => {
  let settle: () => void = () => undefined;
  vi.mocked(copyText).mockImplementationOnce(() => new Promise<void>((resolve) => { settle = resolve; }));
  const timeout = vi.spyOn(window, "setTimeout");
  const { rerender } = render(<ActionRunsPanel dock="sidebar" onDockChange={vi.fn()} runs={[]} terminals={[terminal]} />);
  fireEvent.click(screen.getByRole("button", { name: "Copy pnpm dev" }));
  rerender(<ActionRunsPanel dock="sidebar" onDockChange={vi.fn()} runs={[]} terminals={[]} />);
  timeout.mockClear();
  await act(async () => {
    settle();
  });
  expect(timeout.mock.calls.filter(([, delay]) => delay === 1400)).toHaveLength(0);
  timeout.mockRestore();
});

it("keeps Copy available while a command is stopping", () => {
  render(<ActionRunsPanel dock="sidebar" onDockChange={vi.fn()} runs={[]}
    terminals={[terminal]} stopping="codex-session-1" onStop={vi.fn(async () => undefined)} />);
  expect(screen.getByRole("button", { name: "Stop pnpm dev" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Copy pnpm dev" })).toBeEnabled();
});
