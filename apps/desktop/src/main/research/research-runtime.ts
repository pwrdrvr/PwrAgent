import { ResearchService, type ResearchPorts } from "@pwragent/owner-core/research-service";
import { ResearchHarnessService } from "@pwragent/owner-core/research-harness-service";
import { probeResearchModel, researchModelRequest } from "@pwragent/owner-core/research-model-adapter";
import path from "node:path";
import { getDesktopConfigStore } from "../settings/config-store/desktop-config-store-singleton";
import { getDesktopSettingsService } from "../settings/desktop-settings-singleton";
import { readResearchConfig } from "../settings/config-store/research-runtime-config";
import { listMathosSwarms, listMathosTeams, MathosPlatformError, openMathosPlatformConnection, type MathosPlatformDeps, type MathosPlatformTarget } from "./mathos-platform-connection";
import { openResearchHarnessProcess } from "./research-harness-process";
import { createHarnessModelTransport, selectHarnessModel } from "./research-harness-model";
import {
  MATHOS_TEAM_ID,
  normalizeMathosPlatformOrigin,
  resolveResearchHarnessSource,
  type MathosSwarmsResult,
  type MathosTeamsResult,
  type ResearchHarnessStatus,
} from "@pwragent/shared/research-harness";
import { decisionRunProviderName, type DecisionRunProvider } from "@pwragent/shared/decision-models";
import { RESEARCH_BOARD_PAGE, researchDeadlinePassed } from "@pwragent/shared/research";
import type {
  ResearchActor,
  ResearchCommand,
  StartResearchRequest,
  ResearchAssignRequest,
  ResearchSearchQuery,
  ResearchItem,
  ResearchThread,
} from "@pwragent/shared/research";
import type { AgentToolCallContext } from "../agent-tools/agent-tool-definition";
import type { ResearchAgentHandler } from "../agent-tools/pwragent-research-agent-tools";
import { createResearchStorage } from "../storage/desktop-runtime-storage";

let service: ResearchService | undefined;
let harness: ResearchHarnessService | undefined;

/**
 * What the window may know about the configured source. A bridge's model
 * credential is reported only as a variable name and whether it is set; the
 * MathOS Platform key only as stored or not. No value leaves this process.
 */
export function researchHarnessStatus(workspace?: string, env: NodeJS.ProcessEnv = process.env,
  platformKeyStored?: boolean): ResearchHarnessStatus {
  let research: ReturnType<typeof readResearchConfig>;
  try { research = readResearchConfig(getDesktopConfigStore()); }
  catch (error) { return { configured: false, configError: error instanceof Error ? error.message : "This profile's config.toml cannot be used", ...(workspace ? { workspace } : {}) }; }
  if (resolveResearchHarnessSource(research) === "mathos") {
    const origin = normalizeMathosPlatformOrigin(research.mathos?.origin);
    const team = research.mathos?.team && MATHOS_TEAM_ID.test(research.mathos.team) ? research.mathos.team : undefined;
    return {
      configured: Boolean(origin.ok && team && platformKeyStored !== false),
      source: "mathos",
      ...(origin.ok ? { platformOrigin: origin.origin } : { configError: `research.mathos.origin: ${origin.error}` }),
      ...(team ? { platformTeam: team } : {}),
      ...(platformKeyStored !== undefined ? { platformKeyStored } : {}),
      ...(workspace ? { workspace } : {}),
    };
  }
  const config = research.harness;
  const status: ResearchHarnessStatus = { configured: Boolean(config?.command), source: "bridge", ...(workspace ? { workspace } : {}) };
  if (!config?.command) return status;
  status.bridge = path.basename(config.command);
  if (config.model) status.model = config.model;
  if (config.endpoint && config.model) {
    // The same validation execution applies; a status read never contacts the endpoint.
    try { status.endpointOrigin = selectHarnessModel(config, "execute")?.endpointOrigin; }
    catch (error) { status.endpointError = error instanceof Error ? error.message : "Invalid research model endpoint"; }
  } else if (config.endpoint || config.model) status.endpointError = "Set both research.harness.endpoint and research.harness.model to run a new swarm";
  if (config.apiKeyEnv) { status.credentialEnv = config.apiKeyEnv; status.credentialSet = Boolean(env[config.apiKeyEnv]); }
  return status;
}

/** Whether a Platform key is stored, without decrypting it. Undefined when the store cannot be read. */
export async function researchHarnessPlatformKeyStored(): Promise<boolean | undefined> {
  try { return await getDesktopSettingsService().hasMathosPlatformApiKey(); }
  catch { return undefined; }
}

/** The network seams the MathOS Platform client uses: the owner's own fetch and WebSocket. */
function mathosPlatformDeps(): MathosPlatformDeps {
  const socket = (globalThis as { WebSocket?: unknown }).WebSocket;
  if (typeof socket !== "function") throw new Error("This PwrAgent runtime cannot open WebSockets, so it cannot reach the MathOS Platform.");
  return { fetch: (input, init) => fetch(input, init), WebSocket: socket as MathosPlatformDeps["WebSocket"] };
}

/**
 * The saved MathOS target and the stored key, read only when the owner is about
 * to sign in. The key stays in this process.
 */
function mathosPlatformTarget(research: ReturnType<typeof readResearchConfig>): MathosPlatformTarget {
  const origin = normalizeMathosPlatformOrigin(research.mathos?.origin);
  if (!origin.ok) throw new Error(`research.mathos.origin: ${origin.error}`);
  const team = research.mathos?.team;
  if (!team || !MATHOS_TEAM_ID.test(team)) throw new Error("Choose a MathOS team in Settings › Experimental › Open Math Harness.");
  const apiKey = getDesktopSettingsService().resolveMathosPlatformApiKeySync();
  if (!apiKey) throw new Error("Store a MathOS Platform API key in Settings › Experimental › Open Math Harness.");
  return { origin: origin.origin, team, apiKey };
}

/** The swarms on the saved team's VM, for the New run form. Read-only; nothing is written. */
export async function listResearchMathosSwarms(): Promise<MathosSwarmsResult> {
  try {
    const research = readResearchConfig(getDesktopConfigStore());
    if (resolveResearchHarnessSource(research) !== "mathos") return { ok: false, error: "Open Math Harness is set to a custom bridge." };
    return { ok: true, ...await listMathosSwarms(mathosPlatformDeps(), mathosPlatformTarget(research)) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not list this team’s swarms." };
  }
}

/** The teams the stored key can open, on the saved platform origin. Errors carry the platform's words, never the key. */
export async function listResearchMathosTeams(): Promise<MathosTeamsResult> {
  try {
    const research = readResearchConfig(getDesktopConfigStore());
    const origin = normalizeMathosPlatformOrigin(research.mathos?.origin);
    if (!origin.ok) return { ok: false, error: origin.error };
    const apiKey = getDesktopSettingsService().resolveMathosPlatformApiKeySync();
    if (!apiKey) return { ok: false, error: "Store a MathOS Platform API key first." };
    return { ok: true, teams: await listMathosTeams(mathosPlatformDeps(), { origin: origin.origin, apiKey }) };
  } catch (error) {
    return { ok: false, error: error instanceof MathosPlatformError ? error.message : "Could not list your MathOS teams." };
  }
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
      const research = readResearchConfig(getDesktopConfigStore());
      // PwrAgent's own client: read-only, so `hello` offers neither execution nor cancellation.
      if (resolveResearchHarnessSource(research) === "mathos") return openMathosPlatformConnection(mathosPlatformTarget(research), mathosPlatformDeps());
      const config = research.harness;
      if (!config?.command) throw new Error("Choose a custom bridge program in Settings › Experimental › Open Math Harness");
      const selectedModel = selectHarnessModel(config, mode);
      let modelBusy = false;
      const connection = openResearchHarnessProcess(config, workspace, async (method, params, signal) => {
        const run = storage.header(id);
        const model = models.get(id);
        if (method !== "model_complete" || !model || modelBusy || ports.enabled?.() === false || run?.status !== "running" || run.harness?.state !== "running" || researchDeadlinePassed(run, Date.now())) throw new Error("Research model admission unavailable");
        modelBusy = true;
        try { return await model.complete(researchModelRequest(model.model, params.messages), signal); }
        finally { modelBusy = false; }
      }, ports.onError);
      if (selectedModel) models.set(id, selectedModel);
      return { ...(selectedModel ? { model: { model: selectedModel.model, endpointOrigin: selectedModel.endpointOrigin } } : {}),
        source: `bridge:${config.command}`, request: (method, params) => connection.request(method, params), close: () => { models.delete(id); return connection.close(); } };
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

export type ResearchBoardDecisionsContext = {
  readyProviders: readonly DecisionRunProvider[];
  runDecisions?: number;
  runBatches?: number;
  activeBatches?: number;
};

export type ResearchAgentDecisionsAdapter = {
  readBoardDecisions: (actor: ResearchThread, runId: string) => Promise<ResearchBoardDecisionsContext>;
};

export function createResearchAgentHandler(
  current: ResearchService,
  isLive: (context: AgentToolCallContext) => boolean,
  enabled: () => boolean = () => false,
  decisions?: ResearchAgentDecisionsAdapter,
): ResearchAgentHandler {
  const readDecisions = async (actor: ResearchThread, runId: string): Promise<ResearchBoardDecisionsContext | undefined> => {
    if (!decisions) return undefined;
    try {
      return await decisions.readBoardDecisions(actor, runId);
    } catch {
      return undefined;
    }
  };
  return async (name, args, context) => {
    if (!enabled()) throw new Error("Research runs are disabled. Enable Research runs in Settings → Experimental.");
    if (!isLive(context) || !context.turnId || !context.callId) throw new Error("Research tools require a live turn on the owning instance. In Codex threads they also require Codex Tool Discovery.");
    const actor: ResearchActor & { kind: "agent"; turnId: string; callId: string } = { backend: context.backend, threadId: context.threadId, kind: "agent", turnId: context.turnId, callId: context.callId };
    if (name === "research_start") {
      const started = await current.start(args as unknown as StartResearchRequest, actor);
      return boardView(
        current.readBoard(started.id, { approachOffset: 0, findingOffset: 0, submissionOffset: 0 }, actor),
        0,
        0,
        0,
        await readDecisions(actor, started.id),
      );
    }
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
    return boardView(
      current.readBoard(args.runId, { approachOffset, findingOffset: offset, submissionOffset }, actor),
      offset,
      submissionOffset,
      approachOffset,
      await readDecisions(actor, args.runId),
    );
  };
}

function itemReceipt(item: ResearchItem) {
  return { id: item.id, type: item.type, version: item.version, ...item.work,
    ...(item.type === "submission" ? { review: item.record.review?.decision ?? "unreviewed" } : {}) };
}

/** One page of the board, ten of each list, read from stored projections rather than the journal. */
function boardView(
  board: ReturnType<ResearchService["readBoard"]>,
  offset = 0,
  submissionOffset = 0,
  approachOffset = 0,
  decisions?: ResearchBoardDecisionsContext,
) {
  const { run } = board;
  const readyProviders = decisions?.readyProviders ?? [];
  const hasDecisionsActivity = (decisions?.runDecisions ?? 0) > 0 || (decisions?.runBatches ?? 0) > 0;
  const showDecisions = readyProviders.length > 0 || hasDecisionsActivity;
  const decisionsGuidance = readyProviders.length > 0
    ? ` Decision models are ready (${readyProviders.map(decisionRunProviderName).join(", ")}): register run-scoped rubrics with decisions_register (scope="research_run", researchRunId="${run.id}"), discover them with decisions_list (researchRunId="${run.id}"), run batch evaluations with decisions_invoke, and inspect run batches with decisions_batch_results (researchRunId="${run.id}").`
    : "";
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
    ...(showDecisions
      ? {
          decisions: {
            readyProviders: [...readyProviders],
            ...(decisions?.runDecisions !== undefined ? { runDecisions: decisions.runDecisions } : {}),
            ...(decisions?.runBatches !== undefined ? { runBatches: decisions.runBatches } : {}),
            ...(decisions?.activeBatches !== undefined ? { activeBatches: decisions.activeBatches } : {}),
          },
        }
      : {}),
    guidance: `Accepted means reviewed by the named reviewer, never formally verified. Evidence paths are relative to the originating author's workspace. Report revision feedback as delivered only after a started or queued receipt; unknown outcomes must not be retried blindly. Read another page or a specific finding/submission when needed.${decisionsGuidance}`,
  };
}
