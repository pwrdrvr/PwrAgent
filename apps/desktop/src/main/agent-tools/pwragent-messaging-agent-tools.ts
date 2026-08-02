import type {
  PwrAgentMessagingOperationName,
  PwrAgentMessagingRequest,
  PwrAgentMessagingResponse,
  PwrAgentMessagingToolImage,
} from "@pwragent/shared";
import {
  PWRAGENT_MESSAGING_CALLABLE_OPERATION_NAMES,
  PWRAGENT_MESSAGING_OPERATION_NAMES,
  PWRAGENT_TOOL_NAMESPACE,
} from "@pwragent/shared";
import type {
  AgentToolDefinition,
  AgentToolDispatchResult,
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
      return messagingResponseToAgentToolResult(response);
    },
  }));
}

function descriptionForOperation(operation: PwrAgentMessagingOperationName): string {
  switch (operation) {
    case "get_current_location":
      return "Deprecated alias for get_current_messaging_surface. Inspect the messaging platform, actor, conversation, binding, compact bound-thread identity, and native thread/topic creation capability for the surface that started this Agent turn.";
    case "get_current_messaging_surface":
      return "Inspect the messaging platform, actor, conversation, binding, compact bound-thread identity, and native thread/topic creation capability for the surface that started this Agent turn.";
    case "attach_thread_here":
      return "Attach a known PwrAgent thread to the current messaging surface, creating a native child thread/topic when the provider supports it. This does not rename the PwrAgent thread.";
    case "inspect_messaging_pdfs":
      return "List PDF attachments available only for the current active PwrAgent turn. The initial turn input already includes page metadata when probing succeeded; call this only for an attachment whose metadata was unavailable. Returns local metadata and render limits, not PDF bytes or extracted document text.";
    case "search_messaging_pdf_text":
      return "For a multi-page PDF only, locate an unknown relevant page using its embedded text layer. Use returned page-number snippets only for bounded navigation, then render pages for visual analysis. Do not use this on one-page PDFs or as a content-extraction/comparison workflow; per-turn search calls are capped.";
    case "render_messaging_pdf_pages":
      return "Render explicitly selected PDF pages from the current active PwrAgent turn. The result contains page images for direct visual analysis. This is the only permitted way to access PwrAgent-managed PDF pages: do not use exec, shell, filesystem, OCR, or conversion tools on the source PDF or rendered page. Analyze returned images directly, and do not serialize the result, call image(), or request the same pages again. Partially repeated requests return only unseen pages. Rendering is capped by page count, total pixels, encoded image bytes, and model-input bytes.";
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
          title: {
            type: "string",
            description:
              "Optional title for a newly created native messaging child topic/thread. This is not a PwrAgent thread rename.",
          },
          placement: {
            type: "string",
            enum: ["auto", "new_child", "current_conversation"],
            description:
              "Where to attach the target thread. Use new_child to create a native messaging child topic/thread when supported; use current_conversation only when replacing or reusing the current conversation binding is intended.",
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
              "Specific page numbers to render. Start with the smallest useful batch; pages already supplied in this turn are not emitted again.",
          },
        },
      };
  }
}

function messagingResponseToAgentToolResult(
  response: PwrAgentMessagingResponse,
): AgentToolDispatchResult {
  if (response.ok) {
    if (response.imageContent) {
      const metadata = [
        response.imageContent.length > 0
          ? "PwrAgent returned rendered PDF page image(s) with this tool result. Analyze those images directly. Read requested values from their printed labels, not inferred arithmetic. Do not use web search or other external sources for this PDF unless the user explicitly requests outside research. Do not serialize this result, call image(), use exec or other local tools to reprocess the page, or render the same page again."
          : "PwrAgent already supplied the requested PDF page image(s) earlier in this turn, so no duplicate image was added. Analyze the existing image input directly.",
        JSON.stringify(response.data, null, 2),
      ].join("\n\n");
      return agentToolSuccess(response.data, {
        contentItems: [
          {
            type: "inputText",
            text: metadata,
          },
          ...response.imageContent.map((image) => ({
            type: "inputImage" as const,
            // Dynamic-tool image URLs cross the client/app-server boundary.
            // A local file URL renders in PwrAgent but is not model-readable.
            imageUrl: messagingToolImageDataUrl(image),
          })),
        ],
        mcpContentItems: [
          {
            type: "text",
            text: metadata,
          },
          ...response.imageContent.map((image) => ({
            type: "image" as const,
            data: image.base64,
            mimeType: image.mimeType,
          })),
        ],
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

function messagingToolImageDataUrl(image: PwrAgentMessagingToolImage): string {
  return `data:${image.mimeType};base64,${image.base64}`;
}
