import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AppServerFileInputItem,
  AppServerLocalFileInputItem,
  AppServerPdfRenderProfile,
  AppServerTurnInputItem,
} from "@pwragent/shared";
import type { ImageUploadQualityProfile } from "../../shared/image-normalization";
import type { PendingPdfAttachment } from "./pdf-attachment-store";
import {
  DEFAULT_PDF_RENDER_LIMITS,
  inspectPdfDocument,
  renderPdfPages,
  renderedPdfPageDataUrl,
  renderedPdfPageWireBytes,
  type PdfDocumentInspection,
  type RenderedPdfPage,
} from "./pdf-page-renderer";
import { formatPdfAttachmentModelGuidance } from "./pdf-turn-guidance";

const PDF_MAGIC = Buffer.from("%PDF-");

export const MAX_TURN_PDF_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_TURN_PDF_ATTACHMENT_COUNT = 4;

export type PdfTurnInputHandling =
  | "model_directed"
  | "render_initial_pages"
  | "pass_through";

export type PdfTurnInputPreparation = {
  input: AppServerTurnInputItem[];
  pdfAttachments: PendingPdfAttachment[];
};

export type PdfTurnInputPreparationDependencies = {
  createAttachmentId: () => string;
  inspectPdfDocument: (params: {
    data: Uint8Array;
    profile: ImageUploadQualityProfile;
  }) => Promise<PdfDocumentInspection>;
  renderPdfPages: (params: {
    data: Uint8Array;
    limits?: Partial<typeof DEFAULT_PDF_RENDER_LIMITS>;
    pageNumbers?: number[];
    profile: ImageUploadQualityProfile;
  }) => Promise<RenderedPdfPage[]>;
};

const DEFAULT_DEPENDENCIES: PdfTurnInputPreparationDependencies = {
  createAttachmentId: randomUUID,
  inspectPdfDocument,
  renderPdfPages,
};

/**
 * Recognize PDFs by their header rather than the filename or Finder metadata.
 * Every local path reaches this function only after the user explicitly added
 * it as a composer attachment or file-reference token.
 */
export async function preparePdfTurnInput(params: {
  defaultProfile?: AppServerPdfRenderProfile;
  dependencies?: Partial<PdfTurnInputPreparationDependencies>;
  handling: PdfTurnInputHandling;
  input: AppServerTurnInputItem[];
  maxAttachmentBytes?: number;
  maxAttachmentCount?: number;
}): Promise<PdfTurnInputPreparation> {
  if (params.handling === "pass_through") {
    return {
      input: params.input,
      pdfAttachments: [],
    };
  }
  const dependencies = {
    ...DEFAULT_DEPENDENCIES,
    ...params.dependencies,
  };
  const maxAttachmentBytes =
    params.maxAttachmentBytes ?? MAX_TURN_PDF_ATTACHMENT_BYTES;
  const maxAttachmentCount =
    params.maxAttachmentCount ?? MAX_TURN_PDF_ATTACHMENT_COUNT;
  const defaultProfile = params.defaultProfile ?? "high";
  const input: AppServerTurnInputItem[] = [];
  const pdfAttachments: PendingPdfAttachment[] = [];
  const consumedLocalPdfPaths = new Set<string>();
  const notes: string[] = [];
  let handledPdfCount = 0;
  const renderedBudget = {
    bytes: 0,
    pages: 0,
    pixels: 0,
    wireBytes: 0,
  };

  for (const item of params.input) {
    if (item.type !== "file" && item.type !== "localFile") {
      input.push(item);
      continue;
    }

    const candidate = await readPdfCandidate(item, maxAttachmentBytes);
    if (candidate.kind === "not_pdf") {
      // An explicit local-file selection remains a real backend reference
      // unless it is a PDF that PwrAgent handles itself.
      input.push(item);
      continue;
    }
    if (candidate.kind === "unavailable") {
      input.push(item);
      continue;
    }
    if (candidate.kind === "too_large") {
      input.push(item);
      notes.push(
        `PwrAgent left PDF attachment \`${candidate.name}\` as a normal file reference because it exceeds the ${formatByteLimit(maxAttachmentBytes)} analysis limit.`,
      );
      continue;
    }

    if (handledPdfCount >= maxAttachmentCount) {
      input.push(item);
      notes.push(
        `PwrAgent left PDF attachment \`${candidate.name}\` as a normal file reference because this turn is limited to ${maxAttachmentCount} PDFs.`,
      );
      continue;
    }
    handledPdfCount += 1;

    const profile = resolvePdfProfile(item, defaultProfile);
    if (params.handling === "model_directed") {
      let inspection: PdfDocumentInspection | undefined;
      try {
        inspection = await dependencies.inspectPdfDocument({
          data: candidate.data,
          profile,
        });
      } catch {
        // Keep the attachment available for the dynamic inspection tool when
        // metadata probing cannot read an otherwise recognized PDF.
      }
      if (inspection?.pageCount === 1) {
        const remainingLimits = remainingPdfRenderLimits(renderedBudget);
        if (hasRemainingRenderBudget(remainingLimits)) {
          try {
            const pages = await dependencies.renderPdfPages({
              data: candidate.data,
              limits: remainingLimits,
              pageNumbers: [1],
              profile,
            });
            if (pages.length !== 1) {
              throw new Error("PDF did not render exactly one page.");
            }
            recordRenderedBudget(renderedBudget, pages);
            input.push({
              type: "image",
              name: pdfPageImageName(candidate.name, pages[0]!.pageNumber),
              url: renderedPdfPageDataUrl(pages[0]!),
            });
            notes.push(
              `PwrAgent rendered PDF attachment \`${candidate.name}\` into its only page image for visual analysis.`,
            );
            if (item.type === "localFile") {
              consumedLocalPdfPaths.add(normalizeLocalPdfPath(item.path));
            }
            continue;
          } catch {
            // Keep the managed attachment available as a bounded fallback if
            // initial rendering fails despite a successful inspection.
          }
        }
      }
      pdfAttachments.push({
        attachmentId: dependencies.createAttachmentId(),
        data: candidate.data,
        inspection,
        name: candidate.name,
        profile,
        sizeBytes: candidate.data.byteLength,
      });
      if (item.type === "localFile") {
        consumedLocalPdfPaths.add(normalizeLocalPdfPath(item.path));
      }
      continue;
    }

    const remainingLimits = remainingPdfRenderLimits(renderedBudget);
    if (!hasRemainingRenderBudget(remainingLimits)) {
      input.push(item);
      notes.push(
        `PwrAgent left PDF attachment \`${candidate.name}\` as a normal file reference because this turn's PDF rendering budget is exhausted.`,
      );
      continue;
    }

    try {
      const pages = await dependencies.renderPdfPages({
        data: candidate.data,
        limits: remainingLimits,
        profile,
      });
      if (pages.length === 0) {
        throw new Error("PDF has no renderable pages.");
      }
      recordRenderedBudget(renderedBudget, pages);
      input.push(
        ...pages.map((page) => ({
          type: "image" as const,
          name: pdfPageImageName(candidate.name, page.pageNumber),
          url: renderedPdfPageDataUrl(page),
        })),
      );
      notes.push(
        `PwrAgent rendered PDF attachment \`${candidate.name}\` into ${pages.length} page image${pages.length === 1 ? "" : "s"} for visual analysis.`,
      );
    } catch (error) {
      input.push(item);
      notes.push(
        `PwrAgent left PDF attachment \`${candidate.name}\` as a normal file reference because it could not be rendered: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (pdfAttachments.length > 0) {
    notes.unshift(formatPdfAttachmentModelGuidance(pdfAttachments));
  }

  return {
    input: insertPdfNotes(
      redactConsumedLocalPdfReferences(input, consumedLocalPdfPaths),
      notes,
    ),
    pdfAttachments,
  };
}

type PdfCandidate =
  | { kind: "not_pdf" }
  | { kind: "unavailable" }
  | { kind: "too_large"; name: string }
  | { kind: "pdf"; data: Uint8Array; name: string };

async function readPdfCandidate(
  item: AppServerFileInputItem | AppServerLocalFileInputItem,
  maxAttachmentBytes: number,
): Promise<PdfCandidate> {
  if (item.type === "file") {
    return readStoredPdfCandidate(item, maxAttachmentBytes);
  }
  return await readLocalPdfCandidate(item, maxAttachmentBytes);
}

function readStoredPdfCandidate(
  item: AppServerFileInputItem,
  maxAttachmentBytes: number,
): PdfCandidate {
  const base64 = base64Payload(item.data);
  const prefix = Buffer.from(base64.slice(0, 16), "base64");
  if (!isPdfData(prefix)) {
    return { kind: "not_pdf" };
  }
  if (estimatedBase64ByteLength(base64) > maxAttachmentBytes) {
    return { kind: "too_large", name: item.name };
  }
  const data = Buffer.from(base64, "base64");
  return isPdfData(data)
    ? { kind: "pdf", data, name: item.name }
    : { kind: "not_pdf" };
}

async function readLocalPdfCandidate(
  item: AppServerLocalFileInputItem,
  maxAttachmentBytes: number,
): Promise<PdfCandidate> {
  const name = item.name?.trim() || path.basename(item.path);
  try {
    const handle = await open(item.path, "r");
    try {
      const stats = await handle.stat();
      if (!stats.isFile()) {
        return { kind: "not_pdf" };
      }
      if (stats.size > maxAttachmentBytes) {
        return { kind: "too_large", name };
      }
      const header = Buffer.alloc(PDF_MAGIC.byteLength);
      await handle.read(header, 0, header.byteLength, 0);
      if (!isPdfData(header)) {
        return { kind: "not_pdf" };
      }
      const data = Buffer.allocUnsafe(stats.size);
      let bytesRead = 0;
      while (bytesRead < data.byteLength) {
        const result = await handle.read(
          data,
          bytesRead,
          data.byteLength - bytesRead,
          bytesRead,
        );
        if (result.bytesRead === 0) {
          return { kind: "unavailable" };
        }
        bytesRead += result.bytesRead;
      }
      return isPdfData(data)
        ? { kind: "pdf", data, name }
        : { kind: "unavailable" };
    } finally {
      await handle.close();
    }
  } catch {
    return { kind: "unavailable" };
  }
}

function base64Payload(value: string): string {
  const match = /^data:[^,]*,([\s\S]*)$/u.exec(value);
  return (match?.[1] ?? value).replace(/\s/gu, "");
}

function estimatedBase64ByteLength(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return Math.floor((value.length * 3) / 4) - padding;
}

function isPdfData(data: Uint8Array): boolean {
  return data.byteLength >= PDF_MAGIC.byteLength && PDF_MAGIC.every(
    (byte, index) => data[index] === byte,
  );
}

function resolvePdfProfile(
  item: AppServerFileInputItem | AppServerLocalFileInputItem,
  fallback: AppServerPdfRenderProfile,
): ImageUploadQualityProfile {
  return item.pdfRenderProfile ?? fallback;
}

function hasRemainingRenderBudget(limits: {
  maxEncodedBytes: number;
  maxPages: number;
  maxPixels: number;
  maxWireBytes: number;
}): boolean {
  return (
    limits.maxEncodedBytes > 0 &&
    limits.maxPages > 0 &&
    limits.maxPixels > 0 &&
    limits.maxWireBytes > 0
  );
}

function remainingPdfRenderLimits(budget: {
  bytes: number;
  pages: number;
  pixels: number;
  wireBytes: number;
}): {
  maxEncodedBytes: number;
  maxPageEncodedBytes: number;
  maxPages: number;
  maxPagePixels: number;
  maxPixels: number;
  maxWireBytes: number;
} {
  return {
    maxEncodedBytes: DEFAULT_PDF_RENDER_LIMITS.maxEncodedBytes - budget.bytes,
    maxPageEncodedBytes: DEFAULT_PDF_RENDER_LIMITS.maxPageEncodedBytes,
    maxPages: DEFAULT_PDF_RENDER_LIMITS.maxPages - budget.pages,
    maxPagePixels: DEFAULT_PDF_RENDER_LIMITS.maxPagePixels,
    maxPixels: DEFAULT_PDF_RENDER_LIMITS.maxPixels - budget.pixels,
    maxWireBytes: DEFAULT_PDF_RENDER_LIMITS.maxWireBytes - budget.wireBytes,
  };
}

function recordRenderedBudget(
  budget: { bytes: number; pages: number; pixels: number; wireBytes: number },
  pages: RenderedPdfPage[],
): void {
  budget.bytes += pages.reduce((total, page) => total + page.encodedBytes, 0);
  budget.pages += pages.length;
  budget.pixels += pages.reduce(
    (total, page) => total + page.width * page.height,
    0,
  );
  budget.wireBytes += pages.reduce(
    (total, page) => total + renderedPdfPageWireBytes(page),
    0,
  );
}

function redactConsumedLocalPdfReferences(
  input: AppServerTurnInputItem[],
  consumedLocalPdfPaths: Set<string>,
): AppServerTurnInputItem[] {
  if (consumedLocalPdfPaths.size === 0) {
    return input;
  }
  return input.map((item) => {
    if (item.type !== "text" || !item.text.includes("[@")) {
      return item;
    }
    return {
      ...item,
      text: item.text.replace(
        /\[@([^\]]+)\]\(([^)]*)\)/gu,
        (reference, name: string, value: string) => {
          const referencePath = normalizeExplicitLocalReferencePath(value);
          return referencePath && consumedLocalPdfPaths.has(referencePath)
            ? `@${name}`
            : reference;
        },
      ),
    };
  });
}

function normalizeExplicitLocalReferencePath(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.startsWith("file://")) {
    try {
      return normalizeLocalPdfPath(fileURLToPath(trimmed));
    } catch {
      return undefined;
    }
  }
  const decoded = decodeUriComponentOrOriginal(trimmed);
  const expanded = decoded === "~"
    ? homedir()
    : decoded.startsWith("~/")
      ? path.join(homedir(), decoded.slice(2))
      : decoded;
  return path.isAbsolute(expanded) ? normalizeLocalPdfPath(expanded) : undefined;
}

function normalizeLocalPdfPath(value: string): string {
  return path.resolve(value);
}

function decodeUriComponentOrOriginal(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function insertPdfNotes(
  input: AppServerTurnInputItem[],
  notes: string[],
): AppServerTurnInputItem[] {
  if (notes.length === 0) {
    return input;
  }
  const noteText = notes.join("\n\n");
  const firstTextIndex = input.findIndex((item) => item.type === "text");
  if (firstTextIndex === -1) {
    return [{ type: "text", text: noteText }, ...input];
  }
  return input.map((item, index) =>
    index === firstTextIndex && item.type === "text"
      ? {
          ...item,
          text: [item.text, noteText].filter(Boolean).join("\n\n"),
        }
      : item
  );
}

function pdfPageImageName(fileName: string, pageNumber: number): string {
  const baseName = fileName.replace(/\.pdf$/iu, "") || fileName;
  return `${baseName}-page-${pageNumber}.png`;
}

function formatByteLimit(value: number): string {
  return `${Math.round(value / (1024 * 1024))} MB`;
}
