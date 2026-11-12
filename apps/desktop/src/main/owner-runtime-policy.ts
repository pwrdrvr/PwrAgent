import os from "node:os";
import path from "node:path";
import type { AppServerBackendKind, FederationPeerRole, ThreadExecutionMode } from "@pwragent/shared";
import { resolveOutpostCodexHome, resolveOutpostProtectedRoots } from "./headless/outpost-codex-sandbox";
import { resolvePwragentRoot } from "./profile";

export type OwnerSandboxMode = "read-only" | "workspace-write" | "danger-full-access";
/** `ask`: each execution mode asks as it does on a desktop. `never`: nothing asks. */
export type OwnerApprovals = "ask" | "never";

/** Host configuration; desktop leaves this unset. */
export interface OwnerRuntimePolicy {
  codexCommand?: string;
  codexHome?: string;
  exclusiveProfileOwner?: boolean;
  /** Runtime instances the host proved gone; their profile leases are reclaimed at once. */
  exitedRuntimeInstanceIds?: readonly string[];
  enabledBackends: readonly AppServerBackendKind[];
  approvals: OwnerApprovals;
  executionModes: readonly ThreadExecutionMode[];
  sandboxByMode: Readonly<Partial<Record<ThreadExecutionMode, OwnerSandboxMode>>>;
  /** Network for agent commands inside the sandbox. Absent means off. */
  agentNetwork?: boolean;
  /** This member's containment; see member-containment.ts. */
  memberRole: FederationPeerRole;
  /** Paths every Codex permission profile denies, including Codex credentials; see outpost-codex-sandbox.ts. */
  codexProtectedRoots: readonly string[];
  /** Paths agent commands may read but never write: the Codex home. */
  codexReadOnlyRoots: readonly string[];
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
  if (request.executionMode && !policy.executionModes.includes(request.executionMode)) throw new Error(executionModeUnavailableMessage(request.executionMode));
  if (policy.approvals === "never" && request.approvalPolicy !== undefined && request.approvalPolicy !== "never") {
    throw new Error("This Outpost's operator turned approvals off, so it requires approvalPolicy never.");
  }
  if (request.sandbox !== undefined && !allowedSandboxes(policy).includes(request.sandbox)) throw new Error(`This Outpost does not allow the ${request.sandbox} sandbox.`);
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
  if (!sandbox) throw new Error(executionModeUnavailableMessage(mode));
  if (requested !== undefined && requested !== sandbox) {
    throw new Error(`Execution mode ${mode} uses the ${sandbox} sandbox on this Outpost, not ${requested}.`);
  }
  return sandbox;
}

export function executionModeUnavailableMessage(mode: ThreadExecutionMode): string {
  return mode === "full-access" ? "Full access is unavailable on this Outpost." : `Execution mode ${mode} is unavailable on this Outpost.`;
}

function allowedSandboxes(policy: OwnerRuntimePolicy): string[] {
  return policy.executionModes.flatMap(mode => policy.sandboxByMode[mode] ?? []);
}

const OUTPOST_EXECUTION_MODES: readonly ThreadExecutionMode[] = ["default", "auto", "full-access"];
const OUTPOST_SANDBOX_BY_MODE: Readonly<Record<ThreadExecutionMode, OwnerSandboxMode>> = {
  default: "read-only", auto: "workspace-write", "full-access": "danger-full-access",
};

/**
 * PWRAGENT_OUTPOST_EXECUTION_MODES: comma-separated modes the operator allows. Default `default,auto`.
 * The operator sets it when the container starts; agents cannot change the running owner's environment.
 */
export function parseOutpostExecutionModes(value: string | undefined): ThreadExecutionMode[] {
  if (value === undefined || value.trim() === "") return ["default", "auto"];
  const modes: ThreadExecutionMode[] = [];
  for (const part of value.split(",")) {
    const mode = part.trim();
    if (!mode) continue;
    if (!OUTPOST_EXECUTION_MODES.includes(mode as ThreadExecutionMode)) {
      throw new Error(`PWRAGENT_OUTPOST_EXECUTION_MODES has unknown mode "${mode}". Use default, auto or full-access.`);
    }
    if (!modes.includes(mode as ThreadExecutionMode)) modes.push(mode as ThreadExecutionMode);
  }
  if (modes.length === 0) throw new Error("PWRAGENT_OUTPOST_EXECUTION_MODES allows no execution mode.");
  return OUTPOST_EXECUTION_MODES.filter(mode => modes.includes(mode));
}

/** PWRAGENT_OUTPOST_AGENT_NETWORK: `on` gives agent commands network access. Default off. */
export function parseOutpostAgentNetwork(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  if (normalized === undefined || normalized === "" || normalized === "off") return false;
  if (normalized === "on") return true;
  throw new Error(`PWRAGENT_OUTPOST_AGENT_NETWORK must be on or off, not "${value}".`);
}

/**
 * PWRAGENT_OUTPOST_APPROVALS: `ask` (default) lets each execution mode ask for
 * approval as it does on a desktop, answered from any viewer. `never` is for
 * an Outpost nobody watches: nothing asks, and a command that needs approval
 * fails.
 */
export function parseOutpostApprovals(value: string | undefined): OwnerApprovals {
  const normalized = value?.trim().toLowerCase();
  if (normalized === undefined || normalized === "" || normalized === "ask") return "ask";
  if (normalized === "never") return "never";
  throw new Error(`PWRAGENT_OUTPOST_APPROVALS must be ask or never, not "${value}".`);
}

/**
 * PWRAGENT_OUTPOST_FEDERATION_ROLE: `contained` (default) or `full`. A
 * contained Outpost cannot call back into the federation, and its models get
 * only the agent tool allowlist; a full one is a member like a desktop.
 * Contained is the default so an upgrade never widens what an existing
 * Outpost may do.
 */
export function parseOutpostFederationRole(value: string | undefined): FederationPeerRole {
  const normalized = value?.trim().toLowerCase();
  if (normalized === undefined || normalized === "" || normalized === "contained") return "contained";
  if (normalized === "full") return "full";
  throw new Error(`PWRAGENT_OUTPOST_FEDERATION_ROLE must be contained or full, not "${value}".`);
}

export function createOutpostRuntimePolicy(env: NodeJS.ProcessEnv = process.env): OwnerRuntimePolicy {
  const executionModes = parseOutpostExecutionModes(env.PWRAGENT_OUTPOST_EXECUTION_MODES);
  const sandboxByMode = Object.fromEntries(executionModes.map(mode => [mode, OUTPOST_SANDBOX_BY_MODE[mode]]));
  // The Codex home whose credentials agent commands must not read: the
  // daemon's `--codex-home`, else the one Codex itself would use.
  const codexHome = env.PWRAGENT_CODEX_HOME?.trim() || env.CODEX_HOME?.trim() || path.join(env.HOME?.trim() || os.homedir(), ".codex");
  return { exclusiveProfileOwner: true, codexCommand: env.PWRAGENT_CODEX_COMMAND, codexHome: env.PWRAGENT_CODEX_HOME, enabledBackends: ["codex"],
    approvals: parseOutpostApprovals(env.PWRAGENT_OUTPOST_APPROVALS),
    executionModes, sandboxByMode, agentNetwork: parseOutpostAgentNetwork(env.PWRAGENT_OUTPOST_AGENT_NETWORK),
    memberRole: parseOutpostFederationRole(env.PWRAGENT_OUTPOST_FEDERATION_ROLE),
    codexProtectedRoots: resolveOutpostProtectedRoots(env.PWRAGENT_HOME?.trim() || resolvePwragentRoot({ env }), codexHome),
    codexReadOnlyRoots: [resolveOutpostCodexHome(codexHome)] };
}
