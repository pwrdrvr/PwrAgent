// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import {
  projectResearchRun,
  researchChangePage,
  researchEventPage,
  researchRunAttention,
  searchResearchItems,
  summarizeResearchRun,
  RESEARCH_RUN_ATTENTION_ORDER,
  type ResearchChange,
  type ResearchEvent,
  type ResearchProfileRunsPage,
  type ResearchRun,
} from "@pwragent/shared/research";
import { type NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import type { DesktopApi } from "../../../lib/desktop-api";
import { ResearchWindow } from "../ResearchWindow";
import { harnessRun } from "./research-harness-fixture";

/** A native run coordinated by another thread, live with one worker. */
function nativeRun(id: string, threadId: string, objective: string, at: number): ResearchRun {
  const actor = { backend: "codex", threadId, kind: "agent" } as const;
  const events: ResearchEvent[] = [{ seq: 1, at, commandId: "created", signature: "t", actor, data: { type: "created", objective, coordinator: actor, ownerId: "owner", ownerPid: 1,
    deadlineAt: Date.now() + 600_000, workspaceMode: "none", approaches: [{ id: "a1", title: "Events", task: "Trace ordering", state: "running", worker: { backend: "codex", threadId: "worker", turnId: "turn" } }] } }];
  return projectResearchRun(id, events);
}

/** The owner as the window sees it: a ranked page of every run, and each run read as its coordinating thread. */
function owner(runs: ResearchRun[], pageSize = 50, owned = true) {
  // The run list and the selected run each subscribe, as they do to the owner's one change event.
  const listeners = new Set<(change: ResearchChange) => void>();
  let select: ((runId: string) => void) | undefined;
  const rank = (run: ResearchRun) => RESEARCH_RUN_ATTENTION_ORDER.indexOf(researchRunAttention(summarizeResearchRun(run)));
  const find = (id: string) => runs.find((run) => run.id === id)!;
  const api = {
    researchProfileRuns: vi.fn<NonNullable<DesktopApi["researchProfileRuns"]>>(async (request) => {
      const text = request?.text?.toLowerCase();
      const all = runs.filter((run) => (!request?.source || (request.source === "harness") === Boolean(run.harness)) && (!text || run.objective.toLowerCase().includes(text)))
        .sort((a, b) => rank(a) - rank(b) || b.createdAt - a.createdAt);
      const start = request?.after ? all.findIndex((run) => run.id === request.after!.id) + 1 : 0;
      const page = all.slice(start, start + pageSize);
      const counts: ResearchProfileRunsPage["counts"] = { needs_you: 0, live: 0, retained: 0 };
      for (const run of all) counts[researchRunAttention(summarizeResearchRun(run))]++;
      const last = page.at(-1);
      return { counts, writableRunIds: page.map((run) => run.id),
        runs: page.map((run) => ({ ...summarizeResearchRun(run), attention: researchRunAttention(summarizeResearchRun(run)), thread: { title: `Thread ${run.coordinator.threadId}`, project: "queue-lab" } })),
        ...(last && start + pageSize < all.length ? { nextCursor: { attention: researchRunAttention(summarizeResearchRun(last)), createdAt: last.createdAt, id: last.id } } : {}) };
    }),
    researchSnapshot: vi.fn<NonNullable<DesktopApi["researchSnapshot"]>>(async (request) => {
      const mine = runs.filter((run) => run.coordinator.threadId === request.threadId && (!request.runId || run.id === request.runId));
      return { runs: mine.map(summarizeResearchRun), writableRunIds: owned ? mine.map((run) => run.id) : [] };
    }),
    researchChanges: vi.fn<NonNullable<DesktopApi["researchChanges"]>>(async (request) => {
      if (find(request.runId).coordinator.threadId !== request.threadId) throw new Error("Research run not found");
      return { ...researchChangePage(find(request.runId), request.sinceRevision, request.after), writable: owned };
    }),
    readResearchEvents: vi.fn<NonNullable<DesktopApi["readResearchEvents"]>>(async (request) => researchEventPage(find(request.runId), request.range)),
    searchResearch: vi.fn<NonNullable<DesktopApi["searchResearch"]>>(async (request) => searchResearchItems(request.runId, find(request.runId).items, find(request.runId).revision, request.query)),
    readResearchItem: vi.fn<NonNullable<DesktopApi["readResearchItem"]>>(async (request) => ({ run: find(request.runId), item: find(request.runId).items.find((item) => item.id === request.itemId)! })),
    updateResearch: vi.fn<NonNullable<DesktopApi["updateResearch"]>>(async (request) => ({ runId: request.runId, revision: find(request.runId).revision, status: find(request.runId).status })),
    reconcileResearchHarness: vi.fn<NonNullable<DesktopApi["reconcileResearchHarness"]>>(async (request) => ({ runId: request.runId, revision: 1, status: "interrupted" })),
    openThreadInMainWindow: vi.fn<NonNullable<DesktopApi["openThreadInMainWindow"]>>(async () => {}),
    onResearchChanged: vi.fn((callback: (change: ResearchChange) => void) => { listeners.add(callback); return () => { listeners.delete(callback); }; }),
    onResearchWindowSelect: vi.fn((callback: (runId: string) => void) => { select = callback; return () => {}; }),
  } satisfies Partial<DesktopApi>;
  return { api: api as DesktopApi, mocks: api, changed: (change: ResearchChange) => { for (const listener of [...listeners]) listener(change); }, select: (runId: string) => select?.(runId) };
}

it("lists every run by what it needs, and reads the selected run as its own coordinating thread", async () => {
  const unknown = harnessRun("unknown");
  const live = nativeRun("native-live", "other-thread", "Why does the release job skip the changelog step?", 5000);
  const imported = harnessRun("imported");
  imported.id = "imported-run";
  // Another PwrAgent process on this profile is still running and owns these runs.
  const { api, mocks } = owner([live, imported, unknown], 50, false);
  render(<ResearchWindow desktopApi={api} />);
  const rail = await screen.findByRole("navigation", { name: "Research runs" });
  // The unknown outcome comes first whatever its age, in its own counted group.
  const needs = await within(rail).findByRole("region", { name: /Needs you/ });
  expect(within(needs).getByRole("button", { name: /Outcome unknown.*Inspect contrived source evidence/ })).toHaveAttribute("aria-current", "true");
  expect(within(rail).getByRole("region", { name: /Live/ })).toHaveTextContent("Running");
  expect(within(rail).getByRole("region", { name: /Retained/ })).toHaveTextContent("Imported");
  expect(within(needs).getByText(/Thread parent · queue-lab/)).toBeInTheDocument();
  // The selected run is read as its coordinator, not as any thread of this window.
  const main = screen.getByRole("main", { name: "Research run" });
  expect(await within(main).findByRole("group", { name: "Unresolved source outcome" })).toBeInTheDocument();
  expect(mocks.researchChanges).toHaveBeenCalledWith(expect.objectContaining({ backend: "codex", threadId: "parent", runId: unknown.id }));
  // A run another live process owns cannot take a decision here; the inspector says so instead of showing nothing.
  fireEvent.click(await within(main).findByRole("button", { name: /Candidate.*Invented source candidate/ }));
  const inspector = await screen.findByRole("complementary", { name: "Selected item" });
  expect(await within(inspector).findByText(/Another running PwrAgent process owns this run\. Record the decision from that process\./)).toBeInTheDocument();
  expect(within(inspector).queryByLabelText("Reason for your decision")).not.toBeInTheDocument();

  fireEvent.click(within(rail).getByRole("button", { name: /Running.*release job/ }));
  await within(main).findByText("1 of 1");
  expect(mocks.researchChanges).toHaveBeenLastCalledWith(expect.objectContaining({ threadId: "other-thread", runId: "native-live" }));
  fireEvent.click(screen.getByRole("button", { name: "Open coordinating thread" }));
  expect(mocks.openThreadInMainWindow).toHaveBeenCalledWith({ backend: "codex", threadId: "other-thread" });
});

// An import admits the members its source names, so it has no limit of its own to show; execution counts against the operator's.
it.each([["imported", "1"], ["unknown", "1 of 2"]] as const)("counts a %s Harness run's members as %s", async (state, members) => {
  const { api } = owner([harnessRun(state)]);
  render(<ResearchWindow desktopApi={api} />);
  const summary = await screen.findByRole("region", { name: "Research run summary" });
  expect(within(summary).getByText("Members").nextElementSibling).toHaveTextContent(new RegExp(`^${members}$`));
});

it("opens an item in the inspector beside the board, with a candidate's decision in it", async () => {
  const run = harnessRun("imported");
  const { api, mocks } = owner([run]);
  render(<ResearchWindow desktopApi={api} />);
  await screen.findByRole("region", { name: "Research run summary" });
  const main = screen.getByRole("main", { name: "Research run" });
  fireEvent.click(await within(main).findByRole("button", { name: /Candidate.*Invented source candidate/ }));
  const inspector = await screen.findByRole("complementary", { name: "Selected item" });
  expect(await within(inspector).findByRole("heading", { name: "Candidate from Source direction" })).toHaveFocus();
  // The board keeps its place: the Map is still on screen, not replaced by the detail.
  expect(within(main).getByLabelText("Research map")).toBeInTheDocument();
  expect(within(main).getByRole("tab", { name: "Map" })).toHaveAttribute("aria-selected", "true");
  fireEvent.change(within(inspector).getByLabelText("Reason for your decision"), { target: { value: "Independent review" } });
  expect(within(inspector).getByRole("button", { name: "Request revision" })).toBeDisabled();
  fireEvent.click(within(inspector).getByRole("button", { name: "Accept" }));
  await waitFor(() => expect(mocks.updateResearch).toHaveBeenCalledWith(expect.objectContaining({ backend: "codex", threadId: "parent", runId: run.id,
    command: { action: "review", submissionId: "h:3", decision: "accepted", reason: "Independent review" } })));
  fireEvent.keyDown(within(inspector).getByRole("heading", { name: "Candidate from Source direction" }), { key: "Escape" });
  expect(screen.queryByRole("complementary", { name: "Selected item" })).not.toBeInTheDocument();
  // A source thread opens in the main window: this window has no thread list of its own.
  fireEvent.click(within(main).getByRole("tab", { name: "Findings" }));
  expect(await within(main).findByText(/^From m1 · #1/)).toBeInTheDocument();
});

it("re-reads the list on any research change, pages it, filters it, and selects a run it is told to", async () => {
  const runs = [nativeRun("run-a", "thread-a", "Queue ordering", 1000), nativeRun("run-b", "thread-b", "Cache flake", 2000), nativeRun("run-c", "thread-c", "Release changelog", 3000)];
  const { api, mocks, changed, select } = owner(runs, 2);
  render(<ResearchWindow desktopApi={api} />);
  const rail = await screen.findByRole("navigation", { name: "Research runs" });
  await within(rail).findByRole("button", { name: /Release changelog/ });
  expect(within(rail).queryByRole("button", { name: /Queue ordering/ })).not.toBeInTheDocument();
  expect(within(rail).getByRole("region", { name: /Live/ })).toHaveTextContent("3");
  fireEvent.click(within(rail).getByRole("button", { name: "Show more runs" }));
  await within(rail).findByRole("button", { name: /Queue ordering/ });
  expect(within(rail).queryByRole("button", { name: "Show more runs" })).not.toBeInTheDocument();

  // Told to select a run, as when the panel's pop-out is used while the window is open.
  act(() => select("run-a"));
  await waitFor(() => expect(within(rail).getByRole("button", { name: /Queue ordering/ })).toHaveAttribute("aria-current", "true"));

  // Any change re-reads as many pages as were loaded; the list may have regrouped.
  const before = mocks.researchProfileRuns.mock.calls.length;
  runs.push(nativeRun("run-d", "thread-d", "Webhook duplicates", 4000));
  act(() => changed({ backend: "codex", threadId: "thread-d", runId: "run-d", revision: 1 }));
  await within(rail).findByRole("button", { name: /Webhook duplicates/ });
  expect(mocks.researchProfileRuns.mock.calls.length).toBe(before + 2);

  fireEvent.click(within(rail).getByRole("button", { name: "Harness" }));
  expect(await within(rail).findByText("No runs match.")).toBeInTheDocument();
  expect(mocks.researchProfileRuns).toHaveBeenLastCalledWith({ source: "harness" });
});

it("says how runs start when there are none", async () => {
  const { api } = owner([]);
  render(<ResearchWindow desktopApi={api} />);
  expect(await screen.findByText(/No research runs yet\. A run starts from a thread/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Open coordinating thread" })).not.toBeInTheDocument();
});

it("opens the Research window on the panel's run from its pop-out button", async () => {
  const run = harnessRun("imported");
  const { api } = owner([run]);
  const openResearchWindow = vi.fn<NonNullable<DesktopApi["openResearchWindow"]>>(async () => {});
  const { ResearchPanel } = await import("../ResearchPanel");
  render(<ResearchPanel desktopApi={{ ...api, openResearchWindow } as DesktopApi} thread={{ id: "parent", source: "codex" } as NavigationThreadSummary} />);
  await screen.findByRole("region", { name: "Research run summary" });
  fireEvent.click(screen.getByRole("button", { name: "Open in Research window" }));
  expect(openResearchWindow).toHaveBeenCalledWith({ runId: run.id });
});

it("finishes a run that was interrupted by a restart once a candidate is accepted", async () => {
  const actor = { backend: "codex", threadId: "thread-a", kind: "agent" } as const;
  const events: ResearchEvent[] = [];
  const add = (data: ResearchEvent["data"]) => events.push({ seq: events.length + 1, at: 1000 + events.length, commandId: `e${events.length}`, signature: "t", actor, data });
  add({ type: "created", objective: "Queue ordering", coordinator: actor, ownerId: "earlier-process", ownerPid: 1, deadlineAt: 600_000, workspaceMode: "none",
    approaches: [{ id: "a1", title: "Events", task: "Trace ordering", state: "ended" }] });
  add({ type: "submission", submission: { id: "s1", approachId: "a1", text: "Preserve the original event order", paths: [] } });
  add({ type: "status", status: "interrupted", reason: "PwrAgent closed. Research evidence is retained; execution was not automatically resumed." });
  const interrupted = projectResearchRun("run-a", events);
  const { api, mocks } = owner([interrupted]);
  const view = render(<ResearchWindow desktopApi={api} />);
  await screen.findByRole("region", { name: "Research run summary" });
  // Nothing to finish until something is accepted: the card offers no run controls yet.
  expect(screen.queryByRole("button", { name: "Finish run" })).not.toBeInTheDocument();
  view.unmount();

  add({ type: "review", submissionId: "s1", decision: "accepted", reason: "Independent review" });
  const accepted = projectResearchRun("run-a", events);
  const next = owner([accepted]);
  render(<ResearchWindow desktopApi={next.api} />);
  const finish = await screen.findByRole("button", { name: "Finish run" });
  expect(finish).toBeEnabled();
  // The run is over: there is nothing to stop, only an outcome to record.
  expect(screen.queryByRole("button", { name: "Stop run…" })).not.toBeInTheDocument();
  fireEvent.click(finish);
  await waitFor(() => expect(next.mocks.updateResearch).toHaveBeenCalledWith(expect.objectContaining({ threadId: "thread-a", runId: "run-a",
    command: { action: "finish", reason: "Completed after operator review" } })));
  expect(mocks.updateResearch).not.toHaveBeenCalled();
});
