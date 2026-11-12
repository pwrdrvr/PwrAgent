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
  if (request.executionMode && request.sandbox !== undefined) ownerSandboxForMode(policy, request.executionMode, request.sandbox);
}

/**
 * The sandbox a thread or turn runs with. On a policy host the execution mode
 * chooses it, never the caller: agent tools pass a free-form sandbox, and
 * `default` + `workspace-write` would grant writes the operator's mode
 * withholds. A caller's sandbox is accepted only when it equals the mode's.
 * Admission cannot apply this when the mode comes from the thread overlay, so
 * every provider call site resolves its sandbox here.
 */
export function ownerSandboxForMode(
  policy: OwnerRuntimePolicy | undefined,
  mode: ThreadExecutionMode,
  requested: string | undefined,
  modeSandbox?: string,
): string | undefined {
  if (!policy) return requested ?? modeSandbox;
  const sandbox = policy.sandboxByMode[mode];
  if (!sandbox) throw new Error("Full access is unavailable on this Outpost.");
  if (requested !== undefined && requested !== sandbox) {
    throw new Error(`Execution mode ${mode} uses the ${sandbox} sandbox on this Outpost, not ${requested}.`);
  }
  return sandbox;
}

export function createOutpostRuntimePolicy(env: NodeJS.ProcessEnv = process.env): OwnerRuntimePolicy {
  return { exclusiveProfileOwner: true, codexCommand: env.PWRAGENT_CODEX_COMMAND, codexHome: env.PWRAGENT_CODEX_HOME, enabledBackends: ["codex"], approvalPolicy: "never",
    executionModes: ["default", "auto"], sandboxByMode: { default: "read-only", auto: "workspace-write" }, federationEgressRole: "contained" };
}
