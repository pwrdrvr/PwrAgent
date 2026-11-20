import {
  applyResearchChanges,
  emptyResearchRunStore,
  researchChangePage,
  summarizeResearchRun,
  projectResearchRun,
  type ResearchRun,
  type ResearchEvent,
} from "@pwragent/shared/research";
import { RESEARCH_HARNESS_REVISION, type ResearchHarnessState } from "@pwragent/shared/research-harness";

export function harnessRun(state: ResearchHarnessState["state"] = "running", accepted = false) {
  const actor = { backend: "codex", threadId: "parent", kind: "agent" } as const;
  // A lost cancellation acknowledgement only exists for execution; stopping an import sends no cancel.
  const harness: ResearchHarnessState = { version: 1, mode: state === "unknown" ? "execute" : "import", project: "fixture-project", session: "fixture-session", swarm: "fixture-swarm",
    workspace: "/fixture/workspace", upstreamRevision: RESEARCH_HARNESS_REVISION, state, cursor: 4, members: ["m1"], cancelSupported: false,
    ...(state === "unknown" ? { unresolved: "cancel" as const } : {}),
    note: state === "unknown" ? "Cancellation was requested, but the bridge did not confirm it. Source work may still be running." : "Retained source observations." };
  const events: ResearchEvent[] = [];
  const add = (data: ResearchEvent["data"], source = false) => events.push({ seq: events.length + 1, at: 1000 + events.length, commandId: `fixture:${events.length}`, signature: "fixture", actor, data,
    ...(source ? { provenance: { adapter: "open-math-harness" as const, version: 1 as const, upstreamRevision: RESEARCH_HARNESS_REVISION,
      project: harness.project, session: harness.session, swarm: harness.swarm, seq: events.length, at: 1000, member: "m1", digest: "a".repeat(64) } } : {}),
  });
  add({ type: "created", objective: "Inspect contrived source evidence", coordinator: actor, ownerId: "fixture-owner", ownerPid: 1,
    deadlineAt: Date.now() + 600_000, workspaceMode: "none", harness, approaches: [
      { id: "a1", title: "Source direction", task: "Inspect source evidence", state: "ended" },
      { id: "a2", title: "Reserved slot", task: "Unassigned", state: "stopped" },
    ] });
  add({ type: "finding", finding: { id: "h:2", approachId: "a1", kind: "note", text: "Invented source finding", paths: ["evidence/fixture.txt"] } }, true);
  add({ type: "submission", submission: { id: "h:3", approachId: "a1", text: "Invented source candidate", paths: [] } }, true);
  add({ type: "harness_observation", event: "verdict", text: "Source coordinator accepted this informal candidate" }, true);
  if (accepted) add({ type: "review", submissionId: "h:3", decision: "accepted", reason: "Independent local review" });
  if (state === "imported" || state === "ended") add({ type: "status", status: "interrupted", reason: "Source prefix retained" });
  if (state === "unknown") add({ type: "status", status: "stopping", reason: "Remote stop unconfirmed" });
  return projectResearchRun("fixture-run", events);
}

export function harnessRunView(run: ResearchRun) {
  const store = applyResearchChanges(emptyResearchRunStore(run.id), { ...researchChangePage(run), writable: true });
  const { harness: _phase, ...summary } = summarizeResearchRun(run);
  return { ...summary, ...store.state!, items: store.items, approaches: store.approaches,
    submissions: store.submissions, leaves: store.leaves };
}
