import { randomUUID } from "node:crypto";
import type { CanUseTool, PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import type { AppServerPendingRequestNotification, ThreadExecutionMode } from "@pwragent/shared";
import { CLAUDE_ARTIFACT_TOOLS } from "./claude-tool-activity";

export function claudePermissionMode(mode: ThreadExecutionMode): PermissionMode {
  switch (mode) {
    case "default": return "default";
    case "auto": return "auto";
    case "full-access": return "bypassPermissions";
  }
}

/** Claude's request to leave plan mode, whose input carries the plan. */
export const CLAUDE_EXIT_PLAN_TOOL = "ExitPlanMode";

/**
 * A plan turn ends with the plan, as Codex's does: the operator reads it and
 * replies to implement it. The transcript shows the plan, so the request to
 * leave plan mode is answered here instead of becoming an approval card.
 */
const CLAUDE_PLAN_HANDOFF = "The operator has your plan and will reply when it should be implemented. "
  + "Stay in plan mode and end your turn now.";

/**
 * The input a card shows. Claude Code adds its own `__`-prefixed fields to
 * some calls, such as an artifact publish's consent and source pin. They are
 * returned to the CLI unchanged, never shown.
 */
function displayInput(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([key]) => !key.startsWith("__")));
}

/**
 * What an approval card says. Claude Code writes its own question for an
 * artifact request (a publish to claude.ai, a public share, a delete), so
 * the card asks that instead of showing the call's input as a command.
 */
function claudeApprovalText(
  toolName: string, input: Record<string, unknown>, context: Parameters<CanUseTool>[2],
): { command?: string; prompt?: string; reason: string } {
  const reason = context.decisionReason ?? `Claude requests permission to use ${toolName}.`;
  if (CLAUDE_ARTIFACT_TOOLS.has(toolName)) {
    const question = context.decisionReason ?? context.description ?? context.title
      ?? `Claude requests permission to use ${toolName}.`;
    return { prompt: question, reason: question };
  }
  return {
    command: toolName === "Bash" ? String(input.command ?? "") : `${toolName}: ${JSON.stringify(displayInput(input))}`,
    reason,
  };
}

export function createClaudePermissionHandler(options: {
  threadId: string;
  /**
   * A live session outlives its desktop turn, and a background task can ask
   * between turns, so the turn is read when the request is made.
   */
  turnId: () => string;
  /**
   * Whether the operator asked for this turn to plan. Claude can also enter
   * plan mode on its own, and then leaving it needs the operator's approval.
   */
  planTurn?: () => boolean;
  request: (request: AppServerPendingRequestNotification, signal: AbortSignal) => Promise<unknown>;
  cancelRequest: (requestId: string, turnId: string) => Promise<void>;
}): CanUseTool {
  return async (toolName, input, context) => {
    if (context.signal.aborted) return { behavior: "deny", message: "Turn cancelled.", interrupt: true };
    if (toolName === CLAUDE_EXIT_PLAN_TOOL && options.planTurn?.()) return { behavior: "deny", message: CLAUDE_PLAN_HANDOFF };
    const requestId = randomUUID();
    const turnId = options.turnId();
    const request: AppServerPendingRequestNotification = toolName === "AskUserQuestion"
      ? {
          method: "item/tool/requestUserInput",
          params: {
            threadId: options.threadId,
            turnId,
            requestId,
            questions: Array.isArray(input.questions) ? input.questions.map((value, index) => {
              const question = value as Record<string, unknown>;
              return {
                id: String(index),
                header: String(question.header ?? "Claude"),
                question: String(question.question ?? ""),
                isOther: true,
                isSecret: false,
                options: question.options ?? null,
              };
            }) : [],
          },
        }
      : {
          method: "item/commandExecution/requestApproval",
          params: {
            threadId: options.threadId,
            turnId,
            requestId,
            itemId: context.toolUseID,
            toolName,
            arguments: displayInput(input),
            ...claudeApprovalText(toolName, input, context),
            availableDecisions: ["accept", "decline", "cancel"],
          },
        };
    let abort: (() => void) | undefined;
    try {
      const response = await Promise.race([
        options.request(request, context.signal),
        new Promise<undefined>((resolve) => {
          abort = () => {
            void options.cancelRequest(requestId, turnId).then(() => resolve(undefined), () => resolve(undefined));
          };
          context.signal.addEventListener("abort", abort, { once: true });
          if (context.signal.aborted) abort();
        }),
      ]);
      if (context.signal.aborted) return { behavior: "deny", message: "Turn cancelled.", interrupt: true };
      if (!response || typeof response !== "object") {
        return { behavior: "deny", message: "Permission was not granted." };
      }
      if (toolName === "AskUserQuestion" && "answers" in response
        && response.answers && typeof response.answers === "object") {
        const answers: Record<string, string> = {};
        for (const [index, value] of Object.entries(response.answers)) {
          const question = Array.isArray(input.questions) ? input.questions[Number(index)] : undefined;
          if (question && typeof question === "object" && "question" in question
            && value && typeof value === "object" && "answers" in value && Array.isArray(value.answers)) {
            answers[String(question.question)] = value.answers.map(String).join(", ");
          }
        }
        if (Object.keys(answers).length) return { behavior: "allow", updatedInput: { ...input, answers } };
      }
      const decision = "decision" in response ? response.decision : undefined;
      // Only explicitly offered one-shot approval can authorize execution.
      // Never turn a generic UI response into a saved CLI permission rule.
      if (decision === "accept" || decision === "approve") {
        return { behavior: "allow", updatedInput: input };
      }
      return { behavior: "deny", message: "Permission denied by the operator.", interrupt: decision === "cancel" };
    } finally {
      if (abort) context.signal.removeEventListener("abort", abort);
    }
  };
}
