import {
  isThreadExecutionMode,
  threadExecutionModeExceeds,
  threadExecutionModeForRawPermissions,
  type ThreadExecutionMode,
} from "@pwragent/shared";

const EXECUTION_MODE_LABELS: Record<ThreadExecutionMode, string> = {
  default: "Default Access",
  auto: "Auto",
  "full-access": "Full Access",
};

export type AgentAccessRequest = {
  executionMode?: string;
  approvalPolicy?: string;
  sandbox?: string;
};

/**
 * "caller": the calling thread, which the agent may not exceed anywhere.
 * "target": the thread a message's turn runs in. A per-turn override is not
 * persisted or shown, so it may keep or lower that thread's mode, never
 * raise it; raising a thread's stored mode stays with mutate_thread.
 */
export type AgentAccessCeiling = "caller" | "target";

export type AgentAccessRefusal = {
  code: "invalid_arguments" | "forbidden";
  message: string;
};

/**
 * An agent tool may keep or lower access, never raise it above the calling
 * thread's own mode. Only the operator raises access: the desktop routes it
 * through the "Enable Full Access?" gate and messaging through RBAC. Agent
 * tools have no such gate, so every tool that can choose a thread's access
 * checks here first. Raw `approvalPolicy` / `sandbox` overrides count too,
 * since they can reach Full Access without naming `executionMode`.
 *
 * Returns why the request is refused, or undefined when it is allowed. An
 * omitted field asks for nothing and is always allowed.
 */
export function checkAgentAccessRequest(
  callerMode: ThreadExecutionMode,
  request: AgentAccessRequest,
  /** Whose mode is the ceiling. The calling thread unless named. */
  ceiling: AgentAccessCeiling = "caller",
): AgentAccessRefusal | undefined {
  const { executionMode, approvalPolicy, sandbox } = request;
  if (executionMode !== undefined && !isThreadExecutionMode(executionMode)) {
    return {
      code: "invalid_arguments",
      message: "executionMode must be default, auto, or full-access when provided.",
    };
  }
  if (
    executionMode !== undefined
    && threadExecutionModeExceeds(executionMode, callerMode)
  ) {
    return escalationRefusal(`executionMode="${executionMode}"`, callerMode, ceiling);
  }
  if (
    (approvalPolicy !== undefined || sandbox !== undefined)
    && threadExecutionModeExceeds(
      threadExecutionModeForRawPermissions({ approvalPolicy, sandbox }),
      callerMode,
    )
  ) {
    const requested = [
      ...(approvalPolicy !== undefined ? [`approvalPolicy="${approvalPolicy}"`] : []),
      ...(sandbox !== undefined ? [`sandbox="${sandbox}"`] : []),
    ].join(" with ");
    return escalationRefusal(requested, callerMode, ceiling);
  }
  return undefined;
}

/**
 * Whether an error's text is an access refusal. A peer's refusal reaches the
 * caller only as its startTurn error text.
 */
export function isAgentAccessRefusalMessage(message: string): boolean {
  return message.includes(AGENT_ACCESS_REFUSAL_MARKER);
}

const AGENT_ACCESS_REFUSAL_MARKER = "An agent cannot raise access.";

function escalationRefusal(
  requested: string,
  ceilingMode: ThreadExecutionMode,
  ceiling: AgentAccessCeiling,
): AgentAccessRefusal {
  const subject = ceiling === "target" ? "the target thread" : "this thread";
  return {
    code: "forbidden",
    message:
      `${requested} asks for more access than ${subject} has (${EXECUTION_MODE_LABELS[ceilingMode]}). `
      + `${AGENT_ACCESS_REFUSAL_MARKER} Ask the operator to raise it in PwrAgent, `
      + `or retry with ${subject}'s access or less.`,
  };
}
