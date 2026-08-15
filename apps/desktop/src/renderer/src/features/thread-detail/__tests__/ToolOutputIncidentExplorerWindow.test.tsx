import "@testing-library/jest-dom/vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type {
  AppServerReadThreadResponse,
  ThreadToolInvocationRecord,
} from "@pwragent/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolOutputIncidentExplorerWindow } from "../ToolOutputIncidentExplorerWindow";

afterEach(() => {
  Reflect.deleteProperty(window, "pwragent");
  window.location.hash = "";
});

describe("ToolOutputIncidentExplorerWindow", () => {
  it("uses standard thread identity chrome without exposing the raw thread id", async () => {
    const copyText = vi.fn(async () => undefined);
    const readThread = vi.fn(async () => buildResponse());
    const showThreadFromToolOutputIncidentExplorer = vi.fn(async () => undefined);
    installApi({
      copyText,
      readThread,
      showThreadFromToolOutputIncidentExplorer,
    });
    window.location.hash =
      "#tool-output-incidents/acp%3Agrok/thread-1/Noisy%20work/PwrAgent";
    render(<ToolOutputIncidentExplorerWindow />);

    expect(await screen.findByLabelText(
      "PwrAgent > Noisy work > Tool Output Incidents",
    )).toBeInTheDocument();
    expect(screen.getByText("Grok")).toHaveClass("chip--backend");
    expect(screen.queryByText("acp:grok")).not.toBeInTheDocument();
    expect(screen.queryByText("thread-1")).not.toBeInTheDocument();
    expect(readThread).toHaveBeenCalledWith(expect.objectContaining({
      includeAllToolInvocations: true,
    }));

    const threadChip = screen.getByRole("button", { name: "Open thread Noisy work" });
    fireEvent.click(threadChip);
    await waitFor(() => expect(showThreadFromToolOutputIncidentExplorer)
      .toHaveBeenCalledWith({ backend: "acp:grok", threadId: "thread-1" }));

    fireEvent.contextMenu(threadChip);
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy Thread ID" }));
    await waitFor(() => expect(copyText).toHaveBeenCalledWith("thread-1"));
  });

  it("shows Codex output whose normalized detail id extends the invocation item id", async () => {
    installApi({ readThread: async () => buildResponse() });
    window.location.hash = "#tool-output-incidents/codex/thread-1/Noisy%20work";
    render(<ToolOutputIncidentExplorerWindow />);

    expect(await screen.findByText("failure")).toBeInTheDocument();
    expect(screen.getByText("warning")).toBeInTheDocument();
    expect(screen.queryByText(/Only the truncated output retained/))
      .not.toBeInTheDocument();
  });

  it("shows historical output using the analyzer's normalized detail identity", async () => {
    const response = buildResponse();
    response.toolAccounting!.invocations[0]!.itemId = "historical-detail";
    const entry = response.replay.entries[0];
    if (entry?.type === "activity") {
      entry.id = "historical-activity";
      entry.details[0]!.id = "historical-detail";
      entry.details[0]!.command!.output = "retained historical output\n";
    }
    installApi({ readThread: async () => response });
    window.location.hash = "#tool-output-incidents/codex/thread-1/Noisy%20work";
    render(<ToolOutputIncidentExplorerWindow />);

    expect(await screen.findByText("retained historical output"))
      .toBeInTheDocument();
  });

  it("still shows findings persisted with the legacy activity entry identity", async () => {
    const response = buildResponse();
    response.toolAccounting!.invocations[0]!.itemId = "legacy-activity";
    const entry = response.replay.entries[0];
    if (entry?.type === "activity") {
      entry.id = "legacy-activity";
      entry.details[0]!.id = "unrelated-detail-id";
      entry.details[0]!.command!.output = "legacy retained output\n";
    }
    installApi({ readThread: async () => response });
    window.location.hash = "#tool-output-incidents/codex/thread-1/Noisy%20work";
    render(<ToolOutputIncidentExplorerWindow />);

    expect(await screen.findByText("legacy retained output"))
      .toBeInTheDocument();
  });

  it("steers only when the finding belongs to the exact active turn", async () => {
    const steerTurn = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-1",
      turnId: "turn-1",
    }));
    installApi({ readThread: async () => buildResponse("turn-1"), steerTurn });
    window.location.hash = "#tool-output-incidents/codex/thread-1/Noisy%20work";
    render(<ToolOutputIncidentExplorerWindow />);

    const steerButton = await screen.findByRole("button", { name: "Steer exact active turn" });
    await waitFor(() => expect(steerButton).toBeEnabled());
    fireEvent.click(steerButton);
    await waitFor(() => expect(steerTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedTurnId: "turn-1",
        threadId: "thread-1",
      }),
    ));
  });

  it("does not send or steer a historical finding while another turn is active", async () => {
    const startTurn = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-1",
      turnId: "turn-3",
    }));
    const steerTurn = vi.fn();
    installApi({
      readThread: async () => buildResponse("turn-2"),
      startTurn,
      steerTurn,
    });
    window.location.hash = "#tool-output-incidents/codex/thread-1/Noisy%20work";
    render(<ToolOutputIncidentExplorerWindow />);

    expect(await screen.findByText(/cannot steer the active turn/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send next turn" })).toBeDisabled();
    expect(startTurn).not.toHaveBeenCalled();
    expect(steerTurn).not.toHaveBeenCalled();
  });

  it("sends a historical finding as a new turn after the thread is idle", async () => {
    const startTurn = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-1",
      turnId: "turn-3",
    }));
    const steerTurn = vi.fn();
    installApi({
      readThread: async () => buildResponse(),
      startTurn,
      steerTurn,
    });
    window.location.hash = "#tool-output-incidents/codex/thread-1/Noisy%20work";
    render(<ToolOutputIncidentExplorerWindow />);

    const sendButton = await screen.findByRole("button", { name: "Send next turn" });
    await waitFor(() => expect(sendButton).toBeEnabled());
    fireEvent.click(sendButton);
    await waitFor(() => expect(startTurn).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: "thread-1" }),
    ));
    expect(steerTurn).not.toHaveBeenCalled();
  });

  it("refreshes the visible case snapshot when an existing window is examined again", async () => {
    let refreshListener: (() => void) | undefined;
    let readCount = 0;
    installApi({
      onToolOutputIncidentExplorerRefresh: (callback: () => void) => {
        refreshListener = callback;
        return () => {
          refreshListener = undefined;
        };
      },
      readThread: async () => {
        readCount += 1;
        return buildResponse(undefined, readCount === 1 ? 1 : 2);
      },
    });
    window.location.hash = "#tool-output-incidents/codex/thread-1/Noisy%20work";
    render(<ToolOutputIncidentExplorerWindow />);
    const metrics = await screen.findByLabelText("Incident metrics");

    expect(within(metrics).getByText("1")).toBeInTheDocument();
    await act(async () => refreshListener?.());
    await waitFor(() => expect(within(metrics).getByText("2")).toBeInTheDocument());
    expect(readCount).toBe(2);
  });
});

function installApi(api: Record<string, unknown>): void {
  Object.defineProperty(window, "pwragent", {
    configurable: true,
    value: api,
  });
}

function buildResponse(
  activeTurnId?: string,
  invocationCount = 1,
): AppServerReadThreadResponse {
  const invocations = Array.from({ length: invocationCount }, (_, index) => ({
    ...buildInvocation(),
    invocationId: `invocation-${index + 1}`,
    itemId: `item-${index + 1}`,
    outputChars: 8_000 + index * 1_000,
  }));
  return {
    backend: "codex",
    fetchedAt: 1,
    threadId: "thread-1",
    toolAccounting: {
      alerts: [],
      invocations,
      summaries: [],
    },
    replay: {
      entries: [{
        type: "activity",
        id: "activity-1",
        createdAt: 1_800_000_000_000,
        details: [{
          id: "item-1-output",
          kind: "command",
          label: "pnpm test",
          command: {
            displayCommand: "pnpm test",
            output: "failure\nwarning\n",
            source: "shell",
          },
        }],
        status: "completed",
        summary: "Ran tests",
        ...(activeTurnId
          ? {
              turn: {
                id: activeTurnId,
                status: "in_progress" as const,
              },
            }
          : {}),
      }],
      messages: [],
      pagination: {
        hasPreviousPage: false,
        supportsPagination: true,
      },
      threadStatus: "active",
    },
  };
}

function buildInvocation(): ThreadToolInvocationRecord {
  return {
    backend: "codex",
    category: "build-test",
    debugLines: 0,
    errorLines: 1,
    estimatedOutputTokens: 2_000,
    infoLines: 0,
    invocationId: "invocation-1",
    itemId: "item-1",
    noisy: true,
    noisyReason: "verbose-build-test",
    normalizedCommand: "pnpm test",
    observedAt: 1_800_000_000_000,
    outputChars: 8_000,
    outputLines: 200,
    outputState: "available",
    outputTruncated: false,
    source: "history",
    status: "completed",
    suggestedPrompt: "Reduce output for pnpm test.",
    threadId: "thread-1",
    toolName: "commandExecution",
    turnId: "turn-1",
    updatedAt: 1_800_000_000_000,
    warningLines: 1,
  };
}
