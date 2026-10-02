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
}) {
  return render(<ThreadRow thread={thread} onSelectThread={vi.fn()} onOpenContextMenu={vi.fn()} {...props} />);
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
