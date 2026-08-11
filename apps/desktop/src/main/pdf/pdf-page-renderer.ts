import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import {
  IMAGE_UPLOAD_QUALITY_PROFILES,
  type ImageUploadQualityProfile,
} from "../../shared/image-normalization";

export type RenderedPdfPage = {
  base64: string;
  encodedBytes: number;
  height: number;
  mimeType: "image/png";
  pageNumber: number;
  width: number;
};

export type PdfRenderLimits = {
  maxEncodedBytes: number;
  maxPageEncodedBytes: number;
  maxPages: number;
  maxPagePixels: number;
  maxPixels: number;
  maxWireBytes: number;
};

export type PdfDocumentInspection = {
  firstPage: {
    height: number;
    renderHeight: number;
    renderWidth: number;
    width: number;
  };
  pageCount: number;
};

export type PdfTextSearchMatch = {
  pageNumber: number;
  snippet: string;
};

export const DEFAULT_PDF_RENDER_LIMITS: PdfRenderLimits = {
  // Five high-profile Jeep-sticker pages are about 30.5 MP in aggregate.
  // Keep the data-URL payload below 24 MiB after base64 expansion.
  maxEncodedBytes: 18 * 1024 * 1024,
  maxPageEncodedBytes: 6 * 1024 * 1024,
  maxPages: 5,
  maxPagePixels: 8 * 1024 * 1024,
  maxPixels: 32 * 1024 * 1024,
  maxWireBytes: 24 * 1024 * 1024,
};

export const MAX_PDF_TEXT_SEARCH_PAGES = 25;
export const MAX_PDF_TEXT_SEARCH_RESULTS = 10;
export const MAX_PDF_TEXT_SEARCH_QUERY_CHARACTERS = 200;

const PDF_PAGE_DATA_URL_PREFIX = "data:image/png;base64,";

const require = createRequire(import.meta.url);
const wasmUrl = pathToFileURL(
  `${path.dirname(require.resolve("pdfjs-dist/wasm/openjpeg.wasm"))}${path.sep}`,
).href;

/**
 * PDFs describe a page in points, not pixels. Render into the selected
 * profile's bounding box so vector text gets a meaningful raster resolution.
 */
export function calculatePdfRenderDimensions(params: {
  height: number;
  profile: ImageUploadQualityProfile;
  width: number;
}): { height: number; width: number } {
  if (
    !Number.isFinite(params.width) ||
    !Number.isFinite(params.height) ||
    params.width <= 0 ||
    params.height <= 0
  ) {
    throw new Error("PDF page has invalid dimensions.");
  }
  const sourceWidth = params.width;
  const sourceHeight = params.height;
  const profile = IMAGE_UPLOAD_QUALITY_PROFILES[params.profile];
  const longEdge = Math.max(sourceWidth, sourceHeight);
  const shortEdge = Math.min(sourceWidth, sourceHeight);
  const scale = Math.min(
    profile.maxLongEdge / longEdge,
    profile.maxShortEdge / shortEdge,
  );

  return {
    height: Math.max(1, Math.round(sourceHeight * scale)),
    width: Math.max(1, Math.round(sourceWidth * scale)),
  };
}

export function renderedPdfPageDataUrl(
  page: Pick<RenderedPdfPage, "base64" | "mimeType">,
): string {
  return `${dataUrlPrefix(page.mimeType)}${page.base64}`;
}

export function renderedPdfPageWireBytes(
  page: Pick<RenderedPdfPage, "base64" | "mimeType">,
): number {
  return dataUrlPrefix(page.mimeType).length + page.base64.length;
}

export async function inspectPdfDocument(params: {
  data: Uint8Array;
  profile: ImageUploadQualityProfile;
}): Promise<PdfDocumentInspection> {
  const loadingTask = loadPdfDocument(params.data);
  try {
    const document = await loadingTask.promise;
    if (document.numPages < 1) {
      throw new Error("PDF has no renderable pages.");
    }
    const page = await document.getPage(1);
    try {
      const viewport = page.getViewport({ scale: 1 });
      const dimensions = calculatePdfRenderDimensions({
        height: viewport.height,
        profile: params.profile,
        width: viewport.width,
      });
      return {
        firstPage: {
          height: viewport.height,
          renderHeight: dimensions.height,
          renderWidth: dimensions.width,
          width: viewport.width,
        },
        pageCount: document.numPages,
      };
    } finally {
      page.cleanup();
    }
  } finally {
    await loadingTask.destroy();
  }
}

export async function searchPdfText(params: {
  data: Uint8Array;
  pageEnd?: number;
  pageStart?: number;
  query: string;
}): Promise<{
  matches: PdfTextSearchMatch[];
  pageEnd: number;
  pageStart: number;
  totalPageCount: number;
}> {
  const query = params.query.trim();
  if (!query) {
    throw new Error("PDF text search requires a query.");
  }
  if (query.length > MAX_PDF_TEXT_SEARCH_QUERY_CHARACTERS) {
    throw new Error(
      `PDF text search queries are limited to ${MAX_PDF_TEXT_SEARCH_QUERY_CHARACTERS} characters.`,
    );
  }

  const loadingTask = loadPdfDocument(params.data);
  try {
    const document = await loadingTask.promise;
    const pageStart = normalizePageNumber(params.pageStart, 1);
    const requestedPageEnd = normalizePageNumber(params.pageEnd, document.numPages);
    if (pageStart > document.numPages || requestedPageEnd < pageStart) {
      throw new Error(`PDF page range must be within 1-${document.numPages}.`);
    }
    const pageEnd = Math.min(requestedPageEnd, document.numPages);
    if (pageEnd - pageStart + 1 > MAX_PDF_TEXT_SEARCH_PAGES) {
      throw new Error(
        `PDF text search is limited to ${MAX_PDF_TEXT_SEARCH_PAGES} pages per call.`,
      );
    }

    const lowerQuery = query.toLocaleLowerCase();
    const matches: PdfTextSearchMatch[] = [];
    for (let pageNumber = pageStart; pageNumber <= pageEnd; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      try {
        const textContent = await page.getTextContent();
        const text = textContent.items
          .map((item) => readPdfTextItem(item))
          .filter((item): item is string => item !== undefined)
          .join(" ")
          .replace(/\s+/gu, " ")
          .trim();
        const matchIndex = text.toLocaleLowerCase().indexOf(lowerQuery);
        if (matchIndex === -1) {
          continue;
        }
        matches.push({
          pageNumber,
          snippet: textSnippet(text, matchIndex, query.length),
        });
        if (matches.length >= MAX_PDF_TEXT_SEARCH_RESULTS) {
          break;
        }
      } finally {
        page.cleanup();
      }
    }

    return {
      matches,
      pageEnd,
      pageStart,
      totalPageCount: document.numPages,
    };
  } finally {
    await loadingTask.destroy();
  }
}

export async function renderPdfPages(params: {
  data: Uint8Array;
  limits?: Partial<PdfRenderLimits>;
  pageNumbers?: number[];
  profile: ImageUploadQualityProfile;
}): Promise<RenderedPdfPage[]> {
  const limits = normalizePdfRenderLimits(params.limits);
  const loadingTask = loadPdfDocument(params.data);

  try {
    const document = await loadingTask.promise;
    if (document.numPages < 1) {
      throw new Error("PDF has no renderable pages.");
    }
    const pageNumbers = resolveRenderPageNumbers({
      maxPages: limits.maxPages,
      pageCount: document.numPages,
      requested: params.pageNumbers,
    });
    const dimensionsByPage = new Map<number, { height: number; width: number }>();
    let totalPixels = 0;

    // Validate the whole batch before allocating even one rendering canvas.
    for (const pageNumber of pageNumbers) {
      const page = await document.getPage(pageNumber);
      try {
        const sourceViewport = page.getViewport({ scale: 1 });
        const dimensions = calculatePdfRenderDimensions({
          height: sourceViewport.height,
          profile: params.profile,
          width: sourceViewport.width,
        });
        const pagePixels = dimensions.width * dimensions.height;
        if (pagePixels > limits.maxPagePixels) {
          throw new Error(
            `PDF page ${pageNumber} exceeds the ${formatLimit(limits.maxPagePixels)} pixel per-page limit.`,
          );
        }
        totalPixels += pagePixels;
        if (totalPixels > limits.maxPixels) {
          throw new Error(
            `Rendered PDF pages exceed the ${formatLimit(limits.maxPixels)} pixel limit.`,
          );
        }
        dimensionsByPage.set(pageNumber, dimensions);
      } finally {
        page.cleanup();
      }
    }

    const { createCanvas } = await import("@napi-rs/canvas");
    const pages: RenderedPdfPage[] = [];
    let encodedBytes = 0;
    let wireBytes = 0;
    for (const pageNumber of pageNumbers) {
      const page = await document.getPage(pageNumber);
      try {
        const dimensions = dimensionsByPage.get(pageNumber)!;
        const sourceViewport = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({
          scale: dimensions.width / sourceViewport.width,
        });
        const canvas = createCanvas(dimensions.width, dimensions.height);
        const canvasContext = canvas.getContext("2d");

        await page.render({
          canvas: canvas as unknown as HTMLCanvasElement,
          canvasContext: canvasContext as unknown as CanvasRenderingContext2D,
          viewport,
        }).promise;
        const encoded = await canvas.encode("png");
        const pageEncodedBytes = encoded.byteLength;
        const pageWireBytes =
          PDF_PAGE_DATA_URL_PREFIX.length + base64EncodedByteLength(pageEncodedBytes);
        if (pageEncodedBytes > limits.maxPageEncodedBytes) {
          throw new Error(
            `Rendered PDF page ${pageNumber} exceeds the ${formatByteLimit(limits.maxPageEncodedBytes)} per-image limit.`,
          );
        }
        encodedBytes += pageEncodedBytes;
        if (encodedBytes > limits.maxEncodedBytes) {
          throw new Error(
            `Rendered PDF pages exceed the ${formatByteLimit(limits.maxEncodedBytes)} image-data limit.`,
          );
        }
        wireBytes += pageWireBytes;
        if (wireBytes > limits.maxWireBytes) {
          throw new Error(
            `Rendered PDF pages exceed the ${formatByteLimit(limits.maxWireBytes)} model-input limit.`,
          );
        }
        pages.push({
          base64: encoded.toString("base64"),
          encodedBytes: pageEncodedBytes,
          height: dimensions.height,
          mimeType: "image/png",
          pageNumber,
          width: dimensions.width,
        });
      } finally {
        page.cleanup();
      }
    }

    return pages;
  } finally {
    await loadingTask.destroy();
  }
}

function loadPdfDocument(data: Uint8Array) {
  return pdfjs.getDocument({
    data: new Uint8Array(data),
    verbosity: pdfjs.VerbosityLevel.ERRORS,
    wasmUrl,
  });
}

function normalizePdfRenderLimits(
  limits: Partial<PdfRenderLimits> | undefined,
): PdfRenderLimits {
  const normalized = {
    ...DEFAULT_PDF_RENDER_LIMITS,
    ...limits,
  };
  for (const [name, value] of Object.entries(normalized)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`Invalid PDF render limit: ${name}.`);
    }
  }
  return normalized;
}

function resolveRenderPageNumbers(params: {
  maxPages: number;
  pageCount: number;
  requested: number[] | undefined;
}): number[] {
  const requested = params.requested?.length
    ? [...new Set(params.requested)]
    : Array.from(
      { length: Math.min(params.pageCount, params.maxPages) },
      (_, index) => index + 1,
    );
  if (requested.length === 0) {
    throw new Error("Select at least one PDF page to render.");
  }
  if (requested.length > params.maxPages) {
    throw new Error(
      `PDF rendering is limited to ${params.maxPages} pages per call.`,
    );
  }
  for (const pageNumber of requested) {
    if (!Number.isSafeInteger(pageNumber) || pageNumber < 1 || pageNumber > params.pageCount) {
      throw new Error(`PDF page numbers must be within 1-${params.pageCount}.`);
    }
  }
  return requested;
}

function normalizePageNumber(value: number | undefined, fallback: number): number {
  return value === undefined ? fallback : Math.trunc(value);
}

function readPdfTextItem(item: unknown): string | undefined {
  if (!item || typeof item !== "object" || !("str" in item)) {
    return undefined;
  }
  return typeof item.str === "string" ? item.str : undefined;
}

function textSnippet(text: string, matchIndex: number, queryLength: number): string {
  const radius = 180;
  const start = Math.max(0, matchIndex - radius);
  const end = Math.min(text.length, matchIndex + queryLength + radius);
  return `${start > 0 ? "..." : ""}${text.slice(start, end)}${end < text.length ? "..." : ""}`;
}

function formatLimit(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatByteLimit(value: number): string {
  return `${Math.round(value / (1024 * 1024))} MB`;
}

function base64EncodedByteLength(byteLength: number): number {
  return Math.ceil(byteLength / 3) * 4;
}

function dataUrlPrefix(mimeType: RenderedPdfPage["mimeType"]): string {
  return mimeType === "image/png"
    ? PDF_PAGE_DATA_URL_PREFIX
    : `data:${mimeType};base64,`;
}
