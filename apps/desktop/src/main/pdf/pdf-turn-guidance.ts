import type { PendingPdfAttachment } from "./pdf-attachment-store";

export const MAX_PDF_TEXT_SEARCH_REQUESTS_PER_TURN = 8;

const PDF_TURN_CONTEXT_OPEN = "<pwragent-pdf-context>";
const PDF_TURN_CONTEXT_CLOSE = "</pwragent-pdf-context>";

/**
 * Keep page-selection guidance in the same model input as the user's request.
 * Codex persists each text input as a user message, so a separate input would
 * otherwise show up as a second visible user card in the transcript.
 */
export function formatPdfAttachmentModelGuidance(
  attachments: readonly PendingPdfAttachment[],
): string {
  const manifest = attachments.map((attachment) => {
    if (!attachment.inspection) {
      return `- \`${attachment.name}\` (attachmentId \`${attachment.attachmentId}\`): page metadata is unavailable.`;
    }
    const { firstPage, pageCount } = attachment.inspection;
    return `- \`${attachment.name}\` (attachmentId \`${attachment.attachmentId}\`): ${pageCount} page${pageCount === 1 ? "" : "s"}; page 1 renders at ${firstPage.renderWidth}x${firstPage.renderHeight}.`;
  });
  const hasUnknownPageCount = attachments.some(
    (attachment) => !attachment.inspection,
  );
  const hasSinglePageAttachment = attachments.some(
    (attachment) => attachment.inspection?.pageCount === 1,
  );
  const hasMultiPageAttachment = attachments.some(
    (attachment) => (attachment.inspection?.pageCount ?? 0) > 1,
  );

  return [
    PDF_TURN_CONTEXT_OPEN,
    "PwrAgent owns these local PDFs; their source paths and bytes are not available to you:",
    ...manifest,
    hasSinglePageAttachment
      ? "For every one-page PDF above, call render_messaging_pdf_pages exactly once with that attachmentId and pageNumbers [1], then analyze the supplied image directly. Do not call inspect_messaging_pdfs or search_messaging_pdf_text for a one-page PDF."
      : undefined,
    hasMultiPageAttachment
      ? `For a multi-page PDF, render a known relevant page directly. Use search_messaging_pdf_text only when the relevant page is unknown; it is page navigation only, never a feature-extraction or comparison workflow. Text search is capped at ${MAX_PDF_TEXT_SEARCH_REQUESTS_PER_TURN} calls per turn.`
      : undefined,
    hasUnknownPageCount
      ? "For only a PDF with unavailable page metadata, call inspect_messaging_pdfs once, then follow the one-page or multi-page rule above."
      : undefined,
    "Render only a small useful batch; rendered pages are capped at five total per turn. Successful rendering already adds the page images to model context. Analyze those images directly. For a requested printed value, transcribe its labeled field instead of inferring it from line-item arithmetic. Do not use web search or other external sources for questions about these PDFs unless the user explicitly requests outside research. Do not serialize the render result, call image(), or use exec, shell, filesystem, OCR, or conversion tools on the source PDFs or rendered pages.",
    PDF_TURN_CONTEXT_CLOSE,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}
