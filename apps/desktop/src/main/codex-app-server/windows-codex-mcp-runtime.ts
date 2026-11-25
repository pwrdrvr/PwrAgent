import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { isAbsolute } from "node:path";
import type { Readable, Writable } from "node:stream";
import { nativeRelayPath } from "../native-relay-path";

const RELAY_PREFIX = "\\\\.\\pipe\\pwa-codex-relay-";
const OWNER_PREFIX = "\\\\.\\pipe\\pwa-codex-owner-";
const OWNER_STREAM_LIMIT = 96;
const READY_TIMEOUT = 5_000;

export const WINDOWS_CODEX_MCP_SERVER_PID = "PWRAGENT_CODEX_MCP_SERVER_PID";

/** Microsoft CRT command-line quoting, including runs of trailing backslashes. */
export function windowsCodexArgument(value: string): string {
  return '"' + value.replace(/(\\*)"/gu, '$1$1\\"').replace(/(\\+)$/u, "$1$1") + '"';
}

export class WindowsCodexMcpRuntime {
  readonly child;
  readonly endpoint: string;
  readonly ready: Promise<number>;
  private readonly lifetime: Writable;
  private readonly streams = new Set<Socket>();
  private accept?: (socket: Socket) => void;
  private stopped = false;

  constructor(executable: string, args: string[], env: NodeJS.ProcessEnv, helper = nativeRelayPath()) {
    if (process.platform !== "win32" || !isAbsolute(executable)) {
      throw new Error("Windows MCP requires a local native runtime and owner.");
    }
    this.endpoint = RELAY_PREFIX + randomUUID();
    const commandLine = [executable, ...args].map(windowsCodexArgument).join(" ");
    this.child = spawn(helper, ["--codex-windows-supervisor", this.endpoint, executable, commandLine, String(process.pid)], {
      stdio: ["pipe", "pipe", "pipe", "pipe", "overlapped"], env, windowsHide: true,
    }) as ChildProcessWithoutNullStreams;
    this.lifetime = (this.child.stdio as readonly unknown[])[3] as Writable;
    const events = (this.child.stdio as readonly unknown[])[4] as Readable;
    this.lifetime.on("error", () => this.stop());
    this.ready = new Promise((resolve, reject) => {
      let pending = "";
      let ready = false;
      const failed = () => {
        clearTimeout(timeout);
        this.stop();
        reject(new Error("The Windows Codex supervisor did not establish launch ownership."));
      };
      const timeout = setTimeout(failed, READY_TIMEOUT);
      timeout.unref();
      this.child.once("error", failed);
      this.child.once("close", failed);
      events.on("error", failed);
      events.once("end", failed);
      events.setEncoding("ascii").on("data", (chunk: string) => {
        pending += chunk;
        let newline: number;
        while ((newline = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          const root = /^ready ([1-9]\d{0,9})$/u.exec(line);
          if (!ready && root) {
            ready = true;
            clearTimeout(timeout);
            resolve(Number(root[1]));
          } else if (ready && line.startsWith("stream " + OWNER_PREFIX)) {
            const path = line.slice("stream ".length);
            if (!/^[a-f0-9]{32}$/u.test(path.slice(OWNER_PREFIX.length))) return failed();
            this.connect(path);
          } else {
            return failed();
          }
        }
        if (pending.length > 128) failed();
      });
    });
    void this.ready.catch(() => undefined);
  }

  acceptStreams(accept: (socket: Socket) => void): () => void {
    if (this.stopped || this.accept) throw new Error("The Windows Codex supervisor already has an owner or has stopped.");
    this.accept = accept;
    return () => { if (this.accept === accept) this.accept = undefined; };
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.accept = undefined;
    this.lifetime.end();
    for (const stream of this.streams) stream.destroy();
  }

  private connect(path: string): void {
    if (this.stopped || !this.accept || this.streams.size >= OWNER_STREAM_LIMIT) return;
    const socket = createConnection(path);
    this.streams.add(socket);
    socket.on("error", () => socket.destroy());
    socket.once("close", () => this.streams.delete(socket));
    socket.once("connect", () => {
      if (!this.accept || this.stopped) socket.destroy();
      else this.accept(socket);
    });
  }
}
