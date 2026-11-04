import { connect, type Socket } from "node:net";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  MCP_CONNECTION_TOOL_LIST_TIMEOUT_MS,
  MCP_CONNECTION_TOOL_MAX_TOTAL_TIMEOUT_MS,
  MCP_CONNECTION_TOOL_TIMEOUT_MS,
  MCP_DISCOVERY_RESPONSE_GRACE_MS,
  progressExtendedTimeout,
} from "./mcp-connection-timeouts.js";
import { ELICITATION_WIRE_OPT_IN, URL_ELICITATION_WIRE_OPT_IN, type ElicitationRoute } from "./mcp-elicitation-relay.js";

const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
type RpcResponse =
  | { ok: true; result: unknown }
  | { ok: false; error: string; code?: number; data?: unknown };

export type McpBridgeEvent = { method: string; params?: Record<string, unknown> };

/**
 * One progress report from the upstream server, without its token: the
 * owner's token is not the caller's. A request opts in with
 * `progress: "notify"`, and the owner then sends `{ progress }` lines on its
 * socket. An owner never sends one to a request that did not, so either side
 * may be an older build.
 */
export type McpBridgeProgress = { progress: number; total?: number; message?: string };

export const PROGRESS_WIRE_OPT_IN = "notify";

export function bridgeProgress(value: unknown): McpBridgeProgress | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { progress, total, message } = value as Record<string, unknown>;
  if (typeof progress !== "number" || !Number.isFinite(progress)) return undefined;
  return {
    progress,
    ...(typeof total === "number" && Number.isFinite(total) ? { total } : {}),
    ...(typeof message === "string" ? { message } : {}),
  };
}

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
      let attached = false;
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
              attached = response.ok;
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
        if (attached) onEvent?.({ method: "connection/closed" });
        finish(false);
      });
    });
  }

  /**
   * One request on its own socket. `onElicit` makes it interactive: the
   * owner may then send the upstream server's forms on this socket while the
   * request runs, and each is answered here. Without it the owner refuses
   * every form for this request. `onProgress` asks the owner for the
   * server's progress reports. Each one also pushes this request's timeout
   * back, up to `MCP_CONNECTION_TOOL_MAX_TOTAL_TIMEOUT_MS`. With
   * `urlElicitation`, `onElicit` is also handed the server's links.
   */
  request(
    operation: string,
    params?: unknown,
    signal?: AbortSignal,
    deadlineAt?: number,
    discoveryId?: string,
    rpcTimeoutMs?: number,
    onElicit?: ElicitationRoute,
    onProgress?: (progress: McpBridgeProgress) => void,
    options?: { urlElicitation?: boolean },
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const socket: Socket = connect(this.socketPath);
      let buffer = "";
      let settled = false;
      // Forms still open when the request ends are withdrawn with it.
      const forms = new Map<number, AbortController>();
      const finish = (error?: Error, value?: unknown): void => {
        if (settled) return;
        settled = true;
        timeout.clear();
        timeout.signal.removeEventListener("abort", onTimeout);
        signal?.removeEventListener("abort", onAbort);
        for (const form of forms.values()) {
          form.abort(new DOMException("The MCP request ended.", "AbortError"));
        }
        forms.clear();
        socket.destroy();
        if (error) reject(error);
        else resolve(value);
      };
      const idleMs = rpcTimeoutMs ?? (deadlineAt === undefined
        ? MCP_CONNECTION_TOOL_TIMEOUT_MS
        : Math.max(1, deadlineAt - Date.now() + MCP_DISCOVERY_RESPONSE_GRACE_MS));
      // The owner's cap starts when it calls the server, after it has
      // opened the session. Allow for that, so the owner's cap fires first.
      const timeout = progressExtendedTimeout(
        idleMs,
        onProgress
          ? MCP_CONNECTION_TOOL_MAX_TOTAL_TIMEOUT_MS
            + MCP_CONNECTION_TOOL_LIST_TIMEOUT_MS
            + MCP_DISCOVERY_RESPONSE_GRACE_MS
          : idleMs,
      );
      const onTimeout = (): void => finish(new Error("PwrAgent MCP bridge timed out."));
      timeout.signal.addEventListener("abort", onTimeout, { once: true });
      const onAbort = (): void => {
        finish(new DOMException("The MCP request was cancelled.", "AbortError"));
      };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      const reply = (line: Record<string, unknown>): void => {
        if (!settled && !socket.destroyed) socket.write(`${JSON.stringify(line)}\n`);
      };
      const answerForm = (id: number, formParams: unknown): void => {
        if (!onElicit || forms.has(id)) {
          reply({ elicitError: { id, message: "This client cannot show MCP forms." } });
          return;
        }
        const controller = new AbortController();
        forms.set(id, controller);
        void onElicit(formParams as Parameters<ElicitationRoute>[0], controller.signal).then(
          (result) => {
            if (forms.get(id) !== controller || controller.signal.aborted) return;
            forms.delete(id);
            reply({ elicitResult: { id, result } });
          },
          (error: unknown) => {
            if (forms.get(id) !== controller || controller.signal.aborted) return;
            forms.delete(id);
            reply({ elicitError: {
              id,
              message: error instanceof Error ? error.message : String(error),
              ...(error instanceof McpError ? { code: error.code } : {}),
            } });
          },
        );
      };
      const handleLine = (line: string): void => {
        const message = JSON.parse(line) as RpcResponse & {
          elicit?: { id?: unknown; params?: unknown };
          elicitCancel?: { id?: unknown };
          progress?: unknown;
        };
        if (message.progress !== undefined) {
          const progress = bridgeProgress(message.progress);
          if (progress && onProgress) {
            timeout.extend();
            onProgress(progress);
          }
          return;
        }
        if (message.elicit && typeof message.elicit.id === "number") {
          answerForm(message.elicit.id, message.elicit.params);
          return;
        }
        if (message.elicitCancel && typeof message.elicitCancel.id === "number") {
          const form = forms.get(message.elicitCancel.id);
          forms.delete(message.elicitCancel.id);
          form?.abort(new DOMException("The MCP server withdrew its form.", "AbortError"));
          return;
        }
        if (!message.ok) {
          finish(typeof message.code === "number"
            ? new McpError(message.code, message.error, message.data)
            : new Error(message.error));
          return;
        }
        finish(undefined, message.result);
      };
      socket.setEncoding("utf8");
      socket.on("connect", () => {
        socket.write(`${JSON.stringify({
          token: this.token,
          op: operation,
          ...(deadlineAt === undefined ? {} : { deadlineAt }),
          ...(discoveryId === undefined ? {} : { discoveryId }),
          ...(onElicit ? { elicitation: ELICITATION_WIRE_OPT_IN } : {}),
          ...(onElicit && options?.urlElicitation ? { urlElicitation: URL_ELICITATION_WIRE_OPT_IN } : {}),
          ...(onProgress ? { progress: PROGRESS_WIRE_OPT_IN } : {}),
          ...(params === undefined ? {} : { params }),
        })}\n`);
      });
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        if (buffer.length > MAX_RESPONSE_BYTES) {
          finish(new Error("PwrAgent MCP bridge response was too large."));
          return;
        }
        let newline: number;
        while (!settled && (newline = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          try {
            handleLine(line);
          } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)));
          }
        }
      });
      socket.on("error", (error) => finish(error));
      socket.on("close", () => {
        finish(new Error("PwrAgent MCP bridge closed unexpectedly."));
      });
    });
  }
}
