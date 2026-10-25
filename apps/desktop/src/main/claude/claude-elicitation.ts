import { randomUUID } from "node:crypto";
import type { ElicitationResult, OnElicitation } from "@anthropic-ai/claude-agent-sdk";
import type {
  AppServerMcpElicitationRequestNotification,
  AppServerMcpElicitationSchema,
  AppServerPendingRequestNotification,
} from "@pwragent/shared";

/**
 * Show an MCP server's elicitation on the same card Codex uses. Without this
 * callback the Agent SDK declines every elicitation on the operator's behalf.
 *
 * The answer goes back to the server exactly as the MCP spec shapes it:
 * accept carries form content, URL accept carries none (it means only that
 * the operator agreed to open the page), and decline and cancel carry none.
 */
export function createClaudeElicitationHandler(options: {
  threadId: string;
  /**
   * A live session outlives its desktop turn, and a background task can ask
   * between turns, so the turn is read when the request is made.
   */
  turnId: () => string;
  request: (request: AppServerPendingRequestNotification, signal: AbortSignal) => Promise<unknown>;
  cancelRequest: (requestId: string, turnId: string) => Promise<void>;
}): OnElicitation {
  return async (elicitation, context) => {
    if (context.signal.aborted) return { action: "cancel" };
    const requestId = randomUUID();
    const turnId = options.turnId();
    const mode = elicitation.mode === "url" ? "url" : "form";
    const meta = {
      ...(elicitation.displayName ? { connector_name: elicitation.displayName } : {}),
      ...(elicitation.title ? { tool_description: elicitation.title } : {}),
      ...(elicitation.description ? { subtitle: elicitation.description } : {}),
    };
    const request: AppServerMcpElicitationRequestNotification = {
      method: "mcpServer/elicitation/request",
      params: {
        threadId: options.threadId,
        turnId,
        requestId,
        serverName: elicitation.serverName,
        mode,
        message: elicitation.message,
        _meta: Object.keys(meta).length > 0 ? meta : null,
        ...(mode === "url"
          ? {
              ...(elicitation.url ? { url: elicitation.url } : {}),
              ...(elicitation.elicitationId ? { elicitationId: elicitation.elicitationId } : {}),
            }
          : { requestedSchema: formSchema(elicitation.requestedSchema) }),
      },
    };
    let abort: (() => void) | undefined;
    try {
      const response = await Promise.race([
        options.request(request, context.signal),
        new Promise<undefined>((resolve) => {
          abort = () => {
            void options.cancelRequest(requestId, turnId).then(() => resolve(undefined), () => resolve(undefined));
          };
          context.signal.addEventListener("abort", abort, { once: true });
          if (context.signal.aborted) abort();
        }),
      ]);
      if (context.signal.aborted) return { action: "cancel" };
      return claudeElicitationResult(response, mode);
    } finally {
      if (abort) context.signal.removeEventListener("abort", abort);
    }
  };
}

/** Anything but an explicit accept or decline is a dismissal. */
export function claudeElicitationResult(response: unknown, mode: "form" | "url"): ElicitationResult {
  const record = response && typeof response === "object" && !Array.isArray(response)
    ? response as Record<string, unknown>
    : undefined;
  const action = record?.action;
  if (action === "decline") return { action: "decline" };
  if (action !== "accept") return { action: "cancel" };
  if (mode === "url") return { action: "accept" };
  const content = record?.content;
  if (!content || typeof content !== "object" || Array.isArray(content)) return { action: "accept", content: {} };
  return { action: "accept", content: content as NonNullable<ElicitationResult["content"]> };
}

// The card refuses anything but an object schema. A server that sent none
// asks for confirmation only, which is an empty form.
function formSchema(schema: Record<string, unknown> | undefined): AppServerMcpElicitationSchema {
  if (schema && schema.type === "object") return schema as AppServerMcpElicitationSchema;
  return { type: "object", properties: {} };
}
