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

  it("ranks cases by output size and measures each against the output cap", async () => {
    installApi({ readThread: async () => buildMultiTurnResponse() });
    window.location.hash = "#tool-output-incidents/codex/thread-1/Noisy%20work";
    render(<ToolOutputIncidentExplorerWindow />);

    const cases = await screen.findByLabelText("Incident cases");
    const rows = within(cases).getAllByRole("button", { name: /chars/ });
    expect(rows[0]).toHaveAttribute("title", expect.stringContaining("wide-scan"));
    expect(rows[0]).toHaveTextContent("75% of cap");
    expect(rows[1]).toHaveTextContent("60% of cap");
  });

  it("reports round trips per turn, counting calls that were never flagged", async () => {
    installApi({ readThread: async () => buildMultiTurnResponse() });
    window.location.hash = "#tool-output-incidents/codex/thread-1/Noisy%20work";
    render(<ToolOutputIncidentExplorerWindow />);

    const turns = await screen.findByLabelText("Cost by turn");
    /* turn-1 holds one flagged call plus two quiet ones; the quiet calls
       replay context too, so they belong in the round-trip count. */
    expect(within(turns).getByRole("button", { name: /Turn 1/ }))
      .toHaveTextContent("3 calls");
    expect(within(turns).getByRole("button", { name: /Turn 2/ }))
      .toHaveTextContent("1 call");
    expect(within(turns).getByTitle(
      "7.6k estimated tool-output tokens; this is not provider-billed usage",
    )).toHaveTextContent("7.6k est.");
  });

  it("labels the hover price as billed rather than treating tool output as usage", async () => {
    const response = buildMultiTurnResponse();
    response.pricing = {
      lines: [{
        createdAt: 1,
        currency: "USD",
        threadId: "thread-1",
        totalCostMicros: 123_120,
        turnId: "turn-1",
      }] as never,
      summaries: [],
    };
    installApi({ readThread: async () => response });
    window.location.hash = "#tool-output-incidents/codex/thread-1/Noisy%20work";
    render(<ToolOutputIncidentExplorerWindow />);

    const timeline = await screen.findByRole("group", {
      name: "Tool cost per turn, in order",
    });
    expect(within(timeline).getAllByRole("button")[0]).toHaveAttribute(
      "title",
      expect.stringContaining("7.6k estimated tool-output tokens · 3 calls · billed cost $0.12"),
    );
    expect(screen.getByTitle("Billed cost from provider-reported usage: $0.12"))
      .toHaveTextContent("$0.12");
  });

  it("widens the turn strip from flagged turns to every turn with tool calls", async () => {
    const response = buildMultiTurnResponse();
    /* A turn of only small calls: invisible in the flagged scope, present in
       the all scope. */
    response.toolAccounting!.invocations.push({
      ...response.toolAccounting!.invocations[1]!,
      invocationId: "invocation-quiet-turn",
      itemId: "item-quiet-turn",
      noisy: false,
      observedAt: 1_800_000_005_000,
      outputChars: 120,
      turnId: "turn-3",
    });
    installApi({ readThread: async () => response });
    window.location.hash = "#tool-output-incidents/codex/thread-1/Noisy%20work";
    render(<ToolOutputIncidentExplorerWindow />);

    const turns = await screen.findByLabelText("Cost by turn");
    expect(within(turns).queryByRole("button", { name: /Turn 3/ })).toBeNull();

    fireEvent.click(within(turns).getByRole("button", { name: /All with tool calls/ }));
    expect(await within(turns).findByRole("button", { name: /Turn 3/ }))
      .toBeInTheDocument();
    expect(within(turns).getByRole("button", { name: /Flagged \(2\)/ }))
      .toHaveAttribute("aria-pressed", "false");
  });

  it("filters cases from the chronological timeline spark", async () => {
    installApi({ readThread: async () => buildMultiTurnResponse() });
    window.location.hash = "#tool-output-incidents/codex/thread-1/Noisy%20work";
    render(<ToolOutputIncidentExplorerWindow />);

    const timeline = await screen.findByRole("group", {
      name: "Tool cost per turn, in order",
    });
    const columns = within(timeline).getAllByRole("button");
    expect(columns).toHaveLength(2);
    /* Hover text carries the numbers the bars encode. */
    expect(columns[0]).toHaveAttribute(
      "title",
      expect.stringMatching(/Turn 1 .*estimated tool-output tokens.*3 calls/),
    );

    fireEvent.click(columns[1]!);
    const cases = screen.getByLabelText("Incident cases");
    await waitFor(() =>
      expect(within(cases).getAllByRole("button", { name: /chars/ })).toHaveLength(1));
    expect(within(cases).getAllByRole("button", { name: /chars/ })[0])
      .toHaveAttribute("title", expect.stringContaining("pnpm test"));
  });

  it("filters the case list to a single turn", async () => {
    installApi({ readThread: async () => buildMultiTurnResponse() });
    window.location.hash = "#tool-output-incidents/codex/thread-1/Noisy%20work";
    render(<ToolOutputIncidentExplorerWindow />);

    const turns = await screen.findByLabelText("Cost by turn");
    const cases = screen.getByLabelText("Incident cases");
    expect(within(cases).getAllByRole("button", { name: /chars/ })).toHaveLength(2);

    const secondTurn = within(turns).getByRole("button", { name: /Turn 2/ });
    fireEvent.click(secondTurn);

    await waitFor(() => expect(secondTurn).toHaveAttribute("aria-pressed", "true"));
    const filtered = within(cases).getAllByRole("button", { name: /chars/ });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]).toHaveAttribute("title", expect.stringContaining("pnpm test"));
    expect(within(cases).getByText("Showing 1 of 2 cases")).toBeInTheDocument();

    fireEvent.click(within(cases).getByRole("button", { name: "Clear filters" }));
    await waitFor(() =>
      expect(within(cases).getAllByRole("button", { name: /chars/ })).toHaveLength(2));
  });

  it("filters by category from the composition legend", async () => {
    installApi({ readThread: async () => buildMultiTurnResponse() });
    window.location.hash = "#tool-output-incidents/codex/thread-1/Noisy%20work";
    render(<ToolOutputIncidentExplorerWindow />);

    const legend = await screen.findByRole("group", { name: "Filter by category" });
    fireEvent.click(within(legend).getByRole("button", { name: /Tests & builds/ }));

    const cases = screen.getByLabelText("Incident cases");
    await waitFor(() =>
      expect(within(cases).getAllByRole("button", { name: /chars/ })).toHaveLength(1));
    expect(within(cases).getAllByRole("button", { name: /chars/ })[0])
      .toHaveAttribute("title", expect.stringContaining("pnpm test"));
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
    outputChars: 24_000 + index * 1_000,
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

/**
 * Two turns, mixed categories, and quiet calls alongside flagged ones — the
 * shape the summary band and turn strip are built to read.
 */
function buildMultiTurnResponse(): AppServerReadThreadResponse {
  const base = buildInvocation();
  const invocations: ThreadToolInvocationRecord[] = [
    {
      ...base,
      category: "shell",
      estimatedOutputTokens: 7_500,
      invocationId: "invocation-wide",
      itemId: "item-wide",
      normalizedCommand: "rg --files wide-scan",
      observedAt: 1_800_000_000_000,
      outputChars: 30_000,
      turnId: "turn-1",
    },
    {
      ...base,
      category: "shell",
      estimatedOutputTokens: 40,
      invocationId: "invocation-quiet-1",
      itemId: "item-quiet-1",
      noisy: false,
      normalizedCommand: "git status",
      observedAt: 1_800_000_001_000,
      outputChars: 160,
      turnId: "turn-1",
    },
    {
      ...base,
      category: "shell",
      estimatedOutputTokens: 40,
      invocationId: "invocation-quiet-2",
      itemId: "item-quiet-2",
      noisy: false,
      normalizedCommand: "git diff --stat",
      observedAt: 1_800_000_002_000,
      outputChars: 160,
      turnId: "turn-1",
    },
    {
      ...base,
      category: "build-test",
      estimatedOutputTokens: 6_000,
      invocationId: "invocation-tests",
      itemId: "item-tests",
      normalizedCommand: "pnpm test",
      observedAt: 1_800_000_003_000,
      outputChars: 24_000,
      turnId: "turn-2",
    },
  ];
  return {
    backend: "codex",
    fetchedAt: 1,
    threadId: "thread-1",
    toolAccounting: { alerts: [], invocations, summaries: [] },
    replay: {
      entries: [],
      messages: [],
      pagination: { hasPreviousPage: false, supportsPagination: true },
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
    estimatedOutputTokens: 6_000,
    infoLines: 0,
    invocationId: "invocation-1",
    itemId: "item-1",
    noisy: true,
    noisyReason: "verbose-build-test",
    normalizedCommand: "pnpm test",
    observedAt: 1_800_000_000_000,
    outputChars: 24_000,
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

describe("analysis coverage reporting", () => {
  it("reconciles what the scan reached with what the thread already knows", async () => {
    /* Measured on a real 236-turn thread: the scan reads 202 calls still in
       replay while the store holds 2,225, because the rest were recorded live
       and their transcript entries were compacted away. Reporting only the
       scan's own count read as a contradiction beside a longer case list. */
    const analyzed = buildMultiTurnResponse();
    const analyzeThreadToolHistory = vi.fn(async () => ({
      accounting: analyzed.toolAccounting!,
      coverage: {
        analyzedAt: 1,
        analyzerVersion: "1",
        completeness: "complete" as const,
        entryCount: 1_704,
        invocationCount: 1,
        missingOutputCount: 0,
        pageCount: 1,
      },
    }));
    installApi({
      analyzeThreadToolHistory,
      readThread: async () => buildMultiTurnResponse(),
    });
    window.location.hash = "#tool-output-incidents/codex/thread-1/Noisy%20work";
    render(<ToolOutputIncidentExplorerWindow />);

    fireEvent.click(await screen.findByRole("button", { name: /Analyze history/ }));

    expect(await screen.findByText(/Scanned 1 tool call still in replay/))
      .toBeInTheDocument();
    /* The fixture holds 4 invocations; 3 predate what replay retained. */
    expect(screen.getByText(/3 older calls recorded earlier remain accounted/))
      .toBeInTheDocument();
  });
});

describe("ToolOutputIncidentExplorerWindow federation", () => {
  it("reads and analyzes a peer's thread on the instance that owns it", async () => {
    /* Without the target every read runs against the local registry, which
       does not have the peer's thread id — the viewer's explorer came up
       empty with no explanation. */
    const readThread = vi.fn(async () => buildMultiTurnResponse());
    const analyzeThreadToolHistory = vi.fn(async () => ({
      accounting: { alerts: [], invocations: [], summaries: [] },
      coverage: {
        analyzedAt: 1,
        analyzerVersion: "1",
        completeness: "complete" as const,
        entryCount: 0,
        invocationCount: 0,
        missingOutputCount: 0,
        pageCount: 1,
      },
    }));
    installApi({ analyzeThreadToolHistory, readThread });
    window.location.hash =
      "#tool-output-incidents/codex/thread-1/Noisy%20work/PwrAgent/peer-instance";
    render(<ToolOutputIncidentExplorerWindow />);

    await waitFor(() => expect(readThread).toHaveBeenCalledWith(
      expect.objectContaining({
        federationTarget: { instanceId: "peer-instance", scope: "remote" },
      }),
    ));

    fireEvent.click(await screen.findByRole("button", { name: /Analyze history/ }));
    await waitFor(() => expect(analyzeThreadToolHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        federationTarget: { instanceId: "peer-instance", scope: "remote" },
        threadId: "thread-1",
      }),
    ));
  });

  it("leaves a local thread's reads untargeted", async () => {
    const readThread = vi.fn(async () => buildMultiTurnResponse());
    installApi({ readThread });
    window.location.hash = "#tool-output-incidents/codex/thread-1/Noisy%20work";
    render(<ToolOutputIncidentExplorerWindow />);

    await waitFor(() => expect(readThread).toHaveBeenCalled());
    expect(readThread).not.toHaveBeenCalledWith(
      expect.objectContaining({ federationTarget: expect.anything() }),
    );
  });
});

describe("turn selection is shared across both turn controls", () => {
  it("marks the spark column selected when a strip row selects the turn", async () => {
    /* The two controls were bound to one filter but only the strip rendered
       it: clicking a spark column toggled the strip's selection while the
       column itself stayed unmarked, so it read as a dead control. */
    installApi({ readThread: async () => buildMultiTurnResponse() });
    window.location.hash = "#tool-output-incidents/codex/thread-1/Noisy%20work";
    render(<ToolOutputIncidentExplorerWindow />);

    const turns = await screen.findByLabelText("Cost by turn");
    const timeline = screen.getByRole("group", {
      name: "Tool cost per turn, in order",
    });
    const sparkColumns = within(timeline).getAllByRole("button");
    expect(sparkColumns.every((column) =>
      column.getAttribute("aria-pressed") === "false")).toBe(true);

    fireEvent.click(within(turns).getByRole("button", { name: /Turn 2/ }));

    await waitFor(() => expect(
      within(timeline).getAllByRole("button", { name: /Turn 2/ })[0],
    ).toHaveAttribute("aria-pressed", "true"));
    /* And only that one. */
    expect(within(timeline).getAllByRole("button")
      .filter((column) => column.getAttribute("aria-pressed") === "true"))
      .toHaveLength(1);
  });
});
