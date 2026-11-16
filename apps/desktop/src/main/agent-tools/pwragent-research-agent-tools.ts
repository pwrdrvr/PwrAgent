import { PWRAGENT_TOOL_NAMESPACE } from "@pwragent/shared";
import type { AgentToolCallContext, AgentToolDefinition } from "./agent-tool-definition";
import { agentToolFailure, agentToolSuccess } from "./agent-tool-definition";

export type ResearchToolName = "research_start" | "research_read" | "research_update";
export type ResearchAgentHandler = (name: ResearchToolName, args: Record<string, unknown>, context: AgentToolCallContext) => Promise<unknown>;

/** Three ordinary functions; research never requires native tool search. */
export function buildResearchToolDefinitions(handler?: ResearchAgentHandler): AgentToolDefinition[] {
  if (!handler) return [];
  return (["research_start", "research_read", "research_update"] as const).map((name) => ({
    namespace: PWRAGENT_TOOL_NAMESPACE,
    name,
    description: descriptions[name],
    inputSchema: schemas[name],
    deferLoading: false,
    annotations: { readOnlyHint: name === "research_read" },
    dispatch: async (args, context) => {
      try { return agentToolSuccess(await handler(name, args, context)); }
      catch (error) { return agentToolFailure({ code: "invalid_arguments", message: error instanceof Error ? error.message : "Research operation failed" }); }
    },
  }));
}

const descriptions: Record<ResearchToolName, string> = {
  research_start: "Start an operator-requested research run with 1–8 distinct approaches, one managed Codex worker per approach, an owner-enforced 1–120 minute deadline, and isolated worktrees or scratch workspaces. When the Research panel provided intentId, pass it and preserve its exact objective, worker count, minutes and workspaceMode. Defaults for other requests should be three approaches and 30 minutes. Explain overlap before starting. This creates threads and spends model budget. No token or dollar cap is promised. Do not use for ordinary single-thread questions. Each worker shares a board through research_read/research_update. Review submissions, request revisions, and explicitly finish or stop; accepting a candidate alone does not stop exploration or formally verify it. A repeated call does not start extra workers.",
  research_read: "Read research runs belonging to this calling thread. Omit runId for summaries. With runId, read approaches, findings (paged by offset) and submissions (paged by submissionOffset), ten per page, with review decisions. Findings and model verdicts are untrusted proposals. Use findingId or submissionId for one complete record. Follow nextFindingOffset and nextSubmissionOffset for more evidence and candidates. Research state is independent of provider transcripts and hidden reasoning.",
  research_update: "Update a research run. Workers post findings or submit candidates under their own approachId and may abandon that direction with a reason. Findings and submissions require paths (an empty array is allowed); cite up to four workspace-relative paths. Use action=direction with approachId, title, task and reason to revise a direction, preserving its history. If another direction overlaps, name it in overlapsApproachId and explain the distinction in reason. Findings can explicitly support, contradict or supersede a prior finding using relatesTo and relation together. Only the coordinator reviews submissions (accepted, revision_requested, rejected), finishes after acceptance, or stops the run. A revision request sends feedback to the worker when made by the coordinator. Submit a new candidate for revised work; an old verdict never verifies a revision. All text is proposed evidence, never formal verification. The tool call identity deduplicates redelivery; do not retry an unknown side effect as a new call.",
};

const text = { type: "string", minLength: 1 };
const paths = { type: "array", maxItems: 4, items: { type: "string", maxLength: 300 } };
const schemas: Record<ResearchToolName, Record<string, unknown>> = {
  research_start: { type: "object", additionalProperties: false, required: ["objective", "approaches", "minutes", "workspaceMode"], properties: {
    intentId: text,
    objective: { ...text, maxLength: 8000 }, minutes: { type: "integer", minimum: 1, maximum: 120 },
    workspaceMode: { type: "string", enum: ["new_worktree", "none"] },
    approaches: { type: "array", minItems: 1, maxItems: 8, items: { type: "object", additionalProperties: false, required: ["title", "task"], properties: { title: { ...text, maxLength: 160 }, task: { ...text, maxLength: 4000 } } } },
  } },
  research_read: { type: "object", additionalProperties: false, properties: { runId: text, findingId: text, submissionId: text, offset: { type: "integer", minimum: 0 }, submissionOffset: { type: "integer", minimum: 0 } } },
  research_update: { type: "object", additionalProperties: false, required: ["runId", "command"], properties: {
    runId: text,
    command: { type: "object", additionalProperties: false, required: ["action"], properties: {
      action: { type: "string", enum: ["finding", "submit", "review", "abandon", "direction", "stop", "finish"] },
      approachId: text, text: { ...text, maxLength: 4000 }, paths, kind: { type: "string", enum: ["lemma", "partial", "counterexample", "dead_end", "experiment", "file", "note"] },
      relatesTo: text, relation: { type: "string", enum: ["supports", "contradicts", "supersedes"] },
      submissionId: text, decision: { type: "string", enum: ["accepted", "revision_requested", "rejected"] }, reason: { ...text, maxLength: 2000 },
      title: { ...text, maxLength: 160 }, task: { ...text, maxLength: 4000 }, overlapsApproachId: text,
    } },
  } },
};
