import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
  it("preserves the legacy XDG state root for the default profile", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "pwragent-grok-transport-"),
    );
    const xdgStateHome = path.join(tempRoot, "xdg-state");
    const legacyStateRoot = path.join(xdgStateHome, "grok-app-server");
    await fs.mkdir(path.join(legacyStateRoot, "threads"), {
      recursive: true,
    });
    const child = new MockGrokChildProcess();
    spawnMock.mockReturnValue(child);
    const transport = new GrokStdioJsonRpcTransport({
      apiKey: "test-key",
      command: "node",
      entryPath: "grok-app-server.mjs",
      env: {
        HOME: tempRoot,
        PWRAGENT_PROFILE: "default",
        XDG_STATE_HOME: xdgStateHome,
      },
    });

    await transport.connect();

    expect(spawnMock.mock.calls[0]?.[2]?.env).toMatchObject({
      PWRAGENT_GROK_PROFILE_STATE_ROOT: legacyStateRoot,
    });

    const closePromise = transport.close();
    child.exitCode = 0;
    child.emit("close", 0, null);
    await closePromise;
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("passes the repository env path to the development child", async () => {
    const child = new MockGrokChildProcess();
    spawnMock.mockReturnValue(child);
    const entryPath = path.join(
      path.parse(process.cwd()).root,
      "workspace",
      "apps",
      "grok-app-server",
      "dist",
      "index.mjs",
    );
    const transport = new GrokStdioJsonRpcTransport({
      apiKey: "test-key",
      command: "node",
      entryPath,
      env: {},
    });

    await transport.connect();

    expect(spawnMock.mock.calls[0]?.[2]?.env).toMatchObject({
      PWRAGENT_GROK_LOCAL_ENV_PATH: path.join(
        path.parse(process.cwd()).root,
        "workspace",
        ".env.local",
      ),
    });

    const closePromise = transport.close();
    child.exitCode = 0;
    child.emit("close", 0, null);
    await closePromise;
  });

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
