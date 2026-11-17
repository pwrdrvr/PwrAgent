// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { researchEventPage, researchRunBoard, summarizeResearchRun, type NavigationThreadSummary, type ResearchRun } from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { ResearchPanel } from "../ResearchPanel";
import { harnessRun } from "./research-harness-fixture";

function show(run: ResearchRun) {
  const api = {
    researchSnapshot: vi.fn(async () => ({ runs: [summarizeResearchRun(run)], selected: researchRunBoard(run), writableRunIds: [run.id] })),
    readResearchEvents: vi.fn<NonNullable<DesktopApi["readResearchEvents"]>>(async (request) => researchEventPage(run, request.range)),
    onResearchChanged: vi.fn(() => () => {}),
    readResearchItem: vi.fn<NonNullable<DesktopApi["readResearchItem"]>>(async (request) => ({ run, item: run.items.find((item) => item.id === request.itemId)! })),
    updateResearch: vi.fn<NonNullable<DesktopApi["updateResearch"]>>(async () => researchRunBoard(run)),
    updateResearchItem: vi.fn(), submitThreadReply: vi.fn(),
  } satisfies Partial<DesktopApi>;
  render(<ResearchPanel desktopApi={api as DesktopApi} thread={{ id: "parent", source: "codex" } as NavigationThreadSummary} />);
  return api;
}

it("preserves source provenance, unknown cancellation and source verdicts across the extracted views", async () => {
  const run = harnessRun("unknown");
  const api = show(run);
  expect(await screen.findByLabelText("Harness provenance")).toHaveTextContent(run.harness!.note);
  expect(screen.getByLabelText("Harness provenance")).toHaveTextContent("token and dollar usage unknown");
  fireEvent.click(screen.getByRole("tab", { name: "Findings" }));
  expect(screen.getByText(/Source m1 · record 1 · SHA-256 aaaaaaaaaaaa/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("tab", { name: /Review/ }));
  const candidate = screen.getByRole("article", { name: "Candidate from Source direction" });
  expect(within(candidate).getByText("Awaiting review")).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Reason for your decision"), { target: { value: "Independent review" } });
  expect(screen.getByRole("button", { name: "Request revision" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Accept" }));
  await waitFor(() => expect(api.updateResearch).toHaveBeenCalledWith(expect.objectContaining({ command: {
    action: "review", submissionId: run.submissions[0]!.id, decision: "accepted", reason: "Independent review",
  } })));
  fireEvent.click(screen.getByRole("tab", { name: "Activity" }));
  expect(await screen.findByText("Source coordinator accepted this informal candidate")).toBeInTheDocument();
  expect(api.readResearchEvents).toHaveBeenCalledWith(expect.objectContaining({ runId: run.id, range: { limit: 100 } }));
});

it("keeps imported items readable without offering native progress or child dispatch", async () => {
  const api = show(harnessRun());
  fireEvent.click(await screen.findByRole("button", { name: /Note Invented source finding/ }));
  await screen.findByRole("heading", { name: "Note from Source direction" });
  expect(screen.queryByLabelText("Progress note")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Task for a focused child")).not.toBeInTheDocument();
  expect(screen.getByText(/Source m1 · record 1 · SHA-256/)).toBeInTheDocument();
  expect(api.updateResearchItem).not.toHaveBeenCalled();
  expect(api.submitThreadReply).not.toHaveBeenCalled();
});

it.each(["imported", "ended"] as const)("can finish a retained %s source after independent local acceptance", async (state) => {
  const api = show(harnessRun(state, true));
  const finish = await screen.findByRole("button", { name: "Finish run" });
  expect(finish).toBeEnabled();
  fireEvent.click(finish);
  await waitFor(() => expect(api.updateResearch).toHaveBeenCalledWith(expect.objectContaining({ command: { action: "finish", reason: "Completed after operator review" } })));
});

it("keeps discovery observation and its keyboard navigation separate from native item controls", async () => {
  const run = harnessRun("imported");
  run.harness!.source = "discovery";
  run.harness!.discovery = { observedAt: 1000, state: "done", finished: 1, solved: 1, tokensIn: 10, tokensOut: 20,
    problems: [{ id: "fixture_problem", state: "done", nodes: 1, rounds: 1, solved: true }] };
  show(run);
  await screen.findByLabelText("Discovery observation");
  expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Discovery", "Activity"]);
  fireEvent.keyDown(screen.getByRole("tab", { name: "Discovery" }), { key: "End" });
  expect(screen.getByRole("tab", { name: "Activity" })).toHaveAttribute("aria-selected", "true");
  expect(screen.getByRole("tab", { name: "Activity" })).toHaveFocus();
  fireEvent.keyDown(screen.getByRole("tab", { name: "Activity" }), { key: "Home" });
  expect(screen.getByRole("tab", { name: "Discovery" })).toHaveFocus();
  expect(screen.getByLabelText("Discovery observation")).toBeInTheDocument();
});
