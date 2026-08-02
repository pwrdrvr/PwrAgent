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
} from "./agent-tool-definition.js";
import {
  agentToolFailure,
  agentToolSuccess,
} from "./agent-tool-definition.js";
import { AgentToolRouter } from "./agent-tool-router.js";

export const PWRAGENT_MESSAGING_UNAVAILABLE_MESSAGE =
  "PwrAgent messaging context tools are not available.";

export type PwrAgentMessagingHandler = (
  request: PwrAgentMessagingRequest,
) => PwrAgentMessagingResponse | Promise<PwrAgentMessagingResponse>;

export function buildPwrAgentMessagingToolRouter(
  handler: PwrAgentMessagingHandler | undefined,
  options: { namespace?: string; unsupportedMessage?: string } = {},
): AgentToolRouter {
  return new AgentToolRouter(buildPwrAgentMessagingToolDefinitions(handler, {
    namespace: options.namespace,
  }), {
    unsupportedMessage:
      options.unsupportedMessage ?? "Unsupported PwrAgent messaging tool.",
  });
}

export function buildPwrAgentMessagingToolDefinitions(
  handler: PwrAgentMessagingHandler | undefined,
  options: { namespace?: string } = {},
): AgentToolDefinition<PwrAgentMessagingOperationName>[] {
  return PWRAGENT_MESSAGING_CALLABLE_OPERATION_NAMES.map((operation) => ({
    namespace: options.namespace ?? PWRAGENT_TOOL_NAMESPACE,
    name: operation,
    description: descriptionForOperation(operation),
    inputSchema: inputSchemaForOperation(operation),
    advertise: PWRAGENT_MESSAGING_OPERATION_NAMES.includes(
      operation as (typeof PWRAGENT_MESSAGING_OPERATION_NAMES)[number],
    ),
    advertiseMcp: !isModelDirectedPdfOperation(operation),
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
      return "List PDF attachments available only for the current active messaging turn. Returns local metadata and render limits, not PDF bytes or extracted document text.";
    case "search_messaging_pdf_text":
      return "Search embedded text in a bounded page range of a PDF attached to the current active messaging turn. Use returned page-number snippets only to navigate, then render pages for visual analysis.";
    case "render_messaging_pdf_pages":
      return "Render explicitly selected PDF pages from the current active messaging turn into image input. This is capped by page count, total pixels, encoded image bytes, and model-input bytes; request fewer pages when a cap is exceeded.";
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
            description: "Opaque attachmentId returned by inspect_messaging_pdfs.",
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
            description: "Opaque attachmentId returned by inspect_messaging_pdfs.",
          },
          pageNumbers: {
            type: "array",
            minItems: 1,
            items: {
              type: "integer",
              minimum: 1,
            },
            description: "Specific page numbers to render. Start with the smallest useful batch.",
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
      const metadata = JSON.stringify(response.data, null, 2);
      return agentToolSuccess(response.data, {
        contentItems: [
          {
            type: "inputText",
            text: metadata,
          },
          ...response.imageContent.map((image) => ({
            type: "inputImage" as const,
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
  return (
    operation === "inspect_messaging_pdfs" ||
    operation === "search_messaging_pdf_text" ||
    operation === "render_messaging_pdf_pages"
  );
}

function messagingToolImageDataUrl(image: {
  base64: string;
  mimeType: string;
}): string {
  return `data:${image.mimeType};base64,${image.base64}`;
}
