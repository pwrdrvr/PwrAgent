import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, DecisionsRailBatch, NavigationThreadSummary } from "@pwragent/shared";
import { ActiveDecisionBatchesStrip } from "../ActiveDecisionBatchesStrip";

afterEach(cleanup);

const NOW = 1_800_000_000_000;

const thread = {
  id: "thread-1",
  title: "Triage the backlog",
  titleSource: "explicit",
  source: "codex",
  linkedDirectories: [],
  inbox: { inInbox: true },
} as NavigationThreadSummary;

const running: DecisionsRailBatch = {
  batchId: "batch_run-1",
  decisionId: "dec_1",
  name: "triage_relevance",
  version: 2,
  provider: "openai",
  state: "running",
  stopping: false,
  background: true,
  count: 1000,
  finished: 640,
  succeeded: 631,
  failed: 9,
  skipped: 0,
  concurrency: 8,
  createdAt: NOW - 161_000,
  startedAt: NOW - 161_000,
  hasResultsFile: true,
};

const errorStopped: DecisionsRailBatch = {
  ...running,
  batchId: "batch_err-1",
  name: "diff_risk",
  version: 1,
  state: "stopped",
  finished: 120,
  succeeded: 12,
  failed: 1,
  skipped: 107,
  count: 120,
  stoppedBy: { code: "credential_rejected", message: "The key was rejected." },
};

function decisionEvent(threadId: string, backend = "codex"): AgentEvent {
  return {
    backend,
    notification: { method: "thread/decisionBatches/updated", params: { threadId, batchId: "batch_run-1", status: "running" } },
  } as AgentEvent;
}

function renderStrip(options: { batches?: DecisionsRailBatch[][]; thread?: NavigationThreadSummary } = {}) {
  const reads = options.batches ?? [[running, errorStopped]];
  let call = 0;
  const readActiveDecisionBatches = vi.fn(async () => ({ now: NOW, batches: reads[Math.min(call++, reads.length - 1)]! }));
  const listeners: Array<(event: AgentEvent) => void> = [];
  const onAgentEvent = vi.fn((listener: (event: AgentEvent) => void) => {
    listeners.push(listener);
    return () => { listeners.splice(listeners.indexOf(listener), 1); };
  });
  const actOnDecisionsRailBatch = vi.fn(async () => ({ outcome: "stopped" as const }));
  const readDecisionsRailBatch = vi.fn(async () => ({ batch: running, items: [] }));
  const openDecisionsRailResults = vi.fn(async () => ({ opened: true }));
  const view = render(
    <ActiveDecisionBatchesStrip
      desktopApi={{ readActiveDecisionBatches, onAgentEvent, actOnDecisionsRailBatch, readDecisionsRailBatch, openDecisionsRailResults }}
      thread={options.thread ?? thread}
    />,
  );
  const emit = (event: AgentEvent) => act(() => { for (const listener of [...listeners]) listener(event); });
  return { ...view, readActiveDecisionBatches, actOnDecisionsRailBatch, readDecisionsRailBatch, emit };
}

describe("ActiveDecisionBatchesStrip", () => {
  it("shows running batches and ones an error stopped, each with its action", async () => {
    const api = renderStrip();
    const strip = await screen.findByRole("region", { name: "Decision batches" });
    expect(api.readActiveDecisionBatches).toHaveBeenCalledWith({ backend: "codex", threadId: "thread-1" });
    expect(within(strip).getByText(/triage_relevance v2 · 640\/1000/)).toBeInTheDocument();
    expect(within(strip).getByText(/diff_risk v1 · 120\/120 · credential_rejected/)).toBeInTheDocument();
    expect(within(strip).getByRole("button", { name: "Stop decision batch: triage_relevance v2" })).toBeInTheDocument();

    fireEvent.click(within(strip).getByRole("button", { name: "Dismiss decision batch: diff_risk v1" }));
    expect(within(strip).queryByText(/diff_risk v1/)).not.toBeInTheDocument();
  });

  it("stops a batch and reads again", async () => {
    const api = renderStrip();
    fireEvent.click(await screen.findByRole("button", { name: "Stop decision batch: triage_relevance v2" }));
    await waitFor(() => expect(api.actOnDecisionsRailBatch).toHaveBeenCalledWith({
      backend: "codex", threadId: "thread-1", batchId: "batch_run-1", action: "stop",
    }));
    await waitFor(() => expect(api.readActiveDecisionBatches).toHaveBeenCalledTimes(2));
  });

  // Rule: the strip reads again only when the owner announces a batch of
  // this thread moved, and disappears once nothing is running or failed.
  it("reads again on this thread's batch announcements only", async () => {
    const api = renderStrip({ batches: [[running], [{ ...running, finished: 700 }], []] });
    await screen.findByText(/640\/1000/);
    api.emit(decisionEvent("thread-2"));
    api.emit(decisionEvent("thread-1", "claude"));
    expect(api.readActiveDecisionBatches).toHaveBeenCalledTimes(1);

    api.emit(decisionEvent("thread-1"));
    await screen.findByText(/700\/1000/);
    api.emit(decisionEvent("thread-1"));
    await waitFor(() => expect(screen.queryByRole("region")).not.toBeInTheDocument());
  });

  it("opens the batch's dialog from Details, and keeps it once the batch leaves", async () => {
    const api = renderStrip({ batches: [[running], []] });
    fireEvent.click(await screen.findByRole("button", { name: "Details for decision batch: triage_relevance v2" }));
    await screen.findByRole("dialog", { name: "Decision batch: triage_relevance v2" });
    api.emit(decisionEvent("thread-1"));
    await waitFor(() => expect(api.readActiveDecisionBatches).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("never reads for a thread another instance owns", () => {
    const api = renderStrip({
      thread: {
        ...thread,
        federation: {
          ref: { backend: "codex", target: { scope: "remote", instanceId: "peer" }, threadId: "thread-1" },
          instanceLabel: "Laptop",
          peerStatus: "connected",
          capabilities: [],
        },
      } as NavigationThreadSummary,
    });
    expect(api.readActiveDecisionBatches).not.toHaveBeenCalled();
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
  });
});
