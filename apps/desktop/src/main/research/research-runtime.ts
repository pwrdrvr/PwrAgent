import { ResearchService, type ResearchPorts } from "@pwragent/owner-core/research-service";
import type { ResearchActor, ResearchCommand, StartResearchRequest } from "@pwragent/shared";
import type { AgentToolCallContext } from "../agent-tools/agent-tool-definition";
import type { ResearchAgentHandler } from "../agent-tools/pwragent-research-agent-tools";
import { createResearchStorage } from "../storage/desktop-runtime-storage";

let service: ResearchService | undefined;

export function initializeResearchRuntime(ports: ResearchPorts): ResearchService {
  if (service) return service;
  service = new ResearchService(createResearchStorage(), ports);
  service.initialize();
  return service;
}
export function getResearchService(): ResearchService {
  if (!service) throw new Error("Research owner has not started");
  return service;
}
export function closeResearchRuntime(): void {
  const current = service;
  service = undefined;
  current?.close();
}

export function createResearchAgentHandler(current: ResearchService, isLive: (context: AgentToolCallContext) => boolean): ResearchAgentHandler {
  return async (name, args, context) => {
    if (!isLive(context) || !context.turnId || !context.callId) throw new Error("Research tools require a live Codex turn on the owning instance");
    const actor: ResearchActor & { kind: "agent"; turnId: string; callId: string } = { backend: context.backend, threadId: context.threadId, kind: "agent", turnId: context.turnId, callId: context.callId };
    if (name === "research_start") return toolView(await current.start(args as unknown as StartResearchRequest, actor));
    if (name === "research_update") {
      if (typeof args.runId !== "string" || !args.command || typeof args.command !== "object") throw new Error("Supply runId and command");
      return toolView(await current.update(args.runId, `agent:${context.backend}:${context.threadId}:${context.turnId}:${context.callId}`, args.command as ResearchCommand, actor));
    }
    if (args.runId === undefined) return current.snapshot(actor).runs.map((r) => ({ id: r.id, objective: r.objective, status: r.status, deadlineAt: r.deadlineAt, workers: r.approaches.length, findings: r.findings.length, submissions: r.submissions.length }));
    if (typeof args.runId !== "string") throw new Error("Supply a runId");
    const run = current.read(args.runId, actor);
    if (typeof args.findingId === "string") {
      const finding = run.findings.find((f) => f.id === args.findingId);
      if (!finding) throw new Error("Finding not found");
      return finding;
    }
    if (typeof args.submissionId === "string") {
      const submission = run.submissions.find((s) => s.id === args.submissionId);
      if (!submission) throw new Error("Submission not found");
      return submission;
    }
    const offset = args.offset ?? 0;
    const submissionOffset = args.submissionOffset ?? 0;
    if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0
      || typeof submissionOffset !== "number" || !Number.isSafeInteger(submissionOffset) || submissionOffset < 0) throw new Error("Offsets must be nonnegative integers");
    return toolView(run, offset, submissionOffset);
  };
}

function toolView(run: ReturnType<ResearchService["read"]>, offset = 0, submissionOffset = 0) {
  return {
    id: run.id, objective: run.objective, revision: run.revision, status: run.status, reason: run.reason,
    coordinator: run.coordinator, deadlineAt: run.deadlineAt,
    approaches: run.approaches.map(({ task: _task, ...approach }) => approach),
    findings: run.findings.slice(offset, offset + 10),
    totalFindings: run.findings.length,
    ...(offset + 10 < run.findings.length ? { nextFindingOffset: offset + 10 } : {}),
    submissions: run.submissions.slice(submissionOffset, submissionOffset + 10), totalSubmissions: run.submissions.length,
    ...(submissionOffset + 10 < run.submissions.length ? { nextSubmissionOffset: submissionOffset + 10 } : {}),
    latestSubmissionId: run.submissions.at(-1)?.id,
    deliveries: run.deliveries.slice(-5),
    deliveryFailures: run.events.flatMap((event) => event.data.type === "delivery_failed" ? [event.data.reason] : []).slice(-3),
    guidance: "Accepted means reviewed by the named reviewer, never formally verified. Evidence paths are relative to the originating author's workspace. Report revision feedback as delivered only after a started or queued receipt; unknown outcomes must not be retried blindly. Read another page or a specific finding/submission when needed.",
  };
}
