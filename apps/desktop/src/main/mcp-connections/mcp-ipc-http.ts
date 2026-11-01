import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Agent, request } from "node:http";
import type { Socket } from "node:net";
import { dirname, join, resolve } from "node:path";
import { Duplex, Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { parseMcpIpcUrl, type McpIpcEndpoint } from "@pwragent/shared";

const IPC_ORIGIN = "http://pwragent-ipc.invalid";
export const MCP_IPC_NO_RECONNECT = {
  maxRetries: 0, maxReconnectionDelay: 0, initialReconnectionDelay: 0, reconnectionDelayGrowFactor: 1,
};

export function validateMcpIpcPlatform(endpoint: McpIpcEndpoint, platform = process.platform): void {
  if ((endpoint.scheme === "pipe" && platform !== "win32")
    || (endpoint.scheme === "unix" && platform !== "darwin" && platform !== "linux")) {
    throw new Error(endpoint.scheme === "pipe"
      ? "pipe:// MCP URLs require Windows on the instance running this connection."
      : "unix:// MCP URLs require macOS or Linux on the instance running this connection.");
  }
}

function helperPath(): string {
  const filename = `mcp-ipc-relay${process.platform === "win32" ? ".exe" : ""}`;
  // Both the bundled main and bridge execute under out/main. The installed
  // helper lives outside ASAR and is compiled for each packaging architecture.
  const resources = process.resourcesPath;
  return resources && !resources.includes("node_modules")
    ? join(resources, "mcp-ipc-relay", filename)
    : resolve(dirname(fileURLToPath(import.meta.url)), "../../build/mcp-ipc-relay", `${process.platform}-${process.arch}`, filename);
}

/** A subprocess-owned byte stream; it has no OS socket handle in JS. */
class RelaySocket extends Duplex {
  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    super();
    child.stdout.on("data", (bytes: Buffer) => {
      if (!this.push(bytes)) child.stdout.pause();
    });
    child.stdout.on("end", () => this.push(null));
    child.on("exit", (code) => {
      if (code) this.destroy(new Error("The verified MCP IPC connection closed."));
    });
    child.stdin.on("error", (error) => this.destroy(error));
    child.stdout.on("error", (error) => this.destroy(error));
  }
  override _read(): void { this.child.stdout.resume(); }
  override _write(bytes: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void): void {
    this.child.stdin.write(bytes, done);
  }
  override _final(done: (error?: Error | null) => void): void { this.child.stdin.end(done); }
  override _destroy(error: Error | null, done: (error?: Error | null) => void): void {
    this.child.stdin.destroy();
    this.child.stdout.destroy();
    this.child.kill();
    if (this.child.exitCode !== null || this.child.signalCode !== null) done(error);
    else this.child.once("exit", () => done(error));
  }
  setNoDelay(): this { return this; }
  setKeepAlive(): this { return this; }
  // Request lifetime is controlled by AbortSignal, including response bodies.
  setTimeout(): this { return this; }
}

async function openRelay(path: string, executable: string, signal: AbortSignal): Promise<RelaySocket> {
  signal.throwIfAborted();
  // Do not pass application credentials or user shell setup to the helper.
  const child = spawn(executable, [path], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {},
  });
  return await new Promise((resolveSocket, reject) => {
    let detail = "";
    const timer = setTimeout(() => failed(new Error("Timed out verifying the MCP IPC peer.")), 10_000);
    const abort = (): void => failed(signal.reason instanceof Error ? signal.reason : new Error("MCP IPC connection cancelled."));
    const cleanup = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      child.removeListener("error", failed);
      child.removeListener("exit", exited);
      child.stdout.removeListener("readable", ready);
    };
    const failed = (error: Error): void => {
      cleanup();
      child.kill();
      child.stdin.destroy(); child.stdout.destroy();
      reject(error);
    };
    const exited = (): void => failed(new Error(detail.trim() || "Cannot verify the MCP IPC peer. Build/install the native MCP IPC helper and check endpoint permissions."));
    const ready = (): void => {
      const marker: Buffer | null = child.stdout.read(1);
      if (!marker) return;
      if (marker[0] !== 1) { failed(new Error("Invalid MCP IPC helper readiness marker.")); return; }
      cleanup();
      const socket = new RelaySocket(child);
      resolveSocket(socket);
    };
    child.stderr.on("data", (bytes: Buffer) => { detail = (detail + bytes.toString()).slice(0, 1024); });
    child.once("error", failed);
    child.once("exit", exited);
    child.stdout.on("readable", ready);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** Bind all requests to one IPC endpoint. Synthetic HTTP URLs are never sent
 * to fetch/DNS, and neither redirects nor OAuth discovery can escape it.
 */
export function createMcpIpcHttp(serverUrl: string, options: { executable?: string } = {}): {
  url: URL;
  fetch: FetchLike;
  close: () => void;
} {
  const endpoint = parseMcpIpcUrl(serverUrl);
  validateMcpIpcPlatform(endpoint);
  const url = new URL(endpoint.requestTarget, IPC_ORIGIN);
  const lifetime = new AbortController();
  const agent = new Agent({ keepAlive: false });
  const pending = new Set<RelaySocket>();
  const close = (reason?: Error): void => {
    lifetime.abort(reason);
    for (const socket of pending) socket.destroy();
    agent.destroy();
  };
  agent.createConnection = (_options, callback) => {
    void openRelay(endpoint.path, options.executable ?? helperPath(), lifetime.signal).then((socket) => {
      pending.add(socket);
      socket.once("close", () => pending.delete(socket));
      if (lifetime.signal.aborted) { socket.destroy(); callback?.(new Error("MCP IPC session closed."), socket); }
      else callback?.(null, socket);
    }, (error: Error) => callback?.(error, undefined as unknown as Socket));
    return undefined as unknown as Socket;
  };
  const fetch: FetchLike = async (input, init) => {
    lifetime.signal.throwIfAborted();
    const target = new URL(input);
    if (target.origin !== IPC_ORIGIN || target.href !== url.href || target.username || target.password) {
      throw new Error("MCP IPC requests cannot change endpoint or access a network URL.");
    }
    if (init?.body !== undefined && init.body !== null && typeof init.body !== "string") {
      throw new Error("MCP IPC requires an HTTP JSON request body.");
    }
    const signal = AbortSignal.any([lifetime.signal, ...(init?.signal ? [init.signal] : [])]);
    return await new Promise<Response>((resolveResponse, reject) => {
      const headers = new Headers(init?.headers);
      // Host/connection framing belongs to this transport, never credentials
      // supplied by a server, renderer or OAuth discovery response.
      for (const name of ["host", "connection", "transfer-encoding", "content-length"]) headers.delete(name);
      const req = request(url, {
        agent, method: init?.method ?? "GET", headers: Object.fromEntries(headers), signal,
      }, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400) {
          res.destroy(); close(); reject(new Error("MCP IPC redirects are not allowed.")); return;
        }
        const responseHeaders = new Headers();
        for (let i = 0; i < res.rawHeaders.length; i += 2) responseHeaders.append(res.rawHeaders[i]!, res.rawHeaders[i + 1]!);
        const empty = [204, 205, 304].includes(res.statusCode ?? 0) || init?.method === "HEAD";
        res.once("error", () => { if (!signal.aborted) close(); });
        if (init?.method === "GET" && responseHeaders.get("content-type")?.startsWith("text/event-stream")) {
          // A notification stream ending must not trigger a new IPC
          // connection/replay during this active MCP session.
          res.once("end", () => close());
        }
        if (empty) res.resume();
        resolveResponse(new Response(empty ? null : Readable.toWeb(res) as ReadableStream<Uint8Array>, {
          status: res.statusCode, statusText: res.statusMessage, headers: responseHeaders,
        }));
      });
      req.once("error", (error) => {
        // Cancellation of one request is not permission to replay it or to
        // invalidate healthy concurrent operations. Other failures end this
        // transport; SDK reconnect attempts fail locally without opening IPC.
        if (!signal.aborted) close(error);
        reject(error);
      });
      req.end(init?.body ?? undefined);
    });
  };
  return { url, fetch, close };
}
