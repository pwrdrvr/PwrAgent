import type {
  CodexNativeSubAgentSummary,
} from "./contracts/normalized-app-server";
import type { ThreadActiveSubAgent, ThreadSubAgentSummary } from "./contracts/navigation";

export const CODEX_NATIVE_SUBAGENT_NAVIGATION_RETENTION_MS = 60 * 60 * 1000;
export const CODEX_NATIVE_SUBAGENT_PANEL_RETENTION_MS = 24 * 60 * 60 * 1000;

function latestActivityAt(
  subAgent: Pick<CodexNativeSubAgentSummary, "createdAt" | "updatedAt">,
): number | undefined {
  return subAgent.updatedAt ?? subAgent.createdAt;
}

/**
 * Keep the repeated navigation disclosure focused on live or newly finished
 * native workers. Missing timestamps stay visible because their age cannot be
 * established safely.
 */
export function isCodexNativeSubAgentVisibleInNavigation(
  subAgent: CodexNativeSubAgentSummary,
  now: number,
): boolean {
  if (subAgent.threadStatus === "active") {
    return true;
  }
  const activityAt = latestActivityAt(subAgent);
  return activityAt === undefined
    || activityAt >= now - CODEX_NATIVE_SUBAGENT_NAVIGATION_RETENTION_MS;
}

function hasTerminalEvidence(subAgent: ThreadSubAgentSummary): boolean {
  return (
    subAgent.status === "success"
    || subAgent.status === "failure"
    || subAgent.status === "cancelled"
    || subAgent.completedAt !== undefined
    || subAgent.outcome !== undefined
    || subAgent.completionSource !== undefined
  );
}

/** Composer presence includes live work and undismissed failures, without result or accounting history. */
export function projectActiveThreadSubAgents(
  subAgents: readonly ThreadSubAgentSummary[],
): ThreadActiveSubAgent[] {
  return subAgents
    .filter((agent) => agent.status === "failed" || agent.status === "failure" || !hasTerminalEvidence(agent))
    .map((agent) => ({
      monitorId: agent.monitorId,
      task: agent.task,
      status: agent.status,
      createdAt: agent.createdAt,
      updatedAt: agent.updatedAt,
      monitorThreadId: agent.monitorThreadId,
      monitorTurnId: agent.monitorTurnId,
    }));
}

/**
 * The selected thread's panel retains completed native workers longer than
 * navigation does. Other monitor kinds keep their existing durable history.
 */
export function isThreadSubAgentVisibleInPanel(
  subAgent: ThreadSubAgentSummary,
  now: number,
): boolean {
  if (!subAgent.monitorId.startsWith("codex-native:")) {
    return true;
  }
  if (!hasTerminalEvidence(subAgent)) {
    return true;
  }
  const activityAt = subAgent.completedAt ?? subAgent.updatedAt;
  return activityAt >= now - CODEX_NATIVE_SUBAGENT_PANEL_RETENTION_MS;
}
