import { createCanvas } from "@napi-rs/canvas";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

/**
 * The Composer preview is deliberately much smaller than any turn attachment.
 * It is a local UI raster only: this module has no dependency on model-facing
 * PDF page selection, turn input, or image-budget code.
 */
export const COMPOSER_PDF_PREVIEW_MAX_LONG_EDGE = 480;
export const COMPOSER_PDF_PREVIEW_MAX_ENCODED_BYTES = 2 * 1024 * 1024;

export type ComposerPdfPreviewRaster = {
  dataUrl: string;
  height: number;
  pageCount: number;
  width: number;
};

const require = createRequire(import.meta.url);
const wasmUrl = pathToFileURL(
  `${path.dirname(require.resolve("pdfjs-dist/wasm/openjpeg.wasm"))}${path.sep}`,
).href;

/** Render page one into a bounded, local-only PNG for Composer. */
export async function renderComposerPdfPreview(params: {
  data: Uint8Array;
}): Promise<ComposerPdfPreviewRaster> {
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(params.data),
    verbosity: pdfjs.VerbosityLevel.ERRORS,
    wasmUrl,
  });
  try {
    const document = await loadingTask.promise;
    if (document.numPages < 1) {
      throw new Error("PDF has no renderable pages.");
    }

    const page = await document.getPage(1);
    try {
      const sourceViewport = page.getViewport({ scale: 1 });
      const dimensions = calculateComposerPdfPreviewDimensions({
        height: sourceViewport.height,
        width: sourceViewport.width,
      });
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
      if (encoded.byteLength > COMPOSER_PDF_PREVIEW_MAX_ENCODED_BYTES) {
        throw new Error("PDF preview is too detailed to display safely.");
      }

      return {
        dataUrl: `data:image/png;base64,${encoded.toString("base64")}`,
        height: dimensions.height,
        pageCount: document.numPages,
        width: dimensions.width,
      };
    } finally {
      page.cleanup();
    }
  } finally {
    await loadingTask.destroy();
  }
}

export function calculateComposerPdfPreviewDimensions(params: {
  height: number;
  width: number;
}): { height: number; width: number } {
  if (
    !Number.isFinite(params.width)
    || !Number.isFinite(params.height)
    || params.width <= 0
    || params.height <= 0
  ) {
    throw new Error("PDF page has invalid dimensions.");
  }

  const scale = Math.min(
    1,
    COMPOSER_PDF_PREVIEW_MAX_LONG_EDGE / Math.max(params.width, params.height),
  );
  return {
    height: Math.max(1, Math.round(params.height * scale)),
    width: Math.max(1, Math.round(params.width * scale)),
  };
}
