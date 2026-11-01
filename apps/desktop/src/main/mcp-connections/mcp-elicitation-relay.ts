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
 * The capability a managed thread session declares upstream. Form only: URL
 * mode opens a browser on a server's word, and nothing routes it yet.
 */
export const UPSTREAM_FORM_ELICITATION_CAPABILITIES: ClientCapabilities = {
  elicitation: { form: {} },
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

/**
 * The error an upstream server receives when no person can answer its form.
 *
 * `MethodNotFound` is what the SDK sent before PwrAgent declared the
 * capability, so a server that failed closed then still fails closed now.
 */
export function elicitationUnavailable(message: string): McpError {
  return new McpError(ErrorCode.MethodNotFound, message);
}

/**
 * Refuse what PwrAgent will not forward. Everything it does forward is
 * forwarded exactly: message, requested schema, `_meta` and mode as sent.
 */
export function assertRelayableFormElicitation(params: ElicitRequestParams): void {
  if (params.mode !== undefined && params.mode !== "form") {
    throw new McpError(ErrorCode.InvalidParams, "PwrAgent forwards only form elicitation from managed MCP connections.");
  }
  const schema = (params as { requestedSchema?: unknown }).requestedSchema;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)
    || (schema as { type?: unknown }).type !== "object") {
    throw new McpError(ErrorCode.InvalidParams, "An MCP form must request an object schema.");
  }
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
