import type { AppServerBackendKind } from "./contracts/normalized-app-server";

export type ResearchThread = { backend: AppServerBackendKind; threadId: string };
export type ResearchActor = ResearchThread & { kind: "agent" | "operator"; turnId?: string; callId?: string };
export type ResearchStatus = "running" | "stopping" | "stopped" | "deadline" | "completed" | "interrupted" | "exhausted";
export type ResearchFindingKind = "lemma" | "partial" | "counterexample" | "dead_end" | "experiment" | "file" | "note";
export type ResearchApproach = {
  id: string;
  title: string;
  task: string;
  state: "pending" | "starting" | "running" | "ended" | "failed" | "stopped" | "unknown";
  worker?: ResearchThread & { turnId?: string };
  note?: string;
  directionState?: "active" | "abandoned";
  overlapsApproachId?: string;
};
export type ResearchFinding = {
  id: string;
  author?: ResearchThread;
  approachId: string;
  kind: ResearchFindingKind;
  text: string;
  paths: string[];
  relatesTo?: string;
  relation?: "supports" | "contradicts" | "supersedes";
};
export type ResearchSubmission = {
  id: string;
  author?: ResearchThread;
  approachId: string;
  text: string;
  paths: string[];
  review?: { decision: "accepted" | "revision_requested" | "rejected"; reason: string; actor: ResearchActor };
};
export type ResearchDelivery = { id: string; target: ResearchThread; state: "pending" | "queued" | "started" | "cancelled" | "unknown"; queueEntryId?: string; turnId?: string };
export type StartResearchRequest = {
  intentId?: string;
  objective: string;
  approaches: Array<{ title: string; task: string }>;
  minutes: number;
  workspaceMode: "new_worktree" | "none";
};
export type PrepareResearchRequest = ResearchThread & Omit<StartResearchRequest, "approaches" | "intentId"> & { workers: number };
export type ResearchCommand =
  | ({ action: "finding" } & Omit<ResearchFinding, "id" | "author">)
  | ({ action: "submit" } & Omit<ResearchSubmission, "id" | "review" | "author">)
  | { action: "review"; submissionId: string; decision: "accepted" | "revision_requested" | "rejected"; reason: string }
  | { action: "abandon"; approachId: string; reason: string }
  | { action: "direction"; approachId: string; title: string; task: string; reason: string; overlapsApproachId?: string }
  | { action: "stop"; reason: string }
  | { action: "finish"; reason: string };

export type ResearchEventData =
  | { type: "created"; objective: string; coordinator: ResearchThread; ownerId: string; ownerPid: number; deadlineAt: number; workspaceMode: StartResearchRequest["workspaceMode"]; approaches: ResearchApproach[] }
  | { type: "worker"; approachId: string; state: ResearchApproach["state"]; worker?: ResearchApproach["worker"]; note?: string }
  | { type: "finding"; finding: ResearchFinding }
  | { type: "submission"; submission: ResearchSubmission }
  | { type: "review"; submissionId: string; decision: "accepted" | "revision_requested" | "rejected"; reason: string }
  | { type: "abandoned"; approachId: string; reason: string }
  | { type: "direction"; approachId: string; title: string; task: string; reason: string; overlapsApproachId?: string }
  | { type: "status"; status: ResearchStatus; reason: string }
  | { type: "delivery_failed"; reason: string }
  | { type: "delivery"; delivery: ResearchDelivery };
// Delivery receipts identify exactly the revision work a stop may cancel.
export type ResearchEvent = {
  seq: number;
  commandId: string;
  signature: string;
  at: number;
  actor: ResearchActor;
  data: ResearchEventData;
};
export type ResearchRun = {
  id: string;
  revision: number;
  objective: string;
  coordinator: ResearchThread;
  ownerId: string;
  ownerPid: number;
  createdAt: number;
  deadlineAt: number;
  workspaceMode: StartResearchRequest["workspaceMode"];
  status: ResearchStatus;
  reason?: string;
  approaches: ResearchApproach[];
  findings: ResearchFinding[];
  submissions: ResearchSubmission[];
  events: ResearchEvent[];
  deliveries: ResearchDelivery[];
};
export type ResearchSnapshot = { runs: ResearchRun[]; writableRunIds: string[] };
export type ResearchUpdateRequest = ResearchThread & { runId: string; requestId: string; command: ResearchCommand };
export type ResearchEvidenceRequest = ResearchThread & { runId: string; itemId: string; pathIndex: number };

/** A journal is a complete ordered prefix. Duplicates may repeat a seq, never change it. */
export function projectResearchRun(id: string, records: ResearchEvent[]): ResearchRun {
  const events: ResearchEvent[] = [];
  for (const event of [...records].sort((a, b) => a.seq - b.seq)) {
    const previous = events[event.seq - 1];
    if (previous) {
      if (JSON.stringify(previous) !== JSON.stringify(event)) throw new Error("Conflicting research event");
      continue;
    }
    if (event.seq !== events.length + 1) throw new Error("Incomplete research journal");
    events.push(event);
  }
  const first = events[0];
  if (!first || first.data.type !== "created") throw new Error("Missing research creation event");
  const initial = first.data;
  const run: ResearchRun = {
    id, revision: events.length, objective: initial.objective, coordinator: initial.coordinator,
    ownerId: initial.ownerId, ownerPid: initial.ownerPid, createdAt: first.at, deadlineAt: initial.deadlineAt,
    workspaceMode: initial.workspaceMode, status: "running", approaches: initial.approaches.map((a) => ({ ...a })),
    findings: [], submissions: [], events, deliveries: [],
  };
  for (const event of events.slice(1)) {
    const data = event.data;
    if (data.type === "worker") {
      const approach = run.approaches.find((a) => a.id === data.approachId);
      if (!approach) throw new Error("Unknown research approach");
      Object.assign(approach, { state: data.state }, data.worker ? { worker: data.worker } : {}, data.note ? { note: data.note } : {});
    } else if (data.type === "finding") run.findings.push(data.finding);
    else if (data.type === "submission") run.submissions.push({ ...data.submission });
    else if (data.type === "review") {
      const submission = run.submissions.find((s) => s.id === data.submissionId);
      if (!submission) throw new Error("Unknown research submission");
      submission.review = { decision: data.decision, reason: data.reason, actor: event.actor };
    } else if (data.type === "abandoned") {
      const approach = run.approaches.find((a) => a.id === data.approachId);
      if (!approach) throw new Error("Unknown research approach");
      approach.note = data.reason;
      approach.directionState = "abandoned";
    } else if (data.type === "direction") {
      const approach = run.approaches.find((a) => a.id === data.approachId);
      if (!approach) throw new Error("Unknown research approach");
      Object.assign(approach, { title: data.title, task: data.task, note: data.reason, directionState: "active", overlapsApproachId: data.overlapsApproachId });
    } else if (data.type === "delivery") {
      const index = run.deliveries.findIndex((d) => d.id === data.delivery.id);
      if (index < 0) run.deliveries.push(data.delivery);
      else run.deliveries[index] = data.delivery;
    } else if (data.type === "status") {
      run.status = data.status;
      run.reason = data.reason;
    }
  }
  return run;
}

export function sameResearchThread(a: ResearchThread, b: ResearchThread): boolean {
  return a.backend === b.backend && a.threadId === b.threadId;
}

export const RESEARCH_MAX_WORKERS = 8;
export const RESEARCH_MAX_EVENTS = 4096;
export const RESEARCH_FINDING_KINDS: ResearchFindingKind[] = ["lemma", "partial", "counterexample", "dead_end", "experiment", "file", "note"];
