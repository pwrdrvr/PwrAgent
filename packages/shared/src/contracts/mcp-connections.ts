import type { AppServerBackendKind } from "./normalized-app-server";
import type { FederationRemoteTarget } from "./federation";
import { isAcpBackendId } from "./navigation";
import { forgeRuleRepositoryMatchKey, normalizeForgeRuleRepository } from "./forge-agent-tools";
import {
  describeGithubMcpAccount,
  githubMcpAccountHeadline,
  githubMcpAccountUsable,
  type GithubMcpAccountCheck,
  type GithubMcpSettings,
  type GithubMcpSettingsInput,
} from "../github-mcp";

export const PWRSNAP_MCP_CONNECTION_ID = "pwrsnap" as const;
export const PWRGIT_MCP_CONNECTION_ID = "pwrgit" as const;
// The colon cannot appear in a stored custom ID. Keep legacy `sandboxer`
// connections, credentials, and thread selections on their original identity.
export const SANDBOXER_MCP_CONNECTION_ID = "builtin:sandboxer" as const;

// Docker also installs an unrelated `sbx`. Never resolve this name on PATH.
export const SANDBOXER_CLI_PATH = "/usr/local/bin/sbx";
export const SANDBOXER_MCP_ARGS = ["mcp", "--type", "small", "--ttl", "1800"] as const;
/** Exactly what the gateway launches; Settings shows this line verbatim. */
export const SANDBOXER_MCP_LAUNCH_ARGS = [...SANDBOXER_MCP_ARGS, "--no-update"] as const;
// `onboard` signs in an existing account or creates one, then asks only for
// what the account still lacks (the plan checkout). `login` only signs in, so
// a new account would reach "Signed in" and still fail its first create.
export const SANDBOXER_SETUP_COMMAND = `${SANDBOXER_CLI_PATH} onboard`;

/** Hosted OAuth or the optional existing local CLI login. */
export type SandboxerTransport = "hosted" | "local_cli";

export function isSandboxerTransport(value: unknown): value is SandboxerTransport {
  return value === "hosted" || value === "local_cli";
}

export const SANDBOXER_MCP_URL = "https://sandboxer.com/mcp";

export type SetSandboxerTransportRequest = { transport: SandboxerTransport };

/** Remote compute today; a remote PwrAgent runtime is reserved for later work. */
export type SandboxerRole = "compute" | "remote_agent";
/**
 * What `sbx status --json` says about this machine's Sandboxer setup.
 *
 * Signed in is not ready: an account without a plan, with a card that can't
 * be charged, or with no machine time left signs in fine and then fails its
 * first create. Those states come from the status's `plan.canStart`.
 */
export type SandboxerCliState =
  | "signed_in"
  | "not_signed_in"
  | "no_plan"
  | "billing_issue"
  | "out_of_credit"
  | "cannot_start"
  | "cli_missing"
  | "unavailable";

/** Signed in, but Sandboxer will not start a machine for this account. */
export function isSandboxerAccountLimited(state: SandboxerCliState | undefined): boolean {
  return state === "no_plan"
    || state === "billing_issue"
    || state === "out_of_credit"
    || state === "cannot_start";
}

/**
 * The account the local CLI login bills. Shown in Settings only; federation
 * strips it, and no agent tool returns it.
 */
export type SandboxerAccountSummary = {
  email?: string;
  /** The plan's monthly price, as the CLI reports it. */
  planDollars?: number;
  creditBalanceHours?: number;
};

/** Sandboxer pages Settings can open. Main maps each to a fixed URL. */
export const SANDBOXER_LINK_TARGETS = [
  "home",
  "pricing",
  "quickstart",
  "docs_mcp",
  "docs_machines",
  "docs_billing",
  "dashboard",
] as const;

export type SandboxerLinkTarget = (typeof SANDBOXER_LINK_TARGETS)[number];

export function isSandboxerLinkTarget(value: unknown): value is SandboxerLinkTarget {
  return SANDBOXER_LINK_TARGETS.some((target) => target === value);
}

export const SANDBOXER_ORIGIN = "https://sandboxer.com";

/**
 * Every fixed Sandboxer page, for main's link handler and the launchpad
 * tile. The local dashboard link comes from the CLI.
 */
export const SANDBOXER_LINKS: Readonly<Record<Exclude<SandboxerLinkTarget, "dashboard">, string>> = {
  home: `${SANDBOXER_ORIGIN}/`,
  pricing: `${SANDBOXER_ORIGIN}/pricing`,
  quickstart: `${SANDBOXER_ORIGIN}/docs/quickstart`,
  docs_mcp: `${SANDBOXER_ORIGIN}/docs/mcp`,
  docs_machines: `${SANDBOXER_ORIGIN}/docs/machines`,
  docs_billing: `${SANDBOXER_ORIGIN}/docs/billing`,
};

export type OpenSandboxerLinkRequest = { target: SandboxerLinkTarget };
export type OpenSandboxerLinkResponse = { opened: boolean; error?: string };

/**
 * Boat (boat.dev) rents Ubuntu VMs by the second. It has no MCP server for
 * sandbox control, so PwrAgent hosts one in the main process and is the only
 * holder of the Boat API key. See docs/boat-remote-compute.md.
 */
export const BOAT_MCP_CONNECTION_ID = "builtin:boat" as const;
export const BOAT_ORIGIN = "https://boat.dev";
export const BOAT_API_URL = `${BOAT_ORIGIN}/api/v1`;

export const BOAT_LINK_TARGETS = ["home", "dashboard", "docs", "pricing", "api_keys"] as const;
export type BoatLinkTarget = (typeof BOAT_LINK_TARGETS)[number];

export function isBoatLinkTarget(value: unknown): value is BoatLinkTarget {
  return BOAT_LINK_TARGETS.some((target) => target === value);
}

/** Every Boat page PwrAgent opens. Main opens only these fixed URLs. */
export const BOAT_LINKS: Readonly<Record<BoatLinkTarget, string>> = {
  home: `${BOAT_ORIGIN}/`,
  dashboard: `${BOAT_ORIGIN}/dashboard`,
  docs: "https://docs.boat.dev/quickstart",
  pricing: "https://docs.boat.dev/pricing",
  api_keys: "https://docs.boat.dev/api-keys/scopes",
};

/** Boat's machine sizes, smallest first. The order is what a cap compares. */
export const BOAT_SANDBOX_TYPES = ["small", "default", "large", "xlarge"] as const;
export type BoatSandboxType = (typeof BOAT_SANDBOX_TYPES)[number];

export function isBoatSandboxType(value: unknown): value is BoatSandboxType {
  return BOAT_SANDBOX_TYPES.some((type) => type === value);
}

/** What each size is, for Settings. Rates are Boat's published per-hour price. */
export const BOAT_SANDBOX_TYPE_LABELS: Readonly<Record<BoatSandboxType, string>> = {
  small: "small · 2 vCPU · 4 GB",
  default: "default · 4 vCPU · 8 GB",
  large: "large · 8 vCPU · 16 GB",
  xlarge: "xlarge · 16 vCPU · 32 GB",
};

/** Boat's own ceiling on auto-stop: 30 days. */
export const BOAT_TTL_LIMIT_MINUTES = 30 * 24 * 60;

/**
 * What PwrAgent's Boat tools may do, whatever an agent asks for. Enforced in
 * the main process before any request reaches Boat.
 */
export type BoatSandboxPolicy = {
  /**
   * Create, resume and fork every sandbox with `noEnv`, so the account's
   * GitHub token, secrets, model keys and Boat key never enter one.
   */
  keepCredentialsOut: boolean;
  defaultType: BoatSandboxType;
  defaultTtlMinutes: number;
  /** The largest size and longest auto-stop an agent may ask for. */
  maxType: BoatSandboxType;
  maxTtlMinutes: number;
};

export const DEFAULT_BOAT_SANDBOX_POLICY: BoatSandboxPolicy = {
  keepCredentialsOut: true,
  defaultType: "small",
  defaultTtlMinutes: 60,
  maxType: "large",
  maxTtlMinutes: 8 * 60,
};

/**
 * A policy that holds its own invariants: sizes are Boat's, auto-stop is
 * between one minute and Boat's limit, and a default never exceeds its cap.
 */
export function normalizeBoatSandboxPolicy(input: Partial<Record<keyof BoatSandboxPolicy, unknown>> | undefined): BoatSandboxPolicy {
  const fallback = DEFAULT_BOAT_SANDBOX_POLICY;
  const minutes = (value: unknown, otherwise: number): number =>
    typeof value === "number" && Number.isInteger(value) && value >= 1
      ? Math.min(value, BOAT_TTL_LIMIT_MINUTES)
      : otherwise;
  const maxType = isBoatSandboxType(input?.maxType) ? input.maxType : fallback.maxType;
  const maxTtlMinutes = minutes(input?.maxTtlMinutes, fallback.maxTtlMinutes);
  const defaultType = isBoatSandboxType(input?.defaultType) ? input.defaultType : fallback.defaultType;
  return {
    keepCredentialsOut: input?.keepCredentialsOut !== false,
    defaultType: boatSandboxTypeRank(defaultType) > boatSandboxTypeRank(maxType) ? maxType : defaultType,
    defaultTtlMinutes: Math.min(minutes(input?.defaultTtlMinutes, fallback.defaultTtlMinutes), maxTtlMinutes),
    maxType,
    maxTtlMinutes,
  };
}

export function boatSandboxTypeRank(type: BoatSandboxType): number {
  return BOAT_SANDBOX_TYPES.indexOf(type);
}

/**
 * Boat API keys start with `boat_`; older ones with `box_`. Anything shaped
 * like one is masked before text leaves PwrAgent's Boat server.
 */
export const BOAT_API_KEY_PATTERN = /\b(?:boat|box)_[A-Za-z0-9_-]{8,}/g;

export function redactBoatApiKeys(text: string): string {
  return text.replace(BOAT_API_KEY_PATTERN, "[Boat key removed]");
}

/** A pasted key, trimmed. Undefined when it is not shaped like a Boat key. */
export function normalizeBoatApiKey(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const key = value.trim();
  return /^(?:boat|box)_[A-Za-z0-9_-]{8,512}$/.test(key) ? key : undefined;
}

/**
 * The account behind the stored key. Shown in Settings only; federation
 * strips it, and no agent tool returns it.
 */
export type BoatAccountSummary = {
  login?: string;
  plan?: string;
  activeSandboxes?: number;
  maxActiveSandboxes?: number;
  /** False when Boat will not start a machine for this account right now. */
  canStart?: boolean;
  blockedReason?: string;
};

/**
 * What a Boat API key needs for PwrAgent, and all the key sign-in mints may do: one action per kind of request the Boat tools
 * make, and nothing else. Boat's `full-sandbox` preset is not enough: it
 * leaves out create, resume, fork and delete. No desktop stream, agent
 * prompt, environment or account write is granted.
 *
 * `ssh` is there for `forward_port` alone: PwrAgent registers a key pair it
 * made for one tunnel, and no agent is given a shell over it.
 *
 * `sandbox.delete` rather than `sandbox.delete-own`: a key from a later
 * sign-in must still delete what an earlier key created, or cleanup after a
 * pull request closes would leave those sandboxes billing. PwrAgent, the
 * key's only holder, limits each thread to the sandboxes it created.
 */
export const BOAT_KEY_ACTIONS = [
  "sandbox.create",
  "sandbox.read",
  "sandbox.update",
  "sandbox.stop",
  "sandbox.resume",
  "sandbox.fork",
  "sandbox.delete",
  "exec",
  "file.read",
  "file.write",
  "host",
  "ssh",
  "snapshot.read",
  "snapshot.write",
  "account.read",
] as const;

/** How the operator proves who they are on Boat's sign-in page. */
export const BOAT_SIGN_IN_METHODS = ["github", "google"] as const;
export type BoatSignInMethod = (typeof BOAT_SIGN_IN_METHODS)[number];

export function isBoatSignInMethod(value: unknown): value is BoatSignInMethod {
  return BOAT_SIGN_IN_METHODS.some((method) => method === value);
}

/**
 * A browser sign-in PwrAgent is running, or why the last one failed. The
 * code is the one Boat's page asks for; it is not a credential.
 */
export type BoatSignInProgress =
  | { state: "waiting"; method: BoatSignInMethod; userCode: string; expiresAt: number }
  | { state: "failed"; error: string };

/** One of a thread's Boat sandboxes, as its panel shows it. */
export type BoatThreadSandbox = {
  id: string;
  name?: string;
  state?: string;
  type?: string;
  /** What Boat has billed for it so far. */
  dollars?: number;
  ttlSeconds?: number;
};

export const BOAT_THREAD_SANDBOX_ACTIONS = ["stop", "delete"] as const;
export type BoatThreadSandboxAction = (typeof BOAT_THREAD_SANDBOX_ACTIONS)[number];

export function isBoatThreadSandboxAction(value: unknown): value is BoatThreadSandboxAction {
  return BOAT_THREAD_SANDBOX_ACTIONS.some((action) => action === value);
}

export type ListThreadBoatSandboxesRequest = { backend: string; threadId: string };
export type ListThreadBoatSandboxesResponse = { sandboxes: BoatThreadSandbox[] };
export type ChangeThreadBoatSandboxRequest = ListThreadBoatSandboxesRequest & {
  sandboxId: string;
  action: BoatThreadSandboxAction;
};

export type ConnectBoatRequest = { apiKey: string };
export type StartBoatSignInRequest = { method: BoatSignInMethod };
export type SetBoatSandboxPolicyRequest = { policy: Partial<BoatSandboxPolicy> };
export type SetBoatCleanupOnPrCloseRequest = { enabled: boolean };
export type OpenBoatLinkRequest = { target: BoatLinkTarget };
export type OpenBoatLinkResponse = { opened: boolean; error?: string };

export const MCP_CONNECTION_IDS = [
  PWRSNAP_MCP_CONNECTION_ID,
  PWRGIT_MCP_CONNECTION_ID,
  SANDBOXER_MCP_CONNECTION_ID,
  BOAT_MCP_CONNECTION_ID,
] as const;
/**
 * Any connection id. Remote connections are slugged from their display name,
 * so this is deliberately open.
 */
export type McpConnectionId = string;

/** The connections PwrAgent synthesizes rather than stores. */
export type BuiltInMcpConnectionId = (typeof MCP_CONNECTION_IDS)[number];

/**
 * How PwrAgent holds a connection's access. `none` is a local command: there
 * is nothing to sign in to, and any secrets it needs travel as environment
 * variables PwrAgent stores encrypted.
 */
export type McpConnectionAuthMode = "oauth" | "local_cli" | "none" | "api_key";

/**
 * `stdio` is an operator-configured local command (an MCP stdio server).
 * `github` is GitHub's MCP server, signed in with the GitHub CLI or a token.
 * `boat` is PwrAgent's own server for Boat's API, signed in with an API key.
 */
export type McpConnectionKind = "remote" | "pwrsnap" | "pwrgit" | "sandboxer" | "stdio" | "github" | "boat";

/** One environment variable a local command server receives. */
export type McpStdioEnvironmentEntry = {
  name: string;
  /**
   * The plain value. Always absent for a secret: secret values stay in the
   * main process and are never sent to a window or a federation peer.
   */
  value?: string;
  secret: boolean;
};

/**
 * What PwrAgent launches for a local command connection.
 *
 * There is no shell anywhere in this: `command` is executed directly with
 * `args` as its argv, so nothing in either is expanded or reparsed.
 */
export type McpStdioLaunch = {
  /** Absolute path, resolved when the operator tested or saved it. */
  command: string;
  args: string[];
  /** Absent means the operator's home folder. */
  cwd?: string;
  env: McpStdioEnvironmentEntry[];
};

export type McpStdioEnvironmentInput = {
  name: string;
  secret: boolean;
  /**
   * The value to store. For a secret that already has a stored value,
   * omitting this keeps the stored one, so an edit never has to read it back.
   */
  value?: string;
};

/** A local command as the Settings form submits it. */
export type McpStdioLaunchInput = {
  /** A program name, resolved on the login-shell PATH, or a full path. */
  command: string;
  args: string[];
  cwd?: string;
  env: McpStdioEnvironmentInput[];
};

/**
 * A portable variable name. `__proto__` is refused: every place that holds
 * these names as object keys would turn it into a prototype assignment.
 */
export const MCP_STDIO_ENV_NAME_PATTERN = /^(?!__proto__$)[A-Za-z_][A-Za-z0-9_]*$/;
export const MCP_STDIO_LIMITS = {
  args: 128,
  argLength: 4_096,
  env: 64,
  envValueLength: 32_768,
  commandLength: 4_096,
} as const;

export type McpConnectionRecord = {
  id: McpConnectionId;
  displayName: string;
  serverUrl: string;
  authMode: McpConnectionAuthMode;
  kind: McpConnectionKind;
  /** Only Sandboxer uses this domain role. remote_agent is not implemented. */
  sandboxerRole?: SandboxerRole;
  /**
   * The launch of a `stdio` connection. Absent for every other kind, and also
   * absent on a federation peer's copy: the command, its folder and its
   * variables belong to the machine that runs it.
   */
  stdio?: McpStdioLaunch;
  /**
   * A `github` connection's account source, server and toolsets. Absent for
   * every other kind. A federation peer's copy has no local `command`.
   */
  github?: GithubMcpSettings;
  enabled: boolean;
  /**
   * Whether a new thread starts with this connection already selected.
   *
   * This is a second layer on top of `enabled`, not a stronger form of it.
   * `enabled` decides whether a connection may be offered to threads at all;
   * this decides whether the offer is pre-accepted on a thread that does not
   * exist yet. It seeds a new-thread draft and nothing else: existing threads
   * keep the selection they have, and the seeded one stays editable in the
   * thread's MCP access panel. A connection that is not `enabled` is never
   * seeded, whatever this says.
   *
   * Optional because an owner broker from an older build answers without it;
   * absent reads as `false`.
   */
  selectForNewThreads?: boolean;
  /**
   * When a gateway call to this connection asks the operator first, in
   * Default and Auto threads. Full Access never asks, and an automation's
   * allowlist decides its own calls.
   *
   * - `auto`: Codex's own rule. A tool the server marks read-only, or
   *   non-destructive and closed-world, runs; anything else asks.
   * - `prompt`: every tool asks, read-only ones included.
   * - `approve`: no tool asks.
   *
   * Optional because an owner broker from an older build answers without it;
   * absent reads as `auto`.
   */
  toolApproval?: McpConnectionToolApproval;
  /**
   * Projects whose threads use their own Tool approval for this connection
   * instead of `toolApproval`. A thread belongs to the project of its
   * primary repository; a thread with none uses `toolApproval`.
   *
   * Optional because an owner broker from an older build answers without it;
   * absent reads as none.
   */
  projectToolApprovals?: McpConnectionProjectToolApproval[];
  /**
   * Only the Sandboxer connection uses this. When true, PwrAgent stops or
   * deletes the sandboxes a thread created through this connection once
   * every PR attached to that thread has merged or closed.
   *
   * Optional because an owner broker from an older build answers without it;
   * absent reads as `true`.
   */
  sandboxerCleanupOnPrClose?: boolean;
  /** Only the Boat connection has these. Absent reads as the defaults. */
  boatPolicy?: BoatSandboxPolicy;
  /** Boat's own cleanup switch; absent reads as `true`. */
  boatCleanupOnPrClose?: boolean;
  /**
   * Present only on a connection to Linear's hosted MCP server: whether
   * images in text pasted from Linear are attached to the message, read
   * through this connection once their links expire. One profile-wide
   * setting, so every Linear connection reports the same value as
   * `ListMcpConnectionsResponse.linearPasteImages`.
   *
   * Absent on any other connection, and on an older owner broker's answer,
   * which reads as `true` for a Linear connection.
   */
  linearPasteImages?: boolean;
  createdAt: number;
  updatedAt: number;
};

export const MCP_CONNECTION_TOOL_APPROVALS = ["auto", "prompt", "approve"] as const;

export type McpConnectionToolApproval = (typeof MCP_CONNECTION_TOOL_APPROVALS)[number];

export function isMcpConnectionToolApproval(value: unknown): value is McpConnectionToolApproval {
  return MCP_CONNECTION_TOOL_APPROVALS.some((mode) => mode === value);
}

/**
 * One project's Tool approval for one connection. `repository` is a
 * `host/owner/repo` key from `normalizeForgeRuleRepository`, as a forge
 * project rule's is.
 */
export type McpConnectionProjectToolApproval = {
  repository: string;
  toolApproval: McpConnectionToolApproval;
};

/** Where a thread's Tool approval for a connection came from. */
export type McpConnectionToolApprovalResolution = {
  toolApproval: McpConnectionToolApproval;
  /** The project entry that decided it; absent when the connection did. */
  repository?: string;
};

/**
 * The Tool approval a thread in `repository` uses for this connection: the
 * project's own entry when there is one, else the connection's. Repositories
 * compare without regard to case, as forge project rules do.
 */
export function resolveMcpConnectionToolApproval(
  connection: Pick<McpConnectionRecord, "toolApproval" | "projectToolApprovals">,
  repository?: string,
): McpConnectionToolApprovalResolution {
  const key = repository ? forgeRuleRepositoryMatchKey(repository) : undefined;
  const entry = key
    ? connection.projectToolApprovals?.find((candidate) =>
        forgeRuleRepositoryMatchKey(candidate.repository) === key
        && isMcpConnectionToolApproval(candidate.toolApproval))
    : undefined;
  return entry
    ? { toolApproval: entry.toolApproval, repository: entry.repository }
    : { toolApproval: connection.toolApproval ?? "auto" };
}

/**
 * Elicitation request `_meta` key on an MCP tool approval card: the project
 * grant main offers (`McpProjectToolApprovalOffer`). Main adds it itself and
 * removes any copy a request arrived with, so its presence is PwrAgent's.
 */
export const MCP_PROJECT_TOOL_APPROVAL_OFFER_META_KEY = "pwragent_mcp_project_approval";

/**
 * Elicitation response `_meta` key: `true` when the operator chose the
 * offered project grant. Main honors it only for the request it offered it
 * on, and never forwards it to Codex.
 */
export const MCP_PROJECT_TOOL_APPROVAL_CHOICE_META_KEY = "pwragent_mcp_project_approval_choice";

export type McpProjectToolApprovalOffer = {
  /** The menu item, such as "Allow all Linear tools in PwrApps". */
  label: string;
  description: string;
};

export function buildMcpProjectToolApprovalOffer(input: {
  serverLabel: string;
  projectLabel: string;
}): McpProjectToolApprovalOffer {
  return {
    label: `Allow all ${input.serverLabel} tools in ${input.projectLabel}`,
    description: `Every thread in ${input.projectLabel} can call any ${input.serverLabel} tool without asking. `
      + "Change it in Settings → Plugins.",
  };
}

export function readMcpProjectToolApprovalOffer(
  meta: Record<string, unknown> | null | undefined,
): McpProjectToolApprovalOffer | undefined {
  const value = meta?.[MCP_PROJECT_TOOL_APPROVAL_OFFER_META_KEY];
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { label, description } = value as Record<string, unknown>;
  if (typeof label !== "string" || !label.trim()) return undefined;
  return { label, description: typeof description === "string" ? description : "" };
}

export function readMcpProjectToolApprovalChoice(
  meta: Record<string, unknown> | null | undefined,
): boolean {
  return meta?.[MCP_PROJECT_TOOL_APPROVAL_CHOICE_META_KEY] === true;
}

/**
 * Set or clear one project's entry, keeping every other entry in place.
 * `toolApproval: null` clears it. Returns undefined when `repository` names
 * no repository.
 */
export function upsertMcpConnectionProjectToolApproval(
  entries: readonly McpConnectionProjectToolApproval[] | undefined,
  repository: string,
  toolApproval: McpConnectionToolApproval | null,
): McpConnectionProjectToolApproval[] | undefined {
  const canonical = normalizeForgeRuleRepository(repository);
  const key = canonical?.toLowerCase();
  if (!canonical || !key) return undefined;
  const list = (entries ?? []).slice();
  const index = list.findIndex((entry) => forgeRuleRepositoryMatchKey(entry.repository) === key);
  if (toolApproval === null) {
    if (index >= 0) list.splice(index, 1);
    return list;
  }
  if (index >= 0) list[index] = { repository: list[index].repository, toolApproval };
  else list.push({ repository: canonical, toolApproval });
  return list;
}

export type McpConnectionRuntimeState =
  | "disconnected"
  | "connecting"
  | "ready"
  | "refreshing"
  | "reauthorization_required"
  | "temporarily_unavailable";

export type McpConnectionStatus = McpConnectionRecord & {
  state: McpConnectionRuntimeState;
  sandboxerCliState?: SandboxerCliState;
  sandboxerAccount?: SandboxerAccountSummary;
  /** The Boat account behind the stored key. Settings only, as above. */
  boatAccount?: BoatAccountSummary;
  /** Boat only: its CLI is installed here, so browser sign-in can run. */
  boatCliAvailable?: boolean;
  /** Boat only: a browser sign-in in flight, or the last one's failure. */
  boatSignIn?: BoatSignInProgress;
  /**
   * A `github` connection's account as last checked: its state, login and
   * scopes. Shown in Settings only; federation strips it, as it does the
   * Sandboxer account.
   */
  githubAccount?: GithubMcpAccountCheck;
  configured: boolean;
  detail?: string;
  /**
   * Live copies of a local command running on the owning machine right now:
   * one per thread session. Settings tests and listings are separate copies
   * and are excluded; this count says nothing about a particular thread.
   */
  localProcesses?: number;
  /** In-memory live catalog health, independent of stored authorization. */
  discovery?: {
    state: "untested" | "ready" | "failed";
    lastSuccessAt?: number;
    lastFailure?: {
      at: number;
      message: string;
      /**
       * A local command's last stderr, with stored secrets masked. Settings
       * only: it is stripped from a peer's copy and never sent to an agent.
       */
      output?: string;
    };
  };
};

/**
 * A connection list for a federation peer. The account a local CLI login
 * bills (its email and balance) stays on the machine that holds the login.
 */
export function mcpConnectionsForPeer(connections: McpConnectionStatus[]): McpConnectionStatus[] {
  // A local command's executable path, folder and variables describe the
  // owner's machine; a peer only ever needs the name and the switch.
  return connections.map(({
    sandboxerAccount: _account,
    boatAccount: _boatAccount,
    boatCliAvailable: _boatCliAvailable,
    boatSignIn: _boatSignIn,
    githubAccount: _githubAccount,
    stdio: _stdio,
    ...connection
  }) => {
    if (connection.github?.command) {
      const { command: _command, ...github } = connection.github;
      connection = { ...connection, github };
    }
    const failure = connection.discovery?.lastFailure;
    if (!failure?.output) return connection;
    const { output: _output, ...lastFailure } = failure;
    return { ...connection, discovery: { ...connection.discovery!, lastFailure } };
  });
}

export type ListMcpConnectionsRequest = {
  federationTarget?: FederationRemoteTarget;
  /**
   * Accept a cached Sandboxer status only this recent, in milliseconds.
   * Absent uses the ordinary cache. An owner broker from an older build
   * ignores it.
   */
  sandboxerStatusMaxAgeMs?: number;
};

export type ListMcpConnectionsResponse = {
  connections: McpConnectionStatus[];
  /**
   * Whether images in text pasted from Linear are attached to the message.
   * One profile-wide setting that holds with or without a Linear
   * connection: a fresh signed link needs none.
   *
   * Only the local profile reports it. A peer's answer and an older owner's
   * omit it, and the setting is not offered for them.
   */
  linearPasteImages?: boolean;
};

/**
 * Pushed to this instance's windows when a connection's status may have
 * changed: a setting, a sign-in, a removal, or a Sandboxer CLI answer that
 * differs from the last one. Carries ids only; re-read the list for status.
 * A change made from another PwrAgent instance on the same profile is not
 * announced here, so status reads still happen on window focus.
 */
export type McpConnectionsChangedEvent = {
  connectionIds: McpConnectionId[];
};

/**
 * Add a connection. Exactly one of `serverUrl` (network HTTP with OAuth or
 * verified local HTTP IPC), `stdio` (a local command) or `github` (GitHub's
 * MCP server) is given.
 */
export type CreateMcpConnectionRequest = {
  displayName: string;
  serverUrl?: string;
  /** IPC only; encrypted on the owning instance and never returned. */
  ipcBearerToken?: string;
  stdio?: McpStdioLaunchInput;
  github?: GithubMcpSettingsInput;
};

export type CreateMcpConnectionResponse = {
  connection: McpConnectionStatus;
};

export type AuthorizeMcpConnectionRequest = {
  connectionId: McpConnectionId;
};

export type AuthorizeMcpConnectionResponse = {
  connection: McpConnectionStatus;
};

/**
 * Abandon an authorization that is still out in the browser.
 *
 * The OAuth round trip cannot be aborted -- the browser holds it. What this
 * releases is PwrAgent's side: the loopback callback listener stops waiting
 * and gives up its port, so the next Authorize starts from a fresh redirect
 * URL instead of racing a listener the operator already walked away from.
 * Cancelling an attempt that has already finished, or one that never started,
 * is a no-op.
 */
export type CancelMcpConnectionAuthorizationRequest = {
  connectionId: McpConnectionId;
};

export type DisconnectMcpConnectionRequest = {
  connectionId: McpConnectionId;
};

/**
 * Whether a connection may be offered to threads at all.
 *
 * This is the profile-wide availability switch, not a per-thread selection.
 * A connection can be authorized and healthy yet withheld from every thread,
 * which is how an operator parks a connection without discarding its
 * credentials.
 */
export type SetMcpConnectionEnabledRequest = {
  connectionId: McpConnectionId;
  enabled: boolean;
};

/** See `McpConnectionRecord.selectForNewThreads`. */
export type SetMcpConnectionSelectForNewThreadsRequest = {
  connectionId: McpConnectionId;
  selectForNewThreads: boolean;
};

/** See `McpConnectionRecord.sandboxerCleanupOnPrClose`. */
export type SetSandboxerCleanupOnPrCloseRequest = {
  enabled: boolean;
};

/** See `McpConnectionRecord.linearPasteImages`. */
export type SetLinearPasteImagesRequest = {
  enabled: boolean;
};

/** Fetch the images in text pasted from Linear. */
export type FetchLinearPastedImagesRequest = {
  /** The pasted text. Only its `uploads.linear.app` images are read. */
  text: string;
};

export type LinearPastedImageData = {
  name: string;
  mimeType: string;
  dataBase64: string;
};

export type FetchLinearPastedImagesResponse =
  | {
    status: "fetched";
    images: LinearPastedImageData[];
    failed: number;
    /** Some links had expired, and no Linear connection could read them. */
    needsConnection?: boolean;
  }
  /** The Linear paste setting is off. */
  | { status: "disabled" }
  /**
   * Every link had expired, and no Linear connection is offered to threads
   * to read them.
   */
  | { status: "unavailable" }
  | { status: "failed"; message: string };

/** See `McpConnectionRecord.toolApproval`. */
export type SetMcpConnectionToolApprovalRequest = {
  connectionId: McpConnectionId;
  toolApproval: McpConnectionToolApproval;
};

/**
 * See `McpConnectionRecord.projectToolApprovals`. `toolApproval: null`
 * removes the project's entry, so its threads follow the connection again.
 */
export type SetMcpConnectionProjectToolApprovalRequest = {
  connectionId: McpConnectionId;
  repository: string;
  toolApproval: McpConnectionToolApproval | null;
};

/**
 * The connections a new thread starts with.
 *
 * Only a connection the thread could actually use is seeded: offered to
 * threads, holding credentials, and not waiting on a fresh sign-in. The
 * thread's MCP access panel offers a healthy connection as a switch and an
 * unhealthy one as an Authorize button, so seeding an unhealthy one would put
 * the operator's default on a row with no way to turn it off.
 *
 * The profile-wide gateway switch is deliberately not consulted. It parks
 * every selection rather than rewriting them, and turning it back on restores
 * each thread's selection, so a thread started while it is off gets the same
 * defaults it would have got a minute earlier.
 */
export function mcpConnectionIdsForNewThread(
  connections: readonly McpConnectionStatus[],
): McpConnectionId[] {
  return connections
    .filter((connection) =>
      connection.selectForNewThreads === true
      && connection.enabled
      && connection.configured
      && connection.state !== "disconnected"
      && connection.state !== "reauthorization_required")
    .map((connection) => connection.id);
}

export type RemoveMcpConnectionRequest = {
  connectionId: McpConnectionId;
};

/**
 * Read the tools a managed connection publishes, outside any thread.
 *
 * The Codex-managed list gets this for free -- Codex has already started those
 * servers -- but a managed connection is only ever opened on a thread's
 * behalf, so Settings had nothing to show but a name. The gateway opens a
 * short-lived session of its own for this and caches the answer; `refresh`
 * discards the cache first.
 */
export type ListMcpConnectionToolsRequest = {
  connectionId: McpConnectionId;
  refresh?: boolean;
};

export type ListMcpConnectionToolsResponse = {
  connectionId: McpConnectionId;
  /** Tool names, in the order the server listed them. */
  tools: string[];
  /**
   * How many skills the server offers through the MCP skills extension.
   * Absent when it offers none, and from an older owner broker.
   */
  skillCount?: number;
  /** When the gateway read this list from the server, in epoch ms. */
  fetchedAt: number;
};

export type MutateMcpConnectionResponse = {
  connectionId: McpConnectionId;
  removed?: true;
  connection?: McpConnectionStatus;
};


/**
 * Narrow an arbitrary id to one of the built-ins.
 *
 * Named for what it tests. As `isMcpConnectionId` against the open
 * `McpConnectionId` it was a no-op guard -- `value is string` for a `string`
 * -- which let a caller treat "matches a built-in" and "is a connection id"
 * as the same question. They are not, and one caller had already conflated
 * them.
 */
export function isBuiltInMcpConnectionId(
  value: string,
): value is BuiltInMcpConnectionId {
  return (MCP_CONNECTION_IDS as readonly string[]).includes(value);
}

/** Product names for copy that has to name the app behind a connection id. */
export const MCP_CONNECTION_DISPLAY_NAMES: Record<BuiltInMcpConnectionId, string> = {
  [PWRSNAP_MCP_CONNECTION_ID]: "PwrSnap",
  [PWRGIT_MCP_CONNECTION_ID]: "PwrGit",
  [SANDBOXER_MCP_CONNECTION_ID]: "Sandboxer",
  [BOAT_MCP_CONNECTION_ID]: "Boat",
};

/**
 * A thread's enabled connections are stored as one list, so a toggle for one
 * app must not clobber another's entry. Every surface that flips a single
 * connection composes through this rather than replacing the array.
 */
export function withMcpConnection(
  current: readonly string[] | undefined,
  connectionId: McpConnectionId,
  enabled: boolean,
): string[] {
  const others = (current ?? []).filter((id) => id !== connectionId);
  return enabled ? [...others, connectionId] : others;
}

/** Shared by every PwrSuite MCP connection card. */
export type McpConnectionAvailability =
  | "not_installed"
  | "installed"
  | "running";

export type PwrSnapConnectionAvailability = McpConnectionAvailability;

export type PwrSnapConnectionStatus = {
  connectionId: typeof PWRSNAP_MCP_CONNECTION_ID;
  displayName: "PwrSnap";
  availability: PwrSnapConnectionAvailability;
  configured: boolean;
  detail?: string;
};

export type PwrGitConnectionStatus = {
  connectionId: typeof PWRGIT_MCP_CONNECTION_ID;
  displayName: "PwrGit";
  availability: McpConnectionAvailability;
  configured: boolean;
  detail?: string;
};

export type ReadPwrSnapConnectionStatusRequest = {
  federationTarget?: FederationRemoteTarget;
};

/**
 * `needs_update`: this PwrSnap predates 1.3.0 and has no local relay.
 * `needs_local_agent_access`: PwrSnap is closed or Local Agent Access is off.
 */
export type ConnectPwrSnapResponse = {
  status: PwrSnapConnectionStatus;
  outcome: "connected" | "needs_local_agent_access" | "needs_update";
};

/**
 * `needs_update`: this PwrGit predates 0.56.0 and has no local relay.
 * `needs_local_agent_access`: PwrGit is closed or Local Agent Access is off.
 * `status.detail` says what to do for either.
 */
export type ConnectPwrGitResponse = {
  status: PwrGitConnectionStatus;
  outcome: "connected" | "needs_local_agent_access" | "needs_update";
};

export type OpenPwrSnapResponse = {
  opened: boolean;
  error?: string;
};

export type OpenPwrGitResponse = OpenPwrSnapResponse;
/**
 * A thread's MCP selection, editable for the life of the thread.
 *
 * `providerServersEnabled` controls whether the backend's own configured MCP
 * servers stay available alongside the selected connections. Only Codex can
 * honor `false`: its per-thread config accepts `{ enabled: false }` overrides
 * for inherited servers, while ACP gives PwrAgent no way to suppress servers
 * the agent loads for itself. Callers must not offer the control for backends
 * that cannot enforce it.
 */
export type SetThreadMcpConnectionsRequest = {
  federationTarget?: FederationRemoteTarget;
  backend: AppServerBackendKind;
  threadId: string;
  connectionIds: McpConnectionId[];
  providerServersEnabled?: boolean;
  /** Operator-only: retire this selected local command's grants; never replay a call. */
  reconnectConnectionId?: McpConnectionId;
};

export type ReadThreadMcpConnectionsRequest = {
  federationTarget?: FederationRemoteTarget;
  backend: AppServerBackendKind;
  threadId: string;
};

export type SetThreadMcpConnectionsResponse = {
  connectionIds: McpConnectionId[];
  providerServersEnabled: boolean;
};

/**
 * When a change to a thread's MCP selection actually reaches the agent.
 *
 * Codex re-reads the thread overlay while starting each turn, so a change
 * lands on the next message. ACP resolves MCP servers only during
 * `session/new` and `session/load`, so a change lands when the thread's
 * session is next loaded. Telling the operator "saved" without saying which
 * of these applies would be a lie in the common case.
 */
export type McpSelectionApplyTiming = "next_turn" | "next_session_load";

export function mcpSelectionApplyTiming(
  backend: AppServerBackendKind,
): McpSelectionApplyTiming {
  return backend === "codex" || backend === "claude" ? "next_turn" : "next_session_load";
}

/**
 * Whether a backend can suppress the MCP servers it loads for itself.
 *
 * Only the Codex path can: it writes a per-thread config that disables each
 * inherited server by name. An ACP agent resolves its own servers internally
 * and takes no such instruction, so a stored "off" there would be a promise
 * nothing keeps. Both the renderer control and the main-process writer read
 * this, so a thread cannot end up holding a flag its backend ignores.
 */
/**
 * Whether a thread on this backend loads the gateway connections it selects.
 * Codex, Claude, and ACP agents all do; the launchpad tiles and the MCP access
 * panel ask this one question so they cannot disagree.
 */
export function backendLoadsMcpConnections(backend: AppServerBackendKind): boolean {
  return backend === "codex" || backend === "claude" || isAcpBackendId(backend);
}

export function canIsolateMcpProviderServers(
  backend: AppServerBackendKind,
): boolean {
  return backend === "codex";
}

/** A built-in connection reached through a local application or CLI. */
export function isLocalMcpConnectionKind(kind: McpConnectionKind): boolean {
  // Not `github`: its account lives in the GitHub CLI or a stored token,
  // not in a local PwrSuite app.
  return kind === "pwrsnap" || kind === "pwrgit" || kind === "sandboxer";
}

/**
 * The one thing a connection row is allowed to claim about itself.
 *
 * Four independent switches decide whether a thread can reach a connection:
 * the profile-wide gateway, the connection's own availability (`enabled`),
 * whether PwrAgent holds credentials, and — for a local PwrSuite app —
 * whether that app is installed and running. Rendering them as peers
 * produced rows that read as defects: a never-authorized PwrSnap showed
 * `Not connected` beside an `On` switch, both true and together nonsense.
 *
 * These states resolve that stack in precedence order, so a row makes one
 * claim and offers the action that advances it.
 */
export type McpConnectionSetupState =
  | "gateway_off"
  | "app_not_installed"
  | "app_not_running"
  | "not_authorized"
  | "login_required"
  | "unavailable"
  | "connecting"
  | "parked"
  | "ready";

export type McpConnectionSetupTone = "ok" | "warn" | "err" | "idle";

export type McpConnectionSetupSummary = {
  state: McpConnectionSetupState;
  /** Two or three words. The row's single claim. */
  headline: string;
  /** One sentence naming the remedy, or what "ready" actually means. */
  detail: string;
  tone: McpConnectionSetupTone;
  /**
   * Whether to offer the profile-wide availability switch at all.
   *
   * A connection PwrAgent holds no credentials for cannot be offered to a
   * thread, so a switch claiming it is on would be a promise nothing keeps.
   */
  offersAvailabilitySwitch: boolean;
  /** True only when a thread selecting this can actually reach it. */
  threadSelectable: boolean;
};

export type ResolveMcpConnectionSetupInput = {
  connection: McpConnectionStatus;
  gatewayEnabled: boolean;
  /**
   * Local PwrSuite apps only. Omitted while the probe is still in flight, in
   * which case the credential state is reported on its own rather than
   * guessing that the app is missing.
   */
  localAvailability?: McpConnectionAvailability;
};

// Signed in, but every create would fail. The chip names the reason.
const SANDBOXER_ACCOUNT_HEADLINES: Partial<Record<SandboxerCliState, string>> = {
  no_plan: "No plan",
  billing_issue: "Billing issue",
  out_of_credit: "Out of credit",
  cannot_start: "Can't start",
};

export function resolveMcpConnectionSetup(
  input: ResolveMcpConnectionSetupInput,
): McpConnectionSetupSummary {
  const { connection, gatewayEnabled, localAvailability } = input;
  const name = connection.displayName;
  const configured = connection.configured;
  const build = (
    state: McpConnectionSetupState,
    headline: string,
    detail: string,
    tone: McpConnectionSetupTone,
  ): McpConnectionSetupSummary => ({
    state,
    headline,
    detail,
    tone,
    offersAvailabilitySwitch: configured,
    threadSelectable: state === "ready",
  });

  // The gateway outranks everything: while it is off, authorizing a
  // connection or turning its own switch on changes nothing, so naming any
  // other remedy would send the operator to a control that cannot help.
  if (!gatewayEnabled) {
    return build(
      "gateway_off",
      "Gateway off",
      "No thread can reach this while the managed gateway is off. Credentials stay stored.",
      "idle",
    );
  }

  if (connection.kind === "sandboxer" && connection.authMode === "local_cli") {
    const detail = connection.detail ?? "Check Sandboxer with /usr/local/bin/sbx status.";
    if (connection.sandboxerCliState === "cli_missing") {
      return build("app_not_installed", "CLI missing", detail, "idle");
    }
    if (connection.sandboxerCliState === "unavailable") {
      return build("unavailable", "Unavailable", detail, "err");
    }
    const account = SANDBOXER_ACCOUNT_HEADLINES[connection.sandboxerCliState ?? "signed_in"];
    // No plan means no sandbox exists yet, so threads are not offered it.
    if (account && !configured) return build("login_required", account, detail, "warn");
    if (!configured) return build("login_required", "Not signed in", detail, "warn");
    // A billing problem stops new machines, not running ones. Threads keep
    // reaching it so the agent can still list and stop what is running.
    if (account) {
      return build(connection.enabled ? "ready" : "parked", account, detail, "warn");
    }
    // A sandbox outlives its thread, so the ready line says who stops it.
    const billing =
      "Sandboxes bill per second while they run. Closing the thread does not stop one; auto-stop or the agent does.";
    return connection.enabled
      ? build("ready", "Signed in", `Turn Sandboxer on in a thread's MCP access. ${billing}`, "ok")
      : build("parked", "Parked", `Turn on Offer to threads, then turn Sandboxer on in a thread's MCP access. ${billing}`, "warn");
  }

  if (connection.kind === "boat") {
    const billing =
      "Sandboxes bill per second while they run. Closing the thread does not stop one; auto-stop or the agent does.";
    if (connection.state === "temporarily_unavailable") {
      return build("unavailable", "Unavailable", connection.detail ?? "Could not reach Boat. Check connectivity, then refresh status.", "err");
    }
    if (!configured) {
      return build(
        "login_required",
        connection.state === "reauthorization_required" ? "Key rejected" : "Not connected",
        connection.detail ?? "Paste a Boat API key to connect. PwrAgent keeps it encrypted and never shows it to an agent.",
        "warn",
      );
    }
    if (connection.boatAccount?.canStart === false) {
      return build(
        connection.enabled ? "ready" : "parked",
        "Can't start",
        connection.detail ?? "Boat will not start a new sandbox for this account right now. Running ones can still be listed and stopped.",
        "warn",
      );
    }
    return connection.enabled
      ? build("ready", "Connected", `Turn Boat on in a thread's MCP access. ${billing}`, "ok")
      : build("parked", "Parked", `Turn on Offer to threads, then turn Boat on in a thread's MCP access. ${billing}`, "warn");
  }

  if (
    (connection.kind === "pwrsnap" || connection.kind === "pwrgit")
    && !configured
    && localAvailability !== "not_installed"
  ) {
    // Installed, but too old to have the relay PwrAgent starts.
    return build(
      "app_not_running",
      "Update needed",
      connection.detail ?? `Update ${name}, then turn on Local Agent Access.`,
      "warn",
    );
  }

  if (connection.kind === "stdio") {
    // Nothing to sign in to. The one credential-like failure is a stored
    // secret that encrypted storage can no longer give back.
    if (!configured) {
      return build(
        "login_required",
        "Secret missing",
        connection.detail
          ?? "PwrAgent could not read a stored secret for this server. Edit it and enter the secret again.",
        "warn",
      );
    }
    if (!connection.enabled) {
      return build(
        "parked",
        "Parked",
        "Kept, but no thread can start it until you offer it to threads again.",
        "warn",
      );
    }
    return build(
      "ready",
      "Ready",
      connection.selectForNewThreads
        ? "Starts on this computer for each thread that turns it on, and every new thread starts with it on."
        : "Starts on this computer for each thread that turns it on.",
      "ok",
    );
  }

  if (connection.kind === "github") {
    const account = connection.githubAccount;
    if (!configured) {
      return build(
        "login_required",
        account ? githubMcpAccountHeadline(account) : "Not signed in",
        connection.detail ?? (account ? describeGithubMcpAccount(account) : "Check this connection's GitHub account."),
        "warn",
      );
    }
    if (!connection.enabled) {
      return build(
        "parked",
        "Parked",
        "Kept, but no thread can reach it until you offer it to threads again.",
        "warn",
      );
    }
    return build(
      "ready",
      account && !githubMcpAccountUsable(account.state) ? githubMcpAccountHeadline(account) : "Ready",
      connection.detail ?? describeGithubMcpConnection(connection),
      "ok",
    );
  }

  if (localAvailability === "not_installed") {
    return build(
      "app_not_installed",
      "Not installed",
      `Install ${name} on this machine, then connect it here.`,
      "idle",
    );
  }
  if (localAvailability === "installed") {
    return build(
      "app_not_running",
      "Not running",
      `Open ${name} and turn on Local Agent Access, then connect it here.`,
      "idle",
    );
  }

  if (!configured || connection.state === "disconnected") {
    return build(
      "not_authorized",
      "Not set up",
      `PwrAgent holds no credentials for ${name} yet. Authorize it to offer it to threads.`,
      "idle",
    );
  }
  if (connection.state === "reauthorization_required") {
    return build(
      "login_required",
      "Login required",
      connection.detail
        ?? "The stored credentials stopped working. Authorize this connection again.",
      "err",
    );
  }
  if (connection.state === "temporarily_unavailable") {
    return build(
      "unavailable",
      "Unavailable",
      connection.detail
        ?? "PwrAgent could not reach this server. Threads that select it lose it until it answers.",
      "err",
    );
  }
  if (connection.state === "connecting" || connection.state === "refreshing") {
    return build(
      "connecting",
      "Connecting",
      "PwrAgent is establishing this connection.",
      "warn",
    );
  }
  if (!connection.enabled) {
    return build(
      "parked",
      "Parked",
      "Credentials kept. No thread can reach it until you offer it to threads again.",
      "warn",
    );
  }
  return build(
    "ready",
    "Ready",
    connection.selectForNewThreads
      ? "Offered to threads and selected on every new one. Turn it off per thread under MCP access."
      : "Offered to threads. Choose it per thread under MCP access.",
    "ok",
  );
}

/**
 * The detail line of a GitHub connection: who it acts as, through what, and
 * which toolsets it loads. "Who will this act as" leads, because it is the
 * question at the moment a thread turns it on.
 */
export function describeGithubMcpConnection(
  connection: Pick<McpConnectionStatus, "github" | "githubAccount">,
): string {
  const github = connection.github;
  const login = connection.githubAccount?.login;
  const source = github?.account === "token" ? "a stored personal access token" : "your GitHub CLI sign-in";
  const who = login ? `Acts as @${login} through ${source}.` : `Acts through ${source}.`;
  if (!github) return who;
  const toolsets = `Toolsets: ${github.toolsets.join(", ")}${github.readOnly ? ", read-only" : ""}.`;
  return `${who} ${toolsets}`;
}

/**
 * Counts for the section chip.
 *
 * The shipped chip read `${enabled} of ${total} on`, which counted the
 * availability switch — so it said "2 of 2 on" while one of the two held no
 * credentials and could not serve a single tool. Readiness is the number the
 * operator is actually asking for.
 */
export function summarizeMcpConnectionReadiness(
  summaries: readonly McpConnectionSetupSummary[],
): {
  ready: number;
  parked: number;
  needsSetup: number;
  gatewayOff: number;
  total: number;
} {
  let ready = 0;
  let parked = 0;
  let needsSetup = 0;
  let gatewayOff = 0;
  for (const summary of summaries) {
    if (summary.state === "ready") ready += 1;
    else if (summary.state === "parked") parked += 1;
    // Counted apart from `needsSetup`: the gateway switch masks every other
    // state, so folding these in reported "4 to set up" for four fully
    // authorized connections whose only remedy is the switch itself.
    else if (summary.state === "gateway_off") gatewayOff += 1;
    else needsSetup += 1;
  }
  return { ready, parked, needsSetup, gatewayOff, total: summaries.length };
}

/**
 * Rename or re-point a connection.
 *
 * Without this a mistyped URL was unfixable from inside the app: the record
 * is persisted before authorization is attempted, so a typo left a dead row
 * whose only exit was Remove and retype. Changing the URL drops stored
 * credentials, because they were issued by the old server.
 */
export type UpdateMcpConnectionRequest = {
  /** IPC only. Omit to retain; an empty string removes the encrypted token. */
  ipcBearerToken?: string;
  connectionId: McpConnectionId;
  displayName?: string;
  serverUrl?: string;
  /** Replaces a local command's launch. Restarts its running copies. */
  stdio?: McpStdioLaunchInput;
  /** Replaces a GitHub connection's settings. Restarts its sessions. */
  github?: GithubMcpSettingsInput;
};

/**
 * Start a local command once, read its tools, and stop it, before anything is
 * saved. `connectionId` lets an edit test with that connection's stored
 * secrets for any secret the form left blank.
 */
export type TestMcpStdioConnectionRequest = {
  stdio: McpStdioLaunchInput;
  connectionId?: McpConnectionId;
};

export type McpStdioTestProblem =
  /** A field is malformed: a bad variable name, an empty command. */
  | "invalid"
  /** The program could not be found on the login-shell PATH or at its path. */
  | "not_found"
  /** It exists, but this account may not run it. */
  | "not_executable"
  /** A stored secret could not be read back from encrypted storage. */
  | "secret_unavailable"
  /** The operating system refused to start it. */
  | "spawn_failed"
  /** It started and exited before answering the MCP handshake. */
  | "exited"
  /** It kept running but never answered as an MCP server. */
  | "no_handshake"
  /** The managed gateway is off, so PwrAgent starts no servers. */
  | "gateway_off";

export type TestMcpStdioConnectionResponse =
  | {
      ok: true;
      /** The absolute path that ran. Saving stores this. */
      command: string;
      serverName?: string;
      serverVersion?: string;
      toolCount: number;
      elapsedMs: number;
    }
  | {
      ok: false;
      problem: McpStdioTestProblem;
      /** One sentence naming what to do. */
      message: string;
      /** The end of the server's own output, with stored secrets masked. */
      output?: string;
      command?: string;
    };

/**
 * Split a pasted command line into argv, once, for the operator to review.
 *
 * Deliberately not a shell: quotes group and backslashes escape, and nothing
 * else happens -- no `~`, no `$VAR`, no globbing, no operators. The result is
 * shown in the form before anything runs, and it is what gets stored, so no
 * later step reparses a string. Returns undefined for an unterminated quote.
 */
export function splitMcpCommandLine(text: string): string[] | undefined {
  const args: string[] = [];
  let current = "";
  let started = false;
  let quote: "'" | "\"" | undefined;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (quote === "'") {
      if (character === "'") quote = undefined;
      else current += character;
      continue;
    }
    if (quote === "\"") {
      if (character === "\"") {
        quote = undefined;
      } else if (character === "\\" && (text[index + 1] === "\"" || text[index + 1] === "\\")) {
        current += text[index + 1];
        index += 1;
      } else {
        current += character;
      }
      continue;
    }
    if (/\s/.test(character)) {
      if (started) {
        args.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    started = true;
    if (character === "'" || character === "\"") {
      quote = character;
    } else if (character === "\\" && /[\s'"\\]/.test(text[index + 1] ?? "")) {
      // Only before a space, a quote or another backslash, so a pasted
      // Windows path such as C:\Tools\server.exe keeps its separators.
      current += text[index + 1];
      index += 1;
    } else {
      current += character;
    }
  }
  if (quote) return undefined;
  if (started) args.push(current);
  return args;
}

/**
 * One display line for a launch: what a connection row shows and Copy copies.
 * Quotes only what a POSIX shell would split, so the common case reads clean.
 * Display only -- PwrAgent never runs this string.
 */
export function formatMcpCommandLine(launch: Pick<McpStdioLaunch, "command" | "args">): string {
  return [launch.command, ...launch.args]
    .map((part) => /^[\w@%+=:,./-]+$/.test(part) ? part : `'${part.replaceAll("'", "'\\''")}'`)
    .join(" ");
}

export type McpConnectionProbeProblem =
  /** The text is not a URL PwrAgent can fetch. */
  | "not_a_url"
  /** Looks like a command line for a stdio server: add it as a local command. */
  | "looks_like_stdio"
  /** GitHub's hosted MCP server: set it up with the GitHub option instead. */
  | "github_server"
  /** Reachable, but it is not an MCP endpoint. */
  | "not_mcp"
  /** An MCP endpoint that does not offer OAuth, which is all the gateway holds. */
  | "unsupported_auth"
  /** The host did not answer. */
  | "unreachable";

/**
 * Check a URL before a record is written for it.
 *
 * `create` persisted first and authorized second, so every failure mode —
 * a typo, a stdio command, a bearer-token server — produced a saved row and
 * a raw error string.
 */
export type ProbeMcpConnectionRequest = {
  serverUrl: string;
};

export type ProbeMcpConnectionResponse =
  | {
      ok: true;
      /** The endpoint PwrAgent will store, after discovery redirects. */
      serverUrl: string;
      /** The server's own name, when it reports one. */
      serverName?: string;
      authMode: McpConnectionAuthMode;
      /** Absent when the server will not list tools before authorization. */
      toolCount?: number;
      /** Same-user HTTP answered 401; no authenticated session was opened. */
      needsIpcBearer?: boolean;
    }
  | {
      ok: false;
      problem: McpConnectionProbeProblem;
      /** One sentence, in the operator's terms, naming what to do instead. */
      message: string;
    };

export type McpThreadSessionState = "not_started" | "connecting" | "ready" | "ended";

/** Native MCP and gateway discovery use independent upstream sessions. */
export type McpThreadSessionStates = {
  native: McpThreadSessionState;
  gateway: McpThreadSessionState;
};

/** What a thread's managed selection actually became inside the agent. */
export type ThreadMcpConnectionReport = {
  connectionId: McpConnectionId;
  displayName: string;
  /**
   * The name the agent's own inventory shows for this bridge.
   *
   * PwrAgent injects a managed connection under a hashed alias so it cannot
   * collide with a server the agent inherited, which means the only
   * verification surface named it `pwragent_<name>_<32 hex>` — a string that
   * appears nowhere in Settings. Carrying the alias lets a surface show the
   * operator's own name and still match what the agent reports.
   */
  serverNameInAgent?: string;
  state: McpConnectionRuntimeState;
  configured: boolean;
  enabled: boolean;
  /** Owner-observed sessions, independent of a successful Settings test. */
  sessions?: McpThreadSessionStates;
  /** Absent until the agent reports its inventory. */
  toolCount?: number;
};

export type DescribeThreadMcpConnectionsRequest = {
  federationTarget?: FederationRemoteTarget;
  backend: AppServerBackendKind;
  threadId: string;
};

export type DescribeThreadMcpConnectionsResponse = {
  backend: AppServerBackendKind;
  threadId: string;
  connections: ThreadMcpConnectionReport[];
  providerServersEnabled: boolean;
  appliesAt: McpSelectionApplyTiming;
  /**
   * When PwrAgent last handed this selection to the agent, in epoch ms.
   *
   * For a backend PwrAgent cannot interrogate this is the whole of the
   * honest answer: it states what was handed over and when, rather than
   * leaving the operator with silence.
   */
  handedOverAt?: number;
  /** Whether the backend can be asked what it actually loaded. */
  agentInventoryAvailable: boolean;
};
