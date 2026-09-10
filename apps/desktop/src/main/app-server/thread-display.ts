import { createHash } from "node:crypto";
import {
  aggregateToolAccounting,
  buildThreadPricingDisplay,
  isThreadSubAgentVisibleInPanel,
  subAgentLens,
  type SubAgentLens,
  buildThreadIncidentSummary,
  buildTurnUsageActivityEntryFromLine,
  preferTurnUsageLine,
  reconcileCompletedTurnUsageEntries,
  type AppServerReadThreadRequest,
  type AppServerReadThreadResponse,
  type AppServerThreadMessageEntry,
  type NavigationThreadSummary,
  type ThreadUsageLineRecord,
} from "@pwragent/shared";

/** One owner projection for local IPC and federation; no provider data is needed on the viewer. */
export function projectThreadDisplay(
  response: AppServerReadThreadResponse,
  request: AppServerReadThreadRequest,
  thread?: Pick<NavigationThreadSummary, "subAgents" | "turnFailureLog" | "reasoningEffort"> & { activeTurnId?: string },
): AppServerReadThreadResponse {
  const demand = request.display;
  if (!demand) return response;
  const visibleSubAgents = (thread?.subAgents ?? [])
    .filter((agent) => isThreadSubAgentVisibleInPanel(agent, response.fetchedAt))
    .sort((left, right) => right.createdAt - left.createdAt);
  const subAgentCounts: Record<SubAgentLens, number> = { harness: 0, "token-miser": 0, pwragent: 0 };
  for (const agent of visibleSubAgents) subAgentCounts[subAgentLens(agent)] += 1;
  const selectedLens = demand.subAgentLens && subAgentCounts[demand.subAgentLens] > 0 ? demand.subAgentLens
    : subAgentCounts.harness > 0 ? "harness" : subAgentCounts.pwragent > 0 ? "pwragent" : "token-miser";
  const subAgents = visibleSubAgents.filter((agent) => subAgentLens(agent) === selectedLens);
  const revisionSource = demand.resource === "tools" ? response.toolAccounting
    : demand.resource === "subagents" || demand.resource === "subagent" ? { visibleSubAgents, selectedLens }
      : { pricing: response.pricing, tokenMiser: response.toolAccounting?.tokenMiser, thread };
  const revision = createHash("sha256").update(JSON.stringify([demand.resource, revisionSource])).digest("base64url");
  let offset = 0;
  if (demand.cursor) {
    const [cursorRevision, cursorOffset] = demand.cursor.split(":");
    if (cursorRevision !== revision) throw new Error("Thread display history changed. Refresh the panel before loading more.");
    offset = Number(cursorOffset);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid thread display cursor.");
  }
  const limit = Math.min(50, Math.max(1, Math.floor(demand.limit ?? 20)));
  if (!Number.isFinite(limit)) throw new Error("Invalid thread display page size.");
  const pricing = buildThreadPricingDisplay({
    pricing: response.pricing,
    subAgents: thread?.subAgents,
    tokenMiserAccounting: response.toolAccounting?.tokenMiser,
    turnFailures: thread?.turnFailureLog,
    threadReasoningEffort: thread?.reasoningEffort,
    activeTurnId: thread?.activeTurnId ?? (response.threadStatus !== "idle" ? response.replay.entries.find((entry) => entry.turn?.status === "in_progress")?.turn?.id : undefined),
    offset: demand.resource === "pricing" ? offset : 0,
    limit: demand.resource === "pricing" ? limit : 0,
  });
  const { rows: _rows, spendByModel: _spendByModel, ...pricingSummary } = pricing;
  const messageIds = new Set(response.replay.entries.filter((entry) => entry.type === "message").map((entry) => entry.id));
  // Some providers expose messages without timeline entries. Keep them once,
  // in message order beside their next known timeline anchor.
  const messagesBefore = new Map<string, AppServerThreadMessageEntry[]>();
  const addedMessageIds = new Set<string>();
  let pendingMessages: AppServerThreadMessageEntry[] = [];
  for (const message of response.replay.messages) {
    if (messageIds.has(message.id)) {
      if (pendingMessages.length) messagesBefore.set(message.id, pendingMessages);
      pendingMessages = [];
    } else if (!addedMessageIds.has(message.id)) {
      pendingMessages.push({ ...message, type: "message" });
      addedMessageIds.add(message.id);
    }
  }
  const transcriptEntries = [
    ...response.replay.entries.flatMap((entry) => [...(messagesBefore.get(entry.id) ?? []), entry]),
    ...pendingMessages,
  ];
  let entries = demand.resource === "transcript" ? reconcileCompletedTurnUsageEntries({
    entries: transcriptEntries, lines: response.pricing?.lines, activeTurnId: thread?.activeTurnId,
  }) : [];
  if (demand.resource === "accounting") {
    if ((demand.turns?.length ?? 0) > 256) throw new Error("Too many display turns in one request.");
    const turns = new Map(demand.turns?.map((turn) => [turn.id, turn]));
    const lines = new Map<string, ThreadUsageLineRecord>();
    for (const line of response.pricing?.lines ?? []) {
      const turn = line.turnId ? turns.get(line.turnId) : undefined;
      if (!turn || turn.id === thread?.activeTurnId || line.scope !== "turn" || line.status === "superseded" || line.turnUsageAttributed === false
        || (line.completedAt === undefined && turn.completedAt === undefined)) continue;
      lines.set(turn.id, preferTurnUsageLine(lines.get(turn.id), line));
    }
    entries = [...lines].flatMap(([turnId, line]) => {
      const turn = turns.get(turnId)!;
      const startedAt = turn.startedAt ?? line.startedAt;
      const completedAt = line.completedAt ?? turn.completedAt;
      const entry = buildTurnUsageActivityEntryFromLine({ line, turn: {
        ...turn, startedAt, completedAt,
        status: turn.status === "failed" || turn.status === "cancelled" || turn.status === "interrupted" ? turn.status : "completed",
        durationMs: turn.durationMs ?? (startedAt !== undefined && completedAt !== undefined ? Math.max(0, completedAt - startedAt) : undefined),
      } });
      return entry ? [entry] : [];
    });
  }
  // Usage activities already contain their presentation; the attached ledger
  // record is for inspection clients and is not part of the display contract.
  entries = entries.map((entry) => {
    if (entry.type === "activity") return { ...entry, usageLine: undefined };
    if (entry.type !== "message") return entry;
    // The renderer synthesizes a text part when parts are absent. Providers
    // commonly repeat the entire message (including large pasted logs) here.
    const part = entry.parts?.[0];
    if (entry.parts?.length === 1 && part?.type === "text" && part.text === entry.text) {
      return { ...entry, parts: undefined };
    }
    return entry;
  });
  const tools = response.toolAccounting;
  const toolsPage = demand.resource === "tools" && tools
    ? { summaries: tools.summaries, alerts: tools.alerts, invocations: tools.invocations.slice(offset, offset + limit) }
    : undefined;
  const totalRows = demand.resource === "pricing" ? pricing.totalRows : demand.resource === "subagents" ? subAgents.length : tools?.invocations.length ?? 0;
  return {
    backend: response.backend,
    fetchedAt: response.fetchedAt,
    readDurationMs: response.readDurationMs,
    threadId: response.threadId,
    tokenMiserEnabled: response.tokenMiserEnabled,
    tokenMiserOverride: response.tokenMiserOverride,
    pendingRequest: response.pendingRequest,
    threadStatus: response.threadStatus,
    replay: {
      entries, messages: [],
      pagination: response.replay.pagination,
      threadStatus: response.replay.threadStatus,
      agentName: response.replay.agentName,
    },
    display: {
      pricing: pricingSummary,
      ...(demand.resource === "subagents" ? { subAgents: subAgents.slice(offset, offset + limit), subAgentCounts, subAgentLens: selectedLens } : {}),
      ...(demand.resource === "subagent" ? { subAgent: thread?.subAgents?.find((agent) => agent.monitorId === demand.monitorId) } : {}),
      ...(demand.resource === "incident" && tools ? { incident: buildThreadIncidentSummary({
        backend: response.backend, threadId: response.threadId, accounting: tools,
        usageLines: response.pricing?.lines, firstWarningAt: demand.firstWarningAt,
        largeOutputThresholdChars: demand.largeOutputThresholdChars,
      }) } : {}),
      ...(demand.resource === "pricing" ? { pricingPage: pricing } : {}),
      ...(toolsPage ? { toolsPage, toolTotals: aggregateToolAccounting(tools) } : {}),
      ...((demand.resource === "pricing" || demand.resource === "tools" || demand.resource === "subagents") && offset + limit < totalRows
        ? { nextCursor: `${revision}:${offset + limit}` } : {}),
      revision,
    },
  };
}
