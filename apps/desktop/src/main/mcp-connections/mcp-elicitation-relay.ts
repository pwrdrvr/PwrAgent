import {
  ErrorCode,
  McpError,
  type ClientCapabilities,
  type ElicitRequestParams,
} from "@modelcontextprotocol/sdk/types.js";

/*
 * Shared by the owner gateway, the bridge child and the RPC client, which is
 * why nothing here validates a schema: the bridge bundle stays free of AJV.
 * The owner checks answers in `mcp-upstream-elicitation.ts`.
 */

/**
 * The capability a managed thread session declares upstream. A form or a
 * link still reaches a person only through the one tool call it belongs to,
 * and only when that call's client can show it; otherwise it fails closed.
 */
export const UPSTREAM_THREAD_ELICITATION_CAPABILITIES: ClientCapabilities = {
  elicitation: { form: {}, url: {} },
};

/** What a caller that can show a form to a person does with one. */
export type ElicitationRoute = (
  params: ElicitRequestParams,
  signal: AbortSignal,
) => Promise<unknown>;

/**
 * Wire lines on a bridge RPC socket, besides the request and its final
 * `{ ok }` response. A request opts in with `elicitation: "form"`; an owner
 * never sends `elicit` to a request that did not, so either side may be an
 * older build.
 */
export type ElicitationWireLine =
  | { elicit: { id: number; params: ElicitRequestParams } }
  | { elicitCancel: { id: number } }
  | { elicitResult: { id: number; result: unknown } }
  | { elicitError: { id: number; message: string; code?: number } };

export const ELICITATION_WIRE_OPT_IN = "form";

/**
 * Sent beside `elicitation: "form"` by a request whose caller can also show
 * a link to a person. An owner sends a URL-mode `elicit` line only to a
 * request that sent both; an older owner ignores the field.
 */
export const URL_ELICITATION_WIRE_OPT_IN = "open";

/** The longest link PwrAgent shows, and the longest id it tracks. */
const MAX_ELICITATION_URL_LENGTH = 8_192;
const MAX_ELICITATION_ID_LENGTH = 256;

/**
 * Keys Codex and PwrAgent put in `_meta` to mark a host-owned tool approval.
 * The desktop and messaging cards draw those as Allow / Allow this
 * conversation, and Codex consent paths can answer them on policy. An
 * upstream form carrying one would be asking to be treated as a host grant,
 * so it is refused rather than forwarded or rewritten.
 */
const RESERVED_APPROVAL_META_KEYS = ["codex_approval_kind", "pwragent_approval_kind"] as const;

/**
 * Whether an MCP client declared form elicitation. An empty `elicitation`
 * object is the pre-mode spec's form support, as the SDK reads it.
 */
export function clientSupportsFormElicitation(capabilities: ClientCapabilities | undefined): boolean {
  const elicitation = capabilities?.elicitation;
  if (!elicitation || typeof elicitation !== "object") return false;
  const declared = elicitation as { form?: unknown; url?: unknown };
  return declared.form !== undefined || declared.url === undefined;
}

/** Whether an MCP client declared URL-mode elicitation. */
export function clientSupportsUrlElicitation(capabilities: ClientCapabilities | undefined): boolean {
  const elicitation = capabilities?.elicitation;
  if (!elicitation || typeof elicitation !== "object") return false;
  const url = (elicitation as { url?: unknown }).url;
  return Boolean(url) && typeof url === "object";
}

/**
 * The error an upstream server receives when no person can answer its form.
 *
 * `MethodNotFound` is what the SDK sent before PwrAgent declared the
 * capability, so a server that failed closed then still fails closed now.
 */
export function elicitationUnavailable(message: string): McpError {
  return new McpError(ErrorCode.MethodNotFound, message);
}

export type ElicitationSource = {
  /**
   * The server runs on this machine, so a plain `http` link to this machine
   * is its own page. A remote server never gets one: it would point the
   * person's browser at whatever else listens locally.
   */
  local: boolean;
};

/**
 * Refuse what PwrAgent will not forward. Everything it does forward is
 * forwarded exactly: message, requested schema or link, `_meta` and mode as
 * sent.
 */
export function assertRelayableElicitation(params: ElicitRequestParams, source: ElicitationSource): void {
  if (params.mode === "url") {
    assertRelayableUrlElicitation(params, source);
    return;
  }
  assertRelayableFormElicitation(params);
}

export function isUrlElicitation(params: ElicitRequestParams): boolean {
  return params.mode === "url";
}

/**
 * A link is shown to the person, never opened by PwrAgent on its own. It
 * must be an absolute `https` address with no user name or password; a
 * local server may also use `http` on this machine. The renderer applies the
 * same rule again before it offers Open in browser.
 */
export function assertRelayableUrlElicitation(params: ElicitRequestParams, source: ElicitationSource): void {
  const record = params as { url?: unknown; elicitationId?: unknown; message?: unknown };
  if (typeof record.message !== "string" || !record.message.trim()) {
    throw new McpError(ErrorCode.InvalidParams, "An MCP link request must say why it needs the page.");
  }
  if (typeof record.elicitationId !== "string" || !record.elicitationId
    || record.elicitationId.length > MAX_ELICITATION_ID_LENGTH) {
    throw new McpError(ErrorCode.InvalidParams, "An MCP link request must carry an elicitation id.");
  }
  readRelayableElicitationUrl(record.url, source);
  assertNoHostApprovalMeta(params);
}

/** The link an MCP server asked the person to open, or a refusal. */
export function readRelayableElicitationUrl(value: unknown, source: ElicitationSource): URL {
  if (typeof value !== "string" || !value || value.length > MAX_ELICITATION_URL_LENGTH) {
    throw new McpError(ErrorCode.InvalidParams, "An MCP link request must carry a web address.");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new McpError(ErrorCode.InvalidParams, "The MCP server's link is not a valid web address.");
  }
  if (url.username || url.password) {
    throw new McpError(ErrorCode.InvalidParams, "PwrAgent does not open an MCP link that carries a user name or password.");
  }
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && source.local && isLoopbackHost(url.hostname)) return url;
  throw new McpError(
    ErrorCode.InvalidParams,
    source.local
      ? "PwrAgent opens only https links, or http links to this machine, from a local MCP server."
      : "PwrAgent opens only https links from MCP servers.",
  );
}

function isLoopbackHost(host: string): boolean {
  const name = host.toLowerCase();
  return name === "localhost" || name.endsWith(".localhost")
    || /^127(?:\.\d{1,3}){3}$/.test(name) || name === "[::1]";
}

function assertRelayableFormElicitation(params: ElicitRequestParams): void {
  if (params.mode !== undefined && params.mode !== "form") {
    throw new McpError(ErrorCode.InvalidParams, "PwrAgent forwards only form and link elicitation from managed MCP connections.");
  }
  const schema = (params as { requestedSchema?: unknown }).requestedSchema;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)
    || (schema as { type?: unknown }).type !== "object") {
    throw new McpError(ErrorCode.InvalidParams, "An MCP form must request an object schema.");
  }
  assertNoHostApprovalMeta(params);
}

function assertNoHostApprovalMeta(params: ElicitRequestParams): void {
  const meta = params._meta;
  if (meta && typeof meta === "object"
    && RESERVED_APPROVAL_META_KEYS.some((key) => Object.hasOwn(meta, key))) {
    throw hostApprovalFormRefused();
  }
}

/**
 * The error for a form that would be drawn as a host tool approval, which
 * offers a grant to keep. A server's own form is never shown as one.
 */
export function hostApprovalFormRefused(): McpError {
  return new McpError(
    ErrorCode.InvalidParams,
    "PwrAgent does not forward an MCP form that marks itself as a host tool approval.",
  );
}
