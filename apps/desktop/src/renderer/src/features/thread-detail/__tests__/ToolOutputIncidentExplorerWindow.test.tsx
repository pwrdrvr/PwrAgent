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
import {
  readStoredSavingsLayout,
  SAVINGS_DETAILS_MIN_HEIGHT,
} from "../token-miser-savings-layout";
import { ToolOutputIncidentExplorerWindow } from "../ToolOutputIncidentExplorerWindow";

afterEach(() => {
  Reflect.deleteProperty(window, "pwragent");
  window.localStorage.clear();
  window.location.hash = "";
});

/**
 * The Savings lens folds its reference sections by default, so a test that
 * asserts on one has to open it first. Each section is a named region, which
 * keeps these lookups off the results list below — its rows are buttons whose
 * text also begins "Code Mode".
 */
function savingsSection(label: string) {
  return within(screen.getByRole("region", { name: label }));
}

function openSavingsSection(label: string) {
  fireEvent.click(savingsSection(label).getByRole("button"));
}

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

  it("names the active savings lens in the breadcrumb", async () => {
    const response = buildResponse();
    response.toolAccounting!.tokenMiser = {
      interceptionCount: 1,
      originalCharacters: 40_000,
      baselineParentTokens: 10_000,
      replacementTokens: 300,
      retrievedTokens: 0,
      estimatedParentTokensSaved: 9_700,
      interceptions: [],
    };
    installApi({ readThread: async () => response });
    window.location.hash =
      "#tool-output-incidents/codex/thread-1/Noisy%20work/PwrAgent";
    render(<ToolOutputIncidentExplorerWindow />);

    await screen.findByRole("tab", { name: /Savings/, selected: true });
    expect(screen.getByLabelText(
      "PwrAgent > Noisy work > Token Miser Savings",
    )).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: /Incidents/ }));
    expect(screen.getByLabelText(
      "PwrAgent > Noisy work > Tool Output Incidents",
    )).toBeInTheDocument();
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

  // Gating uses Token Miser's own threshold; flagging uses the much higher
  // alert threshold. Pairing them printed "gated 25 of 7 flagged calls".
  it("states the gated share when the counts reconcile", async () => {
    const response = buildResponse();
    const invocations = response.toolAccounting!.invocations;
    response.toolAccounting!.tokenMiser = {
      interceptionCount: 1,
      originalCharacters: 40_000,
      baselineParentTokens: 10_000,
      replacementTokens: 300,
      retrievedTokens: 0,
      estimatedParentTokensSaved: 9_700,
      interceptions: [],
    };
    installApi({ readThread: async () => response });
    window.location.hash = "#tool-output-incidents/codex/thread-1/Noisy%20work";
    render(<ToolOutputIncidentExplorerWindow />);

    fireEvent.click(await screen.findByRole("tab", { name: /Incidents/ }));
    expect(
      screen.getByText(
        new RegExp(`Token Miser gated 1 of ${invocations.length} tool calls?`),
      ),
    ).toBeInTheDocument();
  });

  it("counts gated calls against every tool call, not the flagged ones", async () => {
    const response = buildResponse();
    const invocations = response.toolAccounting!.invocations;
    response.toolAccounting!.tokenMiser = {
      interceptionCount: invocations.length + 1,
      originalCharacters: 100_000,
      baselineParentTokens: 25_000,
      replacementTokens: 900,
      retrievedTokens: 0,
      estimatedParentTokensSaved: 24_100,
      interceptions: [],
    };
    installApi({ readThread: async () => response });
    window.location.hash = "#tool-output-incidents/codex/thread-1/Noisy%20work";
    render(<ToolOutputIncidentExplorerWindow />);

    fireEvent.click(await screen.findByRole("tab", { name: /Incidents/ }));
    // More gated than accounted-for calls cannot be stated as a ratio, so the
    // count stands alone rather than claiming an impossible denominator.
    expect(
      screen.getByText(/^Token Miser gated \d+ calls and kept /),
    ).toBeInTheDocument();
    expect(screen.queryByText(/gated \d+ of \d+ flagged/)).not.toBeInTheDocument();
  });

  it("shows unavailable nested capture without implying zero commands", async () => {
    const response = buildResponse();
    response.toolAccounting!.tokenMiser = {
      interceptionCount: 0, originalCharacters: 0, baselineParentTokens: 0,
      replacementTokens: 0, retrievedTokens: 0, estimatedParentTokensSaved: 0,
      interceptions: [], codeMode: {
      callCount: 2, unclassifiedCellCount: 2, commandCellCount: null,
      directCommandCellCount: null, dispatchClusterCount: null,
      multiInvocationClusterCount: null, largestDispatchCluster: null,
      nestedCommandInvocationCount: null, patchCellCount: null, otherCellCount: null,
      pollingCellCount: null, directCount: 1, summarizedCount: 1, passThroughCount: 0,
      retrievalCount: 0, capturedNestedInvocationCount: null, observations: [],
      },
    };
    installApi({ readThread: async () => response });
    window.location.hash = "#tool-output-incidents/codex/thread-1/Noisy%20work";
    render(<ToolOutputIncidentExplorerWindow />);
    await screen.findByRole("region", { name: "Code Mode" });
    expect(savingsSection("Code Mode").getByRole("button"))
      .toHaveTextContent(/Unavailable command cells.*Unavailable dispatch clusters/);
    openSavingsSection("Code Mode");
    expect(savingsSection("Code Mode").getByText("Other cells").nextSibling)
      .toHaveTextContent("Unavailable");
    expect(savingsSection("Code Mode").getByText(/2 cells have no nested tool capture/))
      .toBeInTheDocument();
  });

  it("makes ungated Code Mode calls a filter in the shared results list", async () => {
    const response = buildResponse();
    const observations = Array.from({ length: 2 }, (_, index) => ({
      observationId: `direct-${index}`,
      turnId: "turn-1",
      callId: `call-${index}`,
      cellId: `cell-${index}`,
      createdAt: 1_800_000_000_000 + index,
      outputCharacters: 4_000 + index,
      maxOutputTokens: 10_000,
      scriptStatus: "completed",
      script: `text(result${index}.output)`,
      retrieval: false,
      capturedNestedInvocationCount: 1,
      disposition: "direct" as const,
    }));
    response.toolAccounting!.tokenMiser = {
      interceptionCount: 0,
      originalCharacters: 0,
      baselineParentTokens: 0,
      replacementTokens: 0,
      retrievedTokens: 0,
      estimatedParentTokensSaved: 0,
      interceptions: [],
      codeMode: {
        callCount: 2,
        commandCellCount: 2,
        directCommandCellCount: 2,
        dispatchClusterCount: 2,
        multiInvocationClusterCount: 0,
        largestDispatchCluster: 1,
        nestedCommandInvocationCount: 2,
        patchCellCount: 0,
        otherCellCount: 0,
        pollingCellCount: 0,
        directCount: 2,
        summarizedCount: 0,
        passThroughCount: 0,
        retrievalCount: 0,
        capturedNestedInvocationCount: 2,
        observations,
      },
    };
    installApi({ readThread: async () => response });
    window.location.hash = "#tool-output-incidents/codex/thread-1/Noisy%20work";
    render(<ToolOutputIncidentExplorerWindow />);

    await screen.findByRole("region", { name: "Code Mode" });
    expect(savingsSection("Code Mode").getByRole("button"))
      .toHaveTextContent(/2 calls.*2 direct/);
    openSavingsSection("Code Mode");
    expect(savingsSection("Code Mode").getByText("Direct command cells"))
      .toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^All\s*2$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Direct\s*2$/ })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Ungated Code Mode results" }))
      .not.toBeInTheDocument();
    expect(screen.getAllByRole("button", {
      name: /Code Mode4,00[01] charactersdirect/,
    })).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: /^Direct\s*2$/ }));
    expect(screen.getAllByRole("button", {
      name: /Code Mode4,00[01] charactersdirect/,
    })).toHaveLength(2);
  });

  it("keeps Code Mode calls, command cells, decisions, and dispatches distinct", async () => {
    const response = buildResponse();
    response.toolAccounting!.tokenMiser = {
      interceptionCount: 31,
      passThroughCount: 7,
      policyPassThroughCount: 5,
      helperPassThroughCount: 2,
      helperDecisionCount: 26,
      originalCharacters: 100_000,
      baselineParentTokens: 25_000,
      replacementTokens: 3_000,
      retrievedTokens: 1_643,
      estimatedParentTokensSaved: 20_357,
      interceptions: [],
      codeMode: {
        callCount: 143,
        commandCellCount: 121,
        directCommandCellCount: 90,
        dispatchClusterCount: 121,
        multiInvocationClusterCount: 1,
        largestDispatchCluster: 2,
        nestedCommandInvocationCount: 122,
        patchCellCount: 4,
        otherCellCount: 17,
        pollingCellCount: 3,
        directCount: 90,
        summarizedCount: 24,
        passThroughCount: 7,
        retrievalCount: 1,
        capturedNestedInvocationCount: 130,
        observations: [],
      },
    };
    response.pricing = {
      compactions: [{
        backend: "codex",
        threadId: "thread-1",
        compactionId: "compaction-1",
        observedAt: 1_800_000_000_000,
        updatedAt: 1_800_000_000_100,
        coldUsageLineId: "usage-cold-1",
        coldUncachedTokens: 50_000,
        coldCostMicros: 250_000,
      }],
      lines: [buildContextUsageLine()],
      summaries: [],
    };
    installApi({ readThread: async () => response });
    window.location.hash = "#tool-output-incidents/codex/thread-1/Noisy%20work";
    render(<ToolOutputIncidentExplorerWindow />);

    // Folded, each section leads with its own headline counts. Code Mode
    // calls, command cells and reducer decisions are three different numbers
    // and must never be collapsed into one.
    await screen.findByRole("region", { name: "Code Mode" });
    expect(savingsSection("Code Mode").getByRole("button")).toHaveTextContent(
      /143 calls.*121 command cells.*121 dispatch clusters/,
    );
    expect(savingsSection("Decisions").getByRole("button"))
      .toHaveTextContent(/31 decisions/);

    openSavingsSection("Code Mode");
    const codeMode = savingsSection("Code Mode");
    expect(codeMode.getByText(/122 nested · 1\.01 per cell/)).toBeInTheDocument();
    expect(codeMode.getByText(/1 multi-invocation · largest 2/)).toBeInTheDocument();
    expect(codeMode.getByText("Direct command cells").nextSibling)
      .toHaveTextContent("90");
    // Nested invocations divided by decisions rather than by command cells.
    expect(screen.queryByText(/3\.94 per/)).not.toBeInTheDocument();

    openSavingsSection("Decisions");
    const decisions = savingsSection("Decisions");
    expect(decisions.getByText("Luna evaluations").nextSibling)
      .toHaveTextContent("26");
    expect(decisions.getByText(/5 policy · 2 helper/)).toBeInTheDocument();

    openSavingsSection("Context boundaries");
    const boundaries = savingsSection("Context boundaries");
    expect(boundaries.getByText("Cold replay tokens").nextSibling)
      .toHaveTextContent(/50k\$0\.25/);
    expect(boundaries.getByText(/244k \/ 258k \(94\.4%\)/)).toBeInTheDocument();
    expect(boundaries.getByText(/131k \/ 258k \(50\.9%\)/)).toBeInTheDocument();
  });

  it("warns on a near-limit thread even when no compaction occurred", async () => {
    const response = buildResponse();
    response.toolAccounting!.tokenMiser = {
      interceptionCount: 1,
      originalCharacters: 40_000,
      baselineParentTokens: 10_000,
      replacementTokens: 400,
      retrievedTokens: 0,
      estimatedParentTokensSaved: 9_600,
      interceptions: [],
    };
    response.pricing = {
      compactions: [],
      lines: [{
        ...buildContextUsageLine(),
        finalContextTokens: 239_000,
        peakContextTokens: 240_000,
      }],
      summaries: [],
    } as never;
    installApi({ readThread: async () => response });
    window.location.hash = "#tool-output-incidents/codex/thread-1/Near%20limit";
    render(<ToolOutputIncidentExplorerWindow />);

    await screen.findByRole("region", { name: "Context boundaries" });
    openSavingsSection("Context boundaries");
    const boundaries = savingsSection("Context boundaries");
    expect(boundaries.getByText("Parent compactions").nextSibling)
      .toHaveTextContent("0");
    expect(boundaries.getByText(/240k \/ 258k \(92\.9%\)/)).toBeInTheDocument();
    expect(boundaries.getByText(/239k \/ 258k \(92\.5%\)/)).toBeInTheDocument();
    expect(boundaries.getByText(
      /Warning: this thread approached the context limit/,
    )).toBeInTheDocument();
  });

  it("shows every compaction on the Savings context-by-turn chart", async () => {
    const response = buildResponse();
    response.toolAccounting!.tokenMiser = {
      baselineParentTokens: 10_000,
      estimatedParentTokensSaved: 9_600,
      interceptionCount: 1,
      interceptions: [],
      originalCharacters: 40_000,
      replacementTokens: 400,
      retrievedTokens: 0,
    };
    response.pricing = {
      compactions: [
        {
          backend: "codex",
          compactionId: "compaction-turn-2",
          observedAt: 1_800_000_010_500,
          threadId: "thread-1",
          turnId: "turn-2",
          updatedAt: 1_800_000_010_500,
        },
        {
          backend: "codex",
          compactionId: "compaction-turn-3",
          observedAt: 1_800_000_020_000,
          threadId: "thread-1",
          turnId: "turn-3",
          updatedAt: 1_800_000_020_000,
        },
      ],
      lines: [
        {
          ...buildContextUsageLine(),
          createdAt: 1_800_000_000_000,
          finalContextTokens: 231_000,
          peakContextTokens: 240_000,
          turnId: "turn-1",
          usageLineId: "usage-turn-1",
        },
        {
          ...buildContextUsageLine(),
          createdAt: 1_800_000_010_000,
          finalContextTokens: 21_500,
          peakContextTokens: 243_864,
          turnId: "turn-2",
          usageLineId: "usage-turn-2",
        },
      ],
      summaries: [],
    };
    installApi({ readThread: async () => response });
    window.location.hash = "#tool-output-incidents/codex/thread-1/Context%20history";
    render(<ToolOutputIncidentExplorerWindow />);

    const chart = await screen.findByRole("region", {
      name: "Token Miser context by turn",
    });
    expect(within(chart).getAllByRole("img")).toHaveLength(3);
    expect(within(chart).getByRole("img", {
      name: /Turn 2.*final context 21\.5k.*context compacted 1 time/,
    })).toHaveAttribute("data-compaction", "true");
    expect(within(chart).getByRole("img", {
      name: /Turn 3.*final context not observed.*context compacted 1 time/,
    })).toHaveAttribute("data-compaction", "true");
    expect(within(chart).getByText(/compaction boundary/)).toBeInTheDocument();
  });

  // The summary is what the parent actually received in place of the payload.
  // Without it the screen can only say how many tokens were traded, never what
  // was traded for — which is the only way to judge whether a "win" was one.
  it("shows safe decision notes and unavailable originals while filtering outcomes", async () => {
    const response = buildResponse();
    const gate = (
      objectId: string,
      saved: number,
      retrieved: number,
    ) => ({
      objectId,
      turnId: "turn-1",
      toolUseId: `item-${objectId}`,
      toolName: `cmd-${objectId}`,
      createdAt: 1_800_000_000_000,
      originalCharacters: 40_000,
      baselineParentTokens: 10_000,
      replacementTokens: 500,
      retrievedTokens: retrieved,
      estimatedParentTokensSaved: saved,
      summary: {
        summary: `Traced the handler for ${objectId}.`,
        usefulDetails: [`pr-auto-dispatch.ts:326 clears the timer for ${objectId}`],
        suggestedNextStep: `Inspect notifyPending for ${objectId}.`,
      },
    });
    response.toolAccounting!.tokenMiser = {
      interceptionCount: 3,
      originalCharacters: 120_000,
      baselineParentTokens: 30_000,
      replacementTokens: 1_500,
      retrievedTokens: 9_000,
      estimatedParentTokensSaved: 19_500,
      interceptions: [
        gate("win-1", 9_500, 0),
        gate("leak-1", 4_000, 6_000),
        gate("cost-1", -200, 0),
      ],
    };
    installApi({ readThread: async () => response });
    window.location.hash = "#tool-output-incidents/codex/thread-1/Noisy%20work";
    render(<ToolOutputIncidentExplorerWindow />);

    await screen.findByRole("tab", { name: /Savings/, selected: true });
    expect(screen.getByRole("button", { name: /^All\s*3$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Wins\s*1$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Misses\s*1$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Big misses\s*1$/ })).toBeInTheDocument();

    // The summary is behind a disclosure so the list stays scannable.
    expect(screen.queryByText("Traced the handler for win-1.")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /win-1/ }));
    expect(screen.getByText("Output summarized.")).toBeInTheDocument();
    expect(screen.getByText(/Original output is expired or unavailable/)).toBeInTheDocument();
    expect(screen.queryByText("Traced the handler for win-1.")).not.toBeInTheDocument();
    expect(screen.queryByText(/Inspect notifyPending for win-1/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Big misses\s*1$/ }));
    expect(screen.getByRole("button", { name: /cost-1/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /win-1/ })).not.toBeInTheDocument();
  });

  it("separates summary and pass-through tokens on the decisions row", async () => {
    const response = buildResponse();
    response.toolAccounting!.tokenMiser = {
      interceptionCount: 2,
      passThroughCount: 1,
      originalCharacters: 51_000,
      baselineParentTokens: 12_715,
      replacementTokens: 3_107,
      retrievedTokens: 0,
      estimatedParentTokensSaved: 9_608,
      interceptions: [
        {
          objectId: "summary-1",
          turnId: "turn-1",
          toolUseId: "item-summary",
          toolName: "Code Mode",
          createdAt: 1_800_000_000_000,
          originalCharacters: 40_000,
          baselineParentTokens: 10_000,
          replacementTokens: 392,
          retrievedTokens: 0,
          estimatedParentTokensSaved: 9_608,
          disposition: "summarized",
        },
        {
          objectId: "pass-through-1",
          turnId: "turn-1",
          toolUseId: "item-pass-through",
          toolName: "Code Mode",
          createdAt: 1_800_000_000_100,
          originalCharacters: 10_858,
          baselineParentTokens: 2_715,
          replacementTokens: 2_715,
          retrievedTokens: 0,
          estimatedParentTokensSaved: 0,
          disposition: "passed_through",
        },
      ],
    };
    installApi({ readThread: async () => response });
    window.location.hash = "#tool-output-incidents/codex/thread-1/Adaptive%20proof";
    render(<ToolOutputIncidentExplorerWindow />);

    await screen.findByRole("region", { name: "Decisions" });
    expect(savingsSection("Decisions").getByRole("button")).toHaveTextContent(
      /1 summarized.*1 passed through/,
    );
    openSavingsSection("Decisions");
    const decisions = savingsSection("Decisions");
    expect(decisions.getByText("392 of summaries")).toBeInTheDocument();
    expect(decisions.getByText("2.7k tokens")).toBeInTheDocument();
    expect(decisions.getByText("nothing read back later")).toBeInTheDocument();
  });

  /* The lens shipped with every band above the results list fixed-height and
     fully expanded. At the 1000x700 window it runs in, they needed more than
     the window, and the list — the only part an operator can explore — was
     left rendering a single row. These three cover the fix: the reference
     rows cost nothing until asked for, the operator's choice survives, and
     the grip can never hand the list less than its floor. */
  function buildSavingsResponse() {
    const response = buildResponse();
    response.toolAccounting!.tokenMiser = {
      interceptionCount: 23,
      passThroughCount: 5,
      policyPassThroughCount: 0,
      helperPassThroughCount: 5,
      helperDecisionCount: 23,
      originalCharacters: 100_000,
      baselineParentTokens: 25_000,
      replacementTokens: 3_000,
      retrievedTokens: 0,
      estimatedParentTokensSaved: 22_000,
      interceptions: [],
      codeMode: {
        callCount: 37,
        commandCellCount: 0,
        directCommandCellCount: 0,
        dispatchClusterCount: 0,
        multiInvocationClusterCount: 0,
        largestDispatchCluster: 0,
        nestedCommandInvocationCount: 0,
        patchCellCount: 0,
        otherCellCount: 37,
        pollingCellCount: 0,
        directCount: 14,
        summarizedCount: 18,
        passThroughCount: 5,
        retrievalCount: 0,
        capturedNestedInvocationCount: 0,
        observations: [],
      },
    };
    return response;
  }

  it("folds every reference section so the results list is not squeezed", async () => {
    installApi({ readThread: async () => buildSavingsResponse() });
    window.location.hash = "#tool-output-incidents/codex/thread-1/Noisy%20work";
    render(<ToolOutputIncidentExplorerWindow />);

    await screen.findByRole("region", { name: "Decisions" });
    for (const label of ["Decisions", "Context boundaries", "Code Mode"]) {
      expect(savingsSection(label).getByRole("button"))
        .toHaveAttribute("aria-expanded", "false");
    }
    // Folded rows still carry their headline numbers, so nothing has to be
    // opened to read the screen.
    expect(savingsSection("Decisions").getByRole("button"))
      .toHaveTextContent(/23 decisions.*18 summarized.*5 passed through/);
    expect(savingsSection("Code Mode").getByRole("button"))
      .toHaveTextContent(/37 calls.*23 gated.*14 direct/);
    // No section body is mounted until one is asked for.
    expect(screen.queryByText("Luna evaluations")).not.toBeInTheDocument();
    expect(screen.queryByText("Retrieval cells")).not.toBeInTheDocument();
  });

  it("remembers which sections the operator unfolded", async () => {
    installApi({ readThread: async () => buildSavingsResponse() });
    window.location.hash = "#tool-output-incidents/codex/thread-1/Noisy%20work";
    const first = render(<ToolOutputIncidentExplorerWindow />);

    await screen.findByRole("region", { name: "Code Mode" });
    openSavingsSection("Code Mode");
    expect(savingsSection("Code Mode").getByText("Retrieval cells"))
      .toBeInTheDocument();
    first.unmount();

    render(<ToolOutputIncidentExplorerWindow />);
    await screen.findByRole("region", { name: "Code Mode" });
    expect(savingsSection("Code Mode").getByRole("button"))
      .toHaveAttribute("aria-expanded", "true");
    expect(savingsSection("Decisions").getByRole("button"))
      .toHaveAttribute("aria-expanded", "false");
  });

  it("clamps the grip so the results list keeps its floor", async () => {
    installApi({ readThread: async () => buildSavingsResponse() });
    window.location.hash = "#tool-output-incidents/codex/thread-1/Noisy%20work";
    render(<ToolOutputIncidentExplorerWindow />);

    const grip = await screen.findByRole("separator", {
      name: "Resize the Token Miser detail rows",
    });
    fireEvent.keyDown(grip, { key: "ArrowDown" });

    /* jsdom lays nothing out, so every measured height is zero and the drag
       asks for more than the window has. The stored value is the clamp's
       floor rather than the requested one, which is the property that keeps
       the list alive on a genuinely short window too. */
    await waitFor(() => {
      expect(readStoredSavingsLayout().detailsHeight)
        .toBe(SAVINGS_DETAILS_MIN_HEIGHT);
    });
  });

  /* jsdom implements no pointer capture at all, so the grip's own calls have
     to be stubbed for a drag to reach the handlers. Everything the assertions
     read — the captured start height, the delta, and when the drag ends — is
     still the component's. */
  function stubPointerCapture(node: HTMLElement): void {
    let captured = false;
    Object.assign(node, {
      hasPointerCapture: () => captured,
      releasePointerCapture: () => {
        captured = false;
      },
      setPointerCapture: () => {
        captured = true;
      },
    });
  }

  it("resizes the detail stack while the pointer is down", async () => {
    installApi({ readThread: async () => buildSavingsResponse() });
    window.location.hash = "#tool-output-incidents/codex/thread-1/Noisy%20work";
    render(<ToolOutputIncidentExplorerWindow />);

    const grip = await screen.findByRole("separator", {
      name: "Resize the Token Miser detail rows",
    });
    stubPointerCapture(grip);
    const stack = document.querySelector(".incident-explorer__savings-details");
    expect(stack).not.toHaveAttribute("style");

    fireEvent.pointerDown(grip, { button: 0, clientY: 400, pointerId: 1 });
    fireEvent.pointerMove(grip, { clientY: 520, pointerId: 1 });

    // jsdom reports no geometry, so the clamp hands back its floor whatever
    // the drag asked for. What this pins is that the drag ran and committed a
    // height, which is the half the keyboard test cannot reach.
    await waitFor(() => {
      expect(stack).toHaveStyle({ height: `${SAVINGS_DETAILS_MIN_HEIGHT}px` });
    });
  });

  /* A gesture the OS takes over ends in lostpointercapture, never pointerup.
     Clearing the drag only on pointerup left it armed, and every later hover
     across the handle then resized the split with no button held. */
  it("stops resizing when a drag is cancelled instead of released", async () => {
    installApi({ readThread: async () => buildSavingsResponse() });
    window.location.hash = "#tool-output-incidents/codex/thread-1/Noisy%20work";
    render(<ToolOutputIncidentExplorerWindow />);

    const grip = await screen.findByRole("separator", {
      name: "Resize the Token Miser detail rows",
    });
    stubPointerCapture(grip);
    fireEvent.pointerDown(grip, { button: 0, clientY: 400, pointerId: 1 });
    fireEvent.lostPointerCapture(grip, { pointerId: 1 });
    fireEvent.pointerMove(grip, { clientY: 900, pointerId: 1 });

    const stack = document.querySelector(".incident-explorer__savings-details");
    expect(stack).not.toHaveAttribute("style");
    expect(readStoredSavingsLayout().detailsHeight).toBeUndefined();
  });

  it("shows the priced savings equation and how much of it was observed", async () => {
    const response = buildResponse();
    response.pricing = {
      lines: [],
      summaries: [{
        backend: "codex",
        threadId: "thread-1",
        provider: "openai",
        currency: "USD",
        totalCostMicros: 360_000,
        totalTokens: 500_000,
        usageLineCount: 4,
        pricedUsageLineCount: 4,
        unpricedUsageLineCount: 0,
        updatedAt: 1_800_000_000_000,
      }] as never,
    } as never;
    response.toolAccounting!.tokenMiser = {
      interceptionCount: 4,
      originalCharacters: 160_000,
      baselineParentTokens: 40_000,
      replacementTokens: 1_400,
      retrievedTokens: 0,
      estimatedParentTokensSaved: 38_600,
      cachedReplayCount: 47,
      cachedBaselineTokens: 1_850_000,
      cachedRevealedTokens: 50_000,
      estimatedCachedReplayTokensSaved: 1_800_000,
      savings: {
        currency: "USD",
        pricedGateCount: 4,
        gateCount: 4,
        withoutGateCostMicros: 680_000,
        gateCostMicros: 50_000,
        revealedCostMicros: 280_000,
        savingsMicros: 350_000,
        directlyObservedReplayCount: 47,
        reconstructedReplayCount: 0,
        gateModel: "gpt-5.6-luna",
        parentModel: "gpt-5.6-terra",
      },
      interceptions: [],
    };
    installApi({ readThread: async () => response });
    window.location.hash = "#tool-output-incidents/codex/thread-1/Noisy%20work";
    render(<ToolOutputIncidentExplorerWindow />);

    await screen.findByRole("tab", { name: /Savings/, selected: true });
    expect(screen.getByText("Estimated same-trajectory savings"))
      .toBeInTheDocument();
    expect(screen.getByText("49.3% less than estimated unfiltered cost"))
      .toBeInTheDocument();
    // The terms are laid out as the subtraction they are, so the headline and
    // the result of the equation are the same figure printed twice.
    expect(screen.getAllByText("$0.35")).toHaveLength(2);
    expect(screen.getByText("Without the gate")).toBeInTheDocument();
    expect(screen.getByText("$0.68")).toBeInTheDocument();
    expect(screen.getByText("Gate compute")).toBeInTheDocument();
    expect(screen.getByText("$0.05")).toBeInTheDocument();
    expect(screen.getByText("Revealed to parent")).toBeInTheDocument();
    expect(screen.getByText("$0.28")).toBeInTheDocument();
    expect(screen.getByText("Saved")).toBeInTheDocument();
    // 350k saved, 50k gate and 280k revealed out of the 680k unfiltered.
    // The split caption is matched on its own text nodes, because every figure
    // in it sits inside a <b> that getByText does not descend into.
    const splitCaption = screen
      .getByText("avoided · gate · revealed")
      .closest("p");
    // 51.5, 7.4 and 41.2 percent. The last term absorbs the rounding, so the
    // three printed shares close on 100 instead of the 99 that rounding each
    // of them on its own produces.
    expect(splitCaption).toHaveTextContent("51% avoided · 7% gate · 42% revealed");
    expect(splitCaption).toHaveTextContent("observed $0.36 · unfiltered $0.71");
    expect(
      screen.getByText(/Directly observed · 47 payload replays across 4 gates, each counted at a request boundary/),
    ).toBeInTheDocument();

    // The basis stays readable to a screen reader even though the compact
    // equation only paints it into a `title`. `toHaveTextContent` descends,
    // which is the point: it sees what the accessibility tree sees.
    expect(screen.getByText("Without the gate").closest("div"))
      .toHaveTextContent("40k uncached + 1,850k cached at gpt-5.6-terra rates");
    expect(screen.getByText("Gate compute").closest("div"))
      .toHaveTextContent("0 charged by gpt-5.6-luna");

    // The token basis of each term also lands on the decisions row rather than
    // paying for two lines of visible sub-caption under every term.
    openSavingsSection("Decisions");
    const decisions = savingsSection("Decisions");
    expect(decisions.getByText(/40k uncached · 1,850k cached/))
      .toBeInTheDocument();
    expect(decisions.getByText(/1.4k uncached · 50k cached/)).toBeInTheDocument();
    expect(decisions.getByText("Parent rates").nextSibling)
      .toHaveTextContent("gpt-5.6-terra");
    expect(decisions.getByText("Gate model").nextSibling)
      .toHaveTextContent("gpt-5.6-luna");
  });

  it("shows same-trajectory overhead as a percentage of unfiltered cost", async () => {
    const response = buildResponse();
    response.pricing = {
      lines: [],
      summaries: [{
        backend: "codex",
        currency: "USD",
        serviceTier: "standard",
        threadId: "thread-1",
        totalCostMicros: 800_000,
        totalTokens: 500_000,
        usageLineCount: 4,
        pricedUsageLineCount: 4,
        unpricedUsageLineCount: 0,
        updatedAt: 1_800_000_000_000,
      }] as never,
    } as never;
    response.toolAccounting!.tokenMiser = {
      interceptionCount: 1,
      originalCharacters: 40_000,
      baselineParentTokens: 10_000,
      replacementTokens: 1_000,
      retrievedTokens: 0,
      estimatedParentTokensSaved: 9_000,
      savings: {
        currency: "USD",
        pricedGateCount: 1,
        gateCount: 1,
        withoutGateCostMicros: 300_000,
        gateCostMicros: 100_000,
        revealedCostMicros: 400_000,
        savingsMicros: -200_000,
        directlyObservedReplayCount: 0,
        reconstructedReplayCount: 0,
        gateModel: "gpt-5.6-luna",
        parentModel: "gpt-5.6-terra",
      },
      interceptions: [],
    };
    installApi({ readThread: async () => response });
    window.location.hash = "#tool-output-incidents/codex/thread-1/Noisy%20work";
    render(<ToolOutputIncidentExplorerWindow />);

    await screen.findByText("Estimated same-trajectory overhead");
    expect(screen.getByText("33.3% more than estimated unfiltered cost"))
      .toBeInTheDocument();
    /* With negative savings the parts sum past the whole, and a bar
       overflowing its own track reads as a rendering fault. The overspend
       states itself in words above instead. */
    expect(screen.queryByText("avoided · gate · revealed")).not.toBeInTheDocument();
    expect(document.querySelector(".incident-explorer__savings-split")).toBeNull();
  });

  // Reconstructed replays are inferred from later tool calls and cannot see
  // cross-turn replays or compaction, so the figure must not read as measured.
  it("marks savings as reconstructed when replays were inferred", async () => {
    const response = buildResponse();
    response.toolAccounting!.tokenMiser = {
      interceptionCount: 2,
      originalCharacters: 80_000,
      baselineParentTokens: 20_000,
      replacementTokens: 700,
      retrievedTokens: 0,
      estimatedParentTokensSaved: 19_300,
      savings: {
        currency: "USD",
        pricedGateCount: 1,
        gateCount: 2,
        withoutGateCostMicros: 100_000,
        gateCostMicros: 10_000,
        revealedCostMicros: 20_000,
        savingsMicros: 70_000,
        directlyObservedReplayCount: 3,
        reconstructedReplayCount: 5,
      },
      interceptions: [],
    };
    installApi({ readThread: async () => response });
    window.location.hash = "#tool-output-incidents/codex/thread-1/Noisy%20work";
    render(<ToolOutputIncidentExplorerWindow />);

    await screen.findByRole("tab", { name: /Savings/, selected: true });
    expect(
      screen.getByText(/Partly reconstructed · 5 of 8 payload replays inferred from later tool calls · 1 gate is not priced yet/),
    ).toBeInTheDocument();
    // Token counts cover every gate while the dollars cover only the priced
    // ones, so the two token figures say so.
    openSavingsSection("Decisions");
    expect(savingsSection("Decisions").getAllByText(/All gates ·/))
      .toHaveLength(2);
  });

  it("shows Token Miser savings beside gross tool-output exposure", async () => {
    const response = buildResponse();
    response.toolAccounting!.tokenMiser = {
      interceptionCount: 2,
      originalCharacters: 80_000,
      baselineParentTokens: 20_000,
      replacementTokens: 700,
      retrievedTokens: 1_300,
      estimatedParentTokensSaved: 18_000,
      cachedReplayCount: 6,
      cachedBaselineTokens: 36_000,
      cachedRevealedTokens: 1_350,
      estimatedCachedReplayTokensSaved: 34_650,
      interceptions: [{
        objectId: "00000000-0000-0000-0000-000000000001",
        turnId: "turn-1",
        toolUseId: "item-1",
        toolName: "commandExecution",
        createdAt: 1_800_000_000_000,
        originalCharacters: 24_000,
        baselineParentTokens: 6_000,
        replacementTokens: 225,
        retrievedTokens: 0,
        estimatedParentTokensSaved: 5_775,
        cachedReplayCount: 6,
        cachedBaselineTokens: 36_000,
        cachedRevealedTokens: 1_350,
        estimatedCachedReplayTokensSaved: 34_650,
      }],
    };
    installApi({ readThread: async () => response });
    window.location.hash = "#tool-output-incidents/codex/thread-1/Noisy%20work";
    render(<ToolOutputIncidentExplorerWindow />);

    // Gating happened, so the savings lens opens first rather than the
    // raw-output view: the question the operator has here is what it bought.
    const savings = await screen.findByRole("tab", {
      name: /Savings/,
      selected: true,
    });
    expect(savings).toHaveTextContent("52.6k avoided");
    // Without a priced gate the lens states what it has — tokens — and says
    // why the dollars are missing, rather than showing a partial equation.
    expect(
      screen.getByText("Dollar terms appear once the gate's usage line is priced."),
    ).toBeInTheDocument();

    expect(screen.getByText("Without the gate")).toBeInTheDocument();
    expect(screen.getByText("20k")).toBeInTheDocument();
    expect(screen.getByText("Actual parent context")).toBeInTheDocument();
    expect(screen.getByText("2k")).toBeInTheDocument();
    expect(
      screen.getByText(/34.6k more across 6 replays/),
    ).toBeInTheDocument();
    expect(screen.getByText("awaiting the pricing ledger")).toBeInTheDocument();
    expect(savingsSection("Decisions").getByRole("button")).toHaveTextContent(
      /2 decisions.*2 summarized.*1.3k read back/,
    );
    openSavingsSection("Decisions");
    expect(savingsSection("Decisions").getByText("700 of summaries"))
      .toBeInTheDocument();

    // The per-call gate box belongs to the incidents lens, beside the raw
    // output it replaced.
    fireEvent.click(screen.getByRole("tab", { name: /Incidents/ }));
    expect(
      screen.getByText(/kept 52.6k out of the parent's context/),
    ).toBeInTheDocument();
    expect(screen.getByText("Gated by Token Miser")).toBeInTheDocument();
    expect(screen.getByText("6k baseline → 225 summary")).toBeInTheDocument();
    expect(screen.getByText(/5.8k estimated parent-context footprint avoided/))
      .toBeInTheDocument();
  });

  it("labels a summarized nested invocation with actual and counterfactual replay", async () => {
    const response = buildResponse();
    const invocation = response.toolAccounting!.invocations[0]!;
    invocation.itemId = "exec-nested";
    invocation.invocationId = "codex:thread-1:exec-nested";
    invocation.outputChars = 35_122;
    invocation.estimatedOutputTokens = 8_781;
    invocation.normalizedCommand = "rg -n -C 8 'cancel' apps/desktop/src";
    response.toolAccounting!.tokenMiser = {
      interceptionCount: 1,
      originalCharacters: 35_122,
      baselineParentTokens: 8_781,
      replacementTokens: 312,
      retrievedTokens: 0,
      estimatedParentTokensSaved: 8_469,
      cachedReplayCount: 31,
      cachedBaselineTokens: 272_211,
      cachedRevealedTokens: 9_672,
      estimatedCachedReplayTokensSaved: 262_539,
      interceptions: [{
        objectId: "gate-outer",
        turnId: "turn-1",
        toolUseId: "call-outer-code-mode",
        toolName: "Code Mode",
        createdAt: invocation.observedAt + 1,
        originalCharacters: 35_122,
        baselineParentTokens: 8_781,
        replacementCharacters: 1_246,
        replacementTokens: 312,
        retrievedCharacters: 0,
        retrievedTokens: 0,
        estimatedParentTokensSaved: 8_469,
        cachedReplayCount: 31,
        cachedBaselineTokens: 272_211,
        cachedRevealedTokens: 9_672,
        estimatedCachedReplayTokensSaved: 262_539,
        disposition: "summarized",
      }],
    };
    installApi({ readThread: async () => response });
    window.location.hash = "#tool-output-incidents/codex/thread-1/Noisy%20work";
    render(<ToolOutputIncidentExplorerWindow />);

    fireEvent.click(await screen.findByRole("tab", { name: /Incidents/ }));
    expect(screen.getByText("Gated by Token Miser")).toBeInTheDocument();
    expect(screen.getByText(
      "Emitted 35,122 raw characters; Token Miser revealed 1,246 characters.",
    )).toBeInTheDocument();
    expect(screen.getByText(
      "Raw output would otherwise have replayed across 31 later parent requests.",
    )).toBeInTheDocument();
    expect(screen.queryByText(/replayed on the \d+ later round trips in this turn/))
      .not.toBeInTheDocument();
  });

  it("does not present nested tool position as parent replay billing", async () => {
    const response = buildResponse();
    response.toolAccounting!.invocations[0]!.outputChars = 60_465;
    response.toolAccounting!.invocations[0]!.estimatedOutputTokens = 15_117;
    installApi({ readThread: async () => response });
    window.location.hash = "#tool-output-incidents/codex/thread-1/Noisy%20work";
    render(<ToolOutputIncidentExplorerWindow />);

    expect(await screen.findByText(
      /Raw emitted: 60,465 characters\. Estimated parent-visible payload after the standard cap: up to 40,000 characters/,
    )).toBeInTheDocument();
    expect(screen.getByText(
      /later recorded tool invocations\. This is not parent-request replay or billing evidence/,
    )).toBeInTheDocument();
    expect(screen.queryByText(/replayed on the/)).not.toBeInTheDocument();
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

  it("moves an open window to the lens the request asks for", async () => {
    /* The Pricing rail's "Token Miser Savings" action focuses whatever window
       is already open. Without the lens in the request it stays on whichever
       tab the operator left it on, which for this thread is Incidents. */
    let refreshListener:
      | ((request?: { backend: string; lens?: string; threadId: string; title: string }) => void)
      | undefined;
    const response = buildResponse();
    response.toolAccounting!.tokenMiser = {
      interceptionCount: 1,
      originalCharacters: 40_000,
      baselineParentTokens: 10_000,
      replacementTokens: 300,
      retrievedTokens: 0,
      estimatedParentTokensSaved: 9_700,
      interceptions: [],
    };
    installApi({
      onToolOutputIncidentExplorerRefresh: (
        callback: (request?: unknown) => void,
      ) => {
        refreshListener = callback as typeof refreshListener;
        return () => {
          refreshListener = undefined;
        };
      },
      readThread: async () => response,
    });
    window.location.hash =
      "#tool-output-incidents/codex/thread-1/Noisy%20work/PwrAgent";
    render(<ToolOutputIncidentExplorerWindow />);

    await screen.findByRole("tab", { name: /Savings/, selected: true });
    fireEvent.click(screen.getByRole("tab", { name: /Incidents/ }));
    expect(
      screen.getByRole("tab", { name: /Incidents/, selected: true }),
    ).toBeInTheDocument();

    const request = {
      backend: "codex",
      projectLabel: "PwrAgent",
      threadId: "thread-1",
      title: "Noisy work",
    };
    await act(async () => refreshListener?.(request));
    expect(
      screen.getByRole("tab", { name: /Incidents/, selected: true }),
    ).toBeInTheDocument();

    await act(async () => refreshListener?.({ ...request, lens: "savings" }));
    expect(
      screen.getByRole("tab", { name: /Savings/, selected: true }),
    ).toBeInTheDocument();
  });

  it("opens on the lens its route names, not on the one accounting suggests", async () => {
    /* The refresh event only reaches a window that already exists, so a
       window this click creates has to read the lens off its own route. The
       thread below gates, which is exactly the case the opening latch sends
       to Savings — the route has to win, or a request naming a lens means
       nothing until the second click. */
    const response = buildResponse();
    response.toolAccounting!.tokenMiser = {
      interceptionCount: 1,
      originalCharacters: 40_000,
      baselineParentTokens: 10_000,
      replacementTokens: 300,
      retrievedTokens: 0,
      estimatedParentTokensSaved: 9_700,
      interceptions: [],
    };
    installApi({ readThread: async () => response });
    window.location.hash =
      "#tool-output-incidents/codex/thread-1/Noisy%20work/PwrAgent/incidents";
    render(<ToolOutputIncidentExplorerWindow />);

    expect(
      await screen.findByRole("tab", { name: /Incidents/, selected: true }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("tab", { name: /Savings/, selected: false }),
    ).toBeInTheDocument();
  });

  it("updates Token Miser accounting from live tool-accounting events", async () => {
    let agentEventListener: ((event: never) => void) | undefined;
    const initial = buildResponse();
    installApi({
      onAgentEvent: (callback: (event: never) => void) => {
        agentEventListener = callback;
        return () => {
          agentEventListener = undefined;
        };
      },
      readThread: async () => initial,
    });
    window.location.hash = "#tool-output-incidents/codex/thread-1/Noisy%20work";
    render(<ToolOutputIncidentExplorerWindow />);
    expect(await screen.findByText("Raw output from flagged calls"))
      .toBeInTheDocument();

    const updated = buildResponse();
    updated.toolAccounting!.tokenMiser = {
      interceptionCount: 1,
      originalCharacters: 24_000,
      baselineParentTokens: 6_000,
      replacementTokens: 225,
      retrievedTokens: 0,
      estimatedParentTokensSaved: 5_775,
      interceptions: [{
        objectId: "00000000-0000-0000-0000-000000000001",
        turnId: "turn-1",
        toolUseId: "item-1",
        toolName: "commandExecution",
        createdAt: 1_800_000_000_000,
        originalCharacters: 24_000,
        baselineParentTokens: 6_000,
        replacementTokens: 225,
        retrievedTokens: 0,
        estimatedParentTokensSaved: 5_775,
      }],
    };
    await act(async () => agentEventListener?.({
      backend: "codex",
      notification: {
        method: "thread/toolAccounting/updated",
        params: {
          threadId: "thread-1",
          toolAccounting: updated.toolAccounting!,
        },
      },
    } as never));

    // The lens stays where the operator left it when a gate lands mid-turn, so
    // the per-call box is still the one place this call's outcome is stated.
    expect(await screen.findByText("Gated by Token Miser")).toBeInTheDocument();
    expect(screen.getAllByText(/5.8k estimated parent-context footprint avoided/))
      .toHaveLength(1);
    expect(screen.getByRole("tab", { name: /Savings/ }))
      .toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("button", { name: /See the breakdown/ }))
      .toBeInTheDocument();
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

  it("marks compaction boundaries on the per-turn rows and timeline", async () => {
    const response = buildMultiTurnResponse();
    response.pricing = {
      compactions: [{
        backend: "codex",
        compactionId: "compaction-turn-2",
        observedAt: 1_800_000_003_500,
        threadId: "thread-1",
        turnId: "turn-2",
        updatedAt: 1_800_000_003_500,
      }],
      lines: [],
      summaries: [],
    };
    installApi({ readThread: async () => response });
    window.location.hash = "#tool-output-incidents/codex/thread-1/Noisy%20work";
    render(<ToolOutputIncidentExplorerWindow />);

    const turns = await screen.findByLabelText("Cost by turn");
    expect(within(turns).getByRole("button", { name: /Turn 2.*compacted/ }))
      .toBeInTheDocument();
    const timeline = screen.getByRole("group", {
      name: "Tool cost per turn, in order",
    });
    expect(within(timeline).getByRole("button", {
      name: /Turn 2.*context compacted 1 time/,
    })).toHaveAttribute("data-compaction", "true");
    expect(screen.getByText("compaction boundary")).toBeInTheDocument();
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

function buildContextUsageLine() {
  return {
    backend: "codex",
    cachedInputCostMicros: 0,
    cachedInputTokens: 100_000,
    createdAt: 1_800_000_000_000,
    currency: "USD",
    finalContextTokens: 131_443,
    inputTokens: 131_000,
    modelContextWindow: 258_400,
    outputCostMicros: 0,
    outputTokens: 443,
    peakContextTokens: 243_864,
    priceStatus: "priced" as const,
    provider: "openai",
    reasoningOutputTokens: 0,
    scope: "turn" as const,
    source: "live" as const,
    status: "finalized" as const,
    threadId: "thread-1",
    totalCostMicros: 0,
    totalTokens: 131_443,
    uncachedInputCostMicros: 0,
    uncachedInputTokens: 31_000,
    usageLineId: "usage-context-1",
  };
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
      "#tool-output-incidents/codex/thread-1/Noisy%20work/PwrAgent//peer-instance";
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
