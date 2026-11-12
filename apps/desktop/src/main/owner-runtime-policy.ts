import os from "node:os";
import path from "node:path";
import type { AppServerBackendKind, FederationPeerRole, ThreadExecutionMode } from "@pwragent/shared";
import { resolveOutpostCodexHome, resolveOutpostProtectedRoots } from "./headless/outpost-codex-sandbox";
import { OUTPOST_AGENT_TOOL_ALLOWLIST } from "./headless/outpost-agent-tools";
import { resolvePwragentRoot } from "./profile";

/** Host configuration; desktop leaves this unset. */
export interface OwnerRuntimePolicy {
  codexCommand?: string;
  codexHome?: string;
  exclusiveProfileOwner?: boolean;
  /** Runtime instances the host proved gone; their profile leases are reclaimed at once. */
  exitedRuntimeInstanceIds?: readonly string[];
  enabledBackends: readonly AppServerBackendKind[];
  approvalPolicy: "never";
  executionModes: readonly ThreadExecutionMode[];
  sandboxByMode: Readonly<Partial<Record<ThreadExecutionMode, "read-only" | "workspace-write">>>;
  federationEgressRole: FederationPeerRole;
  /** Paths every Codex permission profile denies, including Codex credentials; see outpost-codex-sandbox.ts. */
  codexProtectedRoots: readonly string[];
  /** Paths agent commands may read but never write: the Codex home. */
  codexReadOnlyRoots: readonly string[];
  /**
   * Qualified `namespace/tool` names of the PwrAgent agent tools a model may
   * see and call; every other tool is refused. See outpost-agent-tools.ts.
   */
  agentToolAllowlist: readonly string[];
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
  // The mode chooses the sandbox, so a sandbox is checked against a named mode.
  // Without one the mode comes from the thread, which admission cannot see, and
  // a refusal at the provider call site would come after a queue accepted it.
  if (request.sandbox !== undefined && !request.executionMode) throw new Error("This Outpost needs an executionMode with a sandbox; the mode chooses the sandbox.");
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
  // The Codex home whose credentials agent commands must not read: the
  // daemon's `--codex-home`, else the one Codex itself would use.
  const codexHome = env.PWRAGENT_CODEX_HOME?.trim() || env.CODEX_HOME?.trim() || path.join(env.HOME?.trim() || os.homedir(), ".codex");
  return { exclusiveProfileOwner: true, codexCommand: env.PWRAGENT_CODEX_COMMAND, codexHome: env.PWRAGENT_CODEX_HOME, enabledBackends: ["codex"], approvalPolicy: "never",
    executionModes: ["default", "auto"], sandboxByMode: { default: "read-only", auto: "workspace-write" }, federationEgressRole: "contained",
    codexProtectedRoots: resolveOutpostProtectedRoots(env.PWRAGENT_HOME?.trim() || resolvePwragentRoot({ env }), codexHome),
    codexReadOnlyRoots: [resolveOutpostCodexHome(codexHome)],
    agentToolAllowlist: OUTPOST_AGENT_TOOL_ALLOWLIST };
}
