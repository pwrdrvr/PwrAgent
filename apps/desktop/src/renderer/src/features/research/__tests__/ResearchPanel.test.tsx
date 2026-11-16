// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { projectResearchRun, type NavigationThreadSummary, type ResearchEvent, type ResearchSnapshot } from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { ResearchPanel } from "../ResearchPanel";

const thread = { id: "parent", source: "codex", title: "Queue investigation" } as NavigationThreadSummary;
const actor = { backend: "codex", threadId: "parent", kind: "agent" } as const;
function snapshot(findings = 1): ResearchSnapshot {
  const records: ResearchEvent[] = [];
  const add = (data: ResearchEvent["data"]) => records.push({ seq: records.length + 1, commandId: `e${records.length}`, signature: "test", at: 1000, actor, data });
  add({ type: "created", objective: "Investigate queue ordering", coordinator: actor, ownerId: "owner", ownerPid: 1, deadlineAt: 601_000, workspaceMode: "none",
    approaches: [{ id: "a1", title: "Events", task: "Trace ordering", state: "running", worker: { backend: "codex", threadId: "worker", turnId: "turn" } }] });
  for (let i = 0; i < findings; i++) add({ type: "finding", finding: { id: `f${i}`, approachId: "a1", kind: "counterexample", text: `Counterexample ${i}`, paths: ["evidence.txt"] } });
  add({ type: "submission", submission: { id: "s1", approachId: "a1", text: "Preserve the original event order", paths: [] } });
  return { runs: [projectResearchRun("run", records)], writableRunIds: ["run"] };
}
function apiFor(data = snapshot()) {
  let changed: (() => void) | undefined;
  const unsubscribe = vi.fn();
  const api = {
    researchSnapshot: vi.fn(async () => data),
    prepareResearch: vi.fn(async () => ({ intentId: "prepared-intent" })),
    onResearchChanged: vi.fn((callback) => { changed = () => callback({ backend: "codex", threadId: "parent" }); return unsubscribe; }),
    updateResearch: vi.fn(async () => data.runs[0]!),
    submitThreadReply: vi.fn<NonNullable<DesktopApi["submitThreadReply"]>>(async () => ({ backend: "codex", threadId: "parent", queueStatus: "queued", queueEntryId: "queue" })),
    openResearchEvidence: vi.fn(async () => ({ opened: true })),
  } satisfies Partial<DesktopApi>;
  return { api: api as DesktopApi, mocks: api, changed: () => changed?.(), unsubscribe };
}

describe("Research panel", () => {
  it("shows a recorded graph, a findings board, and evidence references", async () => {
    const { api, mocks, unsubscribe, changed } = apiFor();
    const view = render(<ResearchPanel desktopApi={api} thread={thread} />);
    expect(await screen.findByLabelText("Recorded research graph")).toBeInTheDocument();
    expect(screen.getByText("Counterexample 0")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Board" }));
    expect(screen.getByLabelText("Shared findings")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "evidence.txt" }));
    await waitFor(() => expect(mocks.openResearchEvidence).toHaveBeenCalledWith({ backend: "codex", threadId: "parent", runId: "run", itemId: "f0", pathIndex: 0 }));
    act(changed);
    await waitFor(() => expect(mocks.researchSnapshot).toHaveBeenCalledTimes(2));
    view.unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("requires a reason and keeps reviewer acceptance separate from verification", async () => {
    const { api, mocks } = apiFor();
    render(<ResearchPanel desktopApi={api} thread={thread} />);
    await screen.findByLabelText("Recorded research graph");
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(screen.getByText(/Formal verification has not been performed/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Accept" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Review reason"), { target: { value: "Reproduction supports this" } });
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(mocks.updateResearch).toHaveBeenCalledWith(expect.objectContaining({ runId: "run", command: { action: "review", submissionId: "s1", decision: "accepted", reason: "Reproduction supports this" } })));
    expect(screen.queryByText("Verified")).not.toBeInTheDocument();
  });

  it("reports a research request only after the owner accepts it, including queued sends", async () => {
    const { api, mocks } = apiFor({ runs: [], writableRunIds: [] });
    const pending = Promise.withResolvers<Awaited<ReturnType<NonNullable<DesktopApi["submitThreadReply"]>>>>();
    mocks.submitThreadReply.mockImplementation(async () => await pending.promise);
    render(<ResearchPanel desktopApi={api} thread={thread} />);
    fireEvent.change(await screen.findByLabelText("Objective"), { target: { value: "Investigate cancellation" } });
    fireEvent.click(screen.getByRole("button", { name: "Request research" }));
    expect(screen.queryByText(/Request queued/)).not.toBeInTheDocument();
    await act(async () => pending.resolve({ backend: "codex", threadId: "parent", queueStatus: "queued", queueEntryId: "q" }));
    expect(screen.getByRole("status")).toHaveTextContent("Request queued in the coordinating thread");
    expect(mocks.submitThreadReply).toHaveBeenCalledWith(expect.objectContaining({ input: [expect.objectContaining({ text: expect.stringContaining("exactly 3 distinct approaches") })] }));
  });

  it("does not read the local owner's data for a remote thread", () => {
    const { api, mocks } = apiFor();
    const remote = { ...thread, federation: { ref: { target: { scope: "remote", instanceId: "peer" }, backend: "codex", threadId: "parent" } } } as NavigationThreadSummary;
    render(<ResearchPanel desktopApi={api} thread={remote} />);
    expect(screen.getByText(/owning instance/)).toBeInTheDocument();
    expect(mocks.researchSnapshot).not.toHaveBeenCalled();
  });

  it("keeps a thousand recorded contributions out of the graph DOM until selected", async () => {
    const { api } = apiFor(snapshot(1000));
    render(<ResearchPanel desktopApi={api} thread={thread} />);
    const graph = await screen.findByLabelText("Recorded research graph");
    expect(graph.querySelectorAll(".research-node--finding")).toHaveLength(7);
    expect(screen.getByText(/1000 findings/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Board" }));
    fireEvent.change(screen.getByLabelText("Filter research by approach, finding, or state"), { target: { value: "Counterexample 999" } });
    expect(screen.getByText("Counterexample 999")).toBeInTheDocument();
    expect(screen.queryByText("Counterexample 1")).not.toBeInTheDocument();
  });

  it("discards a read that completes after the selected thread changes", async () => {
    const first = Promise.withResolvers<ResearchSnapshot>();
    const second = snapshot();
    second.runs[0]!.objective = "New thread's run";
    const researchSnapshot = vi.fn(async ({ threadId }: { threadId: string }) => threadId === "parent" ? await first.promise : second);
    const { rerender } = render(<ResearchPanel desktopApi={{ researchSnapshot } as DesktopApi} thread={thread} />);
    rerender(<ResearchPanel desktopApi={{ researchSnapshot } as DesktopApi} thread={{ ...thread, id: "other" }} />);
    await screen.findAllByText("New thread's run");
    await act(async () => first.resolve(snapshot()));
    expect(screen.queryByText("Investigate queue ordering")).not.toBeInTheDocument();
  });
});
