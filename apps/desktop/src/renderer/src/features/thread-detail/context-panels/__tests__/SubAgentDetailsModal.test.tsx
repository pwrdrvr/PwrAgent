import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThreadSubAgentSummary } from "@pwragent/shared";
import { SubAgentDetailsModal } from "../SubAgentDetailsModal";

afterEach(() => {
  cleanup();
});

const LONG_TASK = [
  "Monitor only the already-launched Terminal-owned M4 cold-restart operation.",
  "Do not start, retry, stop, edit, or reinterpret anything. The durable run",
  "state is under local-state/m4-handoff/force-cold-restart-terminal-run.",
].join(" ");

const subAgent: ThreadSubAgentSummary = {
  monitorId: "monitor-1",
  task: LONG_TASK,
  status: "running",
  createdAt: 1_800_000_000_000,
  updatedAt: 1_800_000_000_000,
  backend: "codex",
  monitorThreadId: "monitor-thread",
  monitorTurnId: "monitor-turn",
  preferredModel: "gpt-5.6-luna",
  preferredReasoningEffort: "medium",
  lastMessage: "Still running: stage=waiting_for_fresh_runtime.",
};

function renderModal(overrides?: Partial<ThreadSubAgentSummary>) {
  return render(
    <SubAgentDetailsModal
      defaultBackend="codex"
      parentThreadId="parent-thread"
      subAgent={{ ...subAgent, ...overrides }}
      onClose={vi.fn()}
    />,
  );
}

describe("SubAgentDetailsModal", () => {
  it("headlines the sub-agent identity and files the prompt under Task", () => {
    renderModal({ agentName: "Deployment watcher" });

    expect(
      screen.getByRole("heading", { level: 2 }),
    ).toHaveTextContent("Deployment watcher");
    expect(screen.getByRole("dialog")).toHaveAccessibleName(
      "Sub-agent details: Deployment watcher",
    );
    expect(screen.getByRole("heading", { name: "Task" })).toBeInTheDocument();
    expect(screen.getByText(LONG_TASK)).toBeInTheDocument();
  });

  it("falls back to the spawner label when the sub-agent has no name", () => {
    renderModal();

    expect(
      screen.getByRole("heading", { level: 2 }),
    ).toHaveTextContent("PwrAgent task monitor");
  });

  it("keeps focus in place when the sub-agent streams an update", () => {
    const { rerender } = renderModal();

    const copyButton = screen.getByRole("button", { name: "Copy" });
    copyButton.focus();
    expect(document.activeElement).toBe(copyButton);

    // A streamed update re-renders the opener, which hands the dialog a fresh
    // `onClose`. Re-running the focus effect here would pull focus back to the
    // header and scroll the body to the top under the reader.
    rerender(
      <SubAgentDetailsModal
        defaultBackend="codex"
        parentThreadId="parent-thread"
        subAgent={{ ...subAgent, updatedAt: subAgent.updatedAt + 1_000 }}
        onClose={vi.fn()}
      />,
    );

    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Copy" }),
    );
  });

  it("closes on Escape after the opener handed over a new callback", () => {
    const firstClose = vi.fn();
    const secondClose = vi.fn();
    const { rerender } = render(
      <SubAgentDetailsModal
        defaultBackend="codex"
        parentThreadId="parent-thread"
        subAgent={subAgent}
        onClose={firstClose}
      />,
    );

    rerender(
      <SubAgentDetailsModal
        defaultBackend="codex"
        parentThreadId="parent-thread"
        subAgent={subAgent}
        onClose={secondClose}
      />,
    );

    fireEvent.keyDown(window, { key: "Escape" });

    expect(secondClose).toHaveBeenCalledTimes(1);
    expect(firstClose).not.toHaveBeenCalled();
  });

  it("reports live status and runtime facts in the pinned header", () => {
    renderModal({ status: "failure" });

    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.getByText("OpenAI")).toBeInTheDocument();
    expect(screen.getByText("gpt-5.6-luna · medium")).toBeInTheDocument();
  });
});
