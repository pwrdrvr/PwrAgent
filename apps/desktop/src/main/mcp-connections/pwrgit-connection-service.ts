import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { shell } from "electron";
import {
  PWRGIT_MCP_CONNECTION_ID,
  type ConnectPwrGitResponse,
  type OpenPwrGitResponse,
  type PwrGitConnectionStatus,
} from "@pwragent/shared";
import { getDesktopSettingsService } from "../settings/desktop-settings-singleton";
import type {
  McpConnectionBridgeRegistration,
  McpConnectionBridgeServer,
} from "./pwrsnap-connection-service";

/** PwrGit's loopback agent-access surface. PwrSnap owns 51729. */
const PWRGIT_AGENT_ACCESS_ORIGIN = "http://127.0.0.1:51731";
const PWRGIT_HEALTH_URL = `${PWRGIT_AGENT_ACCESS_ORIGIN}/health`;
const PWRGIT_PAIR_REQUEST_URL = `${PWRGIT_AGENT_ACCESS_ORIGIN}/pair/request`;
const PWRGIT_PAIR_POLL_URL = `${PWRGIT_AGENT_ACCESS_ORIGIN}/pair/poll`;
const PWRGIT_DOWNLOAD_URL = "https://pwrgit.com/download";

/** The operator has to notice the approval card and click it. */
const PAIR_TIMEOUT_MS = 90_000;
const PAIR_POLL_INTERVAL_MS = 1_000;

/**
 * What PwrGit hands back once the operator approves. Persisted in PwrAgent's
 * secret store, because the session token is a bearer credential for read
 * access to every repository in the granted role's scope.
 */
type PwrGitCredential = {
  token?: string;
  policyFile?: string;
  /** Absolute path to the single-file MCP server inside the PwrGit install. */
  scriptPath?: string;
  /** The PwrGit executable, run with ELECTRON_RUN_AS_NODE=1. */
  execPath?: string;
};

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
  resolveExecutable?: (installPath: string) => string | undefined;
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
  return [
    "/usr/bin/pwrgit",
    "/opt/PwrGit/pwrgit",
    join(homedir(), "Applications", "PwrGit.AppImage"),
  ];
}

/**
 * Where PwrGit ships the single-file stdio MCP server it packages in
 * extraResources. PwrAgent launches that directly rather than proxying MCP
 * through its own bridge: PwrGit's server needs only a bearer token in its
 * environment, so a proxy would add a hop and a lifetime dependency on
 * PwrAgent's main process without buying anything. The bridge exists for
 * PwrSnap because PwrSnap's OAuth tokens have to be refreshed by a process
 * that outlives a single agent launch.
 */
function defaultBundledScript(installPath: string): string | undefined {
  const candidates =
    process.platform === "darwin"
      ? [join(installPath, "Contents", "Resources", "pwrgit-mcp.mjs")]
      : [
          join(installPath, "..", "resources", "pwrgit-mcp.mjs"),
          join(installPath, "resources", "pwrgit-mcp.mjs"),
        ];
  return candidates.find((candidate) => existsSync(candidate));
}

function defaultExecutable(installPath: string): string | undefined {
  if (process.platform !== "darwin") {
    return existsSync(installPath) ? installPath : undefined;
  }
  const executable = join(installPath, "Contents", "MacOS", "PwrGit");
  return existsSync(executable) ? executable : undefined;
}

function parseCredential(value: string | undefined): PwrGitCredential {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as PwrGitCredential;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
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
  private readonly resolveExecutable: (
    installPath: string,
  ) => string | undefined;
  /** Resolved on first use, not in the constructor: the settings singleton
   * needs initialized app state, and merely constructing this service (which
   * IPC registration does) must not require it. */
  private readonly settingsOverride: PwrGitSettings | undefined;
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
    this.resolveExecutable = options.resolveExecutable ?? defaultExecutable;
    this.settingsOverride = options.settings;
    this.sleep = options.sleep ?? delay;
    this.now = options.now ?? (() => Date.now());
  }

  async readStatus(): Promise<PwrGitConnectionStatus> {
    const installed = this.findInstalledPath() !== undefined;
    const credential = await this.readCredential();
    const configured = Boolean(credential.token && credential.scriptPath);
    const health = await this.readHealth();

    if (!installed && health === "unreachable") {
      return {
        connectionId: PWRGIT_MCP_CONNECTION_ID,
        displayName: "PwrGit",
        availability: "not_installed",
        configured: false,
      };
    }
    if (health === "unreachable") {
      return {
        connectionId: PWRGIT_MCP_CONNECTION_ID,
        displayName: "PwrGit",
        availability: "installed",
        configured,
        detail: configured
          ? undefined
          : "Open PwrGit to connect it.",
      };
    }
    return {
      connectionId: PWRGIT_MCP_CONNECTION_ID,
      displayName: "PwrGit",
      availability: "running",
      configured,
      ...(health === "agent_access_off"
        ? {
            agentAccessDisabled: true,
            detail:
              "Turn on Settings → Agents → Local agent access in PwrGit, then connect.",
          }
        : {}),
    };
  }

  async openDownload(): Promise<OpenPwrGitResponse> {
    try {
      await this.openExternal(PWRGIT_DOWNLOAD_URL);
      return { opened: true };
    } catch (error) {
      return {
        opened: false,
        error: error instanceof Error ? error.message : String(error),
      };
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
      return {
        status: await this.readStatus(),
        outcome: "needs_local_agent_access",
        detail:
          health === "unreachable"
            ? "Open PwrGit, then turn on Settings → Agents → Local agent access."
            : "Turn on Settings → Agents → Local agent access in PwrGit.",
      };
    }

    const installPath = this.findInstalledPath();
    const scriptPath =
      installPath === undefined
        ? undefined
        : this.resolveBundledScript(installPath);
    const execPath =
      installPath === undefined
        ? undefined
        : this.resolveExecutable(installPath);
    if (scriptPath === undefined || execPath === undefined) {
      return {
        status: await this.readStatus(),
        outcome: "needs_local_agent_access",
        detail:
          "This PwrGit build does not ship the MCP server. Update PwrGit and try again.",
      };
    }

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
      return {
        status: await this.readStatus(),
        outcome: "needs_local_agent_access",
        detail: `PwrGit refused the pairing request (HTTP ${requested.status}).`,
      };
    }
    const ticket = (await requested.json()) as {
      pairingId: string;
      pollIntervalMs?: number;
    };

    const deadline = this.now() + PAIR_TIMEOUT_MS;
    const interval = Math.max(ticket.pollIntervalMs ?? PAIR_POLL_INTERVAL_MS, 250);
    while (this.now() < deadline) {
      await this.sleep(interval);
      const polled = await this.fetchFn(
        `${PWRGIT_PAIR_POLL_URL}?pairingId=${encodeURIComponent(ticket.pairingId)}`,
        { signal: AbortSignal.timeout(5_000) },
      );
      if (!polled.ok) continue;
      const result = (await polled.json()) as {
        status: string;
        token?: string;
        policyFile?: string;
        reason?: string;
      };
      if (result.status === "pending") continue;
      if (result.status === "denied") {
        return {
          status: await this.readStatus(),
          outcome: "declined",
          detail: result.reason ?? "PwrGit declined the request.",
        };
      }
      if (result.status !== "approved" || !result.token) {
        return {
          status: await this.readStatus(),
          outcome: "timed_out",
          detail: "The pairing request expired before it was approved.",
        };
      }
      await this.persistCredential({
        token: result.token,
        ...(result.policyFile === undefined
          ? {}
          : { policyFile: result.policyFile }),
        scriptPath,
        execPath,
      });
      return { status: await this.readStatus(), outcome: "connected" };
    }

    return {
      status: await this.readStatus(),
      outcome: "timed_out",
      detail: "PwrGit was not approved in time. Try connecting again.",
    };
  }

  /**
   * Returns the stdio launch the coding agent should use. There is no bridge
   * process and no per-thread grant to revoke: the credential is PwrGit's own
   * Session token, which the operator revokes in PwrGit.
   */
  async registerBridge(
    _connectionId: string,
    _threadId?: string,
  ): Promise<McpConnectionBridgeRegistration> {
    const credential = await this.readCredential();
    if (!credential.token || !credential.scriptPath || !credential.execPath) {
      throw new Error("PwrGit is not connected to PwrAgent.");
    }
    const server: McpConnectionBridgeServer = {
      name: PWRGIT_MCP_CONNECTION_ID,
      command: credential.execPath,
      args: [credential.scriptPath, "serve"],
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

  async disconnect(): Promise<void> {
    await this.settings.clearPwrGitMcpCredential();
  }

  private get settings(): PwrGitSettings {
    return this.settingsOverride ?? getDesktopSettingsService();
  }

  private findInstalledPath(): string | undefined {
    return this.resolveInstallPaths().find((candidate) => this.exists(candidate));
  }

  private async readCredential(): Promise<PwrGitCredential> {
    return parseCredential(await this.settings.resolvePwrGitMcpCredential());
  }

  private async persistCredential(credential: PwrGitCredential): Promise<void> {
    if (!credential.token) {
      await this.settings.clearPwrGitMcpCredential();
      return;
    }
    await this.settings.savePwrGitMcpCredential(JSON.stringify(credential));
  }

  /**
   * `agent_access_off` is the case worth separating: PwrGit is running but the
   * listener is off, so the card can name the switch instead of offering a
   * pairing that would never be answered.
   */
  private async readHealth(): Promise<
    "ready" | "agent_access_off" | "unreachable"
  > {
    try {
      const response = await this.fetchFn(PWRGIT_HEALTH_URL, {
        method: "GET",
        signal: AbortSignal.timeout(1_000),
      });
      if (!response.ok) return "agent_access_off";
      const health = (await response.json()) as { agentAccess?: boolean };
      return health.agentAccess === true ? "ready" : "agent_access_off";
    } catch {
      // A closed port means either PwrGit is not running or the listener is
      // off; `readStatus` disambiguates using the install check.
      return "unreachable";
    }
  }
}

let pwrGitConnectionService: PwrGitConnectionService | undefined;

export function getPwrGitConnectionService(): PwrGitConnectionService {
  pwrGitConnectionService ??= new PwrGitConnectionService();
  return pwrGitConnectionService;
}

export function resetPwrGitConnectionServiceForTests(): void {
  pwrGitConnectionService = undefined;
}
