import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { compareCodexCliVersions } from "@pwrdrvr/codex-discovery";
import { StdioJsonRpcTransport } from "../codex-app-server/stdio-transport";

const { resolveCodexCommandMock, spawnMock } = vi.hoisted(() => ({
  resolveCodexCommandMock: vi.fn(async ({ command }: { command: string }) => ({
    command,
    source: "path",
    version: "0.126.0",
  })),
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

vi.mock("@pwrdrvr/codex-discovery", async () => {
  const actual = await vi.importActual<typeof import("@pwrdrvr/codex-discovery")>(
    "@pwrdrvr/codex-discovery",
  );
  return {
    ...actual,
    resolveCodexCommand: resolveCodexCommandMock,
  };
});

class MockCodexChildProcess extends EventEmitter {
  readonly writes: string[] = [];
  readonly stdin = new Writable({
    write: (chunk, _encoding, callback) => {
      this.writes.push(chunk.toString());
      callback();
    },
  });
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killCalled = false;

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killCalled = true;
    this.signalCode = signal;
    this.emit("close");
    return true;
  }
}

beforeEach(() => {
  resolveCodexCommandMock.mockClear();
  spawnMock.mockReset();
});

describe("stdio transport Codex CLI resolution", () => {
  it("orders stable Codex CLI releases ahead of prereleases with the same version", () => {
    expect(compareCodexCliVersions("0.125.0", "0.125.0-alpha.3")).toBeGreaterThan(0);
    expect(compareCodexCliVersions("0.125.0-alpha.4", "0.125.0-alpha.3")).toBeGreaterThan(0);
  });

  it("orders newer Codex.app prereleases ahead of older stable PATH releases", () => {
    expect(compareCodexCliVersions("0.126.0-alpha.1", "0.125.0")).toBeGreaterThan(0);
  });
});

describe("StdioJsonRpcTransport", () => {
  it("drops late sends after an intentional close", async () => {
    const child = new MockCodexChildProcess();
    spawnMock.mockReturnValue(child);
    const transport = new StdioJsonRpcTransport({
      command: "codex",
      env: { PATH: process.env.PATH ?? "" },
    });

    await transport.connect();
    transport.send(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }));
    expect(child.writes).toHaveLength(1);

    await transport.close();

    expect(child.killCalled).toBe(true);
    expect(() =>
      transport.send(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { ok: true } })),
    ).not.toThrow();
    expect(child.writes).toHaveLength(1);
  });

  it("rejects client requests after an intentional close", async () => {
    const child = new MockCodexChildProcess();
    spawnMock.mockReturnValue(child);
    const transport = new StdioJsonRpcTransport({
      command: "codex",
      env: { PATH: process.env.PATH ?? "" },
    });

    await transport.connect();
    await transport.close();

    expect(() =>
      transport.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "thread/list" })),
    ).toThrow("codex app server stdio not connected");
    expect(child.writes).toHaveLength(0);
  });

  it("does not treat a child error as proof that the process exited", async () => {
    const child = new MockCodexChildProcess();
    child.kill = vi.fn(() => {
      child.emit("error", Object.assign(new Error("kill EPERM"), { code: "EPERM" }));
      return false;
    });
    spawnMock.mockReturnValue(child);
    const transport = new StdioJsonRpcTransport({
      command: "codex",
      env: { PATH: process.env.PATH ?? "" },
    });

    await transport.connect();
    let closeSettled = false;
    const closePromise = transport.close().finally(() => {
      closeSettled = true;
    });
    await Promise.resolve();

    expect(closeSettled).toBe(false);
    child.exitCode = 1;
    child.emit("close");
    await closePromise;
    expect(closeSettled).toBe(true);
  });

  it("rejects close when no process exit is observed after SIGKILL", async () => {
    vi.useFakeTimers();
    try {
      const child = new MockCodexChildProcess();
      child.kill = vi.fn(() => false);
      spawnMock.mockReturnValue(child);
      const transport = new StdioJsonRpcTransport({
        command: "codex",
        env: { PATH: process.env.PATH ?? "" },
      });

      await transport.connect();
      const closeResult = expect(transport.close()).rejects.toThrow(
        "Codex app-server did not accept SIGKILL",
      );
      await vi.advanceTimersByTimeAsync(10_000);
      await closeResult;
    } finally {
      vi.useRealTimers();
    }
  });

  it("still throws when the app-server exits unexpectedly", async () => {
    const child = new MockCodexChildProcess();
    spawnMock.mockReturnValue(child);
    const transport = new StdioJsonRpcTransport({
      command: "codex",
      env: { PATH: process.env.PATH ?? "" },
    });

    await transport.connect();
    child.emit("close");

    expect(() =>
      transport.send(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } })),
    ).toThrow("codex app server stdio not connected");
  });
});
