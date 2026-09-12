import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { shell } from "electron";
import type { ConnectPwrGitResponse, OpenPwrGitResponse, PwrGitConnectionStatus } from "@pwragent/shared";
import { getMcpConnectionGatewayService, type McpConnectionGatewayService } from "./mcp-connection-gateway-service";

const ENDPOINT = "http://127.0.0.1:51731/mcp";
export type PwrGitConnectionServiceOptions = {
  gateway?: Pick<McpConnectionGatewayService, "listConnections" | "authorizeConnection" | "registerBridge">;
  fetchFn?: (input: string | URL, init?: RequestInit) => Promise<Response>;
  openExternal?: (url: string) => Promise<void>;
  openPath?: (path: string) => Promise<string>;
  resolveInstallPaths?: () => string[];
  launchPollAttempts?: number;
  launchPollDelayMs?: number;
};

function resolveDefaultPwrGitInstallPaths(): string[] {
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
      process.env["ProgramFiles(x86)"]
        ? join(process.env["ProgramFiles(x86)"]!, "PwrGit", "PwrGit.exe")
        : "",
    ].filter(Boolean);
  }
  return [
    "/usr/bin/pwrgit",
    "/opt/PwrGit/pwrgit",
    join(homedir(), "Applications", "PwrGit.AppImage"),
  ];
}

/** Product discovery/UI adapter only. The profile gateway owns OAuth and every relay. */
export class PwrGitConnectionService {
  private connectPromise?: Promise<ConnectPwrGitResponse>;

  constructor(private readonly options: PwrGitConnectionServiceOptions = {}) {}

  private get gateway() {
    // IPC registration can precede settings initialization.
    return this.options.gateway ?? getMcpConnectionGatewayService();
  }

  async readStatus(): Promise<PwrGitConnectionStatus> {
    const [connections, running] = await Promise.all([
      this.gateway.listConnections(), this.isEndpointAvailable(),
    ]);
    const installed = running || Boolean(this.findInstalledPath());
    const connection = connections.find((entry) => entry.id === "pwrgit");
    return {
      connectionId: "pwrgit",
      displayName: "PwrGit",
      availability: running ? "running" : installed ? "installed" : "not_installed",
      configured: connection?.configured ?? false,
      ...(!running && installed
        ? { detail: "PwrAgent cannot reach PwrGit. Open PwrGit and enable Local Agent Access." }
        : connection?.detail ? { detail: connection.detail } : {}),
    };
  }

  async openDownload(): Promise<OpenPwrGitResponse> {
    try {
      await (this.options.openExternal ?? shell.openExternal)("https://github.com/pwrdrvr/PwrGit/releases/latest");
      return { opened: true };
    } catch (error) {
      return { opened: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async openApplication(): Promise<OpenPwrGitResponse> {
    const path = this.findInstalledPath();
    if (!path) return { opened: false, error: "PwrGit is not installed." };
    const error = await (this.options.openPath ?? shell.openPath)(path);
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
    if (!(await this.isEndpointAvailable())) {
      if (this.findInstalledPath()) {
        await this.openApplication();
        for (let attempt = 0; attempt < (this.options.launchPollAttempts ?? 16); attempt += 1) {
          await delay(this.options.launchPollDelayMs ?? 500);
          if (await this.isEndpointAvailable()) break;
        }
      }
      if (!(await this.isEndpointAvailable())) {
        return { outcome: "needs_local_agent_access", status: await this.readStatus() };
      }
    }
    await this.gateway.authorizeConnection("pwrgit");
    return { outcome: "connected", status: await this.readStatus() };
  }

  private findInstalledPath(): string | undefined {
    return (this.options.resolveInstallPaths ?? resolveDefaultPwrGitInstallPaths)().find(existsSync);
  }

  private async isEndpointAvailable(): Promise<boolean> {
    const fetchFn = this.options.fetchFn ?? globalThis.fetch;
    try {
      const response = await fetchFn(ENDPOINT, { method: "GET", signal: AbortSignal.timeout(1_000) });
      if (!(response.ok || response.status === 401 || response.status === 405)) return false;
      const metadataResponse = await fetchFn(new URL("/.well-known/oauth-protected-resource/mcp", ENDPOINT), {
        signal: AbortSignal.timeout(1_000),
      });
      if (!metadataResponse.ok) return false;
      const metadata = await metadataResponse.json() as { resource?: unknown; resource_name?: unknown };
      return metadata?.resource === ENDPOINT && metadata.resource_name === "PwrGit";
    } catch {
      return false;
    }
  }
}

let service: PwrGitConnectionService | undefined;
export function getPwrGitConnectionService(): PwrGitConnectionService {
  service ??= new PwrGitConnectionService();
  return service;
}
