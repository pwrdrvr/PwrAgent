import type { Canvas } from "@napi-rs/canvas";
import type { HostImage } from "../owner-host";

type CanvasModule = typeof import("@napi-rs/canvas");

let loading: Promise<CanvasModule> | undefined;

/**
 * Load the canvas binding on first image decode. A static import put its
 * cold load (~70 ms) on every headless owner start, and most owners decode
 * no image for a long time, if ever. A failed load is not cached.
 */
function loadCanvas(): Promise<CanvasModule> {
  loading ??= import("@napi-rs/canvas").catch((error: unknown) => {
    loading = undefined;
    throw error;
  });
  return loading;
}

function fromCanvas(canvasModule: CanvasModule, canvas: Canvas): HostImage {
  return {
    isEmpty: () => canvas.width < 1 || canvas.height < 1,
    getSize: () => ({ width: canvas.width, height: canvas.height }),
    resize: ({ width = canvas.width, height = canvas.height }) => {
      const resized = canvasModule.createCanvas(width, height);
      const context = resized.getContext("2d");
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.drawImage(canvas, 0, 0, width, height);
      return fromCanvas(canvasModule, resized);
    },
    toPNG: () => canvas.toBuffer("image/png"),
    toJPEG: (quality) => canvas.toBuffer("image/jpeg", quality),
    toDataURL: () => canvas.toDataURL("image/png"),
  };
}

export async function createHeadlessImage(buffer: Buffer): Promise<HostImage> {
  const canvasModule = await loadCanvas();
  const image = new canvasModule.Image();
  try { image.src = buffer; } catch { /* The image contract reports decoding failures as empty. */ }
  const width = image.width;
  const height = image.height;
  const canvas = canvasModule.createCanvas(Math.max(1, width), Math.max(1, height));
  if (width > 0 && height > 0) canvas.getContext("2d").drawImage(image, 0, 0);
  const value = fromCanvas(canvasModule, canvas);
  return { ...value, isEmpty: () => width < 1 || height < 1, getSize: () => ({ width, height }) };
}
