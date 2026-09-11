import type { AppServerBackendKind } from "./normalized-app-server";
import type { FederationRemoteTarget } from "./federation";

export const PWRSNAP_MCP_CONNECTION_ID = "pwrsnap" as const;
export const PWRGIT_MCP_CONNECTION_ID = "pwrgit" as const;

/**
 * Shown on the New thread PwrSnap band next to the Connect to PwrSnap button
 * after PwrSnap rejected the stored session.
 */
export const PWRSNAP_SESSION_REVOKED_DETAIL =
  "PwrSnap revoked this connection. Choose Connect to PwrSnap to connect again.";

export const MCP_CONNECTION_IDS = [
  PWRSNAP_MCP_CONNECTION_ID,
  PWRGIT_MCP_CONNECTION_ID,
] as const;
export type McpConnectionId = string;

export type McpConnectionAuthMode = "oauth";

export type McpConnectionKind = "remote" | "pwrsnap" | "pwrgit";

export type McpConnectionRecord = {
  id: McpConnectionId;
  displayName: string;
  serverUrl: string;
  authMode: McpConnectionAuthMode;
  kind: McpConnectionKind;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
};

export type McpConnectionRuntimeState =
  | "disconnected"
  | "connecting"
  | "ready"
  | "refreshing"
  | "reauthorization_required"
  | "temporarily_unavailable";

export type McpConnectionStatus = McpConnectionRecord & {
  state: McpConnectionRuntimeState;
  configured: boolean;
  detail?: string;
};

export type ListMcpConnectionsResponse = {
  connections: McpConnectionStatus[];
};

export type CreateMcpConnectionRequest = {
  displayName: string;
  serverUrl: string;
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

export type RemoveMcpConnectionRequest = {
  connectionId: McpConnectionId;
};

export type MutateMcpConnectionResponse = {
  connectionId: McpConnectionId;
  removed?: true;
  connection?: McpConnectionStatus;
};


export function isMcpConnectionId(value: string): value is McpConnectionId {
  return (MCP_CONNECTION_IDS as readonly string[]).includes(value);
}

/** Product names for copy that has to name the app behind a connection id. */
export const MCP_CONNECTION_DISPLAY_NAMES: Record<McpConnectionId, string> = {
  [PWRSNAP_MCP_CONNECTION_ID]: "PwrSnap",
  [PWRGIT_MCP_CONNECTION_ID]: "PwrGit",
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
  backend: AppServerBackendKind;
  threadId: string;
  connectionIds: McpConnectionId[];
  providerServersEnabled?: boolean;
};

export type ReadThreadMcpConnectionsRequest = {
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
  return backend === "codex" ? "next_turn" : "next_session_load";
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
export function canIsolateMcpProviderServers(
  backend: AppServerBackendKind,
): boolean {
  return backend === "codex";
}

/** A connection PwrAgent reaches by launching a local PwrSuite application. */
export function isLocalMcpConnectionKind(kind: McpConnectionKind): boolean {
  return kind === "pwrsnap" || kind === "pwrgit";
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
    "Offered to threads. Choose it per thread under MCP access.",
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
): { ready: number; parked: number; needsSetup: number; total: number } {
  let ready = 0;
  let parked = 0;
  let needsSetup = 0;
  for (const summary of summaries) {
    if (summary.state === "ready") ready += 1;
    else if (summary.state === "parked") parked += 1;
    else needsSetup += 1;
  }
  return { ready, parked, needsSetup, total: summaries.length };
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
};

export type McpConnectionProbeProblem =
  /** The text is not a URL PwrAgent can fetch. */
  | "not_a_url"
  /** Looks like a command line for a stdio server, which the gateway cannot host. */
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
