import { ResearchService, type ResearchPorts } from "@pwragent/owner-core/research-service";
import { RESEARCH_BOARD_PAGE, type ResearchActor, type ResearchCommand, type StartResearchRequest, type ResearchAssignRequest, type ResearchSearchQuery, type ResearchItem } from "@pwragent/shared";
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

export function createResearchAgentHandler(current: ResearchService, isLive: (context: AgentToolCallContext) => boolean, enabled: () => boolean = () => false): ResearchAgentHandler {
  return async (name, args, context) => {
    if (!enabled()) throw new Error("Research runs are disabled. Enable Research runs in Settings → Experimental with Codex Tool Discovery.");
    if (!isLive(context) || !context.turnId || !context.callId) throw new Error("Research tools require a live Codex turn on the owning instance");
    const actor: ResearchActor & { kind: "agent"; turnId: string; callId: string } = { backend: context.backend, threadId: context.threadId, kind: "agent", turnId: context.turnId, callId: context.callId };
    if (name === "research_start") return boardView(current.readBoard((await current.start(args as unknown as StartResearchRequest, actor)).id, { approachOffset: 0, findingOffset: 0, submissionOffset: 0 }, actor));
    if (name === "research_assign") return await current.assign(args as unknown as ResearchAssignRequest, actor);
    if (name === "research_search") {
      if (typeof args.runId !== "string") throw new Error("Supply a runId");
      const { runId, ...query } = args;
      return current.search(runId, query as ResearchSearchQuery, actor);
    }
    if (name === "research_update") {
      if (typeof args.runId !== "string" || !args.command || typeof args.command !== "object") throw new Error("Supply runId and command");
      const command = args.command as ResearchCommand;
      const key = `agent:${context.backend}:${context.threadId}:${context.turnId}:${context.callId}`;
      if (command.action === "work") return { runId: args.runId, item: itemReceipt(await current.work(args.runId, key, command, actor)) };
      const run = await current.update(args.runId, key, command, actor);
      // Read only what the command touched: its item and, for a revision, its delivery.
      const { item, delivery } = current.receipt(run.id, key, command);
      return { runId: run.id, revision: run.revision, status: run.status, ...(item ? { item: itemReceipt(item) } : {}),
        ...(command.action === "review" && command.decision === "revision_requested" ? { delivery } : {}) };
    }
    if (args.runId === undefined) return current.summaries(actor);
    if (typeof args.runId !== "string") throw new Error("Supply a runId");
    const ids = [args.itemId, args.approachId, args.findingId, args.submissionId].filter((id) => id !== undefined);
    if (ids.length > 1 || ids.some((id) => typeof id !== "string")) throw new Error("Choose exactly one item ID");
    if (ids.length === 1) {
      const result = current.readItem(args.runId, ids[0] as string, actor);
      if (args.findingId !== undefined && result.item.type !== "finding") throw new Error("Finding not found");
      if (args.submissionId !== undefined && result.item.type !== "submission") throw new Error("Submission not found");
      if (args.approachId !== undefined && result.item.type !== "approach") throw new Error("Approach not found");
      return args.findingId !== undefined || args.submissionId !== undefined ? result.item.record : result;
    }
    const offset = args.offset ?? 0;
    const submissionOffset = args.submissionOffset ?? 0;
    const approachOffset = args.approachOffset ?? 0;
    if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0
      || typeof submissionOffset !== "number" || !Number.isSafeInteger(submissionOffset) || submissionOffset < 0
      || typeof approachOffset !== "number" || !Number.isSafeInteger(approachOffset) || approachOffset < 0) throw new Error("Offsets must be nonnegative integers");
    return boardView(current.readBoard(args.runId, { approachOffset, findingOffset: offset, submissionOffset }, actor), offset, submissionOffset, approachOffset);
  };
}

function itemReceipt(item: ResearchItem) {
  return { id: item.id, type: item.type, version: item.version, ...item.work,
    ...(item.type === "submission" ? { review: item.record.review?.decision ?? "unreviewed" } : {}) };
}

/** One page of the board, ten of each list, read from stored projections rather than the journal. */
function boardView(board: ReturnType<ResearchService["readBoard"]>, offset = 0, submissionOffset = 0, approachOffset = 0) {
  const { run } = board;
  return {
    id: run.id, objective: run.objective, revision: run.revision, status: run.status, reason: run.reason,
    coordinator: run.coordinator, deadlineAt: run.deadlineAt,
    workerLimit: run.workerLimit, activeWorkers: run.activeWorkers,
    approaches: board.approaches.map(({ task: _task, ...approach }) => approach),
    totalApproaches: board.totalApproaches,
    ...(approachOffset + RESEARCH_BOARD_PAGE < board.totalApproaches ? { nextApproachOffset: approachOffset + RESEARCH_BOARD_PAGE } : {}),
    findings: board.findings,
    totalFindings: board.totalFindings,
    ...(offset + RESEARCH_BOARD_PAGE < board.totalFindings ? { nextFindingOffset: offset + RESEARCH_BOARD_PAGE } : {}),
    submissions: board.submissions, totalSubmissions: board.totalSubmissions,
    ...(submissionOffset + RESEARCH_BOARD_PAGE < board.totalSubmissions ? { nextSubmissionOffset: submissionOffset + RESEARCH_BOARD_PAGE } : {}),
    latestSubmissionId: board.latestSubmissionId,
    deliveries: board.deliveries,
    deliveryFailures: board.deliveryFailures,
    guidance: "Accepted means reviewed by the named reviewer, never formally verified. Evidence paths are relative to the originating author's workspace. Report revision feedback as delivered only after a started or queued receipt; unknown outcomes must not be retried blindly. Read another page or a specific finding/submission when needed.",
  };
}
