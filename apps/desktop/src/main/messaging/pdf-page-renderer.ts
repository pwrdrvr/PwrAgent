import { createCanvas } from "@napi-rs/canvas";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import {
  IMAGE_UPLOAD_QUALITY_PROFILES,
  type ImageUploadQualityProfile,
} from "../../shared/image-normalization";

export type RenderedPdfPage = {
  dataUrl: string;
  height: number;
  pageNumber: number;
  width: number;
};

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
  const sourceWidth = Math.max(1, params.width);
  const sourceHeight = Math.max(1, params.height);
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

export async function renderPdfPages(params: {
  data: Uint8Array;
  profile: ImageUploadQualityProfile;
}): Promise<RenderedPdfPage[]> {
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(params.data),
    verbosity: pdfjs.VerbosityLevel.ERRORS,
    wasmUrl,
  });

  try {
    const document = await loadingTask.promise;
    const pages: RenderedPdfPage[] = [];

    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const sourceViewport = page.getViewport({ scale: 1 });
      const dimensions = calculatePdfRenderDimensions({
        height: sourceViewport.height,
        profile: params.profile,
        width: sourceViewport.width,
      });
      const scale = dimensions.width / sourceViewport.width;
      const viewport = page.getViewport({ scale });
      const canvas = createCanvas(dimensions.width, dimensions.height);
      const canvasContext = canvas.getContext("2d");

      await page.render({
        canvas: canvas as unknown as HTMLCanvasElement,
        canvasContext: canvasContext as unknown as CanvasRenderingContext2D,
        viewport,
      }).promise;
      pages.push({
        dataUrl: `data:image/png;base64,${(await canvas.encode("png")).toString("base64")}`,
        height: dimensions.height,
        pageNumber,
        width: dimensions.width,
      });
      page.cleanup();
    }

    return pages;
  } finally {
    await loadingTask.destroy();
  }
}
