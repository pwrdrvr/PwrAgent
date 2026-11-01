import { connect, type Socket } from "node:net";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { MCP_CONNECTION_TOOL_TIMEOUT_MS, MCP_DISCOVERY_RESPONSE_GRACE_MS } from "./mcp-connection-timeouts.js";

const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
type RpcResponse =
  | { ok: true; result: unknown }
  | { ok: false; error: string; code?: number; data?: unknown };

export type McpBridgeEvent = { method: string; params?: Record<string, unknown> };

export class ConnectionRpcClient {
  constructor(
    private readonly socketPath: string,
    private readonly token: string,
  ) {}

  /**
   * Open the socket that tells the gateway this bridge is alive.
   *
   * It stays open until this process exits; the gateway stops a local
   * command started for this bridge's grant when the last one closes. The
   * socket is unref'd, so it never keeps the bridge running after its agent
   * has closed stdin. Resolves false when the gateway does not support it
   * (an older owner), which only means cleanup waits for revocation instead.
   */
  attach(timeoutMs = 5_000, onEvent?: (event: McpBridgeEvent) => void): Promise<boolean> {
    return new Promise((resolve) => {
      const socket: Socket = connect(this.socketPath);
      let buffer = "";
      let settled = false;
      const finish = (attached: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!attached) socket.destroy();
        resolve(attached);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      socket.setEncoding("utf8");
      socket.on("connect", () => {
        socket.write(`${JSON.stringify({ token: this.token, op: "attach" })}\n`);
      });
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        if (buffer.length > 1024 * 1024) { socket.destroy(); finish(false); return; }
        let newline: number;
        while ((newline = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          try {
            const response = JSON.parse(line) as RpcResponse & { event?: McpBridgeEvent };
            if (!settled) {
              if (response.ok) socket.unref();
              finish(response.ok);
            } else if (response.event && typeof response.event.method === "string") {
              onEvent?.(response.event);
            }
          } catch {
            socket.destroy();
            finish(false);
          }
        }
      });
      socket.on("error", () => finish(false));
      socket.on("close", () => {
        if (settled) onEvent?.({ method: "connection/closed" });
        finish(false);
      });
    });
  }

  request(
    operation: string,
    params?: unknown,
    signal?: AbortSignal,
    deadlineAt?: number,
    discoveryId?: string,
    rpcTimeoutMs?: number,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const socket: Socket = connect(this.socketPath);
      let buffer = "";
      let settled = false;
      const finish = (error?: Error, value?: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        socket.destroy();
        if (error) reject(error);
        else resolve(value);
      };
      const timeout = setTimeout(
        () => finish(new Error("PwrAgent MCP bridge timed out.")),
        rpcTimeoutMs ?? (deadlineAt === undefined
          ? MCP_CONNECTION_TOOL_TIMEOUT_MS
          : Math.max(1, deadlineAt - Date.now() + MCP_DISCOVERY_RESPONSE_GRACE_MS)),
      );
      const onAbort = (): void => {
        finish(new DOMException("The MCP request was cancelled.", "AbortError"));
      };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      socket.setEncoding("utf8");
      socket.on("connect", () => {
        socket.write(`${JSON.stringify({
          token: this.token,
          op: operation,
          ...(deadlineAt === undefined ? {} : { deadlineAt }),
          ...(discoveryId === undefined ? {} : { discoveryId }),
          ...(params === undefined ? {} : { params }),
        })}\n`);
      });
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        if (buffer.length > MAX_RESPONSE_BYTES) {
          finish(new Error("PwrAgent MCP bridge response was too large."));
          return;
        }
        const newline = buffer.indexOf("\n");
        if (newline === -1) return;
        try {
          const response = JSON.parse(buffer.slice(0, newline)) as RpcResponse;
          if (!response.ok) {
            finish(typeof response.code === "number"
              ? new McpError(response.code, response.error, response.data)
              : new Error(response.error));
            return;
          }
          finish(undefined, response.result);
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      });
      socket.on("error", (error) => finish(error));
      socket.on("close", () => {
        finish(new Error("PwrAgent MCP bridge closed unexpectedly."));
      });
    });
  }
}

