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
  searchPdfText,
} from "./pdf-page-renderer";

export type PendingMessagingPdfAttachment = {
  attachmentId: string;
  data: Uint8Array;
  name: string;
  profile: ImageUploadQualityProfile;
  sizeBytes: number;
};

export type MessagingPdfAttachmentToolContext = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  turnId: string;
};

export class MessagingPdfAttachmentStore {
  private readonly attachmentsByTurnKey = new Map<
    string,
    {
      attachments: PendingMessagingPdfAttachment[];
      renderedBytes: number;
      renderedPages: number;
      renderedPixels: number;
    }
  >();

  bindTurn(
    context: MessagingPdfAttachmentToolContext,
    attachments: PendingMessagingPdfAttachment[],
  ): void {
    if (attachments.length === 0) {
      return;
    }
    this.attachmentsByTurnKey.set(turnKey(context), {
      attachments,
      renderedBytes: 0,
      renderedPages: 0,
      renderedPixels: 0,
    });
  }

  releaseTurn(context: MessagingPdfAttachmentToolContext): void {
    this.attachmentsByTurnKey.delete(turnKey(context));
  }

  async inspect(
    context: MessagingPdfAttachmentToolContext,
  ): Promise<PwrAgentMessagingPdfAttachmentSummary[]> {
    const attachments = this.requireAttachments(context);
    const summaries: PwrAgentMessagingPdfAttachmentSummary[] = [];
    for (const attachment of attachments) {
      const inspection = await inspectPdfDocument({
        data: attachment.data,
        profile: attachment.profile,
      });
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

  async search(params: MessagingPdfAttachmentToolContext & {
    attachmentId: string;
    pageEnd?: number;
    pageStart?: number;
    query: string;
  }): Promise<PwrAgentMessagingPdfTextSearchResult> {
    const attachment = this.requireAttachment(params, params.attachmentId);
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

  async render(params: MessagingPdfAttachmentToolContext & {
    attachmentId: string;
    pageNumbers: number[];
  }): Promise<{
    imageContent: PwrAgentMessagingToolImage[];
    result: PwrAgentMessagingRenderedPdfPagesResult;
  }> {
    const attachment = this.requireAttachment(params, params.attachmentId);
    const turn = this.requireTurn(params);
    const remainingLimits = {
      maxEncodedBytes:
        DEFAULT_PDF_RENDER_LIMITS.maxEncodedBytes - turn.renderedBytes,
      maxPages: DEFAULT_PDF_RENDER_LIMITS.maxPages - turn.renderedPages,
      maxPagePixels: DEFAULT_PDF_RENDER_LIMITS.maxPagePixels,
      maxPixels: DEFAULT_PDF_RENDER_LIMITS.maxPixels - turn.renderedPixels,
    };
    if (
      remainingLimits.maxEncodedBytes < 1 ||
      remainingLimits.maxPages < 1 ||
      remainingLimits.maxPixels < 1
    ) {
      throw new Error("PDF rendering budget is exhausted for this messaging turn.");
    }
    const pages = await renderPdfPages({
      data: attachment.data,
      limits: remainingLimits,
      pageNumbers: params.pageNumbers,
      profile: attachment.profile,
    });
    turn.renderedBytes += pages.reduce(
      (total, page) => total + page.encodedBytes,
      0,
    );
    turn.renderedPages += pages.length;
    turn.renderedPixels += pages.reduce(
      (total, page) => total + page.width * page.height,
      0,
    );
    return {
      imageContent: pages.map((page) => ({
        dataUrl: page.dataUrl,
        pageNumber: page.pageNumber,
      })),
      result: {
        attachmentId: attachment.attachmentId,
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
    context: MessagingPdfAttachmentToolContext,
  ): PendingMessagingPdfAttachment[] {
    return this.requireTurn(context).attachments;
  }

  private requireTurn(
    context: MessagingPdfAttachmentToolContext,
  ): {
    attachments: PendingMessagingPdfAttachment[];
    renderedBytes: number;
    renderedPages: number;
    renderedPixels: number;
  } {
    const turn = this.attachmentsByTurnKey.get(turnKey(context));
    if (!turn?.attachments.length) {
      throw new Error("No PDF attachments are available for this messaging turn.");
    }
    return turn;
  }

  private requireAttachment(
    context: MessagingPdfAttachmentToolContext,
    attachmentId: string,
  ): PendingMessagingPdfAttachment {
    const attachment = this.requireAttachments(context)
      .find((candidate) => candidate.attachmentId === attachmentId);
    if (!attachment) {
      throw new Error("That PDF attachment is not available for this messaging turn.");
    }
    return attachment;
  }
}

function turnKey(context: MessagingPdfAttachmentToolContext): string {
  return JSON.stringify([context.backend, context.threadId, context.turnId]);
}
