import { spawn, type ChildProcess } from "node:child_process";
import { buildPwrAgentChildProcessEnv } from "../child-process-env";
import { discoverCommands } from "../settings/command-discovery";

export class CloudflareConnector {
  private child?: ChildProcess;
  private command?: string;
  private discovering?: Promise<boolean>;
  private generation = 0;
  running() { return Boolean(this.child && this.child.exitCode === null && !this.child.killed); }

  async installed(): Promise<boolean> {
    if (this.command) return true;
    if (this.discovering) return this.discovering;
    this.discovering = (async () => {
      const result = await discoverCommands({
        fixedCandidates: [],
        autoCandidates: [{ command: "cloudflared", source: "path" }],
        env: process.env,
        parseVersion: (text) => text.match(/\d{4}\.\d+\.\d+/)?.[0],
      });
      this.command = result.candidates.find((entry) => entry.selected)?.command;
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
