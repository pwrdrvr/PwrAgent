import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import {
  OwnedStdioClientTransport,
  type ResolvedStdioLaunch,
  type StdioSpawn,
} from "../../mcp-connections/mcp-stdio-launch";

/**
 * A local MCP server process that never runs. Its stdout is a bare emitter,
 * so `emit("data")` runs the transport's listener synchronously and a throw
 * from it reaches the test instead of the process.
 */
export class FakeMcpStdioChild extends EventEmitter {
  readonly sent: JSONRPCMessage[] = [];
  readonly stdout = new EventEmitter();
  readonly stderr = Object.assign(new EventEmitter(), { setEncoding: () => undefined });
  readonly stdin: Writable;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  private written = "";

  constructor(private readonly onRequest?: (message: JSONRPCMessage) => void) {
    super();
    this.stdin = new Writable({
      write: (chunk: Buffer, _encoding, done) => {
        this.written += chunk.toString("utf8");
        let newline: number;
        while ((newline = this.written.indexOf("\n")) !== -1) {
          const message = JSON.parse(this.written.slice(0, newline)) as JSONRPCMessage;
          this.written = this.written.slice(newline + 1);
          this.sent.push(message);
          this.onRequest?.(message);
        }
        done();
      },
      final: (done) => {
        done();
        this.exit();
      },
    });
  }

  /** Write bytes to the transport as the server's stdout, in the given pieces. */
  emitStdout(...chunks: Buffer[]): void {
    for (const chunk of chunks) this.stdout.emit("data", chunk);
  }

  /** One message as the server would write it. */
  reply(message: unknown): void {
    this.emitStdout(Buffer.from(`${JSON.stringify(message)}\n`));
  }

  kill(): boolean {
    this.exit();
    return true;
  }

  private exit(): void {
    if (this.exitCode !== null) return;
    this.exitCode = 0;
    queueMicrotask(() => this.emit("close"));
  }
}

const LAUNCH: ResolvedStdioLaunch = {
  command: "/usr/local/bin/fixture-mcp",
  args: [],
  cwd: "/",
  env: {},
  secrets: [],
};

/** A transport bound to a fake child; `Client.connect` starts it. */
export function createFakeStdioTransport(
  child: FakeMcpStdioChild,
  options: { maxMessageBytes?: number } = {},
): OwnedStdioClientTransport {
  const spawn = (() => {
    queueMicrotask(() => child.emit("spawn"));
    return child;
  }) as unknown as StdioSpawn;
  return new OwnedStdioClientTransport(LAUNCH, spawn, {}, options);
}

/** A transport bound to a fake child, already started. */
export async function startFakeStdioTransport(
  child: FakeMcpStdioChild,
  options: { maxMessageBytes?: number } = {},
): Promise<OwnedStdioClientTransport> {
  const transport = createFakeStdioTransport(child, options);
  await transport.start();
  return transport;
}
