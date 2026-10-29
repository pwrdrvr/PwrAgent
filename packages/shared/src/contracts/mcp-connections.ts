import type { AppServerBackendKind } from "./normalized-app-server";
import type { FederationRemoteTarget } from "./federation";
import { isAcpBackendId } from "./navigation";

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
 * Shown on the New thread PwrSnap band next to the Connect to PwrSnap button
 * after PwrSnap rejected the stored session.
 */
export const PWRSNAP_SESSION_REVOKED_DETAIL =
  "PwrSnap revoked this connection. Choose Connect to PwrSnap to connect again.";

export const MCP_CONNECTION_IDS = [
  PWRSNAP_MCP_CONNECTION_ID,
  PWRGIT_MCP_CONNECTION_ID,
  SANDBOXER_MCP_CONNECTION_ID,
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
export type McpConnectionAuthMode = "oauth" | "local_cli" | "none";

/** `stdio` is an operator-configured local command (an MCP stdio server). */
export type McpConnectionKind = "remote" | "pwrsnap" | "pwrgit" | "sandboxer" | "stdio";

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
   * Only the Sandboxer connection uses this. When true, PwrAgent stops or
   * deletes the sandboxes a thread created through this connection once
   * every PR attached to that thread has merged or closed.
   *
   * Optional because an owner broker from an older build answers without it;
   * absent reads as `true`.
   */
  sandboxerCleanupOnPrClose?: boolean;
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
  configured: boolean;
  detail?: string;
  /**
   * Live copies of a local command running on the owning machine right now:
   * one per thread session, plus a Settings test while it runs.
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
  return connections.map(({ sandboxerAccount: _account, stdio: _stdio, ...connection }) => {
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
 * Add a connection. Exactly one of `serverUrl` (a remote server that signs in
 * with OAuth) or `stdio` (a local command) is given.
 */
export type CreateMcpConnectionRequest = {
  displayName: string;
  serverUrl?: string;
  stdio?: McpStdioLaunchInput;
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

export type ConnectPwrSnapResponse = {
  status: PwrSnapConnectionStatus;
  outcome: "connected" | "needs_local_agent_access";
};

export type ConnectPwrGitResponse = {
  status: PwrGitConnectionStatus;
  outcome:
    | "connected"
    | "needs_local_agent_access"
    /**
     * PwrGit answered but pairing could not finish: its MCP server was not
     * found beside the app, it stopped answering, or the approved credential
     * could not be stored.
     */
    | "unavailable"
    | "declined"
    | "timed_out";
  /**
   * What to show for a non-connected outcome. Absent when `status.detail`
   * already says everything there is to say, so the card does not stack the
   * same sentence twice.
   */
  detail?: string;
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
  connectionId: McpConnectionId;
  displayName?: string;
  serverUrl?: string;
  /** Replaces a local command's launch. Restarts its running copies. */
  stdio?: McpStdioLaunchInput;
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
    }
  | {
      ok: false;
      problem: McpConnectionProbeProblem;
      /** One sentence, in the operator's terms, naming what to do instead. */
      message: string;
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
