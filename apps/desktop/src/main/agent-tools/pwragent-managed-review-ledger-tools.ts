import { PWRAGENT_TOOL_NAMESPACE } from "@pwragent/shared/contracts/agent-tools";
import {
  MANAGED_REVIEW_CANDIDATE_CATEGORIES,
  MANAGED_REVIEW_OUTPUT_MAX_FINDINGS,
  type ManagedReviewCandidateLedger,
  type ManagedReviewCandidateTurnKey,
} from "../app-server/managed-review-candidate-ledger.js";
import {
  agentToolFailure,
  agentToolSuccess,
  type AgentToolCallContext,
  type AgentToolDefinition,
} from "./agent-tool-definition.js";
import { AgentToolRouter } from "./agent-tool-router.js";

export const MANAGED_REVIEW_LEDGER_TOOL_NAMES = [
  "record_review_candidate",
  "list_review_candidates",
  "dispose_review_candidate",
  "submit_review_output",
] as const;

export type ManagedReviewLedgerToolName =
  (typeof MANAGED_REVIEW_LEDGER_TOOL_NAMES)[number];

const MANAGED_REVIEW_LEDGER_TOOL_NAME_SET: ReadonlySet<string> = new Set(
  MANAGED_REVIEW_LEDGER_TOOL_NAMES,
);

export function isManagedReviewLedgerToolName(
  name: string,
): name is ManagedReviewLedgerToolName {
  return MANAGED_REVIEW_LEDGER_TOOL_NAME_SET.has(name);
}

function resolveTurnKey(
  context: AgentToolCallContext,
  ledger: ManagedReviewCandidateLedger,
): ManagedReviewCandidateTurnKey | undefined {
  const turnId = context.turnId?.trim();
  if (!turnId) {
    return undefined;
  }
  const turn = {
    backend: context.backend,
    threadId: context.threadId,
    turnId,
  };
  // MCP authorization awaits other work before it dispatches. Recheck
  // ownership here, synchronously with the read or mutation.
  return ledger.hasToolTurn(turn) ? turn : undefined;
}

export function buildManagedReviewLedgerToolDefinitions(
  ledger: ManagedReviewCandidateLedger,
): AgentToolDefinition<ManagedReviewLedgerToolName>[] {
  return [
    {
      namespace: PWRAGENT_TOOL_NAMESPACE,
      name: "record_review_candidate",
      description:
        "Record a concrete candidate defect immediately during Pass 1 of a code review so it is preserved for Pass 2 triage.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          file: {
            type: "string",
            description: "Absolute or repository-relative path to the affected file.",
          },
          start_line: {
            type: "integer",
            minimum: 1,
            description: "First affected 1-based line number.",
          },
          end_line: {
            type: "integer",
            minimum: 1,
            description: "Last affected 1-based line number (>= start_line).",
          },
          category: {
            type: "string",
            enum: [...MANAGED_REVIEW_CANDIDATE_CATEGORIES],
            description: "Defect category for Pass 2 grouping.",
          },
          summary: {
            type: "string",
            description: "Short imperative title of the defect.",
          },
          mechanism: {
            type: "string",
            description: "Concrete observable consequence and code mechanism observed.",
          },
        },
        required: [
          "file",
          "start_line",
          "end_line",
          "category",
          "summary",
          "mechanism",
        ],
      },
      dispatch: (args, context) => {
        const turnKey = resolveTurnKey(context, ledger);
        if (!turnKey) {
          return agentToolFailure({
            code: "forbidden",
            message: "Review candidate tools require an active review turn.",
          });
        }
        const result = ledger.record(turnKey, {
          file: args.file,
          start_line: args.start_line,
          end_line: args.end_line,
          category: args.category,
          summary: args.summary,
          mechanism: args.mechanism,
        });
        return result.ok
          ? agentToolSuccess(result.data)
          : agentToolFailure({ code: result.code, message: result.message });
      },
    },
    {
      namespace: PWRAGENT_TOOL_NAMESPACE,
      name: "list_review_candidates",
      description:
        "List every candidate defect recorded during this review turn with its current disposition before Pass 2 triage.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
      dispatch: (_args, context) => {
        const turnKey = resolveTurnKey(context, ledger);
        if (!turnKey) {
          return agentToolFailure({
            code: "forbidden",
            message: "Review candidate tools require an active review turn.",
          });
        }
        return agentToolSuccess(ledger.list(turnKey));
      },
    },
    {
      namespace: PWRAGENT_TOOL_NAMESPACE,
      name: "dispose_review_candidate",
      description:
        "Mark a recorded review candidate as keep (with calibrated P0-P3 priority) or drop (with concrete code-grounded justification) during Pass 2 triage.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: {
            type: "string",
            description: 'Candidate ID returned by record_review_candidate (for example, "C1").',
          },
          disposition: {
            type: "string",
            enum: ["keep", "drop"],
            description: "Whether to keep the defect in the final JSON or drop it.",
          },
          priority: {
            type: "integer",
            minimum: 0,
            maximum: 3,
            description: 'Required when disposition is "keep": 0 (P0) to 3 (P3).',
          },
          category: {
            type: "string",
            enum: [...MANAGED_REVIEW_CANDIDATE_CATEGORIES],
            description: "Optional updated defect category.",
          },
          reason: {
            type: "string",
            description: "Concise code-grounded reason for keeping or dropping this candidate.",
          },
        },
        required: ["id", "disposition", "reason"],
      },
      dispatch: (args, context) => {
        const turnKey = resolveTurnKey(context, ledger);
        if (!turnKey) {
          return agentToolFailure({
            code: "forbidden",
            message: "Review candidate tools require an active review turn.",
          });
        }
        const result = ledger.dispose(turnKey, {
          id: args.id,
          disposition: args.disposition,
          priority: args.priority,
          category: args.category,
          reason: args.reason,
        });
        return result.ok
          ? agentToolSuccess(result.data)
          : agentToolFailure({ code: result.code, message: result.message });
      },
    },
    {
      namespace: PWRAGENT_TOOL_NAMESPACE,
      name: "submit_review_output",
      description:
        "Submit the final structured code review verdict and findings at the end of Pass 2 so PwrAgent records them directly without parsing free-text JSON.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          findings: {
            type: "array",
            maxItems: MANAGED_REVIEW_OUTPUT_MAX_FINDINGS,
            description: "Ordered list of concrete findings to report (empty array when no actionable defects remain).",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                title: {
                  type: "string",
                  description: "Short finding title without a redundant [P0]-[P3] prefix.",
                },
                body: {
                  type: "string",
                  description: "Markdown explanation leading with the observable consequence, code mechanism, and specific fix.",
                },
                confidence_score: {
                  type: "number",
                  minimum: 0,
                  maximum: 1,
                  description: "Certainty from 0 to 1 that the issue is real and verified in the code.",
                },
                priority: {
                  type: "integer",
                  minimum: 0,
                  maximum: 3,
                  description: "Calibrated priority: 0 (P0) critical to 3 (P3) low-impact.",
                },
                category: {
                  type: "string",
                  description: "Optional short single-line defect category.",
                },
                code_location: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    absolute_file_path: {
                      type: "string",
                      description: "Absolute path to the affected file.",
                    },
                    line_range: {
                      type: "object",
                      additionalProperties: false,
                      properties: {
                        start: {
                          type: "integer",
                          minimum: 1,
                          description: "First affected 1-based line number.",
                        },
                        end: {
                          type: "integer",
                          minimum: 1,
                          description: "Last affected 1-based line number (>= start).",
                        },
                      },
                      required: ["start", "end"],
                    },
                  },
                  required: ["absolute_file_path", "line_range"],
                },
              },
              required: [
                "title",
                "body",
                "confidence_score",
                "priority",
                "code_location",
              ],
            },
          },
          overall_correctness: {
            type: "string",
            enum: ["patch is correct", "patch is incorrect"],
            description: 'Must be "patch is correct" when no actionable defects remain, or "patch is incorrect" otherwise.',
          },
          overall_explanation: {
            type: "string",
            description: "Concise summary of the review verdict.",
          },
          overall_confidence_score: {
            type: "number",
            minimum: 0,
            maximum: 1,
            description: "Optional confidence from 0 to 1 that overall_correctness is the right verdict.",
          },
        },
        required: [
          "findings",
          "overall_correctness",
          "overall_explanation",
        ],
      },
      dispatch: (args, context) => {
        const turnKey = resolveTurnKey(context, ledger);
        if (!turnKey) {
          return agentToolFailure({
            code: "forbidden",
            message: "Review candidate tools require an active review turn.",
          });
        }
        const result = ledger.submitOutput(turnKey, {
          findings: args.findings,
          overall_correctness: args.overall_correctness,
          overall_explanation: args.overall_explanation,
          overall_confidence_score: args.overall_confidence_score,
        });
        return result.ok
          ? agentToolSuccess(result.data)
          : agentToolFailure({ code: result.code, message: result.message });
      },
    },
  ];
}

export function buildManagedReviewLedgerToolRouter(
  ledger: ManagedReviewCandidateLedger,
): AgentToolRouter {
  return new AgentToolRouter(buildManagedReviewLedgerToolDefinitions(ledger), {
    unsupportedMessage: "Unsupported PwrAgent managed review tool.",
  });
}
