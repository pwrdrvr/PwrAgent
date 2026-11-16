import { ResearchService, type ResearchPorts } from "@pwragent/owner-core/research-service";
import { ResearchHarnessService } from "@pwragent/owner-core/research-harness-service";
import { probeResearchModel, researchModelRequest } from "@pwragent/owner-core/research-model-adapter";
import { getDesktopConfigStore } from "../settings/config-store/desktop-config-store-singleton";
import { readResearchHarnessConfig } from "../settings/config-store/research-runtime-config";
import { openResearchHarnessProcess } from "./research-harness-process";
import { createHarnessModelTransport, selectHarnessModel } from "./research-harness-model";
import type { ResearchHarnessStatus } from "@pwragent/shared";
import type { ResearchActor, ResearchCommand, StartResearchRequest, ResearchAssignRequest, ResearchSearchQuery, ResearchItem } from "@pwragent/shared";
import type { AgentToolCallContext } from "../agent-tools/agent-tool-definition";
import type { ResearchAgentHandler } from "../agent-tools/pwragent-research-agent-tools";
import { createResearchStorage } from "../storage/desktop-runtime-storage";

let service: ResearchService | undefined;
let harness: ResearchHarnessService | undefined;

export function researchHarnessStatus(): ResearchHarnessStatus {
  const config = readResearchHarnessConfig(getDesktopConfigStore());
  let endpointOrigin: string | undefined;
  try { if (config?.endpoint) endpointOrigin = new URL(config.endpoint).origin; } catch { /* Execution validation reports invalid endpoints; observation stays available. */ }
  return { configured: Boolean(config?.command), model: config?.model, endpointOrigin };
}
export function getResearchHarnessService(): ResearchHarnessService {
  if (!harness) throw new Error("Research Harness owner has not started");
  return harness;
}

export function initializeResearchRuntime(ports: ResearchPorts): ResearchService {
  if (service) return service;
  const storage = createResearchStorage();
  const models = new Map<string, { model: string; complete: ReturnType<typeof createHarnessModelTransport> }>();
  harness = new ResearchHarnessService(storage, {
    ...ports,
    open: (workspace, id, mode) => {
      const config = readResearchHarnessConfig(getDesktopConfigStore());
      if (!config?.command) throw new Error("Configure research.harness in this profile's config.toml");
      const selectedModel = selectHarnessModel(config, mode);
      let modelBusy = false;
      const connection = openResearchHarnessProcess(config, workspace, async (method, params, signal) => {
        const run = storage.get(id);
        const model = models.get(id);
        if (method !== "model_complete" || !model || modelBusy || ports.enabled?.() === false || run?.status !== "running" || run.harness?.state !== "running" || Date.now() >= run.deadlineAt) throw new Error("Research model admission unavailable");
        modelBusy = true;
        try { return await model.complete(researchModelRequest(model.model, params.messages), signal); }
        finally { modelBusy = false; }
      }, ports.onError);
      if (selectedModel) models.set(id, selectedModel);
      return { ...(selectedModel ? { model: { model: selectedModel.model, endpointOrigin: selectedModel.endpointOrigin } } : {}),
        request: (method, params) => connection.request(method, params), close: () => { models.delete(id); return connection.close(); } };
    },
    probe: async (id, signal) => {
      const model = models.get(id);
      if (!model) throw new Error("Configure an explicit hosted model endpoint before Harness execution");
      await probeResearchModel(model.complete, model.model, signal);
    },
  });
  service = new ResearchService(storage, { ...ports, stopHarness: (id, actor, outcome, reason) => getResearchHarnessService().stop(id, actor, outcome, reason) });
  service.initialize();
  return service;
}
export function getResearchService(): ResearchService {
  if (!service) throw new Error("Research owner has not started");
  return service;
}
export async function closeResearchRuntime(): Promise<void> {
  const current = service;
  service = undefined;
  const closing = harness?.close();
  harness = undefined;
  current?.close();
  await closing;
}

export function createResearchAgentHandler(current: ResearchService, isLive: (context: AgentToolCallContext) => boolean, enabled: () => boolean = () => false): ResearchAgentHandler {
  return async (name, args, context) => {
    if (!enabled()) throw new Error("Research runs are disabled. Enable Research runs in Settings → Experimental with Codex Tool Discovery.");
    if (!isLive(context) || !context.turnId || !context.callId) throw new Error("Research tools require a live Codex turn on the owning instance");
    const actor: ResearchActor & { kind: "agent"; turnId: string; callId: string } = { backend: context.backend, threadId: context.threadId, kind: "agent", turnId: context.turnId, callId: context.callId };
    if (name === "research_start") return toolView(await current.start(args as unknown as StartResearchRequest, actor));
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
      const event = run.events.find((e) => e.commandId === key);
      const id = event?.data.type === "finding" ? event.data.finding.id : event?.data.type === "submission" ? event.data.submission.id
        : command.action === "review" ? command.submissionId : "approachId" in command ? command.approachId : undefined;
      const item = id ? run.items.find((entry) => entry.id === id) : undefined;
      return { runId: run.id, revision: run.revision, status: run.status, ...(item ? { item: itemReceipt(item) } : {}),
        ...(command.action === "review" && command.decision === "revision_requested" ? { delivery: run.deliveries.find((d) => d.id === `feedback:${key}`) } : {}) };
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
    const run = current.read(args.runId, actor);
    const offset = args.offset ?? 0;
    const submissionOffset = args.submissionOffset ?? 0;
    const approachOffset = args.approachOffset ?? 0;
    if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0
      || typeof submissionOffset !== "number" || !Number.isSafeInteger(submissionOffset) || submissionOffset < 0
      || typeof approachOffset !== "number" || !Number.isSafeInteger(approachOffset) || approachOffset < 0) throw new Error("Offsets must be nonnegative integers");
    return toolView(run, offset, submissionOffset, approachOffset);
  };
}

function itemReceipt(item: ResearchItem) {
  return { id: item.id, type: item.type, version: item.version, ...item.work,
    ...(item.type === "submission" ? { review: item.record.review?.decision ?? "unreviewed" } : {}) };
}

function toolView(run: ReturnType<ResearchService["read"]>, offset = 0, submissionOffset = 0, approachOffset = 0) {
  return {
    id: run.id, objective: run.objective, revision: run.revision, status: run.status, reason: run.reason,
    coordinator: run.coordinator, deadlineAt: run.deadlineAt,
    workerLimit: run.workerLimit, activeWorkers: run.activeWorkers,
    approaches: run.approaches.slice(approachOffset, approachOffset + 10).map(({ task: _task, ...approach }) => approach),
    totalApproaches: run.approaches.length,
    ...(approachOffset + 10 < run.approaches.length ? { nextApproachOffset: approachOffset + 10 } : {}),
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
