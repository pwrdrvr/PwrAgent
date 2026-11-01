import type { ForgeApprovalRememberOptionId, SubmitServerRequestRequest } from "@pwragent/shared";
import {
  buildPendingRequestActions,
  buildPendingRequestResponse,
} from "@pwragent/shared";
import {
  buildMcpElicitationResponse,
  readMcpApprovalPersistence,
  readMcpRememberOptions,
  type McpApprovalPersistence,
} from "../thread-detail/mcp-elicitation";
import type { OperatorWait } from "./operator-waits";

/**
 * Shown when an answer was taken but a fresh read of the owner queue still
 * lists the request. The answers come back, so the operator is not stuck.
 */
export const APPROVAL_STILL_OPEN_MESSAGE = "Answer sent, but the request is still open.";

/** One answer an approval takes outside its thread's card. */
export type ApprovalChoice = {
  id: string;
  label: string;
  /** Whether the answer lets the work go ahead, refuses it, or ends the turn. */
  effect: "allow" | "decline" | "cancel";
  /** Shown while the answer is in flight. */
  busyLabel: string;
  /** Built on use, so a malformed request fails where the answer is sent. */
  buildResponse: () => SubmitServerRequestRequest["response"];
};

export type ApprovalChoices = {
  /**
   * The plain yes. Absent when consent belongs on the card, as for an MCP
   * link, whose full address shows there before anything opens.
   */
  accept?: ApprovalChoice;
  decline?: ApprovalChoice;
  /** The other answers in the order the request offers them. */
  alternatives: ApprovalChoice[];
};

/**
 * The answers an approval wait takes from a row or a notice. Undefined for
 * every other wait kind, which needs its card's inputs.
 */
export function approvalChoices(wait: OperatorWait): ApprovalChoices | undefined {
  if (wait.kind === "mcp-approval") return mcpApprovalChoices(wait);
  // A link request asks consent before anything opens, as an approval does.
  if (wait.kind === "mcp-input" && wait.mcp?.mode === "url") return mcpApprovalChoices(wait);
  if (wait.kind === "approval") return pendingApprovalChoices(wait);
  return undefined;
}

function mcpApprovalChoices(wait: OperatorWait): ApprovalChoices | undefined {
  const mcp = wait.mcp;
  if (!mcp) return undefined;
  const choice = (
    id: string,
    label: string,
    busyLabel: string,
    action: "accept" | "decline" | "cancel",
    persist?: McpApprovalPersistence,
    remember?: ForgeApprovalRememberOptionId,
  ): ApprovalChoice => ({
    id,
    label,
    effect: action === "accept" ? "allow" : action,
    busyLabel,
    buildResponse: () => buildMcpElicitationResponse(mcp, action, persist, remember),
  });
  const decline = choice("decline", "Decline", "Declining…", "decline");
  if (mcp.url) return { decline, alternatives: [] };
  const persistence = readMcpApprovalPersistence(mcp);
  const alternatives: ApprovalChoice[] = [];
  if (persistence.includes("server-session")) {
    alternatives.push(choice(
      "server-session",
      `Allow ${mcp.serverName} for this conversation`,
      "Allowing…",
      "accept",
      "server-session",
    ));
  }
  if (persistence.includes("session")) {
    alternatives.push(choice(
      "session",
      mcp._meta?.pwragent_approval_kind === "mcp_tool_call"
        ? "Allow this tool for this conversation" : "Allow this conversation",
      "Allowing…",
      "accept",
      "session",
    ));
  }
  if (persistence.includes("always")) {
    alternatives.push(choice("always", "Always allow", "Allowing…", "accept", "always"));
  }
  // A forge approval can save the answer as a project rule, as its card can.
  for (const option of readMcpRememberOptions(mcp)) {
    alternatives.push(choice(
      `remember:${option.id}`,
      option.label,
      "Allowing…",
      "accept",
      undefined,
      option.id,
    ));
  }
  alternatives.push(choice("cancel", "Cancel turn", "Cancelling…", "cancel"));
  return {
    accept: choice("accept", "Allow", "Allowing…", "accept"),
    decline,
    alternatives,
  };
}

function pendingApprovalChoices(wait: OperatorWait): ApprovalChoices | undefined {
  const request = wait.request;
  if (!request) return undefined;
  const actions = buildPendingRequestActions(request);
  const primary = actions.find((action) => action.style === "primary")
    ?? actions.find((action) => action.decision === "accept");
  if (!primary) return undefined;
  const decline = actions.find((action) => action.decision === "decline");
  const choice = (action: (typeof actions)[number]): ApprovalChoice => ({
    id: action.id,
    label: action.label,
    effect: action.decision === "decline" || action.decision === "cancel"
      ? action.decision
      : "allow",
    busyLabel: action.decision === "decline"
      ? "Declining…"
      : action.decision === "cancel"
        ? "Cancelling…"
        : "Approving…",
    buildResponse: () => buildPendingRequestResponse(request, action),
  });
  return {
    accept: choice(primary),
    ...(decline ? { decline: choice(decline) } : {}),
    alternatives: actions
      .filter((action) => action !== primary && action !== decline)
      .map(choice),
  };
}
