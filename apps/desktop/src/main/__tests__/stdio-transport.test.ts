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
  killCalled = false;

  kill(): void {
    this.killCalled = true;
    this.emit("close");
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
