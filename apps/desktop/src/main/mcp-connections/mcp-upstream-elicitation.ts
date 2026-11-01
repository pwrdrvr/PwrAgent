import {
  ErrorCode,
  McpError,
  type ElicitRequestParams,
  type ElicitResult,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { validateJsonSchemaValue } from "./mcp-gateway-catalog";
import {
  assertRelayableFormElicitation,
  elicitationUnavailable,
  type ElicitationRoute,
  type ElicitationWireLine,
} from "./mcp-elicitation-relay";

/**
 * `elicitation/create` with its params exactly as the server sent them.
 *
 * The SDK client still checks the request against its own schema before the
 * handler runs. Registering this one only keeps that check's parsed copy from
 * being what is forwarded: the copy drops keywords the SDK does not model,
 * such as a string field's `pattern`, and the person would then be shown a
 * looser form than the server asked for.
 */
export const VerbatimElicitRequestSchema = z.object({
  method: z.literal("elicitation/create"),
  params: z.looseObject({}),
});

/**
 * What an upstream server receives when the person never gave an answer: the
 * caller left, the session or selection ended, or the form was withdrawn.
 * MCP's own word for "dismissed without a choice". Never an acceptance.
 */
const CANCELLED: ElicitResult = { action: "cancel" };

type InFlight = {
  /** The upstream client the request runs on; a reconnect is a new one. */
  client: object;
  signal: AbortSignal;
  route?: ElicitationRoute;
};

export type ElicitationOutcome =
  | "answered"
  | "cancelled"
  | "no_request"
  | "ambiguous"
  | "no_interactive_client"
  | "refused";

/**
 * Routes an upstream server's `elicitation/create` to the one request that
 * caused it.
 *
 * MCP gives a client no link from a server request to the client request it
 * belongs to, and a session is shared by every request on a bridge grant.
 * So a form goes to the request in flight on that exact upstream client, and
 * only when there is exactly one: with none, nobody asked; with several,
 * PwrAgent cannot tell whose confirmation it is and will not guess. Both
 * fail closed, as does a request whose caller cannot show a form.
 *
 * Nothing here caches or replays an answer. Each answer goes back on the
 * JSON-RPC response of the request that asked, on the client that asked, so
 * a replacement session can only ever be answered by its own form.
 */
export class UpstreamElicitationRoutes {
  private readonly byToken = new Map<string, Set<InFlight>>();

  /**
   * Record one request on an upstream client for as long as it runs. A route
   * is given only for a request whose caller can show the form to a person.
   */
  track(token: string, client: object, signal: AbortSignal, route?: ElicitationRoute): () => void {
    const entry: InFlight = { client, signal, ...(route ? { route } : {}) };
    let entries = this.byToken.get(token);
    if (!entries) {
      entries = new Set();
      this.byToken.set(token, entries);
    }
    entries.add(entry);
    return () => {
      const current = this.byToken.get(token);
      if (!current?.delete(entry)) return;
      if (current.size === 0) this.byToken.delete(token);
    };
  }

  async route(params: {
    token: string;
    client: object;
    request: ElicitRequestParams;
    /** Aborts when the server cancels the form or its session closes. */
    signal: AbortSignal;
    /** Throws when the caller may not be asked, such as a revoked selection. */
    beforeAsk?: () => Promise<void>;
    /** Throws when an answer may no longer be delivered. */
    beforeAnswer?: () => Promise<void>;
    onOutcome?: (outcome: ElicitationOutcome) => void;
  }): Promise<ElicitResult> {
    const report = (outcome: ElicitationOutcome): void => params.onOutcome?.(outcome);
    try {
      assertRelayableFormElicitation(params.request);
    } catch (error) {
      report("refused");
      throw error;
    }
    // A request whose caller just left still counts until it is released:
    // the server may be asking on its behalf, and its form must not be
    // handed to whoever else is still waiting.
    const entries = [...(this.byToken.get(params.token) ?? [])]
      .filter((entry) => entry.client === params.client);
    if (entries.length === 0) {
      report("no_request");
      throw elicitationUnavailable("No PwrAgent request is waiting on this MCP server, so no one can answer its form.");
    }
    if (entries.length > 1) {
      report("ambiguous");
      throw elicitationUnavailable("Several requests are running on this MCP session, so PwrAgent cannot tell which one this form belongs to.");
    }
    const entry = entries[0]!;
    if (!entry.route) {
      report("no_interactive_client");
      throw elicitationUnavailable("The client that made this request cannot show MCP forms.");
    }
    try {
      await params.beforeAsk?.();
    } catch (error) {
      report("refused");
      throw elicitationUnavailable(error instanceof Error ? error.message : String(error));
    }
    const signal = AbortSignal.any([params.signal, entry.signal]);
    if (signal.aborted) {
      report("cancelled");
      return CANCELLED;
    }
    let answer: unknown;
    try {
      answer = await entry.route(params.request, signal);
    } catch (error) {
      // Withdrawn without an answer: the caller's request ended, or its
      // client dismissed the form.
      if (signal.aborted || (error instanceof DOMException && error.name === "AbortError")) {
        report("cancelled");
        return CANCELLED;
      }
      report("refused");
      throw error instanceof McpError
        ? error
        : new McpError(ErrorCode.InternalError, error instanceof Error ? error.message : String(error));
    }
    if (signal.aborted) {
      report("cancelled");
      return CANCELLED;
    }
    try {
      await params.beforeAnswer?.();
    } catch {
      report("cancelled");
      return CANCELLED;
    }
    let result: ElicitResult;
    try {
      result = readFormElicitationAnswer(params.request, answer);
    } catch (error) {
      report("refused");
      throw error;
    }
    report("answered");
    return result;
  }
}

/**
 * The answer a person gave, checked before it goes upstream.
 *
 * An acceptance must carry content that satisfies the requested schema: an
 * `accept` with no content is not an answer to a form, and some servers read
 * a missing `content` as nothing left to check. Decline and cancel carry no
 * content. The client's `_meta` passes through unchanged.
 */
export function readFormElicitationAnswer(
  request: ElicitRequestParams,
  answer: unknown,
): ElicitResult {
  const record = answer && typeof answer === "object" && !Array.isArray(answer)
    ? answer as Record<string, unknown>
    : undefined;
  const action = record?.action;
  if (action !== "accept" && action !== "decline" && action !== "cancel") {
    throw new McpError(ErrorCode.InvalidParams, "The MCP form answer had no valid action.");
  }
  const meta = record?._meta;
  const preservedMeta = meta && typeof meta === "object" && !Array.isArray(meta)
    ? { _meta: meta as Record<string, unknown> }
    : {};
  if (action !== "accept") return { action, ...preservedMeta };
  const content = record?.content;
  if (!content || typeof content !== "object" || Array.isArray(content)) {
    throw new McpError(ErrorCode.InvalidParams, "An accepted MCP form answer must include its content.");
  }
  const schema = (request as { requestedSchema?: Record<string, unknown> }).requestedSchema;
  try {
    validateJsonSchemaValue(schema ?? { type: "object" }, content);
  } catch (error) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `The MCP form answer does not match the requested schema: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return {
    action,
    content: content as NonNullable<ElicitResult["content"]>,
    ...preservedMeta,
  };
}

/**
 * The owner's end of forms sent over one bridge RPC socket.
 *
 * A form is written as an `elicit` line and settles on its matching
 * `elicitResult` or `elicitError`. A withdrawn form is announced with
 * `elicitCancel`; a reply for an id that is no longer open is dropped, so a
 * late answer can never settle anything else. Closing settles every open
 * form as withdrawn.
 */
export class ElicitationWireChannel {
  private nextId = 1;
  private closed = false;
  private readonly open = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
  }>();

  /** `write` returns false once the socket can no longer carry a line. */
  constructor(private readonly write: (line: ElicitationWireLine) => boolean) {}

  readonly route: ElicitationRoute = (params, signal) => new Promise((resolve, reject) => {
    if (this.closed) {
      reject(elicitationUnavailable("The client that made this request has gone."));
      return;
    }
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const id = this.nextId++;
    const settle = (): boolean => {
      signal.removeEventListener("abort", onAbort);
      return this.open.delete(id);
    };
    const onAbort = (): void => {
      if (!settle()) return;
      this.write({ elicitCancel: { id } });
      reject(signal.reason);
    };
    this.open.set(id, {
      resolve: (value) => { if (settle()) resolve(value); },
      reject: (error) => { if (settle()) reject(error); },
    });
    signal.addEventListener("abort", onAbort, { once: true });
    if (!this.write({ elicit: { id, params } })) {
      this.open.get(id)?.reject(elicitationUnavailable("The client that made this request has gone."));
    }
  });

  /** A line the requester sent after its request line. */
  receive(line: string): void {
    let message: Partial<Extract<ElicitationWireLine, { elicitResult: unknown }>>
      & Partial<Extract<ElicitationWireLine, { elicitError: unknown }>>;
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      return;
    }
    if (message.elicitResult && typeof message.elicitResult.id === "number") {
      this.open.get(message.elicitResult.id)?.resolve(message.elicitResult.result);
      return;
    }
    if (message.elicitError && typeof message.elicitError.id === "number") {
      const { id, message: text, code } = message.elicitError;
      this.open.get(id)?.reject(new McpError(
        typeof code === "number" ? code : ErrorCode.InternalError,
        typeof text === "string" ? text : "The client could not show the MCP form.",
      ));
    }
  }

  close(): void {
    this.closed = true;
    for (const form of [...this.open.values()]) {
      form.reject(new DOMException("The MCP request ended.", "AbortError"));
    }
  }
}
