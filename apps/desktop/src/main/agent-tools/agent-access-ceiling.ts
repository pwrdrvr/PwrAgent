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
    return escalationRefusal(`executionMode="${executionMode}"`, callerMode);
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
    return escalationRefusal(requested, callerMode);
  }
  return undefined;
}

function escalationRefusal(
  requested: string,
  callerMode: ThreadExecutionMode,
): AgentAccessRefusal {
  return {
    code: "forbidden",
    message:
      `${requested} asks for more access than this thread has (${EXECUTION_MODE_LABELS[callerMode]}). `
      + "An agent cannot raise access. Ask the operator to raise it in PwrAgent, "
      + "or retry with this thread's access or less.",
  };
}
