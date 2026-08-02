import type {
  PwrAgentMessagingRequest,
  PwrAgentMessagingResponse,
} from "@pwragent/shared";
import type { PdfAttachmentStore } from "./pdf-attachment-store";

export function isPwrAgentPdfOperation(
  operation: PwrAgentMessagingRequest["operation"],
): boolean {
  return (
    operation === "inspect_messaging_pdfs" ||
    operation === "search_messaging_pdf_text" ||
    operation === "render_messaging_pdf_pages"
  );
}

/**
 * Return undefined when this store does not own the turn. The registry can
 * then defer legacy messaging-origin requests to MessagingController while
 * desktop-origin turns use the same dynamic-tool contract.
 */
export async function handlePwrAgentPdfToolRequest(params: {
  request: PwrAgentMessagingRequest;
  store: PdfAttachmentStore;
}): Promise<PwrAgentMessagingResponse | undefined> {
  if (!isPwrAgentPdfOperation(params.request.operation)) {
    return undefined;
  }
  const turnId = params.request.context.turnId;
  if (!turnId) {
    return {
      ok: false,
      error: {
        code: "not_found",
        message: "PDF tools require an active turn.",
      },
    };
  }
  const context = {
    backend: params.request.context.backend,
    threadId: params.request.context.threadId,
    turnId,
  };
  if (!params.store.hasTurn(context)) {
    return undefined;
  }

  switch (params.request.operation) {
    case "inspect_messaging_pdfs":
      try {
        return {
          ok: true,
          data: {
            attachments: await params.store.inspect(context),
          },
        };
      } catch (error) {
        return pdfToolFailure(error);
      }
    case "search_messaging_pdf_text": {
      const attachmentId = readPdfToolString(params.request.args.attachmentId);
      const query = readPdfToolString(params.request.args.query);
      const pageStart = readOptionalPositiveInteger(params.request.args.pageStart);
      const pageEnd = readOptionalPositiveInteger(params.request.args.pageEnd);
      if (
        !attachmentId ||
        !query ||
        (params.request.args.pageStart !== undefined && pageStart === undefined) ||
        (params.request.args.pageEnd !== undefined && pageEnd === undefined)
      ) {
        return invalidArguments(
          "search_messaging_pdf_text requires attachmentId and query; pageStart and pageEnd must be positive integers when supplied.",
        );
      }
      try {
        return {
          ok: true,
          data: await params.store.search({
            ...context,
            attachmentId,
            pageEnd,
            pageStart,
            query,
          }),
        };
      } catch (error) {
        return pdfToolFailure(error);
      }
    }
    case "render_messaging_pdf_pages": {
      if (context.backend !== "codex") {
        return {
          ok: false,
          error: {
            code: "unsupported_operation",
            message: "Rendered PDF pages are available only to Codex dynamic-tool turns.",
          },
        };
      }
      const attachmentId = readPdfToolString(params.request.args.attachmentId);
      const pageNumbers = readPdfToolPageNumbers(params.request.args.pageNumbers);
      if (!attachmentId || !pageNumbers) {
        return invalidArguments(
          "render_messaging_pdf_pages requires attachmentId and one or more positive integer pageNumbers.",
        );
      }
      try {
        const rendered = await params.store.render({
          ...context,
          attachmentId,
          pageNumbers,
        });
        return {
          ok: true,
          data: rendered.result,
          imageContent: rendered.imageContent,
        };
      } catch (error) {
        return pdfToolFailure(error);
      }
    }
  }
}

function invalidArguments(message: string): Extract<PwrAgentMessagingResponse, { ok: false }> {
  return {
    ok: false,
    error: {
      code: "invalid_arguments",
      message,
    },
  };
}

function readPdfToolString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readOptionalPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function readPdfToolPageNumbers(value: unknown): number[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  const pageNumbers = value.map(readOptionalPositiveInteger);
  return pageNumbers.every((pageNumber): pageNumber is number => pageNumber !== undefined)
    ? pageNumbers
    : undefined;
}

function pdfToolFailure(error: unknown): Extract<PwrAgentMessagingResponse, { ok: false }> {
  return {
    ok: false,
    error: {
      code: "internal_error",
      message: error instanceof Error ? error.message : "PDF attachment could not be read.",
    },
  };
}
