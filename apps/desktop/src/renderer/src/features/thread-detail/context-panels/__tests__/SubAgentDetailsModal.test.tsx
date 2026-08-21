import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThreadSubAgentSummary } from "@pwragent/shared";
import { SubAgentDetailsModal } from "../SubAgentDetailsModal";

afterEach(() => {
  delete (window as Window & { pwragent?: unknown }).pwragent;
  cleanup();
  vi.restoreAllMocks();
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

  it("opens with focus on Close even once the run has settled", () => {
    // A settled run makes the header's duration tabbable (it carries the exact
    // end timestamp), and it sits ahead of the actions in DOM order. Focus
    // must still land on a control, not on that span with its tooltip open.
    renderModal({
      status: "success",
      completedAt: subAgent.createdAt + 1_000,
      updatedAt: subAgent.createdAt + 1_000,
    });

    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
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

  it("opens a native child transcript on the instance that owns it", () => {
    const openSubAgentTranscriptWindow = vi.fn(async () => ({ opened: true as const }));
    (window as Window & { pwragent?: unknown }).pwragent = {
      openSubAgentTranscriptWindow,
    };
    render(
      <SubAgentDetailsModal
        defaultBackend="codex"
        federationTarget={{ scope: "remote", instanceId: "pwr_remote" }}
        parentThreadId="parent-thread"
        subAgent={{
          ...subAgent,
          agentName: "Epicurus",
          monitorId: "codex-native:monitor-1",
        }}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open transcript" }));

    expect(openSubAgentTranscriptWindow).toHaveBeenCalledWith({
      backend: "codex",
      federationTarget: {
        scope: "remote",
        instanceId: "pwr_remote",
      },
      threadId: "monitor-thread",
      title: "Epicurus",
    });
  });

  it("opens a running non-Codex monitor transcript", () => {
    const openSubAgentTranscriptWindow = vi.fn(async () => ({ opened: true as const }));
    (window as Window & { pwragent?: unknown }).pwragent = {
      openSubAgentTranscriptWindow,
    };
    render(
      <SubAgentDetailsModal
        defaultBackend="acp:claude"
        parentThreadId="parent-thread"
        subAgent={{
          ...subAgent,
          backend: "acp:claude",
          monitorId: "monitor-job-1",
          monitorThreadId: "claude-monitor-thread",
          monitorTurnId: undefined,
        }}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open transcript" }));

    expect(openSubAgentTranscriptWindow).toHaveBeenCalledWith({
      backend: "acp:claude",
      threadId: "claude-monitor-thread",
      title: LONG_TASK,
    });
  });
});
