// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DecisionProvidersReadiness } from "@pwragent/shared/decision-models";
import {
  projectResearchRun,
  researchChangePage,
  researchEventPage,
  researchRunAttention,
  searchResearchItems,
  summarizeResearchRun,
  type ResearchDecisionsSnapshot,
  type ResearchEvent,
  type ResearchRun,
} from "@pwragent/shared/research";
import type { NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import type { DesktopApi } from "../../../lib/desktop-api";
import { ResearchPanel } from "../ResearchPanel";
import { ResearchWindow } from "../ResearchWindow";

afterEach(() => cleanup());

const thread = { id: "coord-1", source: "codex", title: "Paper 38" } as NavigationThreadSummary;
const coordActor = { backend: "codex", threadId: "coord-1", kind: "agent" } as const;
const workerActor = { backend: "codex", threadId: "worker-1", kind: "agent" } as const;

const readyOpenAI: DecisionProvidersReadiness = {
  providers: [
    { provider: "openai", enabled: true, ready: true },
    { provider: "jev", enabled: true, ready: false, missing: "key" },
    { provider: "local", enabled: true, ready: false, missing: "choice" },
  ],
  defaultProvider: "openai",
};

const unreadyAll: DecisionProvidersReadiness = {
  providers: [
    { provider: "openai", enabled: true, ready: false, missing: "key" },
    { provider: "jev", enabled: true, ready: false, missing: "key" },
    { provider: "local", enabled: true, ready: false, missing: "choice" },
  ],
  defaultProvider: "openai",
};

function makeRunWithDecisionCitation(): ResearchRun {
  const events: ResearchEvent[] = [
    {
      seq: 1,
      commandId: "start",
      signature: "s",
      at: 1_000,
      actor: coordActor,
      data: {
        type: "created",
        objective: "Check all 120 claims in Paper 38",
        coordinator: { backend: "codex", threadId: "coord-1" },
        ownerId: "owner-1",
        ownerPid: 1,
        workspaceMode: "none",
        approaches: [
          {
            id: "a1",
            title: "Claim Rubric",
            task: "Score claims",
            state: "running",
            worker: { backend: "codex", threadId: "worker-1", turnId: "t1" },
          },
        ],
      },
    },
    {
      seq: 2,
      commandId: "f1",
      signature: "f1",
      at: 2_000,
      actor: workerActor,
      data: {
        type: "finding",
        finding: {
          id: "finding-1",
          author: { backend: "codex", threadId: "worker-1" },
          approachId: "a1",
          kind: "experiment",
          text: "Scored 120 claims in batch_worker-001; 4 claims failed threshold.",
          paths: ["scores.jsonl"],
        },
      },
    },
  ];
  return projectResearchRun("run-38", events);
}

function makeDecisionsSnapshot(readiness: DecisionProvidersReadiness): ResearchDecisionsSnapshot {
  return {
    runId: "run-38",
    readiness,
    now: 5_000,
    decisions: [
      {
        decisionId: "dec-rubric-1",
        name: "claim_validity",
        version: 1,
        scope: "research_run",
        researchRunId: "run-38",
        provider: "openai",
        providerDisabled: false,
        questions: [{ type: "predicate", name: "valid" }],
        inputSchema: { type: "string" },
      },
    ],
    batches: [
      {
        batchId: "batch_worker-001",
        decisionId: "dec-rubric-1",
        name: "claim_validity",
        version: 1,
        adHoc: false,
        questionNames: ["valid"],
        provider: "openai",
        model: "gpt-6-luna",
        state: "running",
        stopping: false,
        background: true,
        count: 120,
        finished: 80,
        succeeded: 79,
        failed: 1,
        skipped: 0,
        concurrency: 8,
        createdAt: 2_000,
        startedAt: 2_100,
        wallMs: 2_900,
        hasResultsFile: true,
        caller: { backend: "codex", threadId: "worker-1" },
        role: "worker",
        approachId: "a1",
        approachTitle: "Claim Rubric",
      },
    ],
  };
}

describe("Research Decisions UI", () => {
  it("shows Decisions readiness in ResearchStartForm and gates coordinator prompt guidance on readiness", async () => {
    const onOpenDecisionSettings = vi.fn();
    const prepareResearch = vi.fn(async () => ({ intentId: "intent-1" }));
    const submitThreadReply = vi.fn(async () => ({ backend: "codex", threadId: "coord-1", queueStatus: "started" }));
    const baseApi = {
      researchSnapshot: vi.fn(async () => ({ runs: [], writableRunIds: [] })),
      researchChanges: vi.fn(),
      onResearchChanged: vi.fn(() => () => {}),
      prepareResearch,
      submitThreadReply,
      readResearchDecisionsStatus: vi.fn(async () => unreadyAll),
    } as unknown as DesktopApi;

    render(
      <ResearchPanel
        desktopApi={baseApi}
        thread={thread}
        onOpenDecisionSettings={onOpenDecisionSettings}
      />,
    );

    expect(await screen.findByText("Decisions not configured")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Set up Decisions" }));
    expect(onOpenDecisionSettings).toHaveBeenCalledWith("openai-decisions");

    fireEvent.change(screen.getByLabelText("Objective"), { target: { value: "Audit proofs" } });
    fireEvent.click(screen.getByRole("button", { name: "Request research" }));
    await waitFor(() => expect(submitThreadReply).toHaveBeenCalledTimes(1));
    const unreadyPrompt = (submitThreadReply.mock.calls[0] as unknown as [{ input: Array<{ text: string }> }])[0].input[0]!.text;
    expect(unreadyPrompt).not.toContain("decisions_register");
    cleanup();

    // Now with OpenAI Decisions ready.
    submitThreadReply.mockClear();
    const readyApi = {
      ...baseApi,
      readResearchDecisionsStatus: vi.fn(async () => readyOpenAI),
    } as unknown as DesktopApi;
    render(
      <ResearchPanel
        desktopApi={readyApi}
        thread={thread}
        onOpenDecisionSettings={onOpenDecisionSettings}
      />,
    );
    expect(await screen.findByText("Decisions ready")).toBeInTheDocument();
    expect(screen.getByText(/OpenAI Decisions \(gpt-6-luna\)/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Objective"), { target: { value: "Audit proofs" } });
    fireEvent.click(screen.getByRole("button", { name: "Request research" }));
    await waitFor(() => expect(submitThreadReply).toHaveBeenCalledTimes(1));
    const readyPrompt = (submitThreadReply.mock.calls[0] as unknown as [{ input: Array<{ text: string }> }])[0].input[0]!.text;
    expect(readyPrompt).toContain("OpenAI Decisions (gpt-6-luna)");
    expect(readyPrompt).toContain("decisions_register");
  });

  it("renders run-scoped decisions, cross-worker batches, stop action, and finding batch evidence links in ResearchPanel and ResearchWindow", async () => {
    const run = makeRunWithDecisionCitation();
    const decisionsSnapshot = makeDecisionsSnapshot(readyOpenAI);
    const actOnResearchDecisionBatch = vi.fn(async () => ({ outcome: "stopped" as const }));
    const readResearchDecisionBatch = vi.fn(async () => ({
      batch: decisionsSnapshot.batches[0]!,
      items: [{ index: 0, ok: true, answers: [{ type: "predicate" as const, name: "valid", value: "yes", probability: 0.94 }], inputPreview: "\"Claim 1\"" }],
    }));

    const api = {
      researchProfileRuns: vi.fn(async () => ({
        runs: [{ ...summarizeResearchRun(run), attention: researchRunAttention(summarizeResearchRun(run)), thread: { title: "Paper 38" } }],
        writableRunIds: [run.id],
        counts: { needs_you: 0, live: 1, retained: 0 },
      })),
      researchSnapshot: vi.fn(async () => ({ runs: [summarizeResearchRun(run)], writableRunIds: [run.id] })),
      researchChanges: vi.fn(async () => ({ ...researchChangePage(run, 0), writable: true })),
      readResearchEvents: vi.fn(async (req) => researchEventPage(run, req.range)),
      searchResearch: vi.fn(async (req) => searchResearchItems(run.id, run.items, run.revision, req.query)),
      readResearchItem: vi.fn(async (req) => ({ run, item: run.items.find((item) => item.id === req.itemId)! })),
      onResearchChanged: vi.fn(() => () => {}),
      readResearchDecisionsStatus: vi.fn(async () => readyOpenAI),
      readResearchDecisions: vi.fn(async () => decisionsSnapshot),
      readResearchDecisionBatch,
      actOnResearchDecisionBatch,
      openResearchDecisionResults: vi.fn(async () => ({ opened: true })),
      openThreadInMainWindow: vi.fn(async () => {}),
    } as unknown as DesktopApi;

    // 1. ResearchPanel: card summary, finding evidence link, Decisions tab & Stop action.
    render(<ResearchPanel desktopApi={api} thread={thread} />);
    expect(await screen.findByText(/Decisions: 1 run decision · 1 decision batch \(1 running\)/)).toBeInTheDocument();

    // Open Findings tab -> finding links directly to batch_worker_001.
    fireEvent.click(screen.getByRole("tab", { name: "Findings" }));
    const batchEvidenceLink = await screen.findByRole("button", { name: /Decision batch: claim_validity v1/ });
    fireEvent.click(batchEvidenceLink);

    // Clicking the evidence link opens the Decisions tab AND the batch modal.
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(readResearchDecisionBatch).toHaveBeenCalledWith(expect.objectContaining({
      runId: "run-38",
      batchId: "batch_worker-001",
    }));
    fireEvent.keyDown(document, { key: "Escape" });

    const decisionsRegion = await screen.findByLabelText("Research decisions");
    expect(within(decisionsRegion).getByText("claim_validity")).toBeInTheDocument();
    expect(within(decisionsRegion).getByText("Worker: Claim Rubric")).toBeInTheDocument();
    expect(within(decisionsRegion).getByText(/Cited in 1 item/)).toBeInTheDocument();

    fireEvent.click(within(decisionsRegion).getByRole("button", { name: "Stop batch" }));
    await waitFor(() => expect(actOnResearchDecisionBatch).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "coord-1",
      runId: "run-38",
      batchId: "batch_worker-001",
      action: "stop",
    }));
    cleanup();

    // 2. ResearchWindow: also surfaces the Decisions tab with run-scoped decisions and worker batches.
    render(<ResearchWindow desktopApi={api} />);
    await screen.findByRole("region", { name: "Research run summary" });
    const main = screen.getByRole("main", { name: "Research run" });
    fireEvent.click(within(main).getByRole("tab", { name: /Decisions/ }));
    expect(await within(main).findByText("Worker: Claim Rubric")).toBeInTheDocument();
    expect(within(main).getByText("claim_validity")).toBeInTheDocument();
  });

  it("ignores remote federation decision batch events in useResearchDecisions while refreshing on local events", async () => {
    const run = makeRunWithDecisionCitation();
    const decisionsSnapshot = makeDecisionsSnapshot(readyOpenAI);
    let agentEventListener: ((event: Record<string, unknown>) => void) | undefined;
    const readResearchDecisions = vi.fn(async () => decisionsSnapshot);
    const api = {
      researchSnapshot: vi.fn(async () => ({ runs: [summarizeResearchRun(run)], writableRunIds: [run.id] })),
      researchChanges: vi.fn(async () => ({ ...researchChangePage(run, 0), writable: true })),
      readResearchEvents: vi.fn(async (req) => researchEventPage(run, req.range)),
      searchResearch: vi.fn(async (req) => searchResearchItems(run.id, run.items, run.revision, req.query)),
      readResearchItem: vi.fn(async (req) => ({ run, item: run.items.find((item) => item.id === req.itemId)! })),
      onResearchChanged: vi.fn(() => () => {}),
      onAgentEvent: vi.fn((listener: (event: Record<string, unknown>) => void) => {
        agentEventListener = listener;
        return () => { agentEventListener = undefined; };
      }),
      readResearchDecisionsStatus: vi.fn(async () => readyOpenAI),
      readResearchDecisions,
      openThreadInMainWindow: vi.fn(async () => {}),
    } as unknown as DesktopApi;

    render(<ResearchPanel desktopApi={api} thread={thread} />);
    await screen.findByText(/Decisions: 1 run decision/);
    const initialCalls = readResearchDecisions.mock.calls.length;

    // Remote federation event with colliding backend:threadId MUST NOT trigger local refresh.
    await act(async () => {
      agentEventListener?.({
        backend: "codex",
        federationTarget: { scope: "remote", instanceId: "peer-remote-1" },
        notification: { method: "thread/decisionBatches/updated", params: { threadId: "worker-1" } },
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    expect(readResearchDecisions).toHaveBeenCalledTimes(initialCalls);

    // Local event for the worker thread MUST trigger a refresh.
    await act(async () => {
      agentEventListener?.({
        backend: "codex",
        notification: { method: "thread/decisionBatches/updated", params: { threadId: "worker-1" } },
      });
    });
    await waitFor(() => expect(readResearchDecisions.mock.calls.length).toBeGreaterThan(initialCalls));
  });
});
