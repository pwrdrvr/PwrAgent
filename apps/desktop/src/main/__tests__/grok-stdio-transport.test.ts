import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GrokStdioJsonRpcTransport } from "../grok-app-server/stdio-transport";

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>(
    "node:child_process",
  );
  return {
    ...actual,
    spawn: spawnMock,
  };
});

class MockGrokChildProcess extends EventEmitter {
  readonly stdin = new Writable({
    write: (_chunk, _encoding, callback) => callback(),
  });
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killCalled = false;

  kill(): boolean {
    this.killCalled = true;
    return true;
  }
}

beforeEach(() => {
  spawnMock.mockReset();
});

describe("GrokStdioJsonRpcTransport", () => {
  it("waits for the child process to close before resolving close", async () => {
    const child = new MockGrokChildProcess();
    spawnMock.mockReturnValue(child);
    const transport = new GrokStdioJsonRpcTransport({
      apiKey: "test-key",
      command: "node",
      entryPath: "grok-app-server.mjs",
      env: {},
    });

    await transport.connect();
    let closeResolved = false;
    const closePromise = transport.close().then(() => {
      closeResolved = true;
    });

    await Promise.resolve();
    expect(child.killCalled).toBe(true);
    expect(closeResolved).toBe(false);

    child.exitCode = 0;
    child.emit("close", 0, null);

    await closePromise;
    expect(closeResolved).toBe(true);
  });
});
