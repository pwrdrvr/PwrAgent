import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared";
import { ThreadRow } from "../ThreadRow";

afterEach(cleanup);

const thread: NavigationThreadSummary = {
  id: "thread-1",
  title: "Keep search scroll position",
  titleSource: "explicit",
  summary: "",
  source: "codex",
  executionMode: "default",
  updatedAt: 1_000,
  inbox: { inInbox: false },
  linkedDirectories: [],
};

function renderRow(props: {
  agentCommandThreadKeys?: Record<string, boolean>;
  thinkingThreadKeys?: Record<string, boolean>;
  row?: Partial<NavigationThreadSummary>;
}) {
  const { row, ...rest } = props;
  return render(
    <ThreadRow thread={{ ...thread, ...row }} onSelectThread={vi.fn()} onOpenContextMenu={vi.fn()} {...rest} />,
  );
}

it("marks an idle thread whose command outlived its turn", () => {
  renderRow({ agentCommandThreadKeys: { "codex:thread-1": true } });
  expect(screen.getByRole("img", { name: "Agent command running" })).toBeInTheDocument();
});

it("leaves the mark to the scanner while a turn is running", () => {
  renderRow({
    agentCommandThreadKeys: { "codex:thread-1": true },
    thinkingThreadKeys: { "codex:thread-1": true },
  });
  expect(screen.queryByRole("img", { name: "Agent command running" })).toBeNull();
});

it("shows no mark without a running command", () => {
  renderRow({ agentCommandThreadKeys: { "codex:other": true } });
  expect(screen.queryByRole("img", { name: "Agent command running" })).toBeNull();
});

// The owner's row flag reaches windows that never listed the thread's
// terminals, and peer viewers.
it("marks an idle thread from the owner's running-command flag", () => {
  renderRow({ row: { hasAgentCommands: true, threadStatus: "idle" } });
  expect(screen.getByRole("img", { name: "Agent command running" })).toBeInTheDocument();
  // A running command is not the agent working.
  expect(screen.queryByRole("img", { name: "Thinking" })).toBeNull();
});

it("leaves the owner's running-command flag to the scanner during a turn", () => {
  renderRow({ row: { hasAgentCommands: true, threadStatus: "active" } });
  expect(screen.getByRole("img", { name: "Thinking" })).toBeInTheDocument();
  expect(screen.queryByRole("img", { name: "Agent command running" })).toBeNull();
});
