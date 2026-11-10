import { externalLinks as shell } from "../owner-host";
import { existsSync } from "node:fs";
import type { ConnectPwrGitResponse, OpenPwrGitResponse, PwrGitConnectionStatus } from "@pwragent/shared";
import {
  getMcpConnectionGatewayService,
  pwrSuiteUpdateDetail,
  type McpConnectionGatewayService,
} from "./mcp-connection-gateway-service";
import { defaultPwrSuiteInstallPaths, isPwrSuiteEndpointListening } from "./pwrsuite-relay";

const NOT_LISTENING_DETAIL = "Open PwrGit and turn on Local Agent Access to connect agents.";

export type PwrGitConnectionServiceOptions = {
  gateway?: Pick<McpConnectionGatewayService, "listConnections" | "authorizeConnection" | "registerBridge">;
  /** Whether PwrGit's local MCP socket or pipe accepts a connection. */
  isListening?: () => Promise<boolean>;
  openExternal?: (url: string) => Promise<void>;
  openPath?: (path: string) => Promise<string>;
  resolveInstallPaths?: () => string[];
};

/**
 * Product discovery/UI adapter only. The profile gateway owns every relay.
 *
 * PwrGit 0.56.0 and later serve MCP only over a protected Unix socket or
 * Windows named pipe. The gateway reaches it through the `pwrgit-mcp` relay
 * inside the PwrGit install, and PwrGit approves each session in its own
 * window, so there is nothing here to sign in to.
 */
export class PwrGitConnectionService {
  private connectPromise?: Promise<ConnectPwrGitResponse>;

  constructor(private readonly options: PwrGitConnectionServiceOptions = {}) {}

  private get gateway() {
    // IPC registration can precede settings initialization.
    return this.options.gateway ?? getMcpConnectionGatewayService();
  }

  async readStatus(): Promise<PwrGitConnectionStatus> {
    const [connections, listening] = await Promise.all([
      this.gateway.listConnections(), this.isListening(),
    ]);
    const installed = listening || Boolean(this.findInstalledPath());
    const connection = connections.find((entry) => entry.id === "pwrgit");
    // The gateway reports configured once this machine has a PwrGit with
    // the relay; an older PwrGit only serves the retired loopback OAuth.
    const configured = connection?.configured ?? false;
    const detail = !installed
      ? undefined
      : !configured
        ? connection?.detail ?? pwrSuiteUpdateDetail("pwrgit")
        : !listening
          ? NOT_LISTENING_DETAIL
          : undefined;
    return {
      connectionId: "pwrgit",
      displayName: "PwrGit",
      availability: listening ? "running" : installed ? "installed" : "not_installed",
      configured,
      ...(detail ? { detail } : {}),
    };
  }

  async openDownload(): Promise<OpenPwrGitResponse> {
    try {
      const url = "https://github.com/pwrdrvr/PwrGit/releases/latest";
      if (this.options.openExternal) await this.options.openExternal(url);
      else await shell.openExternal(url);
      return { opened: true };
    } catch (error) {
      return { opened: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async openApplication(): Promise<OpenPwrGitResponse> {
    const path = this.findInstalledPath();
    if (!path) return { opened: false, error: "PwrGit is not installed." };
    const error = this.options.openPath
      ? await this.options.openPath(path)
      : await shell.openPath(path);
    return error ? { opened: false, error } : { opened: true };
  }

  async connect(): Promise<ConnectPwrGitResponse> {
    this.connectPromise ??= this.connectNow().finally(() => { this.connectPromise = undefined; });
    return await this.connectPromise;
  }

  async registerBridge(connectionId: string, threadId?: string) {
    if (connectionId !== "pwrgit") throw new Error("Expected the PwrGit connection.");
    return await this.gateway.registerBridge(connectionId, threadId);
  }

  private async connectNow(): Promise<ConnectPwrGitResponse> {
    const status = await this.readStatus();
    if (status.availability !== "not_installed" && !status.configured) {
      return { outcome: "needs_update", status };
    }
    if (status.availability !== "running") {
      return { outcome: "needs_local_agent_access", status };
    }
    await this.gateway.authorizeConnection("pwrgit");
    return { outcome: "connected", status };
  }

  private findInstalledPath(): string | undefined {
    return (this.options.resolveInstallPaths ?? (() => defaultPwrSuiteInstallPaths("pwrgit")))().find(existsSync);
  }

  private async isListening(): Promise<boolean> {
    return await (this.options.isListening ?? (async () => await isPwrSuiteEndpointListening("pwrgit")))();
  }
}

let service: PwrGitConnectionService | undefined;
export function getPwrGitConnectionService(): PwrGitConnectionService {
  service ??= new PwrGitConnectionService();
  return service;
}
