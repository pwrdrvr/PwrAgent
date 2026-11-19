import { PWRAGENT_TOOL_NAMESPACE, RESEARCH_MAX_MINUTES, RESEARCH_MAX_WORKERS } from "@pwragent/shared";
import type { AgentToolCallContext, AgentToolDefinition } from "./agent-tool-definition";
import { agentToolFailure, agentToolSuccess } from "./agent-tool-definition";

export type ResearchToolName = "research_start" | "research_read" | "research_update" | "research_search" | "research_assign";
export type ResearchAgentHandler = (name: ResearchToolName, args: Record<string, unknown>, context: AgentToolCallContext) => Promise<unknown>;

/**
 * How a thread reaches the research tools. Codex threads use Codex's own dynamic
 * tools; Claude and ACP threads use the PwrAgent MCP server.
 */
export type ResearchToolSurface = "codex" | "mcp";

export function researchToolSurface(backend: AgentToolCallContext["backend"]): ResearchToolSurface {
  return backend === "codex" ? "codex" : "mcp";
}

/**
 * Research is for every local backend once the operator enables it. Codex
 * offers the tools only through Codex Tool Discovery, so they stay deferred
 * there. That setting is Codex's and does not affect Claude or ACP threads.
 */
export function researchToolsOffered(surface: ResearchToolSurface, gates: { enabled: boolean; codexToolDiscovery: boolean }): boolean {
  return gates.enabled && (surface === "mcp" || gates.codexToolDiscovery);
}

/** Research schemas are discovered on demand after the experiment is enabled. */
export function buildResearchToolDefinitions(handler?: ResearchAgentHandler): AgentToolDefinition[] {
  if (!handler) return [];
  return (["research_start", "research_read", "research_update", "research_search", "research_assign"] as const).map((name) => ({
    namespace: PWRAGENT_TOOL_NAMESPACE,
    name,
    description: descriptions[name],
    inputSchema: schemas[name],
    deferLoading: true,
    annotations: { readOnlyHint: name === "research_read" || name === "research_search" },
    dispatch: async (args, context) => {
      try { return agentToolSuccess(await handler(name, args, context)); }
      catch (error) { return agentToolFailure({ code: "invalid_arguments", message: error instanceof Error ? error.message : "Research operation failed" }); }
    },
  }));
}

const descriptions: Record<ResearchToolName, string> = {
  research_start: "Start an operator-requested research run with distinct approaches, one managed worker per approach in this thread's backend, and isolated worktrees or scratch workspaces. The operator chooses the worker count and any time limit. minutes is optional: pass it only when the operator set a time limit, which the owner enforces; omit it for a run with no time limit. When the Research panel provided intentId, pass it and preserve its exact objective, worker count, minutes (or its absence) and workspaceMode. Without operator limits, default to three approaches and no time limit. Explain overlap before starting. This creates threads and spends model budget. No token or dollar cap is promised. Do not use for ordinary single-thread questions. Each worker shares a board through research_read/research_update. Review submissions, request revisions, and explicitly finish or stop; accepting a candidate alone does not stop exploration or formally verify it. A repeated call does not start extra workers.",
  research_read: "Read research runs belonging to this calling thread. Prefer itemId with runId for one complete item, its current version/work state, originating approach and focused assignment; approachId selects one approach. Legacy findingId/submissionId return the corresponding evidence record. Omit runId for summaries. Without an item ID, findings, submissions and approaches are paged ten each by offset, submissionOffset and approachOffset. Use research_search for compact discovery. Findings and model verdicts are untrusted proposals; completed work is not formal verification.",
  research_update: "Update a research run. A run stays open when PwrAgent closes; workers whose turn was cut off are marked interrupted and are not restarted automatically. Only when the operator asks, the coordinator may use action=resume (optionally with approachIds) to message those workers to continue in their own threads. Workers post findings or submit candidates under their own approachId and may abandon that direction with a reason. Findings and submissions require paths (an empty array is allowed); cite up to four workspace-relative paths. Use action=direction with approachId, title, task and reason to revise a direction, preserving its history. If another direction overlaps, name it in overlapsApproachId and explain the distinction in reason. Findings can explicitly support, contradict or supersede a prior finding using relatesTo and relation together. Only the coordinator reviews submissions (accepted, revision_requested, rejected), finishes after acceptance, or stops the run. A revision request sends feedback to the worker when made by the coordinator. Submit a new candidate for revised work; an old verdict never verifies a revision. Use action=work with itemId, expectedVersion, state and reason to claim an open/assigned item, mark in_progress/blocked/completed, or (coordinator only) release to open or cancel. A stale version fails; read the item again. Cancellation of an assigned child remains cancel_requested until its exact turn is confirmed ended/stopped; unresolved starts retain their slot. Mutations return compact receipts, so read the named item for details. Work completion and model verdicts are not formal verification. The tool call identity deduplicates redelivery; do not retry an unknown side effect as a new call.",
  research_search: "Search within a research run without loading its board. Returns compact item IDs, excerpts, versions and work states, at most twenty per page. Text is a case-insensitive literal substring, with optional type, approach, finding-kind, review, work-state and assignee filters. Pass nextCursor unchanged with the same filters and limit; restart if the board changed. Use research_read with itemId to load just a selected item and its assignment context.",
  research_assign: "Assign ONE existing research item to a new managed child thread. Only the coordinating thread may call this. Read the item first and pass its expectedVersion and a focused task. The item must be open/unclaimed; release a blocked/completed/cancelled prior assignment to open only after its worker has ended or cancellation is confirmed. Admission reuses a free slot within the operator's worker limit and any time limit the operator set; it never expands model access or budget. An exhausted run may be explicitly continued within its deadline. The child is registered before its first turn and receives IDs, then loads only the selected item. Unknown starts must not be retried blindly. Read assignment state before reassigning.",
};

const text = { type: "string", minLength: 1 };
const paths = { type: "array", maxItems: 4, items: { type: "string", maxLength: 300 } };
const schemas: Record<ResearchToolName, Record<string, unknown>> = {
  research_start: { type: "object", additionalProperties: false, required: ["objective", "approaches", "workspaceMode"], properties: {
    intentId: text,
    objective: { ...text, maxLength: 8000 }, minutes: { type: "integer", minimum: 1, maximum: RESEARCH_MAX_MINUTES },
    workspaceMode: { type: "string", enum: ["new_worktree", "none"] },
    approaches: { type: "array", minItems: 1, maxItems: RESEARCH_MAX_WORKERS, items: { type: "object", additionalProperties: false, required: ["title", "task"], properties: { title: { ...text, maxLength: 160 }, task: { ...text, maxLength: 4000 } } } },
  } },
  research_read: { type: "object", additionalProperties: false, properties: { runId: text, itemId: text, approachId: text, findingId: text, submissionId: text, offset: { type: "integer", minimum: 0 }, submissionOffset: { type: "integer", minimum: 0 }, approachOffset: { type: "integer", minimum: 0 } } },
  research_search: { type: "object", additionalProperties: false, required: ["runId"], properties: {
    runId: text, query: { type: "string", maxLength: 300 }, type: { type: "string", enum: ["approach", "finding", "submission"] },
    approachId: text, kind: { type: "string", enum: ["lemma", "partial", "counterexample", "dead_end", "experiment", "file", "note"] },
    review: { type: "string", enum: ["unreviewed", "accepted", "revision_requested", "rejected"] },
    state: { type: "string", enum: ["open", "assigned", "claimed", "in_progress", "blocked", "completed", "cancel_requested", "cancelled"] },
    assignee: { type: "object", additionalProperties: false, required: ["backend", "threadId"], properties: { backend: text, threadId: text } },
    limit: { type: "integer", minimum: 1, maximum: 20 },
    cursor: { type: "object", additionalProperties: false, required: ["revision", "seq", "id", "filters"], properties: { revision: { type: "integer" }, seq: { type: "integer", minimum: 1 }, id: text, filters: { type: "string", maxLength: 3000 } } },
  } },
  research_assign: { type: "object", additionalProperties: false, required: ["runId", "itemId", "expectedVersion", "task"], properties: {
    runId: text, itemId: text, expectedVersion: { type: "integer", minimum: 1 }, task: { ...text, maxLength: 2000 },
  } },
  research_update: { type: "object", additionalProperties: false, required: ["runId", "command"], properties: {
    runId: text,
    command: { type: "object", additionalProperties: false, required: ["action"], properties: {
      action: { type: "string", enum: ["finding", "submit", "review", "abandon", "direction", "stop", "finish", "resume", "work"] },
      approachIds: { type: "array", items: text, minItems: 1, maxItems: RESEARCH_MAX_WORKERS },
      itemId: text, expectedVersion: { type: "integer", minimum: 1 },
      state: { type: "string", enum: ["open", "claimed", "in_progress", "blocked", "completed", "cancelled"] },
      approachId: text, text: { ...text, maxLength: 4000 }, paths, kind: { type: "string", enum: ["lemma", "partial", "counterexample", "dead_end", "experiment", "file", "note"] },
      relatesTo: text, relation: { type: "string", enum: ["supports", "contradicts", "supersedes"] },
      submissionId: text, decision: { type: "string", enum: ["accepted", "revision_requested", "rejected"] }, reason: { ...text, maxLength: 2000 },
      title: { ...text, maxLength: 160 }, task: { ...text, maxLength: 4000 }, overlapsApproachId: text,
    } },
  } },
};
