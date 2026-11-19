// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  projectResearchRun, researchChangePage, researchEventPage, summarizeResearchRun,
  type NavigationThreadSummary, type ResearchChange, type ResearchEvent, type ResearchRun, type ResearchUpdateReceipt,
} from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { chooseSelectOption } from "../../../test/select";
import { ResearchPanel } from "../ResearchPanel";

const thread = { id: "parent", source: "codex", title: "Queue investigation" } as NavigationThreadSummary;
const actor = { backend: "codex", threadId: "parent", kind: "agent" } as const;
const MINUTE = 60_000;

/** An invented running run with a per-worker limit and total worker time: three workers, one finished after 40 minutes and two an hour in. */
function boundedRun(now: number): ResearchRun {
  const createdAt = now - 60 * MINUTE;
  const records: ResearchEvent[] = [];
  const add = (at: number, data: ResearchEvent["data"]) => records.push({ seq: records.length + 1, commandId: `e${records.length}`, signature: "test", at, actor, data });
  add(createdAt, { type: "created", objective: "Find where the queue reorders terminal events", coordinator: actor, ownerId: "owner", ownerPid: 1, deadlineAt: createdAt + 8 * 60 * MINUTE,
    turnMinutes: 45, totalWorkerMinutes: 600, workspaceMode: "none", approaches: [
      { id: "a1", title: "Receipt ordering", task: "Trace receipts", state: "pending" }, { id: "a2", title: "Cancellation races", task: "Trace cancellation", state: "pending" },
      { id: "a3", title: "Restart gate", task: "Trace restarts", state: "pending" }] });
  for (const index of [1, 2, 3]) add(createdAt, { type: "worker", approachId: `a${index}`, state: "running", worker: { backend: "codex", threadId: `worker-${index}`, turnId: `turn-${index}` } });
  add(createdAt + 40 * MINUTE, { type: "worker", approachId: "a1", state: "ended" });
  return projectResearchRun("run", records);
}

function apiFor(runs: ResearchRun[]) {
  const run = (id: string) => runs.find((entry) => entry.id === id)!;
  const api = {
    researchSnapshot: vi.fn<NonNullable<DesktopApi["researchSnapshot"]>>(async () => ({ runs: runs.map(summarizeResearchRun), writableRunIds: runs.map((entry) => entry.id) })),
    researchChanges: vi.fn<NonNullable<DesktopApi["researchChanges"]>>(async (request) => ({ ...researchChangePage(run(request.runId), request.sinceRevision, request.after), writable: true })),
    readResearchEvents: vi.fn<NonNullable<DesktopApi["readResearchEvents"]>>(async (request) => researchEventPage(run(request.runId), request.range)),
    prepareResearch: vi.fn<NonNullable<DesktopApi["prepareResearch"]>>(async () => ({ intentId: "prepared-intent" })),
    withdrawResearch: vi.fn(async () => {}),
    onResearchChanged: vi.fn((_callback: (change: ResearchChange) => void) => () => {}),
    updateResearch: vi.fn<NonNullable<DesktopApi["updateResearch"]>>(async (request): Promise<ResearchUpdateReceipt> => ({ runId: request.runId, revision: run(request.runId).revision, status: "running" })),
    submitThreadReply: vi.fn<NonNullable<DesktopApi["submitThreadReply"]>>(async () => ({ backend: "codex", threadId: "parent", queueStatus: "queued", queueEntryId: "queue" })),
  } satisfies Partial<DesktopApi>;
  return { api: api as DesktopApi, mocks: api };
}

describe("research bounds in the panel", () => {
  it("sends a per-worker time limit the operator set, and tells the coordinator to omit the ones they did not", async () => {
    const { api, mocks } = apiFor([]);
    render(<ResearchPanel desktopApi={api} thread={thread} />);
    fireEvent.change(await screen.findByLabelText("Objective"), { target: { value: "Investigate cancellation" } });
    const field = screen.getByRole("group", { name: "Per-worker time limit" });
    fireEvent.click(within(field).getByRole("button", { name: "Set a limit" }));
    fireEvent.change(within(field).getByLabelText("Length"), { target: { value: "45" } });
    chooseSelectOption(within(field).getByRole("combobox", { name: "Unit" }), "Minutes");
    expect(screen.getByText(/A worker whose turn runs past 45 min is stopped; the run continues\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Request research" }));
    await waitFor(() => expect(mocks.prepareResearch).toHaveBeenCalled());
    const request = mocks.prepareResearch.mock.calls[0]![0];
    expect(request).not.toHaveProperty("minutes");
    expect(request).not.toHaveProperty("totalWorkerMinutes");
    expect(request.turnMinutes).toBe(45);
    const text = (mocks.submitThreadReply.mock.calls[0]![0].input[0] as { text: string }).text;
    expect(text).toContain("turnMinutes=45");
    expect(text).toContain("no time limit (omit minutes)");
    expect(text).toContain("no total worker time (omit totalWorkerMinutes)");
  });

  it("shows the worker limits that are set, and records only what the operator changed", async () => {
    const now = Date.now();
    const { api, mocks } = apiFor([boundedRun(now)]);
    render(<ResearchPanel desktopApi={api} thread={thread} />);
    const row = await screen.findByLabelText("Worker limits");
    expect(row).toHaveTextContent("45 min");
    expect(row).toHaveTextContent("Each worker");
    // One finished 40-minute turn and two turns an hour in.
    expect(row).toHaveTextContent(/2 h 40 min of 10 h/);

    fireEvent.click(screen.getByRole("button", { name: "Change bounds…" }));
    const editor = screen.getByRole("form", { name: "Change the run's bounds" });
    expect(within(editor).getByLabelText("Workers at once")).toHaveValue(3);
    expect(within(editor).getByRole("button", { name: "Save bounds" })).toBeDisabled();
    fireEvent.change(within(editor).getByLabelText("Workers at once"), { target: { value: "1" } });
    expect(editor).toHaveTextContent("Lowering the worker count stops no one: the 2 running workers finish their turns");
    fireEvent.click(within(within(editor).getByRole("group", { name: /^Time limit, from the start/ })).getByRole("button", { name: "No limit" }));
    fireEvent.click(within(editor).getByRole("button", { name: "Save bounds" }));
    await waitFor(() => expect(mocks.updateResearch).toHaveBeenCalledWith(expect.objectContaining({ runId: "run", command: { action: "bounds", workers: 1, minutes: null } })));
    await waitFor(() => expect(screen.queryByRole("form", { name: "Change the run's bounds" })).not.toBeInTheDocument());
    expect(screen.getByRole("status")).toHaveTextContent("Bounds saved.");
  });

  it("refuses a total worker time the workers have already used before asking the owner", async () => {
    const { api, mocks } = apiFor([boundedRun(Date.now())]);
    render(<ResearchPanel desktopApi={api} thread={thread} />);
    fireEvent.click(await screen.findByRole("button", { name: "Change bounds…" }));
    const editor = screen.getByRole("form", { name: "Change the run's bounds" });
    const total = within(editor).getByRole("group", { name: "Total worker time" });
    fireEvent.change(within(total).getByLabelText("Length"), { target: { value: "1" } });
    expect(editor).toHaveTextContent("Workers have already used 2 h 40 min.");
    expect(within(editor).getByRole("button", { name: "Save bounds" })).toBeDisabled();
    expect(mocks.updateResearch).not.toHaveBeenCalled();
  });
});
