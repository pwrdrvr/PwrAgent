import type { ThreadExecutionMode } from "@pwragent/shared";
import { approvalSettingsForMode, localMemberRole } from "../member-containment";
import { getOwnerHostServices } from "../owner-host";
import { executionModeUnavailableMessage } from "../owner-runtime-policy";
import { EXECUTION_MODE_SUMMARIES } from "./thread-model-options";

export function executionModeSettings(mode: ThreadExecutionMode) {
  const original = EXECUTION_MODE_SUMMARIES[mode];
  const policy = getOwnerHostServices().runtimePolicy;
  if (policy && !policy.executionModes.includes(mode)) throw new Error(executionModeUnavailableMessage(mode));
  return {
    ...original,
    ...approvalSettingsForMode(original, { approvals: policy?.approvals, role: localMemberRole() }),
    sandbox: policy?.sandboxByMode[mode] ?? original.sandbox,
  };
}
