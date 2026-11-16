import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { StdioJsonRpcTransport } from "../codex-app-server/stdio-transport";
import { AcpStdioJsonRpcTransport } from "../acp/acp-stdio-transport";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(), spawn: spawnMock,
}));
vi.mock("../log", () => ({
  getMainLogger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
}));
vi.mock("@pwrdrvr/codex-discovery", async (original) => ({
  ...await original<typeof import("@pwrdrvr/codex-discovery")>(),
  resolveCodexCommand: async ({ command }: { command: string }) => ({ command, source: "path", version: "0.163.0" }),
}));

class Child extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly kill = vi.fn((signal: NodeJS.Signals = "SIGTERM") => {
    this.signalCode = signal;
    this.emit("close");
    return true;
  });
}

type Connection = { connect(): Promise<void>; close(): Promise<void> };
const factories: Array<[string, (onLine: (line: string) => void) => Connection]> = [
  ["desktop and Outpost Codex transport", (onLine) => {
    const transport = new StdioJsonRpcTransport({ command: "fixture" });
    transport.setMessageHandler(onLine);
    return transport;
  }],
  ["desktop and Outpost ACP transport", (onLine) => new AcpStdioJsonRpcTransport({
    launchDescriptor: {
      backendId: "acp:fixture", registryId: "fixture", distributionKind: "local",
      command: "fixture", args: [], env: {}, cwd: "/fixture",
    },
    spawn: spawnMock,
    observer: { onMessage: ({ direction, raw }) => { if (direction === "inbound") onLine(raw); } },
  })],
];

// JSON.stringify is the wire encoder and the oracle. UTF-16 code units also
// cover escaped lone surrogates; the sentinel guarantees both literal separators.
const text = fc.array(fc.integer({ min: 0, max: 0xffff }), { maxLength: 60 })
  .map((units) => String.fromCharCode(...units));

describe.each(factories)("%s JSON framing", (_name, create) => {
  it("preserves arbitrary JSON strings over byte partitions, CRLF and EOF", async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(text, { minLength: 1, maxLength: 4 }),
      fc.array(fc.integer({ min: 1, max: 97 }), { minLength: 1, maxLength: 12 }),
      fc.boolean(), fc.boolean(),
      async (texts, sizes, crlf, finalLf) => {
        const child = new Child();
        spawnMock.mockReturnValue(child);
        const received: string[] = [];
        const transport = create((line) => received.push(line));
        await transport.connect();
        try {
          const frames = texts.map((value, id) => JSON.stringify({
            jsonrpc: "2.0", id, result: { [value]: value, sentinel: "\u2028\u2029é🛰️\r\n\u0000" },
          }));
          const delimiter = crlf ? "\r\n" : "\n";
          const wire = Buffer.from(frames.join(delimiter) + (finalLf ? delimiter : ""));
          for (let offset = 0, i = 0; offset < wire.length; i++) {
            const end = offset + sizes[i % sizes.length]!;
            child.stdout.write(wire.subarray(offset, end));
            offset = end;
          }
          const ended = once(child.stdout, "end");
          child.stdout.end();
          await ended;
          expect(received).toEqual(frames);
          expect(child.kill).not.toHaveBeenCalled();
        } finally {
          await transport.close();
          expect(child.kill).toHaveBeenCalledTimes(1);
        }
      },
    ), { numRuns: 50 });
  });
});
