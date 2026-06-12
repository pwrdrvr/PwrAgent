import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import readline from "node:readline";
import type { JsonRpcTransport } from "@pwrdrvr/agent-transport";
import { getMainLogger } from "../log";
import {
  compareCodexCliVersions,
  resolveCodexCommand,
} from "@pwrdrvr/codex-discovery";

const codexTransportLog = getMainLogger("pwragent:codex-transport");

export type StdioJsonRpcTransportOptions = {
  command: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
};

export { compareCodexCliVersions };

export class StdioJsonRpcTransport implements JsonRpcTransport {
  private childProcess: ChildProcessWithoutNullStreams | null = null;
  private messageHandler: (message: string) => void = () => undefined;
  private closeHandler: (error?: Error) => void = () => undefined;

  constructor(private readonly options: StdioJsonRpcTransportOptions) {}

  setMessageHandler(handler: (message: string) => void): void {
    this.messageHandler = handler;
  }

  setCloseHandler(handler: (error?: Error) => void): void {
    this.closeHandler = handler;
  }

  async connect(): Promise<void> {
    if (this.childProcess) {
      return;
    }

    const env = this.options.env ?? process.env;
    const command = await resolveCodexCommand({
      command: this.options.command,
      env,
    });
    codexTransportLog.info("launch app-server", {
      command: command.command,
      source: command.source,
      version: command.version ?? null,
    });

    const child = spawn(command.command, ["app-server", ...(this.options.args ?? [])], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });

    if (!child.stdin || !child.stdout || !child.stderr) {
      throw new Error("codex app server stdio pipes unavailable");
    }

    this.childProcess = child;

    const stdoutReader = readline.createInterface({ input: child.stdout });
    stdoutReader.on("line", (line: string) => {
      this.messageHandler(line);
    });

    // Codex app-server diagnostics — transport fallbacks (e.g. dropping
    // from WebSocket to HTTPS), retries, and upstream errors — are written
    // to stderr, NOT the JSON-RPC stdout stream, so they never reach the
    // transcript or the `agentEvent` log. We used to discard stderr
    // entirely, which made those outages impossible to diagnose after the
    // fact. Line-buffer it and mirror each non-empty line into the
    // codex-transport log. Logged at info (captured without debug
    // collection) since severity isn't parseable from raw passthrough;
    // length-capped so a pathological line can't bloat the log file.
    const stderrReader = readline.createInterface({ input: child.stderr });
    stderrReader.on("line", (line: string) => {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        return;
      }
      codexTransportLog.info("app-server stderr", {
        line:
          trimmed.length > 4000
            ? `${trimmed.slice(0, 4000)}…[truncated]`
            : trimmed,
      });
    });
    child.on("error", (error: Error) => {
      this.closeHandler(error);
    });
    child.on("close", () => {
      this.childProcess = null;
      this.closeHandler();
    });
  }

  async close(): Promise<void> {
    const child = this.childProcess;
    this.childProcess = null;
    if (!child) {
      return;
    }
    child.kill();
  }

  send(message: string): void {
    const child = this.childProcess;
    if (!child?.stdin) {
      throw new Error("codex app server stdio not connected");
    }
    child.stdin.write(`${message}\n`);
  }
}
