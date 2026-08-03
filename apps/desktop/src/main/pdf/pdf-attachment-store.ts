import type {
  AppServerBackendKind,
  PwrAgentMessagingPdfAttachmentSummary,
  PwrAgentMessagingPdfTextSearchResult,
  PwrAgentMessagingRenderedPdfPagesResult,
  PwrAgentMessagingToolImage,
  ThreadIdentifier,
} from "@pwragent/shared";
import type { ImageUploadQualityProfile } from "../../shared/image-normalization";
import {
  DEFAULT_PDF_RENDER_LIMITS,
  inspectPdfDocument,
  renderPdfPages,
  renderedPdfPageWireBytes,
  searchPdfText,
  type PdfDocumentInspection,
} from "./pdf-page-renderer";
import { MAX_PDF_TEXT_SEARCH_REQUESTS_PER_TURN } from "./pdf-turn-guidance";

export type PendingPdfAttachment = {
  attachmentId: string;
  data: Uint8Array;
  inspection?: PdfDocumentInspection;
  name: string;
  profile: ImageUploadQualityProfile;
  sizeBytes: number;
};

export class PdfAttachmentToolError extends Error {
  constructor(
    readonly code: "unsupported_operation",
    message: string,
  ) {
    super(message);
    this.name = "PdfAttachmentToolError";
  }
}

export type PdfAttachmentToolContext = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  turnId: string;
};

export class PdfAttachmentStore {
  private readonly attachmentsByTurnKey = new Map<
    string,
    {
      attachments: PendingPdfAttachment[];
      renderedBytes: number;
      renderedPages: number;
      claimedPageNumbersByAttachmentId: Map<string, Set<number>>;
      inspectionPromisesByAttachmentId: Map<string, Promise<PdfDocumentInspection>>;
      renderedPixels: number;
      renderedWireBytes: number;
      textSearchRequests: number;
    }
  >();

  bindTurn(
    context: PdfAttachmentToolContext,
    attachments: PendingPdfAttachment[],
  ): void {
    if (attachments.length === 0) {
      return;
    }
    this.attachmentsByTurnKey.set(turnKey(context), {
      attachments,
      renderedBytes: 0,
      renderedPages: 0,
      claimedPageNumbersByAttachmentId: new Map(),
      inspectionPromisesByAttachmentId: new Map(),
      renderedPixels: 0,
      renderedWireBytes: 0,
      textSearchRequests: 0,
    });
  }

  releaseTurn(context: PdfAttachmentToolContext): void {
    this.attachmentsByTurnKey.delete(turnKey(context));
  }

  hasTurn(context: PdfAttachmentToolContext): boolean {
    return this.attachmentsByTurnKey.has(turnKey(context));
  }

  async inspect(
    context: PdfAttachmentToolContext,
  ): Promise<PwrAgentMessagingPdfAttachmentSummary[]> {
    const turn = this.requireTurn(context);
    const summaries: PwrAgentMessagingPdfAttachmentSummary[] = [];
    for (const attachment of turn.attachments) {
      const inspection = await this.inspectAttachment(turn, attachment);
      summaries.push({
        attachmentId: attachment.attachmentId,
        firstPage: inspection.firstPage,
        name: attachment.name,
        pageCount: inspection.pageCount,
        renderLimits: { ...DEFAULT_PDF_RENDER_LIMITS },
        sizeBytes: attachment.sizeBytes,
      });
    }
    return summaries;
  }

  async search(params: PdfAttachmentToolContext & {
    attachmentId: string;
    pageEnd?: number;
    pageStart?: number;
    query: string;
  }): Promise<PwrAgentMessagingPdfTextSearchResult> {
    const turn = this.requireTurn(params);
    const attachment = this.requireAttachment(params, params.attachmentId);
    const inspection = await this.inspectAttachment(turn, attachment);
    if (inspection.pageCount === 1) {
      throw new PdfAttachmentToolError(
        "unsupported_operation",
        `Text search is unavailable for \`${attachment.name}\` because it has one page. Render page 1 directly and analyze the image.`,
      );
    }
    if (turn.textSearchRequests >= MAX_PDF_TEXT_SEARCH_REQUESTS_PER_TURN) {
      throw new PdfAttachmentToolError(
        "unsupported_operation",
        `PDF text search is limited to ${MAX_PDF_TEXT_SEARCH_REQUESTS_PER_TURN} calls per turn. Render the identified pages and analyze the images.`,
      );
    }
    // Reserve the request before awaiting searchPdfText so concurrent dynamic
    // calls cannot overrun the per-turn navigation budget.
    turn.textSearchRequests += 1;
    const result = await searchPdfText({
      data: attachment.data,
      pageEnd: params.pageEnd,
      pageStart: params.pageStart,
      query: params.query,
    });
    return {
      attachmentId: attachment.attachmentId,
      ...result,
      query: params.query.trim(),
    };
  }

  async render(params: PdfAttachmentToolContext & {
    attachmentId: string;
    pageNumbers: number[];
  }): Promise<{
    imageContent: PwrAgentMessagingToolImage[];
    result: PwrAgentMessagingRenderedPdfPagesResult;
  }> {
    const attachment = this.requireAttachment(params, params.attachmentId);
    const turn = this.requireTurn(params);
    const requestedPageNumbers = [...new Set(params.pageNumbers)];
    if (requestedPageNumbers.length === 0) {
      throw new Error("Select at least one PDF page to render.");
    }
    const claimedPageNumbers =
      turn.claimedPageNumbersByAttachmentId.get(attachment.attachmentId)
      ?? new Set<number>();
    const alreadySuppliedPageNumbers = requestedPageNumbers.filter((pageNumber) =>
      claimedPageNumbers.has(pageNumber)
    );
    const pageNumbersToRender = requestedPageNumbers.filter(
      (pageNumber) => !claimedPageNumbers.has(pageNumber),
    );
    if (pageNumbersToRender.length === 0) {
      return {
        imageContent: [],
        result: {
          attachmentId: attachment.attachmentId,
          alreadySuppliedPageNumbers,
          name: attachment.name,
          pages: [],
        },
      };
    }
    const remainingLimits = {
      maxEncodedBytes:
        DEFAULT_PDF_RENDER_LIMITS.maxEncodedBytes - turn.renderedBytes,
      maxPageEncodedBytes: DEFAULT_PDF_RENDER_LIMITS.maxPageEncodedBytes,
      maxPages: DEFAULT_PDF_RENDER_LIMITS.maxPages - turn.renderedPages,
      maxPagePixels: DEFAULT_PDF_RENDER_LIMITS.maxPagePixels,
      maxPixels: DEFAULT_PDF_RENDER_LIMITS.maxPixels - turn.renderedPixels,
      maxWireBytes: DEFAULT_PDF_RENDER_LIMITS.maxWireBytes - turn.renderedWireBytes,
    };
    if (
      remainingLimits.maxEncodedBytes < 1 ||
      remainingLimits.maxPages < 1 ||
      remainingLimits.maxPixels < 1 ||
      remainingLimits.maxWireBytes < 1
    ) {
      throw new Error("PDF rendering budget is exhausted for this turn.");
    }
    // Claim pages before awaiting the renderer so concurrent dynamic-tool
    // calls cannot emit the same model image twice.
    for (const pageNumber of pageNumbersToRender) {
      claimedPageNumbers.add(pageNumber);
    }
    turn.claimedPageNumbersByAttachmentId.set(
      attachment.attachmentId,
      claimedPageNumbers,
    );
    let pages: Awaited<ReturnType<typeof renderPdfPages>>;
    try {
      pages = await renderPdfPages({
        data: attachment.data,
        limits: remainingLimits,
        pageNumbers: pageNumbersToRender,
        profile: attachment.profile,
      });
    } catch (error) {
      for (const pageNumber of pageNumbersToRender) {
        claimedPageNumbers.delete(pageNumber);
      }
      if (claimedPageNumbers.size === 0) {
        turn.claimedPageNumbersByAttachmentId.delete(attachment.attachmentId);
      }
      throw error;
    }
    turn.renderedBytes += pages.reduce(
      (total, page) => total + page.encodedBytes,
      0,
    );
    turn.renderedPages += pages.length;
    turn.renderedPixels += pages.reduce(
      (total, page) => total + page.width * page.height,
      0,
    );
    turn.renderedWireBytes += pages.reduce(
      (total, page) => total + renderedPdfPageWireBytes(page),
      0,
    );
    return {
      imageContent: pages.map((page) => ({
        base64: page.base64,
        mimeType: page.mimeType,
        pageNumber: page.pageNumber,
      })),
      result: {
        attachmentId: attachment.attachmentId,
        alreadySuppliedPageNumbers,
        name: attachment.name,
        pages: pages.map(({ height, pageNumber, width }) => ({
          height,
          pageNumber,
          width,
        })),
      },
    };
  }

  private requireAttachments(
    context: PdfAttachmentToolContext,
  ): PendingPdfAttachment[] {
    return this.requireTurn(context).attachments;
  }

  private requireTurn(
    context: PdfAttachmentToolContext,
  ): {
    attachments: PendingPdfAttachment[];
    renderedBytes: number;
    renderedPages: number;
    claimedPageNumbersByAttachmentId: Map<string, Set<number>>;
    inspectionPromisesByAttachmentId: Map<string, Promise<PdfDocumentInspection>>;
    renderedPixels: number;
    renderedWireBytes: number;
    textSearchRequests: number;
  } {
    const turn = this.attachmentsByTurnKey.get(turnKey(context));
    if (!turn?.attachments.length) {
      throw new Error("No PDF attachments are available for this turn.");
    }
    return turn;
  }

  private requireAttachment(
    context: PdfAttachmentToolContext,
    attachmentId: string,
  ): PendingPdfAttachment {
    const attachment = this.requireAttachments(context)
      .find((candidate) => candidate.attachmentId === attachmentId);
    if (!attachment) {
      throw new Error("That PDF attachment is not available for this turn.");
    }
    return attachment;
  }

  private async inspectAttachment(
    turn: {
      inspectionPromisesByAttachmentId: Map<string, Promise<PdfDocumentInspection>>;
    },
    attachment: PendingPdfAttachment,
  ): Promise<PdfDocumentInspection> {
    if (attachment.inspection) {
      return attachment.inspection;
    }
    const existing = turn.inspectionPromisesByAttachmentId.get(
      attachment.attachmentId,
    );
    if (existing) {
      return await existing;
    }

    const inspection = inspectPdfDocument({
      data: attachment.data,
      profile: attachment.profile,
    }).then((result) => {
      attachment.inspection = result;
      return result;
    });
    turn.inspectionPromisesByAttachmentId.set(
      attachment.attachmentId,
      inspection,
    );
    try {
      return await inspection;
    } finally {
      turn.inspectionPromisesByAttachmentId.delete(attachment.attachmentId);
    }
  }
}

function turnKey(context: PdfAttachmentToolContext): string {
  return JSON.stringify([context.backend, context.threadId, context.turnId]);
}
