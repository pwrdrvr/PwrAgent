import type { ThreadExecutionMode } from "./contracts/normalized-app-server";

const AGENT_MESSAGE_ACCESS_REFUSAL_PREFIX =
  "Blocked by the operator's setting";

/**
 * What an agent hears when `general.block_agent_messages_to_higher_access`
 * stops its message. The target would act on the text with more access than
 * the sender has, so the agent is pointed at a to-do card instead: the
 * operator can read it and start the work at the access they choose.
 */
export function agentMessageAccessRefusalMessage(params: {
  senderExecutionMode: ThreadExecutionMode;
  targetExecutionMode: ThreadExecutionMode;
}): string {
  return `${AGENT_MESSAGE_ACCESS_REFUSAL_PREFIX} that blocks agent messages to threads with higher access: this thread runs with ${formatAccess(params.senderExecutionMode)} and the target runs with ${formatAccess(params.targetExecutionMode)}. The message was not sent. Raise a to-do card with add_todo instead, so the operator can decide.`;
}

/**
 * Whether an error message is an agent-message access refusal. The refusal
 * crosses federation as text, so the sender classifies it by its prefix.
 */
export function isAgentMessageAccessRefusal(message: string): boolean {
  return message.includes(AGENT_MESSAGE_ACCESS_REFUSAL_PREFIX);
}

function formatAccess(mode: ThreadExecutionMode): string {
  return mode === "full-access"
    ? "Full Access"
    : mode === "auto"
      ? "Auto access"
      : "Default Access";
}
