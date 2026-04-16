import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import type { JsonRpcTransport } from "./json-rpc";

export type StdioJsonRpcTransportOptions = {
  command: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
};

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

    const child = spawn(this.options.command, ["app-server", ...(this.options.args ?? [])], {
      stdio: ["pipe", "pipe", "pipe"],
      env: this.options.env ?? process.env
    });

    if (!child.stdin || !child.stdout || !child.stderr) {
      throw new Error("codex app server stdio pipes unavailable");
    }

    this.childProcess = child;

    const stdoutReader = readline.createInterface({ input: child.stdout });
    stdoutReader.on("line", (line: string) => {
      this.messageHandler(line);
    });

    child.stderr.on("data", () => undefined);
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
