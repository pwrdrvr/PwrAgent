import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getMainLogger } from "../log";

const log = getMainLogger("pwragent:mcp-connections");
export type McpDiscoveryPhase = "registration" | "initialize" | "tools/list" | "auth/refresh";
export const mcpDiscoveryContext = new AsyncLocalStorage<McpDiscovery>();
export const mcpDiscoveryPhaseContext = new AsyncLocalStorage<{ phase: McpDiscoveryPhase; page?: number }>();
export const mcpRequestSignalContext = new AsyncLocalStorage<AbortSignal>();

// Never retain upstream text: HTTP errors may embed response bodies, URLs,
// headers, or credentials. These allowlisted fields still identify the failure.
export function discoveryFailure(error: unknown, signal?: AbortSignal) {
  const value = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const causes: Record<string, unknown>[] = [value];
  for (let depth = 0; depth < 3; depth += 1) {
    const cause = causes[depth]?.cause;
    if (!cause || typeof cause !== "object") break;
    causes.push(cause as Record<string, unknown>);
  }
  const code = error instanceof McpError || error instanceof StreamableHTTPError ? error.code : undefined;
  const networkCode = causes.map((entry) => entry.code).find((entry) =>
    typeof entry === "string" && /^(?:E[A-Z_]+|UND_ERR_[A-Z_]+)$/.test(entry));
  const status = typeof value.status === "number" ? value.status
    : error instanceof StreamableHTTPError && code && code >= 400 && code <= 599 ? code : undefined;
  const kind = signal?.aborted
    ? signal.reason?.name === "TimeoutError" ? "deadline" : "cancelled"
    : code === -32001 ? "sdk_timeout"
    : value.name === "McpReauthorizationRequiredError" ? "authorization"
    : status ? "upstream_http"
    : networkCode ? "upstream_network" : "upstream_error";
  return {
    kind,
    ...(code === undefined ? {} : { code }),
    ...(status === undefined ? {} : { status }),
    ...(networkCode ? { networkCode } : {}),
    errorName: error instanceof StreamableHTTPError ? "StreamableHTTPError" : error instanceof McpError ? "McpError"
      : value.name === "McpReauthorizationRequiredError" ? "McpReauthorizationRequiredError"
      : error instanceof TypeError ? "TypeError" : error instanceof Error ? "Error" : "Unknown",
  };
}

export class McpDiscoveryError extends McpError {}

export class McpDiscovery {
  readonly id = randomUUID();
  readonly startedAt = Date.now();
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;

  constructor(readonly connectionId: string, readonly deadlineAt: number, signal?: AbortSignal, private readonly context?: { threadId?: string; operation?: string; parentDiscoveryId?: string }) {
    this.signal = signal ? AbortSignal.any([signal, this.controller.signal]) : this.controller.signal;
    this.timer = setTimeout(() => this.controller.abort(new DOMException("MCP discovery deadline expired.", "TimeoutError")), Math.max(0, deadlineAt - Date.now()));
    this.timer.unref();
  }

  remaining(): number {
    if (Date.now() >= this.deadlineAt) {
      this.controller.abort(new DOMException("MCP discovery deadline expired.", "TimeoutError"));
    }
    this.signal.throwIfAborted();
    return Math.max(1, this.deadlineAt - Date.now());
  }

  async phase<T>(phase: McpDiscoveryPhase, operation: () => Promise<T>, page?: number, preserveError = false): Promise<T> {
    const startedAt = Date.now();
    const fields = { connectionId: this.connectionId, discoveryId: this.id, ...this.context, phase, ...(page === undefined ? {} : { page }) };
    log.info("MCP discovery phase started", fields);
    try {
      this.remaining();
      const result = await waitForMcp(mcpDiscoveryContext.run(this, async () =>
        await mcpDiscoveryPhaseContext.run({ phase, page }, operation)), this.signal);
      this.remaining();
      log.info("MCP discovery phase completed", { ...fields, elapsedMs: Date.now() - startedAt });
      return result;
    } catch (error) {
      // A nested phase already has the useful attribution.
      if (error instanceof McpDiscoveryError) throw error;
      const diagnostic = { ...fields, ...discoveryFailure(error, this.signal), elapsedMs: Date.now() - this.startedAt };
      log.warn("MCP discovery phase failed", diagnostic);
      if (preserveError && !this.signal.aborted) throw error;
      // These messages originate locally and contain no upstream content.
      const localMessage = error instanceof Error && (
        error.message.startsWith("PwrSnap revoked this connection.")
        || error.message === "The MCP connection changed while its session was opening. Retry discovery."
      ) ? error.message : undefined;
      const detail = diagnostic.kind === "deadline" ? "discovery deadline expired"
        : diagnostic.kind === "cancelled" ? "request cancelled"
        : diagnostic.kind === "sdk_timeout" ? "upstream MCP request timed out"
        : diagnostic.kind === "authorization" ? "reauthorization required in Settings → Plugins"
        : diagnostic.status ? `upstream HTTP ${diagnostic.status}`
        : diagnostic.networkCode ? `upstream connection failed (${diagnostic.networkCode})` : "upstream request failed";
      throw new McpDiscoveryError(error instanceof McpError ? error.code : -32000, localMessage ?? `${this.connectionId}: ${phase}${page === undefined ? "" : ` page ${page}`} — ${detail} (discovery ${this.id}).`, diagnostic);
    }
  }

  close(): void { clearTimeout(this.timer); }
}

/** Detach a waiter without cancelling work owned by another request. */
export async function waitForMcp<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener("abort", abort);
    const abort = (): void => { cleanup(); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    promise.then((value) => { cleanup(); resolve(value); }, (error: unknown) => { cleanup(); reject(error); });
    if (signal.aborted) abort();
  });
}
