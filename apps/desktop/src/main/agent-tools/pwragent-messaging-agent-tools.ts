import type {
  PwrAgentMessagingOperationName,
  PwrAgentMessagingRequest,
  PwrAgentMessagingResponse,
} from "@pwragent/shared";
import {
  PWRAGENT_MESSAGING_CALLABLE_OPERATION_NAMES,
  PWRAGENT_MESSAGING_OPERATION_NAMES,
  PWRAGENT_TOOL_NAMESPACE,
} from "@pwragent/shared";
import type {
  AgentToolDefinition,
  AgentToolDispatchResult,
  AgentToolTransport,
} from "./agent-tool-definition.js";
import {
  agentToolFailure,
  agentToolSuccess,
} from "./agent-tool-definition.js";
import { AgentToolRouter } from "./agent-tool-router.js";

export const PWRAGENT_MESSAGING_UNAVAILABLE_MESSAGE =
  "PwrAgent messaging context tools are not available.";

export const PWRAGENT_MODEL_DIRECTED_PDF_OPERATION_NAMES = [
  "inspect_messaging_pdfs",
  "search_messaging_pdf_text",
  "render_messaging_pdf_pages",
] as const satisfies readonly PwrAgentMessagingOperationName[];

export type PwrAgentMessagingHandler = (
  request: PwrAgentMessagingRequest,
) => PwrAgentMessagingResponse | Promise<PwrAgentMessagingResponse>;

export type PwrAgentMessagingToolRouterOptions = {
  includeModelDirectedPdfMcp?: boolean;
  namespace?: string;
  unsupportedMessage?: string;
};

export function buildPwrAgentMessagingToolRouter(
  handler: PwrAgentMessagingHandler | undefined,
  options: PwrAgentMessagingToolRouterOptions = {},
): AgentToolRouter {
  return new AgentToolRouter(buildPwrAgentMessagingToolDefinitions(handler, {
    includeModelDirectedPdfMcp: options.includeModelDirectedPdfMcp,
    namespace: options.namespace,
  }), {
    unsupportedMessage:
      options.unsupportedMessage ?? "Unsupported PwrAgent messaging tool.",
  });
}

/**
 * The dedicated loopback MCP surface for managed PDF attachments. Keeping it
 * separate from the broader messaging router prevents Codex from receiving
 * every PwrAgent dynamic tool twice.
 */
export function buildPwrAgentMessagingPdfToolRouter(
  handler: PwrAgentMessagingHandler | undefined,
  options: PwrAgentMessagingToolRouterOptions = {},
): AgentToolRouter {
  return new AgentToolRouter(
    buildPwrAgentMessagingToolDefinitions(handler, {
      includeModelDirectedPdfMcp: true,
      namespace: options.namespace,
    }).filter((definition) => isModelDirectedPdfOperation(definition.name)),
    {
      unsupportedMessage:
        options.unsupportedMessage ?? "Unsupported PwrAgent PDF tool.",
    },
  );
}

export function buildPwrAgentMessagingToolDefinitions(
  handler: PwrAgentMessagingHandler | undefined,
  options: Pick<
    PwrAgentMessagingToolRouterOptions,
    "includeModelDirectedPdfMcp" | "namespace"
  > = {},
): AgentToolDefinition<PwrAgentMessagingOperationName>[] {
  return PWRAGENT_MESSAGING_CALLABLE_OPERATION_NAMES.map((operation) => ({
    namespace: options.namespace ?? PWRAGENT_TOOL_NAMESPACE,
    name: operation,
    description: descriptionForOperation(operation),
    inputSchema: inputSchemaForOperation(operation),
    advertise: PWRAGENT_MESSAGING_OPERATION_NAMES.includes(
      operation as (typeof PWRAGENT_MESSAGING_OPERATION_NAMES)[number],
    ),
    advertiseMcp:
      options.includeModelDirectedPdfMcp === true ||
      !isModelDirectedPdfOperation(operation),
    deferLoading: false,
    dispatch: async (args, context): Promise<AgentToolDispatchResult> => {
      if (!handler) {
        return agentToolFailure({
          code: "internal_error",
          message: PWRAGENT_MESSAGING_UNAVAILABLE_MESSAGE,
        });
      }
      const response = await handler({
        operation,
        context: {
          backend: context.backend,
          threadId: context.threadId,
          turnId: context.turnId,
        },
        args,
      } as PwrAgentMessagingRequest);
      return messagingResponseToAgentToolResult(response, context.transport);
    },
  }));
}

function descriptionForOperation(operation: PwrAgentMessagingOperationName): string {
  switch (operation) {
    case "get_current_location":
      return "Deprecated alias for get_current_messaging_surface. Inspect the messaging platform, actor, conversation, binding, compact bound-thread identity, and native thread/topic creation capability for the surface that started this Agent turn.";
    case "get_current_messaging_surface":
      return "Inspect the current messaging surface, actor, conversation, binding, bound thread, and native child-topic support. Also returns rename support, current-actor permission, and outbound attachment limits.";
    case "rename_current_messaging_conversation":
      return "Rename the current messaging conversation or thread that started this Agent turn. Use when the user asks to name the current Slack thread, Agent Session, Telegram topic, or equivalent surface. Use this PwrAgent operation instead of Browser or Computer Use. This cannot target another conversation and does not rename the PwrAgent Agent thread.";
    case "send_private_response":
      return "Send the final response privately to the user who started this messaging turn. Use this only after an explicit request or to protect secrets. After success, end the turn without a public copy. Set awaitReply and replyInstructions to start a continuation from one private reply. Only the continuation's final response returns to the source surface. This tool works only in an active messaging turn and cannot target another user.";
    case "send_messaging_file":
      return "Send a local file that is not already in the response. Use this for a rendered PDF, zip, or installer. Do not use it for an image you will embed in the final reply. Those images already go to this messaging surface. Do not use this tool to inspect a file. Requires an absolute filesystem path. Optional caption, filename, mediaKind, and private. private=true DMs the requesting user without suppressing the source reply. Call get_current_messaging_surface for this surface's outboundAttachments limits before sending a large file. Works only on the active messaging origin.";
    case "attach_thread_here":
      return "Attach a known PwrAgent thread to the current messaging surface. Use new_child for a native child topic when supported. Pass instanceId for a known remote thread. Otherwise, PwrAgent resolves the owner. This tool does not rename the PwrAgent thread.";
    case "inspect_messaging_pdfs":
      return "List PDF attachments for the current messaging turn. Use this only when the initial attachment metadata is unavailable. The result contains local metadata and render limits, not PDF content. In Codex Code Mode, parse the JSON string. Native MCP clients receive the response directly.";
    case "search_messaging_pdf_text":
      return "Search the text layer of a multi-page PDF to find an unknown page. Use the snippets only to select pages for rendering. Do not use this tool for one-page PDFs, extraction, or comparison. Each turn has a search limit. In Codex Code Mode, parse the JSON string. Native MCP clients receive the response directly.";
    case "render_messaging_pdf_pages":
      return "Render selected PDF pages from the current messaging turn. In Codex Code Mode, parse the JSON string and pass each image to image(item) once. Do not print the JSON. Native MCP clients receive image content directly. Do not call image() for MCP content. Use only this tool for PwrAgent PDFs. Do not use shell, filesystem, OCR, or conversion tools. Repeated requests return only pages not shown before. Render limits apply to pages, pixels, encoded bytes, and model input.";
  }
}

function inputSchemaForOperation(
  operation: PwrAgentMessagingOperationName,
): Record<string, unknown> {
  switch (operation) {
    case "get_current_location":
    case "get_current_messaging_surface":
      return {
        type: "object",
        additionalProperties: false,
        properties: {},
      };
    case "rename_current_messaging_conversation":
      return {
        type: "object",
        additionalProperties: false,
        required: ["title"],
        properties: {
          title: {
            type: "string",
            minLength: 1,
            maxLength: 200,
            description:
              "New title for the current messaging conversation or thread. Providers can enforce a shorter limit.",
          },
        },
      };
    case "send_private_response":
      return {
        type: "object",
        additionalProperties: false,
        required: ["text"],
        properties: {
          awaitReply: {
            type: "boolean",
            description:
              "Set true to start a continuation from the first private reply. Only its final response returns to the source surface. This requires replyInstructions.",
          },
          replyInstructions: {
            type: "string",
            minLength: 1,
            maxLength: 4_000,
            description:
              "Explain how to turn the private reply into the final source response. Include content that must stay private. Use only with awaitReply=true.",
          },
          text: {
            type: "string",
            minLength: 1,
            maxLength: 40_000,
            description:
              "Complete private response to deliver to the requesting user. Do not include an additional public copy in the final response.",
          },
        },
      };
    case "send_messaging_file":
      return {
        type: "object",
        additionalProperties: false,
        required: ["path"],
        properties: {
          path: {
            type: "string",
            minLength: 1,
            description:
              "Absolute local filesystem path of the file to send. Relative paths are rejected.",
          },
          filename: {
            type: "string",
            minLength: 1,
            maxLength: 255,
            description:
              "Optional display name for the attachment. Defaults to the path's basename.",
          },
          caption: {
            type: "string",
            minLength: 1,
            maxLength: 4_000,
            description:
              "Optional caption or accompanying text delivered with the file.",
          },
          mediaKind: {
            type: "string",
            enum: ["document", "image", "auto"],
            description:
              "How to present the file. auto sends images as photos when the provider supports it and everything else as a document. Use document when the recipient should see the exact filename. Some providers rename photo uploads.",
          },
          private: {
            type: "boolean",
            description:
              "When true, deliver privately to the requesting user. This does not suppress the source conversation's final response.",
          },
        },
      };
    case "attach_thread_here":
      return {
        type: "object",
        additionalProperties: false,
        required: ["backend", "threadId"],
        properties: {
          backend: {
            type: "string",
          },
          threadId: { type: "string" },
          instanceId: {
            type: "string",
            description:
              "Federation instance that owns the thread. Omit to check the local instance, then remembered and connected peers.",
          },
          includeRemote: {
            type: "boolean",
            description:
              "Whether to resolve the thread across connected Federation peers after checking locally. Defaults to true.",
          },
          title: {
            type: "string",
            description:
              "Optional title for a newly created native messaging child topic/thread. This is not a PwrAgent thread rename.",
          },
          placement: {
            type: "string",
            enum: ["auto", "new_child", "current_conversation"],
            description:
              "Use new_child to create a native child topic when supported. Use current_conversation only to replace or reuse the current binding.",
          },
          targetKind: {
            type: "string",
            enum: ["thread", "agent_thread"],
            description:
              "How PwrAgent should classify the messaging binding. This does not change the target thread's Agent metadata or title.",
          },
        },
      };
    case "inspect_messaging_pdfs":
      return {
        type: "object",
        additionalProperties: false,
        properties: {},
      };
    case "search_messaging_pdf_text":
      return {
        type: "object",
        additionalProperties: false,
        required: ["attachmentId", "query"],
        properties: {
          attachmentId: {
            type: "string",
            description: "Opaque attachmentId supplied in the initial PDF page manifest or returned by inspect_messaging_pdfs.",
          },
          query: {
            type: "string",
            description: "Text to locate in the PDF's embedded text layer.",
          },
          pageStart: {
            type: "integer",
            minimum: 1,
            description: "First page to search, inclusive. Defaults to page 1.",
          },
          pageEnd: {
            type: "integer",
            minimum: 1,
            description: "Last page to search, inclusive. The range is capped at 25 pages.",
          },
        },
      };
    case "render_messaging_pdf_pages":
      return {
        type: "object",
        additionalProperties: false,
        required: ["attachmentId", "pageNumbers"],
        properties: {
          attachmentId: {
            type: "string",
            description: "Opaque attachmentId supplied in the initial PDF page manifest or returned by inspect_messaging_pdfs.",
          },
          pageNumbers: {
            type: "array",
            minItems: 1,
            items: {
              type: "integer",
              minimum: 1,
            },
            description:
              "Pages to render. Start with the smallest useful batch. PwrAgent does not return pages already supplied in this turn.",
          },
        },
      };
  }
}

function messagingResponseToAgentToolResult(
  response: PwrAgentMessagingResponse,
  transport: AgentToolTransport,
): AgentToolDispatchResult {
  if (response.ok) {
    if (response.imageContent) {
      const metadata = [
        response.imageContent.length > 0
          ? "PwrAgent returned rendered PDF page image(s) with this tool result. Analyze those images directly. Read requested values from their printed labels, not inferred arithmetic. Do not use web search or other external sources for this PDF unless the user explicitly requests outside research. Do not use local tools to reprocess the page or render the same page again."
          : "PwrAgent already supplied the requested PDF page image(s) earlier in this turn, so no duplicate image was added. Analyze the existing image input directly.",
        JSON.stringify(response.data, null, 2),
      ].join("\n\n");
      const mcpContentItems = [
        {
          type: "text" as const,
          text: metadata,
        },
        ...response.imageContent.map((image) => ({
          type: "image" as const,
          data: image.base64,
          mimeType: image.mimeType,
        })),
      ];
      if (transport === "codex_dynamic_tool") {
        return agentToolSuccess(response.data, {
          contentItems: [
            {
              type: "inputText",
              text: JSON.stringify({
                content: mcpContentItems,
                result: response.data,
              }),
            },
          ],
          mcpContentItems,
        });
      }
      return agentToolSuccess(response.data, {
        contentItems: [
          {
            type: "inputText",
            text: metadata,
          },
        ],
        mcpContentItems,
      });
    }
    return agentToolSuccess(response.data);
  }
  return agentToolFailure({
    code: response.error.code,
    message: response.error.message,
  });
}

function isModelDirectedPdfOperation(operation: PwrAgentMessagingOperationName): boolean {
  return (PWRAGENT_MODEL_DIRECTED_PDF_OPERATION_NAMES as readonly string[])
    .includes(operation);
}
