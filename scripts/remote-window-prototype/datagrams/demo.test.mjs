import { EventEmitter, once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), createFabric: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("./fabric.mts", () => ({ createFabric: mocks.createFabric }));
const require = createRequire(new URL("../../../apps/desktop/package.json", import.meta.url));
const { WebSocket } = require("ws");

test("only the authenticated source owner can stop the harness", async () => {
  const out = await mkdtemp(join(tmpdir(), "pwrwin-socket-test-"));
  const listeners = new Map(["SIGINT", "SIGTERM"].map(signal => [signal, new Set(process.listeners(signal))]));
  const clients = [];
  let stopped;
  const closed = new Promise(resolve => { stopped = resolve; });
  const closeFabric = vi.fn(async () => stopped());
  mocks.createFabric.mockResolvedValue({ wire: {}, signal: vi.fn(), close: closeFabric });
  // Never spawn an OS process, capture a window, or open Federation identities.
  const native = Object.assign(new EventEmitter(), {
    pid: 1, exitCode: null, signalCode: null,
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(),
  });
  native.stdin.on("finish", () => { native.exitCode = 0; native.emit("exit", 0); });
  mocks.spawn.mockReturnValue(native);
  vi.stubEnv("PWRWIN_OUTPUT", out);
  let stop;
  try {
    await import("./demo.mts");
    stop = process.listeners("SIGINT").find(listener => !listeners.get("SIGINT").has(listener));
    const ready = JSON.parse(await readFile(join(out, "ready.json"), "utf8"));
    const source = new URL(ready.source), token = source.hash.slice(1);
    async function connect() {
      const ws = new WebSocket(`${source.origin.replace("http", "ws")}/socket/source`, { origin: source.origin });
      clients.push(ws); await once(ws, "open"); return ws;
    }
    async function rejected(value) {
      const ws = await connect(), ended = once(ws, "close");
      if (value === undefined) ws.close(); // Disconnect before authentication.
      else ws.send(JSON.stringify({ token: value }));
      await ended;
      expect(closeFabric).not.toHaveBeenCalled();
      expect((await fetch(source.origin)).status).toBe(200);
    }

    await rejected("invalid-token");
    await rejected(undefined);
    expect(mocks.spawn).not.toHaveBeenCalled();

    const owner = await connect(), authenticated = once(owner, "message");
    owner.send(JSON.stringify({ token }));
    expect(JSON.parse(String((await authenticated)[0]))).toEqual({ kind: "authenticated", role: "source" });
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    await rejected(token); // A second source tab with the correct token is not the owner.
    await rejected("invalid-token");
    await rejected(undefined);
    expect(native.exitCode).toBeNull();

    const forwarded = once(owner, "message");
    const manifest = { kind: "manifest", generation: 1, versions: Array(117).fill(1), preview: true };
    native.stdout.write(JSON.stringify(manifest) + "\n");
    expect(JSON.parse(String((await forwarded)[0]))).toEqual(manifest);

    owner.close(); await closed;
    expect(closeFabric).toHaveBeenCalledTimes(1);
    expect(native.exitCode).toBe(0);
    expect(native.kill).not.toHaveBeenCalled();
  } finally {
    for (const ws of clients) if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
    if (stop) { stop(); await closed; }
    for (const [signal, previous] of listeners) {
      for (const listener of process.listeners(signal)) if (!previous.has(listener)) process.removeListener(signal, listener);
    }
    native.stdout.destroy(); native.stderr.destroy(); native.stdin.destroy();
    vi.unstubAllEnvs(); await rm(out, { recursive: true, force: true });
  }
});
