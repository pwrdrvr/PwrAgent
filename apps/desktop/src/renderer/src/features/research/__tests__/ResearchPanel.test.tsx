// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  projectResearchRun, researchChangePage, researchEventPage, searchResearchItems, summarizeResearchRun,
  type NavigationThreadSummary, type ResearchChange, type ResearchChanges, type ResearchChangesRequest, type ResearchEvent, type ResearchRun, type ResearchSnapshot, type ResearchSnapshotRequest,
  type ResearchItemContext, type ResearchUpdateReceipt,
} from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { chooseSelectOption } from "../../../test/select";
import { ResearchPanel } from "../ResearchPanel";

const thread = { id: "parent", source: "codex", title: "Queue investigation" } as NavigationThreadSummary;
const actor = { backend: "codex", threadId: "parent", kind: "agent" } as const;
/** What the owner holds: complete runs. The fake API answers only as the owner's IPC does, through the shared oracles. */
type OwnerState = { runs: ResearchRun[]; writableRunIds: string[]; pending?: ResearchSnapshot["pending"] };
function ownerSnapshot(data: OwnerState, request?: Pick<ResearchSnapshotRequest, "runId">): ResearchSnapshot {
  const runs = request?.runId === undefined ? data.runs : data.runs.filter((run) => run.id === request.runId);
  return { runs: runs.map(summarizeResearchRun), writableRunIds: data.writableRunIds.filter((id) => runs.some((run) => run.id === id)), ...(data.pending ? { pending: data.pending } : {}) };
}
function ownerChanges(data: OwnerState, request: Pick<ResearchChangesRequest, "runId" | "sinceRevision" | "after">): ResearchChanges {
  const run = data.runs.find((entry) => entry.id === request.runId);
  if (!run) throw new Error("Research run not found");
  return { ...researchChangePage(run, request.sinceRevision, request.after), writable: data.writableRunIds.includes(run.id) };
}
function snapshot(findings = 1): OwnerState {
  const records: ResearchEvent[] = [];
  const add = (data: ResearchEvent["data"]) => records.push({ seq: records.length + 1, commandId: `e${records.length}`, signature: "test", at: 1000, actor, data });
  add({ type: "created", objective: "Investigate queue ordering", coordinator: actor, ownerId: "owner", ownerPid: 1, deadlineAt: 601_000, workspaceMode: "none",
    approaches: [{ id: "a1", title: "Events", task: "Trace ordering", state: "running", worker: { backend: "codex", threadId: "worker", turnId: "turn" } }] });
  for (let i = 0; i < findings; i++) add({ type: "finding", finding: { id: `f${i}`, approachId: "a1", kind: "counterexample", text: `Counterexample ${i}`, paths: ["evidence.txt"] } });
  add({ type: "submission", submission: { id: "s1", approachId: "a1", text: "Preserve the original event order", paths: [] } });
  return { runs: [projectResearchRun("run", records)], writableRunIds: ["run"] };
}
function apiFor(data: OwnerState = snapshot()) {
  let notify: ((change: ResearchChange) => void) | undefined;
  const unsubscribe = vi.fn();
  const run = (id: string) => data.runs.find((entry) => entry.id === id)!;
  const api = {
    researchSnapshot: vi.fn<NonNullable<DesktopApi["researchSnapshot"]>>(async (request) => ownerSnapshot(data, request)),
    researchChanges: vi.fn<NonNullable<DesktopApi["researchChanges"]>>(async (request) => ownerChanges(data, request)),
    readResearchEvents: vi.fn<NonNullable<DesktopApi["readResearchEvents"]>>(async (request) => researchEventPage(data.runs.find((run) => run.id === request.runId)!, request.range)),
    prepareResearch: vi.fn(async () => ({ intentId: "prepared-intent" })),
    withdrawResearch: vi.fn(async () => {}),
    onResearchChanged: vi.fn((callback: (change: ResearchChange) => void) => { notify = callback; return unsubscribe; }),
    updateResearch: vi.fn<NonNullable<DesktopApi["updateResearch"]>>(async (request): Promise<ResearchUpdateReceipt> => ({ runId: request.runId, revision: run(request.runId).revision, status: run(request.runId).status })),
    submitThreadReply: vi.fn<NonNullable<DesktopApi["submitThreadReply"]>>(async () => ({ backend: "codex", threadId: "parent", queueStatus: "queued", queueEntryId: "queue" })),
    openResearchEvidence: vi.fn(async () => ({ opened: true })),
    searchResearch: vi.fn<NonNullable<DesktopApi["searchResearch"]>>(async (request) => searchResearchItems(request.runId, run(request.runId).items, run(request.runId).revision, request.query)),
    readResearchItem: vi.fn<NonNullable<DesktopApi["readResearchItem"]>>(async (request) => ({ run: data.runs[0]!, item: data.runs[0]!.items.find((item) => item.id === request.itemId)! })),
    updateResearchItem: vi.fn<NonNullable<DesktopApi["updateResearchItem"]>>(async (request) => ({ run: data.runs[0]!, item: { ...data.runs[0]!.items.find((item) => item.id === request.command.itemId)!, version: 99, work: { state: request.command.state } } })),
  } satisfies Partial<DesktopApi>;
  /** The owner's change event: for a run at its current revision, or (with no run) for the thread's pending request. */
  const changed = (runId: string | null | undefined = data.runs[0]?.id) => notify?.({ backend: "codex", threadId: "parent", ...(runId ? { runId, revision: run(runId).revision } : {}) });
  return { api: api as DesktopApi, mocks: api, changed, unsubscribe };
}

describe("Research panel", () => {
  it("searches compact pages, opens one item in place and uses its version for progress", async () => {
    const { api, mocks } = apiFor(snapshot(15));
    render(<ResearchPanel desktopApi={api} thread={thread} />);
    await screen.findByLabelText("Research map");
    fireEvent.click(screen.getByRole("tab", { name: "Items" }));
    expect(await screen.findByText("17 items · showing 10")).toBeInTheDocument();
    chooseSelectOption(screen.getByRole("combobox", { name: "Type" }), "Findings");
    fireEvent.change(screen.getByLabelText("Search items"), { target: { value: "Counterexample 14" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(mocks.searchResearch).toHaveBeenLastCalledWith(expect.objectContaining({ query: expect.objectContaining({ query: "Counterexample 14", type: "finding" }) })));
    fireEvent.click(await screen.findByRole("button", { name: /^Counterexample Counterexample 14/ }));
    const heading = await screen.findByRole("heading", { name: "Counterexample from Events" });
    expect(heading).toHaveFocus();
    expect(screen.queryByText(/items · showing/)).not.toBeInTheDocument();
    expect(mocks.readResearchItem).toHaveBeenLastCalledWith({ backend: "codex", threadId: "parent", runId: "run", itemId: "f14" });
    expect(screen.getByRole("button", { name: "Claim" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Progress note"), { target: { value: "Reproduce this case" } });
    fireEvent.click(screen.getByRole("button", { name: "Claim" }));
    await waitFor(() => expect(mocks.updateResearchItem).toHaveBeenCalledWith(expect.objectContaining({ command: { action: "work", itemId: "f14", expectedVersion: 16, state: "claimed", reason: "Reproduce this case" } })));
    expect(screen.queryByText("Verified")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "← Back to results" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /^Counterexample Counterexample 14/ })).toHaveFocus());
    expect(screen.getByRole("combobox", { name: "Type" })).toHaveTextContent("Findings");
  });

  it("opens an item directly from the map, findings, relations and activity", async () => {
    const data = snapshot(2);
    const { api, mocks } = apiFor(data);
    render(<ResearchPanel desktopApi={api} thread={thread} />);
    fireEvent.click(await screen.findByRole("button", { name: /^Counterexample Counterexample 1/ }));
    expect(await screen.findByRole("heading", { name: "Counterexample from Events" })).toHaveFocus();
    expect(screen.getByRole("tab", { name: "Items" })).toHaveAttribute("aria-selected", "true");
    expect(mocks.readResearchItem).toHaveBeenLastCalledWith(expect.objectContaining({ itemId: "f1" }));
    fireEvent.click(screen.getByRole("tab", { name: "Activity" }));
    fireEvent.click(await screen.findByRole("button", { name: "Counterexample 0" }));
    await waitFor(() => expect(mocks.readResearchItem).toHaveBeenLastCalledWith(expect.objectContaining({ itemId: "f0" })));
  });

  it("does not report a child assignment before its request is accepted", async () => {
    const data = snapshot();
    data.runs[0]!.deadlineAt = Date.now() + 600_000;
    const { api, mocks } = apiFor(data);
    const pending = Promise.withResolvers<Awaited<ReturnType<NonNullable<DesktopApi["submitThreadReply"]>>>>();
    mocks.submitThreadReply.mockImplementation(async () => await pending.promise);
    render(<ResearchPanel desktopApi={api} thread={thread} />);
    fireEvent.click(await screen.findByRole("button", { name: /^Counterexample Counterexample 0/ }));
    fireEvent.change(await screen.findByLabelText("Task for a focused child"), { target: { value: "Investigate only this counterexample" } });
    fireEvent.click(screen.getByRole("button", { name: "Request focused child" }));
    expect(screen.queryByText(/Assignment request queued/)).not.toBeInTheDocument();
    await act(async () => pending.resolve({ backend: "codex", threadId: "parent", queueStatus: "queued", queueEntryId: "q" }));
    expect(screen.getByRole("status")).toHaveTextContent("Assignment request queued in the coordinating thread");
    expect(mocks.submitThreadReply).toHaveBeenCalledWith(expect.objectContaining({ input: [expect.objectContaining({ text: expect.stringContaining("itemId=f0; expectedVersion=2") })] }));
  });

  it("discards an old item read when a different item is opened", async () => {
    const data = snapshot(2);
    const { api, mocks } = apiFor(data);
    let resolve!: (value: ResearchItemContext) => void;
    const pending = new Promise<ResearchItemContext>((done) => { resolve = done; });
    mocks.readResearchItem.mockImplementationOnce(async () => await pending);
    render(<ResearchPanel desktopApi={api} thread={thread} />);
    fireEvent.click(await screen.findByRole("button", { name: /^Counterexample Counterexample 0/ }));
    fireEvent.click(screen.getByRole("button", { name: "← Back to results" }));
    fireEvent.click(await screen.findByRole("button", { name: /^Counterexample Counterexample 1/ }));
    await waitFor(() => expect(screen.getByText("f1")).toBeInTheDocument());
    await act(async () => resolve({ run: data.runs[0]!, item: data.runs[0]!.items.find((item) => item.id === "f0")! }));
    expect(screen.getByText("f1")).toBeInTheDocument();
    expect(screen.queryByText("f0")).not.toBeInTheDocument();
  });

  it("shows a map, a findings list and evidence references, and follows owner changes by reading only what changed", async () => {
    const data = snapshot();
    const { api, mocks, unsubscribe, changed } = apiFor(data);
    const view = render(<ResearchPanel desktopApi={api} thread={thread} />);
    expect(await screen.findByLabelText("Research map")).toBeInTheDocument();
    expect(screen.getByText("Counterexample 0")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open worker thread: Events" })).toBeInTheDocument();
    expect(mocks.researchChanges).toHaveBeenCalledExactlyOnceWith({ backend: "codex", threadId: "parent", runId: "run", sinceRevision: 0 });
    data.runs[0] = projectResearchRun("run", [...data.runs[0]!.events, { seq: 4, commandId: "late", signature: "t", at: 2000, actor,
      data: { type: "finding", finding: { id: "late", approachId: "a1", kind: "note", text: "Arrived after the first read", paths: [] } } } as ResearchEvent]);
    act(() => changed());
    expect(await screen.findByText("Arrived after the first read")).toBeInTheDocument();
    // The change names its run and revision: one read of the items changed since revision 3, and no second read of the run list.
    expect(mocks.researchChanges).toHaveBeenLastCalledWith({ backend: "codex", threadId: "parent", runId: "run", sinceRevision: 3 });
    const delta = await mocks.researchChanges.mock.results.at(-1)!.value as ResearchChanges;
    expect(delta.items.map((item) => item.id)).toEqual(["late"]);
    expect(mocks.researchChanges).toHaveBeenCalledTimes(2);
    expect(mocks.researchSnapshot).toHaveBeenCalledTimes(1);
    expect(screen.getByText("2", { selector: "dd" })).toBeInTheDocument();
    // A change the store already holds reads nothing.
    act(() => changed());
    await act(async () => {});
    expect(mocks.researchChanges).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("tab", { name: "Findings" }));
    expect(screen.getByLabelText("Shared findings")).toBeInTheDocument();
    fireEvent.click((await screen.findAllByRole("button", { name: "evidence.txt" }))[0]!);
    await waitFor(() => expect(mocks.openResearchEvidence).toHaveBeenCalledWith({ backend: "codex", threadId: "parent", runId: "run", itemId: "f0", pathIndex: 0 }));
    view.unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("refreshes one summary for a change to a run that is not on screen, and the run list only for a change that names no run", async () => {
    const first = snapshot();
    const second = projectResearchRun("other-run", first.runs[0]!.events.map((event) => event.data.type === "created" ? { ...event, data: { ...event.data, objective: "Second objective" } } : event));
    const data: OwnerState = { runs: [first.runs[0]!, second], writableRunIds: ["run", "other-run"] };
    const { api, mocks, changed } = apiFor(data);
    render(<ResearchPanel desktopApi={api} thread={thread} />);
    await screen.findByLabelText("Research map");
    data.runs[1] = projectResearchRun("other-run", [...second.events, { seq: second.revision + 1, commandId: "end", signature: "t", at: 2000, actor, data: { type: "status", status: "stopped", reason: "Stopped" } } as ResearchEvent]);
    act(() => changed("other-run"));
    await waitFor(() => expect(mocks.researchSnapshot).toHaveBeenLastCalledWith({ backend: "codex", threadId: "parent", runId: "other-run" }));
    expect(mocks.researchSnapshot).toHaveBeenCalledTimes(2);
    // The run on screen was not read again.
    expect(mocks.researchChanges).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("combobox", { name: "Run" }));
    await waitFor(() => expect(screen.getByRole("option", { name: /Second objective/ })).toHaveAccessibleDescription("Stopped"));
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Run" }), { key: "Escape" });
    act(() => changed(null));
    await waitFor(() => expect(mocks.researchSnapshot).toHaveBeenLastCalledWith({ backend: "codex", threadId: "parent" }));
    expect(mocks.researchSnapshot).toHaveBeenCalledTimes(3);
    expect(mocks.researchChanges).toHaveBeenCalledTimes(1);
  });

  it("reports where revision feedback went from the update's own receipt", async () => {
    const data = snapshot();
    data.runs[0]!.deadlineAt = Date.now() + 600_000;
    const { api, mocks } = apiFor(data);
    mocks.updateResearch.mockImplementation(async (request) => ({ runId: request.runId, revision: 4, status: "running", delivery: { id: "feedback", target: { backend: "codex", threadId: "worker" }, approachId: "a1", state: "queued" } }));
    render(<ResearchPanel desktopApi={api} thread={thread} />);
    await screen.findByLabelText("Research map");
    fireEvent.click(screen.getByRole("tab", { name: "Review, 1 to review" }));
    fireEvent.change(screen.getByLabelText("Reason for your decision"), { target: { value: "Reproduce it first" } });
    fireEvent.click(screen.getByRole("button", { name: "Request revision" }));
    expect(await screen.findByText("Revision feedback is queued for the worker.")).toBeInTheDocument();
  });

  it("reviews each candidate with its own reason and keeps acceptance separate from verification", async () => {
    const data = snapshot();
    const records = [...data.runs[0]!.events, { seq: data.runs[0]!.events.length + 1, commandId: "s2", signature: "t", at: 1000, actor,
      data: { type: "submission", submission: { id: "s2", approachId: "a1", text: "Release in insertion order", paths: [] } } } as ResearchEvent];
    data.runs[0] = projectResearchRun("run", records);
    const { api, mocks } = apiFor(data);
    render(<ResearchPanel desktopApi={api} thread={thread} />);
    await screen.findByLabelText("Research map");
    const tab = screen.getByRole("tab", { name: "Review, 2 to review" });
    fireEvent.click(tab);
    expect(screen.getByText(/It is not formal verification/)).toBeInTheDocument();
    const first = screen.getByRole("button", { name: "Release in insertion order" }).closest("article")!;
    const accept = within(first).getByRole("button", { name: "Accept" });
    expect(accept).toBeDisabled();
    fireEvent.change(within(first).getByLabelText("Reason for your decision"), { target: { value: "Reproduction supports this" } });
    const second = screen.getByRole("button", { name: "Preserve the original event order" }).closest("article")!;
    expect(within(second).getByRole("button", { name: "Accept" })).toBeDisabled();
    fireEvent.click(accept);
    await waitFor(() => expect(mocks.updateResearch).toHaveBeenCalledWith(expect.objectContaining({ runId: "run", command: { action: "review", submissionId: "s2", decision: "accepted", reason: "Reproduction supports this" } })));
    expect(screen.queryByText("Verified")).not.toBeInTheDocument();
  });

  it("does not call a run awaiting review when every candidate is decided", async () => {
    const data = snapshot(0);
    const records = data.runs[0]!.events.map((event) => event.data.type === "created"
      ? { ...event, data: { ...event.data, approaches: event.data.approaches.map((a) => ({ ...a, state: "ended" as const })) } } : event);
    records.push({ seq: records.length + 1, commandId: "review", signature: "t", at: 1000, actor, data: { type: "review", submissionId: "s1", decision: "rejected", reason: "Not reproduced" } });
    const { api } = apiFor({ ...data, runs: [projectResearchRun("run", records)] });
    render(<ResearchPanel desktopApi={api} thread={thread} />);
    await screen.findAllByText("Investigate queue ordering");
    expect(screen.queryByText("Awaiting review")).not.toBeInTheDocument();
  });

  it("confirms before stopping every worker", async () => {
    const data = snapshot();
    data.runs[0]!.deadlineAt = Date.now() + 600_000;
    const { api, mocks } = apiFor(data);
    render(<ResearchPanel desktopApi={api} thread={thread} />);
    fireEvent.click(await screen.findByRole("button", { name: "Stop run…" }));
    expect(mocks.updateResearch).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Keep running" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Keep running" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop run…" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop run" }));
    await waitFor(() => expect(mocks.updateResearch).toHaveBeenCalledWith(expect.objectContaining({ command: { action: "stop", reason: "Stopped by the operator" } })));
    expect(screen.getByText("Accept a candidate to finish the run.")).toBeInTheDocument();
  });

  it("does not carry a stop confirmation over to another run", async () => {
    const first = snapshot();
    const second = projectResearchRun("other-run", first.runs[0]!.events.map((event) => event.data.type === "created" ? { ...event, data: { ...event.data, objective: "Second objective" } } : event));
    const data: OwnerState = { runs: [first.runs[0]!, second], writableRunIds: ["run", "other-run"] };
    data.runs.forEach((run) => { run.deadlineAt = Date.now() + 600_000; });
    const { api, mocks } = apiFor(data);
    render(<ResearchPanel desktopApi={api} thread={thread} />);
    fireEvent.click(await screen.findByRole("button", { name: "Stop run…" }));
    expect(screen.getByRole("group", { name: "Confirm stopping the run" })).toBeInTheDocument();
    chooseSelectOption(screen.getByRole("combobox", { name: "Run" }), /Second objective/);
    // The previous run's controls leave with the choice, before the chosen board arrives.
    expect(screen.queryByRole("button", { name: "Stop run" })).not.toBeInTheDocument();
    expect(await screen.findByText("Second objective", { selector: ".research-objective" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Confirm stopping the run" })).not.toBeInTheDocument();
    expect(mocks.updateResearch).not.toHaveBeenCalled();
  });

  it("withdraws a prepared request the coordinating thread did not accept", async () => {
    const { api, mocks } = apiFor({ runs: [], writableRunIds: [] });
    mocks.submitThreadReply.mockImplementation(async () => undefined as never);
    render(<ResearchPanel desktopApi={api} thread={thread} />);
    fireEvent.change(await screen.findByLabelText("Objective"), { target: { value: "Investigate cancellation" } });
    fireEvent.click(screen.getByRole("button", { name: "Request research" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("did not accept");
    expect(mocks.withdrawResearch).toHaveBeenCalledWith({ backend: "codex", threadId: "parent" });
  });

  it("returns focus to a result once, not on every later refresh", async () => {
    const { api, mocks } = apiFor(snapshot(3));
    render(<ResearchPanel desktopApi={api} thread={thread} />);
    fireEvent.click(await screen.findByRole("button", { name: /^Counterexample Counterexample 1/ }));
    fireEvent.click(await screen.findByRole("button", { name: "← Back to results" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /^Counterexample Counterexample 1/ })).toHaveFocus());
    const search = screen.getByLabelText("Search items");
    search.focus();
    const calls = mocks.searchResearch.mock.calls.length;
    fireEvent.change(search, { target: { value: "Counterexample" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    search.focus();
    await waitFor(() => expect(mocks.searchResearch.mock.calls.length).toBeGreaterThan(calls));
    await act(async () => {});
    expect(search).toHaveFocus();
  });

  it("moves between views with the arrow keys", async () => {
    const { api } = apiFor();
    render(<ResearchPanel desktopApi={api} thread={thread} />);
    const map = await screen.findByRole("tab", { name: "Map" });
    map.focus();
    fireEvent.keyDown(map, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Findings" })).toHaveFocus();
    expect(screen.getByRole("tab", { name: "Findings" })).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(screen.getByRole("tab", { name: "Findings" }), { key: "End" });
    expect(screen.getByRole("tab", { name: "Activity" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("tab", { name: "Activity" }), { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Map" })).toHaveFocus();
  });

  it("reports a research request only after the owner accepts it, then shows the owner's pending request", async () => {
    const { api, mocks } = apiFor({ runs: [], writableRunIds: [] });
    const pending = Promise.withResolvers<Awaited<ReturnType<NonNullable<DesktopApi["submitThreadReply"]>>>>();
    mocks.submitThreadReply.mockImplementation(async () => await pending.promise);
    render(<ResearchPanel desktopApi={api} thread={thread} />);
    expect(await screen.findByText(/This thread coordinates/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Objective"), { target: { value: "Investigate cancellation" } });
    fireEvent.click(screen.getByRole("button", { name: "Request research" }));
    expect(screen.queryByText(/Request queued/)).not.toBeInTheDocument();
    await act(async () => pending.resolve({ backend: "codex", threadId: "parent", queueStatus: "queued", queueEntryId: "q" }));
    expect(screen.getByRole("status")).toHaveTextContent("Request queued");
    expect(mocks.submitThreadReply).toHaveBeenCalledWith(expect.objectContaining({ input: [expect.objectContaining({ text: expect.stringContaining("exactly 3 distinct approaches") })] }));
  });

  it("shows a pending request until it expires and withdraws it on request", async () => {
    const expiresAt = Date.now() + 120_000;
    const { api, mocks } = apiFor({ runs: [], writableRunIds: [], pending: { objective: "Why does the changelog step skip?", workers: 2, minutes: 15, workspaceMode: "none", preparedAt: Date.now(), expiresAt } });
    render(<ResearchPanel desktopApi={api} thread={thread} />);
    const card = await screen.findByRole("region", { name: "Research request waiting to start" });
    expect(card).toHaveTextContent("Why does the changelog step skip?");
    expect(card).toHaveTextContent("2 workers · 15 min · scratch workspaces");
    expect(screen.queryByLabelText("Objective")).not.toBeInTheDocument();
    fireEvent.click(within(card).getByRole("button", { name: "Withdraw request" }));
    await waitFor(() => expect(mocks.withdrawResearch).toHaveBeenCalledWith({ backend: "codex", threadId: "parent" }));
  });

  it("hides an expired pending request", async () => {
    const { api } = apiFor({ runs: [], writableRunIds: [], pending: { objective: "Stale", workers: 1, minutes: 5, workspaceMode: "none", preparedAt: 0, expiresAt: Date.now() - 1 } });
    render(<ResearchPanel desktopApi={api} thread={thread} />);
    expect(await screen.findByLabelText("Objective")).toBeInTheDocument();
    expect(screen.queryByText("Stale")).not.toBeInTheDocument();
  });

  it("does not read the local owner's data for a remote thread", () => {
    const { api, mocks } = apiFor();
    const remote = { ...thread, federation: { ref: { target: { scope: "remote", instanceId: "peer" }, backend: "codex", threadId: "parent" } } } as NavigationThreadSummary;
    render(<ResearchPanel desktopApi={api} thread={remote} />);
    expect(screen.getByText(/owning instance/)).toBeInTheDocument();
    expect(mocks.researchSnapshot).not.toHaveBeenCalled();
  });

  it("keeps a thousand recorded contributions out of the map DOM and links to the rest", async () => {
    const { api, mocks } = apiFor(snapshot(1000));
    render(<ResearchPanel desktopApi={api} thread={thread} />);
    const map = await screen.findByLabelText("Research map");
    expect(map.querySelectorAll(".research-node")).toHaveLength(6);
    expect(screen.getByText("1000", { selector: "dd" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "995 more from Events" }));
    await waitFor(() => expect(mocks.searchResearch).toHaveBeenLastCalledWith(expect.objectContaining({ query: expect.objectContaining({ approachId: "a1" }) })));
    expect(screen.getByRole("button", { name: "Remove approach filter: Events" })).toBeInTheDocument();
    // The first read arrives in pages, each continuing from the last item of the one before.
    expect(mocks.researchChanges).toHaveBeenCalledTimes(3);
    expect(mocks.researchChanges).toHaveBeenLastCalledWith(expect.objectContaining({ sinceRevision: 0, after: expect.objectContaining({ version: expect.any(Number) }) }));
  });

  it("pages the findings newest first through the item search, and filters through it too", async () => {
    const { api, mocks } = apiFor(snapshot(1000));
    render(<ResearchPanel desktopApi={api} thread={thread} />);
    await screen.findByLabelText("Research map");
    fireEvent.click(screen.getByRole("tab", { name: "Findings" }));
    const list = screen.getByLabelText("Shared findings");
    expect(await screen.findByText("Showing the latest 20 of 1000 findings.")).toBeInTheDocument();
    expect(list.querySelectorAll("article")).toHaveLength(20);
    expect(within(list).getAllByRole("article")[0]).toHaveTextContent("Counterexample 999");
    expect(mocks.searchResearch).toHaveBeenLastCalledWith({ backend: "codex", threadId: "parent", runId: "run", query: { type: "finding", query: undefined, limit: 20 } });
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(await screen.findByText("Showing the latest 40 of 1000 findings.")).toBeInTheDocument();
    expect(mocks.searchResearch).toHaveBeenLastCalledWith(expect.objectContaining({ query: expect.objectContaining({ cursor: expect.objectContaining({ id: "f980" }) }) }));
    expect(within(list).getAllByRole("article")[39]).toHaveTextContent("Counterexample 960");
    fireEvent.change(screen.getByLabelText("Filter this view"), { target: { value: "Counterexample 99" } });
    // The filter reaches findings that were never loaded: 99 and 990 to 999.
    expect(await screen.findByText("All 11 matching findings.")).toBeInTheDocument();
    expect(mocks.searchResearch).toHaveBeenLastCalledWith(expect.objectContaining({ query: { type: "finding", query: "Counterexample 99", limit: 20 } }));
    expect(within(list).getAllByRole("article").at(-1)).toHaveTextContent("Counterexample 99");
    expect(screen.queryByText("Counterexample 1", { exact: true })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Filter this view"), { target: { value: "nothing matches this" } });
    expect(await screen.findByText("No findings match this filter.")).toBeInTheDocument();
    // The owner's search refuses a query over 300 characters, so a longer filter is cut to that, not answered with an error.
    fireEvent.change(screen.getByLabelText("Filter this view"), { target: { value: "x".repeat(400) } });
    await waitFor(() => expect(mocks.searchResearch).toHaveBeenLastCalledWith(expect.objectContaining({ query: expect.objectContaining({ query: "x".repeat(300) }) })));
    expect(await screen.findByText("No findings match this filter.")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("reads summaries with no items or journal, and the chosen run through its own change stream", async () => {
    const first = snapshot(3);
    const second = projectResearchRun("other-run", first.runs[0]!.events.map((event) => event.data.type === "created" ? { ...event, data: { ...event.data, objective: "Second objective" } } : event));
    const { api, mocks } = apiFor({ runs: [first.runs[0]!, second], writableRunIds: ["run"] });
    render(<ResearchPanel desktopApi={api} thread={thread} />);
    await screen.findByLabelText("Research map");
    const response = await mocks.researchSnapshot.mock.results[0]!.value;
    expect(JSON.stringify(response)).not.toContain("\"events\"");
    expect(JSON.stringify(response)).not.toContain("Counterexample");
    expect(response.runs.map((run: { id: string }) => run.id)).toEqual(["run", "other-run"]);
    chooseSelectOption(screen.getByRole("combobox", { name: "Run" }), /Second objective/);
    await waitFor(() => expect(mocks.researchChanges).toHaveBeenLastCalledWith({ backend: "codex", threadId: "parent", runId: "other-run", sinceRevision: 0 }));
    expect(await screen.findByText("Second objective", { selector: ".research-objective" })).toBeInTheDocument();
    expect(screen.getByText("This run’s owner is not running in this window’s process.", { exact: false })).toBeInTheDocument();
    // Choosing a run reads that run, not the list again.
    expect(mocks.researchSnapshot).toHaveBeenCalledTimes(1);
  });

  it("pages Activity newest first, reads only new events on a change, and reaches the first event with Show older", async () => {
    const data = snapshot(250);
    const { api, mocks, changed } = apiFor(data);
    render(<ResearchPanel desktopApi={api} thread={thread} />);
    await screen.findByLabelText("Research map");
    expect(mocks.readResearchEvents).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("tab", { name: "Activity" }));
    const list = await screen.findByLabelText("Research activity");
    await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(100));
    expect(within(list).getAllByRole("listitem")[0]).toHaveTextContent("Preserve the original event order");
    expect(screen.getByText("Showing the latest 100 of 252 events.")).toBeInTheDocument();
    // The board changes between page reads: the new event lands on top, and the older page continues where the window ended.
    const records = [...data.runs[0]!.events, { seq: 253, commandId: "late", signature: "t", at: 2000, actor,
      data: { type: "finding", finding: { id: "late", approachId: "a1", kind: "note", text: "Arrived between pages", paths: [] } } } as ResearchEvent];
    data.runs[0] = projectResearchRun("run", records);
    act(() => changed());
    await waitFor(() => expect(within(list).getAllByRole("listitem")[0]).toHaveTextContent("Arrived between pages"));
    expect(mocks.readResearchEvents).toHaveBeenLastCalledWith(expect.objectContaining({ runId: "run", range: { afterSeq: 252, limit: 100 } }));
    fireEvent.click(screen.getByRole("button", { name: "Show older" }));
    await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(201));
    expect(mocks.readResearchEvents).toHaveBeenLastCalledWith(expect.objectContaining({ range: { beforeSeq: 153, limit: 100 } }));
    fireEvent.click(screen.getByRole("button", { name: "Show older" }));
    await waitFor(() => expect(screen.getByText("All 253 events.")).toBeInTheDocument());
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(253);
    expect(rows.at(-1)).toHaveTextContent("Run requested");
    expect(screen.queryByRole("button", { name: "Show older" })).not.toBeInTheDocument();
    expect(list).toHaveFocus();
  });

  it("counts events the Activity read found beyond the board it was given", async () => {
    const data = snapshot(250);
    const { api, mocks } = apiFor(data);
    // The journal grew after the board was read: the head page already holds seq 253.
    const grown = projectResearchRun("run", [...data.runs[0]!.events, { seq: 253, commandId: "late", signature: "t", at: 2000, actor,
      data: { type: "finding", finding: { id: "late", approachId: "a1", kind: "note", text: "Newer than the board", paths: [] } } } as ResearchEvent]);
    mocks.readResearchEvents.mockImplementation(async (request) => researchEventPage(grown, request.range));
    render(<ResearchPanel desktopApi={api} thread={thread} />);
    await screen.findByLabelText("Research map");
    fireEvent.click(screen.getByRole("tab", { name: "Activity" }));
    expect(await screen.findByText("Showing the latest 100 of 253 events.")).toBeInTheDocument();
    expect(screen.getByText("Showing the latest 100 of 253 events.")).not.toHaveAttribute("role");
  });

  it("says Activity is unavailable when the window cannot read events", async () => {
    const { api } = apiFor();
    render(<ResearchPanel desktopApi={{ ...api, readResearchEvents: undefined }} thread={thread} />);
    await screen.findByLabelText("Research map");
    fireEvent.click(screen.getByRole("tab", { name: "Activity" }));
    expect(await screen.findByText("Activity is unavailable in this window.")).toBeInTheDocument();
    expect(screen.queryByText("Loading activity…")).not.toBeInTheDocument();
  });

  it("discards a read that completes after the selected thread changes", async () => {
    const first = Promise.withResolvers<ResearchSnapshot>();
    const second = snapshot();
    second.runs[0]!.objective = "New thread's run";
    const researchSnapshot = vi.fn(async ({ threadId }: { threadId: string }) => threadId === "parent" ? await first.promise : ownerSnapshot(second));
    const researchChanges = vi.fn(async (request: ResearchChangesRequest) => ownerChanges(second, request));
    const { rerender } = render(<ResearchPanel desktopApi={{ researchSnapshot, researchChanges } as DesktopApi} thread={thread} />);
    rerender(<ResearchPanel desktopApi={{ researchSnapshot, researchChanges } as DesktopApi} thread={{ ...thread, id: "other" }} />);
    await screen.findAllByText("New thread's run");
    await act(async () => first.resolve(ownerSnapshot(snapshot())));
    expect(screen.queryByText("Investigate queue ordering")).not.toBeInTheDocument();
  });
});
