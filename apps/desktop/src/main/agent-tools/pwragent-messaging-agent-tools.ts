import { pathToFileURL } from "node:url";
import type {
  AppServerTurnInputItem,
  PwrAgentMessagingOperationName,
  PwrAgentMessagingRequest,
  PwrAgentMessagingResponse,
  PwrAgentMessagingToolImage,
} from "@pwragent/shared";
import { materializeLocalImageInputs } from "../app-server/image-input-files.js";
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

type MaterializeImageInputs = (
  input: AppServerTurnInputItem[],
) => Promise<AppServerTurnInputItem[]>;

export type PwrAgentMessagingToolRouterOptions = {
  materializeImageInputs?: MaterializeImageInputs;
  namespace?: string;
  unsupportedMessage?: string;
};

export function buildPwrAgentMessagingToolRouter(
  handler: PwrAgentMessagingHandler | undefined,
  options: PwrAgentMessagingToolRouterOptions = {},
): AgentToolRouter {
  return new AgentToolRouter(buildPwrAgentMessagingToolDefinitions(handler, {
    materializeImageInputs: options.materializeImageInputs,
    namespace: options.namespace,
  }), {
    unsupportedMessage:
      options.unsupportedMessage ?? "Unsupported PwrAgent messaging tool.",
  });
}

export function buildPwrAgentMessagingToolDefinitions(
  handler: PwrAgentMessagingHandler | undefined,
  options: Pick<PwrAgentMessagingToolRouterOptions, "materializeImageInputs" | "namespace"> = {},
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
      return await messagingResponseToAgentToolResult(
        response,
        options.materializeImageInputs ?? materializeLocalImageInputs,
      );
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
      return "Render explicitly selected PDF pages from the current active PwrAgent turn into image input. This is the only permitted way to access PwrAgent-managed PDF pages: do not use exec, shell, filesystem, OCR, or conversion tools on the source PDF or rendered page. Successful calls automatically add the returned page images to model context: analyze those images directly, and do not serialize the result, call image(), or request the same pages again. Partially repeated requests return only unseen pages. Rendering is capped by page count, total pixels, encoded image bytes, and model-input bytes.";
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

async function messagingResponseToAgentToolResult(
  response: PwrAgentMessagingResponse,
  materializeImageInputs: MaterializeImageInputs,
): Promise<AgentToolDispatchResult> {
  if (response.ok) {
    if (response.imageContent) {
      const imageUrls = await materializePdfImageUrls(
        response.imageContent,
        materializeImageInputs,
      );
      const metadata = [
        response.imageContent.length > 0
          ? "PwrAgent has already added the rendered PDF page image(s) to this turn's model context. Analyze those images directly. Do not serialize this result, call image(), use exec or other local tools to reprocess the page, or render the same page again."
          : "PwrAgent already supplied the requested PDF page image(s) earlier in this turn, so no duplicate image was added. Analyze the existing image input directly.",
        JSON.stringify(response.data, null, 2),
      ].join("\n\n");
      return agentToolSuccess(response.data, {
        contentItems: [
          {
            type: "inputText",
            text: metadata,
          },
          ...imageUrls.map((imageUrl) => ({
            type: "inputImage" as const,
            imageUrl,
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

async function materializePdfImageUrls(
  images: PwrAgentMessagingToolImage[],
  materializeImageInputs: MaterializeImageInputs,
): Promise<string[]> {
  const fallbackUrls = images.map((image) => messagingToolImageDataUrl(image));
  try {
    const materialized = await materializeImageInputs(
      images.map((image) => ({
        type: "image" as const,
        name: `pwragent-pdf-page-${image.pageNumber}.${pdfImageExtension(image.mimeType)}`,
        url: messagingToolImageDataUrl(image),
      })),
    );
    const localImages = materialized.filter(
      (item): item is Extract<AppServerTurnInputItem, { type: "localImage" }> =>
        item.type === "localImage",
    );
    return localImages.length === images.length
      ? localImages.map((image) => pathToFileURL(image.path).toString())
      : fallbackUrls;
  } catch {
    return fallbackUrls;
  }
}

function messagingToolImageDataUrl(image: PwrAgentMessagingToolImage): string {
  return `data:${image.mimeType};base64,${image.base64}`;
}

function pdfImageExtension(mimeType: string): "jpg" | "png" {
  return mimeType === "image/jpeg" || mimeType === "image/jpg" ? "jpg" : "png";
}
