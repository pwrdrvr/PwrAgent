import { spawn, type ChildProcess } from "node:child_process";
import { buildPwrAgentChildProcessEnv } from "../child-process-env";
import { discoverCommands } from "../settings/command-discovery";

export class CloudflareConnector {
  private child?: ChildProcess;
  private command?: string;
  private installedVersion?: string;
  private discoveredAt = 0;
  private discovering?: Promise<boolean>;
  private generation = 0;
  running() { return Boolean(this.child && this.child.exitCode === null && !this.child.killed); }

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
        autoCandidates: [{ command: "cloudflared", source: "path" }],
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
    if (!await this.installed() || !this.command) throw new Error("Install cloudflared, then try again.");
    if (generation !== this.generation) return;
    if (this.running()) return;
    const child = spawn(this.command, ["tunnel", "--no-autoupdate", "run"], {
      env: { ...buildPwrAgentChildProcessEnv(process.env), TUNNEL_TOKEN: token },
      windowsHide: true,
      stdio: "ignore",
    });
    this.child = child;
    child.once("exit", () => { if (this.child === child) this.child = undefined; });
    child.on("error", () => { if (this.child === child) this.child = undefined; });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", () => reject(new Error("cloudflared could not start. Check the installation.")));
    });
  }

  async stop(): Promise<void> {
    this.generation++;
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
