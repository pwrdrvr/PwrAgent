import {
  agentCapabilityRuntimeSupport,
  type AgentCapabilityExecutionPath,
} from "@pwragent/shared/contracts/agent-capability-policy";
import type { AppServerBackendKind } from "@pwragent/shared/contracts/normalized-app-server";
import { getMainLogger } from "../log";

const log = getMainLogger("pwragent:agent-capabilities");

export function assertAgentCapabilityAdmission(
  policy: unknown,
  identity: { backend: AppServerBackendKind; threadId?: string },
  path: AgentCapabilityExecutionPath,
): void {
  const result = agentCapabilityRuntimeSupport(policy, identity.backend, path);
  if (result.status === "legacy") return;
  const reason = result.status === "invalid" ? result.code : "unsupported-runtime";
  log.warn("agent_capability_denied", { backend: identity.backend, threadId: identity.threadId, path, reason });
  if (result.status === "invalid") {
    throw new Error(result.code === "unsupported-version"
      ? "This Agent capability policy version is unsupported."
      : `This Agent capability policy has an invalid ${result.field} field.`);
  }
  throw new Error(`The ${result.backend} backend cannot enforce this restricted Agent capability policy for ${result.path} execution.`);
}
