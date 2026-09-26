import { spawn, type ChildProcess } from "node:child_process";
import type { CloudflareSetupStatus } from "@pwragent/shared";
import { buildPwrAgentChildProcessEnv } from "../child-process-env";
import { discoverCommands } from "../settings/command-discovery";

export class CloudflareConnector {
  private child?: ChildProcess;
  private command?: string;
  private installedVersion?: string;
  private discoveredAt = 0;
  private discovering?: Promise<boolean>;
  private generation = 0;
  private metricsUrl?: string;
  private lastFailure?: string;
  running() { return Boolean(this.child && this.child.exitCode === null && !this.child.killed); }

  async health(): Promise<NonNullable<CloudflareSetupStatus["connectorHealth"]>> {
    const child = this.child;
    if (!this.running()) return this.lastFailure
      ? { state: "failed", detail: this.lastFailure }
      : { state: "stopped" };
    if (!this.metricsUrl) return { state: "unavailable", detail: "Waiting for the connector’s readiness address." };
    try {
      const response = await fetch(`${this.metricsUrl}/ready`, {
        signal: AbortSignal.timeout(1500), redirect: "error",
      });
      await response.body?.cancel();
      // A stop or replacement while awaiting HTTP invalidates this evidence.
      if (child !== this.child || !this.running()) return { state: "stopped" };
      if (response.status === 200) return { state: "connected" };
      if (response.status === 503) return { state: "connecting", detail: "No active connection to Cloudflare’s edge." };
      return { state: "unavailable", detail: "The connector’s readiness check returned an unexpected response." };
    } catch {
      return child !== this.child || !this.running() ? { state: "stopped" }
        : { state: "unavailable", detail: "The connector’s readiness check could not be reached." };
    }
  }

  /**
   * Whether cloudflared is on this computer. A missing one is looked for again
   * at most every 30 seconds: discovery tries to run it, and absent is the
   * usual answer on a client machine, whose setup pane reads status each second
   * while a sign-in waits. `version({ refresh: true })` looks right away.
   */
  async installed(): Promise<boolean> {
    if (this.command) return true;
    if (this.discoveredAt && Date.now() - this.discoveredAt <= 30_000) return false;
    return this.discover();
  }

  /**
   * The installed version, re-read on request and otherwise at most every 30
   * seconds, so an update made while PwrAgent runs is seen without a restart.
   * The running connector keeps the binary it started with until it is stopped
   * and started again.
   */
  async version(options: { refresh?: boolean } = {}): Promise<string | undefined> {
    if (options.refresh || Date.now() - this.discoveredAt > 30_000) await this.discover();
    return this.installedVersion;
  }

  private async discover(): Promise<boolean> {
    if (this.discovering) return this.discovering;
    this.discovering = (async () => {
      const result = await discoverCommands({
        fixedCandidates: [],
        autoCandidates: [
          { command: "cloudflared", source: "path" },
          // Finder-launched macOS apps do not inherit Homebrew's shell PATH.
          ...(process.platform === "darwin" ? [
            { command: "/opt/homebrew/bin/cloudflared", source: "homebrew" },
            { command: "/usr/local/bin/cloudflared", source: "homebrew" },
            { command: "/opt/local/bin/cloudflared", source: "macports" },
          ] : []),
        ],
        env: process.env,
        parseVersion: (text) => text.match(/\d{4}\.\d+\.\d+/)?.[0],
      });
      const selected = result.candidates.find((entry) => entry.selected);
      this.command = selected?.command;
      this.installedVersion = selected?.version;
      this.discoveredAt = Date.now();
      return Boolean(this.command);
    })();
    try { return await this.discovering; } finally { this.discovering = undefined; }
  }

  async start(token: string): Promise<void> {
    if (this.running()) return;
    const generation = this.generation;
    if (!await this.installed() || !this.command) {
      this.lastFailure = "PwrAgent could not find an executable cloudflared. Check the installation, then check again.";
      throw new Error(this.lastFailure);
    }
    if (generation !== this.generation) return;
    if (this.running()) return;
    this.metricsUrl = undefined;
    this.lastFailure = undefined;
    const child = spawn(this.command, ["--output", "json", "tunnel", "--no-autoupdate", "--metrics", "127.0.0.1:0", "run"], {
      env: { ...buildPwrAgentChildProcessEnv(process.env), TUNNEL_TOKEN: token },
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    this.child = child;
    // Learn the OS-assigned port from this child's structured output. Never
    // probe a shared default port: another profile may own that connector.
    // Keep only a bounded partial line, and never persist raw logs or tokens.
    let pending = "";
    let dropping = false;
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      if (this.child !== child) return;
      for (const part of chunk.split(/(?<=\n)/)) {
        if (!dropping) pending += part;
        if (pending.length > 16_384) { pending = ""; dropping = true; }
        if (!part.endsWith("\n")) continue;
        if (!dropping) {
          try {
            const entry = JSON.parse(pending) as { message?: string };
            const port = typeof entry.message === "string"
              ? entry.message.match(/^Starting metrics server on 127\.0\.0\.1:(\d+)\/metrics$/)?.[1]
              : undefined;
            if (port && Number(port) > 0 && Number(port) <= 65535) this.metricsUrl = `http://127.0.0.1:${port}`;
          } catch { /* Older or unstructured output is not readiness evidence. */ }
        }
        pending = "";
        dropping = false;
      }
    });
    child.once("exit", (code, signal) => {
      if (this.child !== child) return;
      this.child = undefined;
      this.metricsUrl = undefined;
      this.lastFailure = `cloudflared exited (${signal ?? code ?? "unknown"}). Start the connector to try again.`;
    });
    child.on("error", () => {
      if (this.child !== child) return;
      this.child = undefined;
      this.metricsUrl = undefined;
      this.lastFailure = "cloudflared could not start. Check the installation and executable permissions.";
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", () => reject(new Error("cloudflared could not start. Check the installation.")));
    });
  }

  async stop(): Promise<void> {
    this.generation++;
    this.metricsUrl = undefined;
    this.lastFailure = undefined;
    const child = this.child;
    if (!child) return;
    this.child = undefined;
    if (child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
      child.kill("SIGTERM");
    });
  }
}

export const cloudflareConnector = new CloudflareConnector();
