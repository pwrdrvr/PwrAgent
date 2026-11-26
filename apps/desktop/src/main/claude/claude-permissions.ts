import { randomUUID } from "node:crypto";
import type { CanUseTool, Options, PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { PWRAGENT_TOOL_NAMESPACE } from "@pwragent/shared/contracts/agent-tools";
import {
  type AppServerPendingRequestNotification,
  type ThreadExecutionMode,
} from "@pwragent/shared/contracts/normalized-app-server";
import { FORGE_PR_TOOL_OPERATIONS, FORGE_PR_WRITE_OPERATIONS } from "../pr-status/forge-pr-tool-contract";
import { FORGE_READ_OPERATIONS } from "../pr-status/forge-tool-contract";
import { formatConversationGrantLabel } from "../acp/acp-mcp-permission";
import {
  formatRedactedToolArguments,
  redactSecretStringValue,
  redactToolArgumentsForDisplay,
} from "../util/redact-mcp-tool-args";
import { CLAUDE_ARTIFACT_TOOLS } from "./claude-tool-activity";

/** PwrAgent's MCP gateway invocation tool, as Claude names it. */
export const CLAUDE_MCP_GATEWAY_TOOL = `mcp__${PWRAGENT_TOOL_NAMESPACE}__call_mcp_tool`;

/**
 * PwrAgent's forge tools, as Claude names them: the CI reads, the pull
 * request and issue reads, and every write, merging included.
 */
export const CLAUDE_FORGE_TOOLS: readonly string[] = [...FORGE_READ_OPERATIONS, ...FORGE_PR_TOOL_OPERATIONS]
  .map(claudePwragentToolName);

/** The forge tools that change the forge, as Claude names them, to their operations. */
const CLAUDE_FORGE_WRITE_OPERATIONS: ReadonlyMap<string, string> = new Map(FORGE_PR_WRITE_OPERATIONS
  .map((operation) => [claudePwragentToolName(operation), operation]));

function claudePwragentToolName(operation: string): string {
  return `mcp__${PWRAGENT_TOOL_NAMESPACE}__${operation}`;
}

/**
 * Tools Claude runs without asking, because PwrAgent decides them itself.
 *
 * A gateway call gets PwrAgent's own card when it needs one. That card knows
 * the upstream tool, the connection's Tool approval setting, the
 * conversation's earlier approvals and automation allowlists. Claude's card
 * would only name `call_mcp_tool`, and accepting it led to the gateway card.
 *
 * A forge tool follows `[git.agent_tools]` on every call: the group's level,
 * the repository's project rules and the turn's mode. Allow runs, Off is
 * refused by name, and Ask, or Auto outside the modes that run it, gets
 * PwrAgent's card. Outside plan turns, Approve and merge keeps that card
 * unless the turn has Full Access. Claude's card came first and named only
 * the tool, so a write asked twice and an Allow group still asked. The list
 * is fixed, not read from the policy, so a Settings change applies to the
 * next call without relaunching the process, and an Off tool stays unadvertised.
 *
 * The rules name exact tools on PwrAgent's own server, so they are set only
 * when that server is attached. Claude still applies the operator's own
 * `ask` and `deny` rules for these tools. Its plan mode still asks for a
 * forge write and for any gateway call. A plan turn refuses the forge write
 * without a card and passes a verified host gateway call to the gateway,
 * which refuses an upstream tool that is not read-only. An explicit ask
 * rule still gets Claude's card.
 */
export function claudeAllowedTools(mcpServers: Options["mcpServers"]): string[] {
  return mcpServers && Object.hasOwn(mcpServers, PWRAGENT_TOOL_NAMESPACE)
    ? [CLAUDE_MCP_GATEWAY_TOOL, ...CLAUDE_FORGE_TOOLS]
    : [];
}

export function claudePermissionMode(mode: ThreadExecutionMode): PermissionMode {
  switch (mode) {
    case "default": return "default";
    case "auto": return "auto";
    case "full-access": return "bypassPermissions";
  }
}

/**
 * The PwrAgent approval mode a Claude permission mode runs under. Plan,
 * accept-edits and don't-ask still stop for anything not already allowed, so
 * they count as Default Access.
 */
export function threadExecutionModeForClaudePermission(mode: PermissionMode): ThreadExecutionMode {
  switch (mode) {
    case "bypassPermissions": return "full-access";
    case "auto": return "auto";
    default: return "default";
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
 * A plan turn is read-only, so a call that would change something is refused
 * without a card. Claude's plan mode still asks for an allowed tool that is
 * not read-only, and accepting that card led to PwrAgent's own card for the
 * same call. A forge write is refused here. A gateway call is refused by the
 * gateway, which knows whether the upstream tool is read-only. The forge
 * reads are read-only tools, which plan mode runs without asking.
 */
export function claudePlanTurnRefusal(action: string): string {
  return `This is a plan turn, which is read-only, so PwrAgent did not run ${action}. `
    + "Put this step in your plan. The operator will reply when the plan should be implemented.";
}

/**
 * The input a card shows. Claude Code adds its own `__`-prefixed fields to an
 * artifact call, such as a publish's consent and source pin. They are
 * returned to the CLI unchanged, never shown. Another tool's input is shown
 * whole: its `__` fields are arguments the call sends.
 */
function displayInput(toolName: string, input: Record<string, unknown>): Record<string, unknown> {
  if (!CLAUDE_ARTIFACT_TOOLS.has(toolName)) return input;
  return Object.fromEntries(Object.entries(input).filter(([key]) => !key.startsWith("__")));
}

type ClaudeMcpToolApproval = {
  acpMcpToolName: string;
  acpMcpToolDetail?: string;
  prompt: string;
  reason: string;
  grantKey?: string;
  grantLabel?: string;
};

function inspectClaudeMcpToolApproval(
  toolName: string,
  input: Record<string, unknown>,
  context: Parameters<CanUseTool>[2],
  allowConversationGrant: boolean,
): ClaudeMcpToolApproval | undefined {
  const match = /^mcp__(.+?)__(.+)$/u.exec(toolName);
  if (!match?.[1] || !match[2]) {
    return undefined;
  }
  const serverName = match[1];
  const innerTool = match[2];
  const isVerifiedPwrAgent =
    context.mcpServer?.source === "sdk" && context.mcpServer.name === PWRAGENT_TOOL_NAMESPACE;

  if (toolName === CLAUDE_MCP_GATEWAY_TOOL) {
    const targetTool =
      isVerifiedPwrAgent && typeof input.toolName === "string" && input.toolName.trim()
        ? input.toolName.trim()
        : undefined;
    const connectionId =
      isVerifiedPwrAgent && typeof input.connectionId === "string" && input.connectionId.trim()
        ? input.connectionId.trim()
        : undefined;
    const acpMcpToolName = targetTool
      ? (connectionId ? `${connectionId} / ${targetTool}` : targetTool)
      : toolName;
    const defaultPrompt = targetTool
      ? (connectionId
          ? `Claude wants to use the MCP tool ${targetTool} on ${connectionId}.`
          : `Claude wants to use the MCP tool ${targetTool}.`)
      : `Claude requests permission to use ${toolName}.`;
    const prompt = context.decisionReason ? redactSecretStringValue(context.decisionReason) : defaultPrompt;
    const detailSource = targetTool ? input.arguments : displayInput(toolName, input);
    // Never offer a conversation grant on `call_mcp_tool`: the MCP gateway
    // owns per-upstream-tool and per-server conversation grants.
    return {
      acpMcpToolName,
      ...(formatRedactedToolArguments(detailSource) ? { acpMcpToolDetail: formatRedactedToolArguments(detailSource) } : {}),
      prompt,
      reason: prompt,
    };
  }

  const isPwrAgentTool =
    serverName === PWRAGENT_TOOL_NAMESPACE && (!context.mcpServer || isVerifiedPwrAgent);
  const isUntrustedPwrAgentNamesake =
    serverName === PWRAGENT_TOOL_NAMESPACE && Boolean(context.mcpServer) && !isVerifiedPwrAgent;
  const acpMcpToolName = isUntrustedPwrAgentNamesake
    ? toolName
    : isPwrAgentTool
      ? innerTool
      : `${serverName} / ${innerTool}`;
  const defaultPrompt = isUntrustedPwrAgentNamesake
    ? `Claude requests permission to use ${toolName}.`
    : isPwrAgentTool
      ? `Claude wants to use the PwrAgent tool ${innerTool}.`
      : `Claude wants to use the MCP tool ${innerTool} on ${serverName}.`;
  const prompt = context.decisionReason ? redactSecretStringValue(context.decisionReason) : defaultPrompt;
  const detail = formatRedactedToolArguments(displayInput(toolName, input));
  const grantKey = allowConversationGrant && !isUntrustedPwrAgentNamesake
    ? JSON.stringify([context.mcpServer?.source ?? "", context.mcpServer?.name ?? "", toolName])
    : undefined;
  return {
    acpMcpToolName,
    ...(detail ? { acpMcpToolDetail: detail } : {}),
    prompt,
    reason: prompt,
    ...(grantKey ? { grantKey, grantLabel: formatConversationGrantLabel(innerTool) } : {}),
  };
}

/**
 * What an approval card says. Claude Code writes its own question for an
 * artifact request (a publish to claude.ai, a public share, a delete), so
 * the card asks that instead of showing the call's input as a command. An
 * artifact request without one shows its input, as any other tool's does.
 */
function claudeApprovalText(
  toolName: string, input: Record<string, unknown>, context: Parameters<CanUseTool>[2],
): { command?: string; prompt?: string; reason: string } {
  const question = CLAUDE_ARTIFACT_TOOLS.has(toolName)
    ? context.decisionReason ?? context.description ?? context.title
    : undefined;
  if (question) return { prompt: question, reason: question };
  const redactedInput = redactToolArgumentsForDisplay(displayInput(toolName, input));
  return {
    command: toolName === "Bash"
      ? String(input.command ?? "")
      : `${toolName}: ${JSON.stringify(redactedInput)}`,
    reason: context.decisionReason ?? `Claude requests permission to use ${toolName}.`,
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
   * This handler refuses forge writes and hands gateway calls to the gateway
   * in a plan turn before showing a card. Both gates also check the live
   * process's permission mode.
   */
  planTurn?: () => boolean;
  request: (request: AppServerPendingRequestNotification, signal: AbortSignal) => Promise<unknown>;
  cancelRequest: (requestId: string, turnId: string) => Promise<void>;
}): CanUseTool {
  // In-memory conversation-scoped MCP tool grants. Never written to Claude CLI
  // permission rules, and bypassed whenever a plan turn or operator ask rule applies.
  const sessionMcpGrants = new Set<string>();
  return async (toolName, input, context) => {
    if (context.signal.aborted) return { behavior: "deny", message: "Turn cancelled.", interrupt: true };
    if (toolName === CLAUDE_EXIT_PLAN_TOOL && options.planTurn?.()) return { behavior: "deny", message: CLAUDE_PLAN_HANDOFF };
    const forgeWrite = CLAUDE_FORGE_WRITE_OPERATIONS.get(toolName);
    if (forgeWrite && options.planTurn?.()) return { behavior: "deny", message: claudePlanTurnRefusal(forgeWrite) };
    // Only our host-registered gateway checks whether the upstream tool reads
    // or writes. A configured namesake is untrusted, and an operator ask rule
    // still requires a human decision even for our own gateway.
    if (toolName === CLAUDE_MCP_GATEWAY_TOOL && options.planTurn?.()
      && context.mcpServer?.source === "sdk" && context.mcpServer.name === PWRAGENT_TOOL_NAMESPACE
      && !context.matchedAskRule) return { behavior: "allow", updatedInput: input };
    const allowConversationGrant = !options.planTurn?.() && !context.matchedAskRule;
    const mcpApproval = inspectClaudeMcpToolApproval(toolName, input, context, allowConversationGrant);
    if (mcpApproval?.grantKey && sessionMcpGrants.has(mcpApproval.grantKey)) {
      return { behavior: "allow", updatedInput: input };
    }
    const requestId = randomUUID();
    const turnId = options.turnId();
    const redactedArguments = redactToolArgumentsForDisplay(displayInput(toolName, input));
    const availableDecisions: unknown[] = mcpApproval?.grantKey
      ? [
          "accept",
          { decision: "accept_for_session", label: mcpApproval.grantLabel ?? "Allow for this conversation" },
          "decline",
          "cancel",
        ]
      : ["accept", "decline", "cancel"];
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
                ...(question.multiSelect === true ? { multiSelect: true } : {}),
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
            arguments: redactedArguments,
            ...(mcpApproval
              ? {
                  acpMcpToolName: mcpApproval.acpMcpToolName,
                  ...(mcpApproval.acpMcpToolDetail ? { acpMcpToolDetail: mcpApproval.acpMcpToolDetail } : {}),
                  prompt: mcpApproval.prompt,
                  reason: mcpApproval.reason,
                }
              : claudeApprovalText(toolName, input, context)),
            availableDecisions,
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
      // Only explicitly offered approval can authorize execution.
      // Never turn a generic UI response into a saved CLI permission rule.
      if (mcpApproval?.grantKey && decision === "accept_for_session") {
        sessionMcpGrants.add(mcpApproval.grantKey);
        return { behavior: "allow", updatedInput: input };
      }
      if (decision === "accept" || decision === "approve") {
        return { behavior: "allow", updatedInput: input };
      }
      return { behavior: "deny", message: "Permission denied by the operator.", interrupt: decision === "cancel" };
    } finally {
      if (abort) context.signal.removeEventListener("abort", abort);
    }
  };
}
