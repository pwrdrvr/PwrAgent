import { connect, type Socket } from "node:net";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { MCP_CONNECTION_TOOL_TIMEOUT_MS } from "./mcp-connection-timeouts.js";

const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
type RpcResponse =
  | { ok: true; result: unknown }
  | { ok: false; error: string; code?: number; data?: unknown };

export class ConnectionRpcClient {
  constructor(
    private readonly socketPath: string,
    private readonly token: string,
  ) {}

  request(
    operation: string,
    params?: unknown,
    signal?: AbortSignal,
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
        MCP_CONNECTION_TOOL_TIMEOUT_MS,
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

