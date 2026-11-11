import type { AppServerBackendKind, FederationPeerRole, ThreadExecutionMode } from "@pwragent/shared";

/** Host configuration; desktop leaves this unset. */
export interface OwnerRuntimePolicy {
  codexCommand?: string;
  codexHome?: string;
  exclusiveProfileOwner?: boolean;
  enabledBackends: readonly AppServerBackendKind[];
  approvalPolicy: "never";
  executionModes: readonly ThreadExecutionMode[];
  sandboxByMode: Readonly<Partial<Record<ThreadExecutionMode, "read-only" | "workspace-write">>>;
  federationEgressRole: FederationPeerRole;
}
export interface OwnerExecutionRequest {
  backend: AppServerBackendKind;
  executionMode?: ThreadExecutionMode;
  approvalPolicy?: string;
  sandbox?: string;
}
export function assertOwnerExecutionPolicy(policy: OwnerRuntimePolicy | undefined, request: OwnerExecutionRequest): void {
  if (!policy) return;
  if (!policy.enabledBackends.includes(request.backend)) throw new Error(`Backend ${request.backend} is disabled by this host's configuration.`);
  if (request.executionMode && !policy.executionModes.includes(request.executionMode)) throw new Error("Full access is unavailable on this Outpost.");
  if (request.approvalPolicy !== undefined && request.approvalPolicy !== policy.approvalPolicy) throw new Error("This unattended Outpost requires approvalPolicy never.");
  if (request.sandbox !== undefined && request.sandbox !== "read-only" && request.sandbox !== "workspace-write") throw new Error("This Outpost requires a read-only or workspace-write sandbox.");
}

export function createOutpostRuntimePolicy(env: NodeJS.ProcessEnv = process.env): OwnerRuntimePolicy {
  return { exclusiveProfileOwner: true, codexCommand: env.PWRAGENT_CODEX_COMMAND, codexHome: env.PWRAGENT_CODEX_HOME, enabledBackends: ["codex"], approvalPolicy: "never",
    executionModes: ["default", "auto"], sandboxByMode: { default: "read-only", auto: "workspace-write" }, federationEgressRole: "contained" };
}
