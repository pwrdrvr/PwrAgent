import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { shell } from "electron";
import {
  PWRGIT_MCP_CONNECTION_ID,
  type ConnectPwrGitResponse,
  type OpenPwrGitResponse,
  type PwrGitConnectionStatus,
} from "@pwragent/shared";
import { getMainLogger } from "../log";
import { getDesktopSettingsService } from "../settings/desktop-settings-singleton";
import type {
  McpConnectionBridgeRegistration,
  McpConnectionBridgeServer,
} from "./pwrsnap-connection-service";

const connectionLog = getMainLogger("pwragent:mcp-connections");

/** PwrGit's loopback agent-access surface. PwrSnap owns 51729. */
const PWRGIT_AGENT_ACCESS_ORIGIN = "http://127.0.0.1:51731";
const PWRGIT_HEALTH_URL = `${PWRGIT_AGENT_ACCESS_ORIGIN}/health`;
const PWRGIT_PAIR_REQUEST_URL = `${PWRGIT_AGENT_ACCESS_ORIGIN}/pair/request`;
const PWRGIT_PAIR_POLL_URL = `${PWRGIT_AGENT_ACCESS_ORIGIN}/pair/poll`;
/** What PwrGit's `/health` reports. Anything else on the port is not PwrGit. */
const PWRGIT_AGENT_ACCESS_PROTOCOL = "pwrgit.agent-access/v1";
/** PwrGit publishes releases on GitHub; pwrgit.com has no download route. */
const PWRGIT_DOWNLOAD_URL = "https://github.com/pwrdrvr/PwrGit/releases/latest";

/**
 * PwrGit keeps a pairing request alive for five minutes and mints the session
 * the moment the operator approves, whether or not anyone is still polling.
 * Giving up sooner would leave that session with no client to hold it. This
 * is also the window PwrSnap's OAuth callback waits.
 */
const PAIR_TIMEOUT_MS = 5 * 60_000;
const PAIR_POLL_INTERVAL_MS = 1_000;
const PAIR_POLL_MIN_INTERVAL_MS = 250;
const PAIR_POLL_MAX_INTERVAL_MS = 5_000;

const LOCAL_AGENT_ACCESS_SWITCH = "Settings → Agents → Local agent access";

/**
 * What PwrGit hands back once the operator approves. Persisted in PwrAgent's
 * secret store, because the session token is a bearer credential for read
 * access to every repository in the granted role's scope.
 *
 * Nothing about where PwrGit is installed is stored: the launch is resolved
 * every time it is needed, so moving or reinstalling PwrGit does not strand
 * the credential behind a path that no longer exists.
 */
type PwrGitCredential = {
  token?: string;
  policyFile?: string;
};

type PairingTicket = {
  pairingId: string;
  pollIntervalMs: number;
};

type PairingPollResult =
  | { status: "pending" | "expired" }
  | { status: "denied"; reason?: string }
  | { status: "approved"; token: string; policyFile?: string };

type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

type PwrGitSettings = Pick<
  ReturnType<typeof getDesktopSettingsService>,
  | "clearPwrGitMcpCredential"
  | "resolvePwrGitMcpCredential"
  | "savePwrGitMcpCredential"
>;

export type PwrGitConnectionServiceOptions = {
  fetchFn?: FetchLike;
  openExternal?: (url: string) => Promise<void>;
  openPath?: (path: string) => Promise<string>;
  resolveInstallPaths?: () => string[];
  /** Existence check for the resolved install path. Injectable so a test does
   * not silently depend on whether PwrGit happens to be installed on the
   * machine running it — locally that made three pairing tests pass and fail
   * on every CI runner. */
  exists?: (path: string) => boolean;
  resolveBundledScript?: (installPath: string) => string | undefined;
  settings?: PwrGitSettings;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

export function resolveDefaultPwrGitInstallPaths(): string[] {
  if (process.platform === "darwin") {
    return [
      "/Applications/PwrGit.app",
      join(homedir(), "Applications", "PwrGit.app"),
    ];
  }
  if (process.platform === "win32") {
    return [
      process.env.LOCALAPPDATA
        ? join(process.env.LOCALAPPDATA, "Programs", "PwrGit", "PwrGit.exe")
        : "",
      process.env.ProgramFiles
        ? join(process.env.ProgramFiles, "PwrGit", "PwrGit.exe")
        : "",
    ].filter(Boolean);
  }
  // The deb installs the app under /opt and symlinks /usr/bin/pwrgit to it.
  // The real location comes first so the bundled server is found beside it.
  return [
    "/opt/PwrGit/pwrgit",
    "/usr/bin/pwrgit",
    join(homedir(), "Applications", "PwrGit.AppImage"),
  ];
}

/**
 * Where PwrGit ships the single-file stdio MCP server it packages in
 * extraResources: inside the bundle on macOS, in `resources/` beside the
 * executable elsewhere. A launcher symlink is resolved first, so that
 * `/usr/bin/pwrgit` finds `/opt/PwrGit/resources`, not `/usr/bin/resources`.
 */
function defaultBundledScript(installPath: string): string | undefined {
  if (process.platform === "darwin") {
    const candidate = join(installPath, "Contents", "Resources", "pwrgit-mcp.mjs");
    return existsSync(candidate) ? candidate : undefined;
  }
  const executable = realpathOrSelf(installPath);
  return [
    join(executable, "..", "resources", "pwrgit-mcp.mjs"),
    join(executable, "resources", "pwrgit-mcp.mjs"),
  ].find((candidate) => existsSync(candidate));
}

function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseCredential(value: string | undefined): PwrGitCredential {
  if (!value) return {};
  try {
    return asRecord(JSON.parse(value)) ?? {};
  } catch {
    return {};
  }
}

/**
 * The wire shapes come from another app, so they are checked rather than
 * cast: a ticket without an id would poll `?pairingId=undefined` for five
 * minutes, and a non-numeric interval would turn `Math.max` into NaN and the
 * poll loop into a tight one.
 */
function parsePairingTicket(value: unknown): PairingTicket {
  const record = asRecord(value);
  const pairingId = record?.pairingId;
  if (typeof pairingId !== "string" || pairingId.length === 0) {
    throw new Error("PwrGit returned a pairing ticket without an id.");
  }
  const requested = record?.pollIntervalMs;
  const interval =
    typeof requested === "number" && Number.isFinite(requested)
      ? requested
      : PAIR_POLL_INTERVAL_MS;
  return {
    pairingId,
    pollIntervalMs: Math.min(
      Math.max(interval, PAIR_POLL_MIN_INTERVAL_MS),
      PAIR_POLL_MAX_INTERVAL_MS,
    ),
  };
}

function parsePollResult(value: unknown): PairingPollResult {
  const record = asRecord(value);
  const status = record?.status;
  if (status === "pending" || status === "expired") return { status };
  if (status === "denied") {
    return {
      status,
      ...(typeof record?.reason === "string" ? { reason: record.reason } : {}),
    };
  }
  if (
    status === "approved"
    && typeof record?.token === "string"
    && record.token.length > 0
  ) {
    return {
      status,
      token: record.token,
      ...(typeof record.policyFile === "string"
        ? { policyFile: record.policyFile }
        : {}),
    };
  }
  throw new Error("PwrGit returned an unrecognized pairing state.");
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class PwrGitConnectionService {
  private readonly fetchFn: FetchLike;
  private readonly openExternal: (url: string) => Promise<void>;
  private readonly openPath: (path: string) => Promise<string>;
  private readonly resolveInstallPaths: () => string[];
  private readonly exists: (path: string) => boolean;
  private readonly resolveBundledScript: (
    installPath: string,
  ) => string | undefined;
  private readonly settings: PwrGitSettings;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private connectPromise?: Promise<ConnectPwrGitResponse>;

  constructor(options: PwrGitConnectionServiceOptions = {}) {
    this.fetchFn = options.fetchFn ?? ((input, init) => fetch(input, init));
    this.openExternal =
      options.openExternal ?? (async (url) => await shell.openExternal(url));
    this.openPath = options.openPath ?? ((path) => shell.openPath(path));
    this.resolveInstallPaths =
      options.resolveInstallPaths ?? resolveDefaultPwrGitInstallPaths;
    this.exists = options.exists ?? existsSync;
    this.resolveBundledScript =
      options.resolveBundledScript ?? defaultBundledScript;
    this.settings = options.settings ?? getDesktopSettingsService();
    this.sleep = options.sleep ?? delay;
    this.now = options.now ?? (() => Date.now());
  }

  async readStatus(): Promise<PwrGitConnectionStatus> {
    const [credential, health] = await Promise.all([
      this.readCredential(),
      this.readHealth(),
    ]);
    // A listener that answers is proof of an install; only probe the disk
    // when it does not.
    const installed =
      health !== "unreachable" || this.findInstalledPath() !== undefined;
    const configured = Boolean(credential.token);

    if (!installed) {
      return {
        connectionId: PWRGIT_MCP_CONNECTION_ID,
        displayName: "PwrGit",
        availability: "not_installed",
        configured: false,
      };
    }
    if (health === "unreachable") {
      // PwrGit only listens while Local agent access is on, so "installed but
      // silent" is the state in which the operator needs to hear about the
      // switch. Once paired, the stdio server runs without the app.
      return {
        connectionId: PWRGIT_MCP_CONNECTION_ID,
        displayName: "PwrGit",
        availability: "installed",
        configured,
        ...(configured
          ? {}
          : {
              detail: `Open PwrGit and turn on ${LOCAL_AGENT_ACCESS_SWITCH} to connect it.`,
            }),
      };
    }
    return {
      connectionId: PWRGIT_MCP_CONNECTION_ID,
      displayName: "PwrGit",
      availability: "running",
      configured,
      ...(health === "agent_access_off"
        ? { detail: `Turn on ${LOCAL_AGENT_ACCESS_SWITCH} in PwrGit, then connect.` }
        : {}),
    };
  }

  async openDownload(): Promise<OpenPwrGitResponse> {
    try {
      await this.openExternal(PWRGIT_DOWNLOAD_URL);
      return { opened: true };
    } catch (error) {
      return { opened: false, error: describeError(error) };
    }
  }

  async openApplication(): Promise<OpenPwrGitResponse> {
    const installPath = this.findInstalledPath();
    if (!installPath) {
      return { opened: false, error: "PwrGit is not installed." };
    }
    const failure = await this.openPath(installPath);
    return failure ? { opened: false, error: failure } : { opened: true };
  }

  /** Serialized: two cards racing would produce two approval prompts. */
  async connect(): Promise<ConnectPwrGitResponse> {
    this.connectPromise ??= this.connectNow().finally(() => {
      this.connectPromise = undefined;
    });
    return await this.connectPromise;
  }

  private async connectNow(): Promise<ConnectPwrGitResponse> {
    const health = await this.readHealth();
    if (health !== "ready") {
      // `status.detail` already names the switch; adding a second sentence
      // would only stack the same instruction twice on the card.
      return await this.respond("needs_local_agent_access");
    }
    if (this.resolveScriptPath() === undefined) {
      return await this.respond(
        "unavailable",
        "PwrGit is running, but PwrAgent could not find its MCP server beside the app. Reinstall PwrGit in Applications (or /opt/PwrGit on Linux) and try again.",
      );
    }

    let ticket: PairingTicket;
    try {
      const requested = await this.fetchFn(PWRGIT_PAIR_REQUEST_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientName: "PwrAgent",
          requestedRoleId: "builtin.live-status",
        }),
        signal: AbortSignal.timeout(5_000),
      });
      if (!requested.ok) {
        return await this.respond(
          "unavailable",
          `PwrGit refused the pairing request (HTTP ${requested.status}).`,
        );
      }
      ticket = parsePairingTicket(await requested.json());
    } catch (error) {
      return await this.respond(
        "unavailable",
        `PwrGit stopped answering during pairing: ${describeError(error)}`,
      );
    }

    const deadline = this.now() + PAIR_TIMEOUT_MS;
    while (this.now() < deadline) {
      await this.sleep(
        Math.min(ticket.pollIntervalMs, Math.max(0, deadline - this.now())),
      );
      let result: PairingPollResult;
      try {
        const polled = await this.fetchFn(
          `${PWRGIT_PAIR_POLL_URL}?pairingId=${encodeURIComponent(ticket.pairingId)}`,
          { signal: AbortSignal.timeout(5_000) },
        );
        // Transient server errors are retried; an unknown or expired pairing
        // answers 200 with `expired`, so this never masks a terminal state.
        if (!polled.ok) continue;
        result = parsePollResult(await polled.json());
      } catch (error) {
        // One slow or dropped poll must not abandon a pairing the operator is
        // looking at: PwrGit would still hand the token out on the next one.
        connectionLog.warn("pwrgit pairing poll failed", {
          error: describeError(error),
        });
        continue;
      }
      if (result.status === "pending") continue;
      if (result.status === "denied") {
        return await this.respond(
          "declined",
          result.reason ?? "PwrGit declined the request.",
        );
      }
      if (result.status !== "approved") {
        return await this.respond(
          "timed_out",
          "The pairing request expired before it was approved.",
        );
      }
      try {
        await this.persistCredential({
          token: result.token,
          ...(result.policyFile === undefined
            ? {}
            : { policyFile: result.policyFile }),
        });
      } catch (error) {
        // PwrGit hands the token out exactly once and has already recorded
        // the session, so the operator has to clean that up before retrying.
        return await this.respond(
          "unavailable",
          `PwrGit approved the connection, but PwrAgent could not store the credential (${describeError(error)}). Revoke the PwrAgent session in PwrGit under ${LOCAL_AGENT_ACCESS_SWITCH}, then connect again.`,
        );
      }
      return await this.respond("connected");
    }

    return await this.respond(
      "timed_out",
      "PwrGit was not approved in time. Try connecting again.",
    );
  }

  /**
   * Returns the stdio launch the coding agent should use, or `undefined` when
   * there is nothing to launch: like PwrSnap, a thread that enabled the
   * connection must keep starting turns after the credential is gone or
   * PwrGit is uninstalled, so this never throws for an operator state. There
   * is no bridge process and no per-thread grant to revoke; the credential is
   * PwrGit's own Session token, which the operator revokes in PwrGit.
   *
   * The script runs under PwrAgent's own runtime, never PwrGit's: PwrGit
   * ships with Electron's `runAsNode` fuse off, so `ELECTRON_RUN_AS_NODE`
   * against its binary would open the PwrGit window instead. PwrAgent's build
   * keeps the fuse on for exactly this kind of helper, and the script is
   * plain JavaScript with no native modules.
   */
  async registerBridge(
    _connectionId: string,
    _threadId?: string,
  ): Promise<McpConnectionBridgeRegistration | undefined> {
    const credential = await this.readCredential();
    if (!credential.token) {
      connectionLog.warn("pwrgit is not connected; skipping its MCP server");
      return undefined;
    }
    const scriptPath = this.resolveScriptPath();
    if (scriptPath === undefined) {
      connectionLog.warn("pwrgit MCP server not found; skipping it", {
        installPaths: this.resolveInstallPaths(),
      });
      return undefined;
    }
    const server: McpConnectionBridgeServer = {
      name: PWRGIT_MCP_CONNECTION_ID,
      command: process.execPath,
      args: [scriptPath, "serve"],
      env: {
        ELECTRON_RUN_AS_NODE: "1",
        PWRGIT_MCP_SESSION_TOKEN: credential.token,
        ...(credential.policyFile === undefined
          ? {}
          : { PWRGIT_MCP_POLICY_FILE: credential.policyFile }),
      },
    };
    return {
      server,
      bindThread: () => undefined,
      revoke: () => undefined,
    };
  }

  private async respond(
    outcome: ConnectPwrGitResponse["outcome"],
    detail?: string,
  ): Promise<ConnectPwrGitResponse> {
    return {
      status: await this.readStatus(),
      outcome,
      ...(detail === undefined ? {} : { detail }),
    };
  }

  private findInstalledPath(): string | undefined {
    return this.resolveInstallPaths().find((candidate) => this.exists(candidate));
  }

  private resolveScriptPath(): string | undefined {
    const installPath = this.findInstalledPath();
    return installPath === undefined
      ? undefined
      : this.resolveBundledScript(installPath);
  }

  private async readCredential(): Promise<PwrGitCredential> {
    return parseCredential(await this.settings.resolvePwrGitMcpCredential());
  }

  private async persistCredential(
    credential: PwrGitCredential & { token: string },
  ): Promise<void> {
    await this.settings.savePwrGitMcpCredential(JSON.stringify(credential));
  }

  /**
   * PwrGit only listens while Local agent access is on, so today a closed
   * port is the "switch is off" signal and `agent_access_off` is kept for a
   * PwrGit that one day answers while off. The protocol field is what
   * separates PwrGit from any other local process that happens to own the
   * port.
   */
  private async readHealth(): Promise<
    "ready" | "agent_access_off" | "unreachable"
  > {
    try {
      const response = await this.fetchFn(PWRGIT_HEALTH_URL, {
        method: "GET",
        signal: AbortSignal.timeout(1_000),
      });
      if (!response.ok) return "unreachable";
      const health = asRecord(await response.json());
      if (health?.protocol !== PWRGIT_AGENT_ACCESS_PROTOCOL) return "unreachable";
      return health.agentAccess === true ? "ready" : "agent_access_off";
    } catch {
      return "unreachable";
    }
  }
}

let pwrGitConnectionService: PwrGitConnectionService | undefined;

export function getPwrGitConnectionService(): PwrGitConnectionService {
  pwrGitConnectionService ??= new PwrGitConnectionService();
  return pwrGitConnectionService;
}
