import { execFile } from "node:child_process";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpConnectionStatus } from "@pwragent/shared";

// Docker also installs an unrelated `sbx`. Never resolve this name on PATH.
export const SANDBOXER_CLI_PATH = "/usr/local/bin/sbx";
export const SANDBOXER_MCP_ARGS = ["mcp", "--type", "small", "--ttl", "1800"];

type CliStatus = Pick<McpConnectionStatus, "configured" | "state" | "detail" | "sandboxerCliState">;
type RunStatus = () => Promise<string>;

function sandboxerEnvironment(): Record<string, string> {
  const env = getDefaultEnvironment();
  for (const key of ["SANDBOXER_API_KEY", "SANDBOXER_API_URL", "SANDBOXER_ORG", "XDG_CONFIG_HOME"]) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  return env;
}

function runStatus(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(SANDBOXER_CLI_PATH, ["status", "--json", "--no-update"], {
      timeout: 8_000,
      maxBuffer: 256 * 1024,
      windowsHide: true,
      env: sandboxerEnvironment(),
    }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

/** Owns local CLI discovery only. Credentials remain owned by Sandboxer. */
export class SandboxerConnection {
  private cached?: { at: number; value: CliStatus };
  private pending?: Promise<CliStatus>;

  constructor(private readonly statusCommand: RunStatus = runStatus) {}

  /** Snapshot for latency-sensitive defaults reads; never starts or awaits a CLI. */
  cachedStatus(): CliStatus {
    return this.cached?.value ?? {
      configured: false,
      state: "connecting",
      detail: "Sandboxer CLI status has not been checked yet. Refresh status in Settings → Plugins.",
    };
  }

  async readStatus(refresh = false): Promise<CliStatus> {
    if (!refresh && this.cached && Date.now() - this.cached.at < 15_000) {
      return this.cached.value;
    }
    if (this.pending) return await this.pending;
    const pending = this.probe().then((value) => {
      this.cached = { at: Date.now(), value };
      return value;
    }).finally(() => {
      if (this.pending === pending) this.pending = undefined;
    });
    this.pending = pending;
    return await pending;
  }

  createTransport(): Transport {
    // Only the official built-in command is allowed. The SDK's default env
    // preserves HOME/PATH for the CLI login. Share only Sandboxer's overrides
    // with status, rather than the desktop's entire secret-bearing environment.
    return new StdioClientTransport({
      command: SANDBOXER_CLI_PATH,
      args: [...SANDBOXER_MCP_ARGS, "--no-update"],
      env: sandboxerEnvironment(),
      stderr: "ignore",
    });
  }

  private async probe(): Promise<CliStatus> {
    try {
      const status = JSON.parse(await this.statusCommand()) as { signedIn?: boolean; apiReachable?: boolean };
      if (typeof status.signedIn !== "boolean") throw new Error("Invalid CLI status");
      if (!status.signedIn) {
        return {
          configured: false, state: "disconnected", sandboxerCliState: "not_signed_in",
          detail: "Not signed in. Run /usr/local/bin/sbx login in a terminal, then refresh status. PwrAgent uses that local login.",
        };
      }
      if (status.apiReachable === false) throw new Error("API unavailable");
      return {
        configured: true, state: "ready", sandboxerCliState: "signed_in",
        detail: "Signed in through the Sandboxer CLI. Enable this connection, then select Sandboxer under a thread’s MCP access to use remote compute.",
      };
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException)?.code === "ENOENT";
      return {
        configured: false, state: "temporarily_unavailable",
        sandboxerCliState: missing ? "cli_missing" : "unavailable",
        detail: missing
          ? "Sandboxer CLI missing. Install the official CLI from https://sandboxer.com/docs/cli at /usr/local/bin/sbx, run /usr/local/bin/sbx login, then refresh status."
          : "Could not check Sandboxer. Run /usr/local/bin/sbx status in a terminal, check access and connectivity, then refresh status.",
      };
    }
  }
}
