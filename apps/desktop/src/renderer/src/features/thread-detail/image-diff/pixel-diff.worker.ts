import pixelmatch from "pixelmatch";
import { DIFF_OPTIONS } from "./pixel-diff-options";
import type { PixelDiffReply, PixelDiffRequest } from "./pixel-diff-client";

/**
 * The pixel comparison, off the UI thread. A retina pair is 6 megapixels a
 * side, and pixelmatch's anti-aliasing pass walks every neighbour of every
 * differing pixel — long enough on the renderer's thread to freeze the window.
 *
 * Typed structurally rather than as a DedicatedWorkerGlobalScope so this file
 * compiles under the renderer's DOM lib without a second tsconfig.
 */
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<PixelDiffRequest>) => void) | null;
  postMessage: (message: PixelDiffReply) => void;
};

/** Above this a comparison is minutes of work and gigabytes of buffers. */
const MAX_PIXELS = 40_000_000;

function rasterize(
  bitmap: ImageBitmap,
  width: number,
  height: number,
  fit: PixelDiffRequest["fit"],
): ImageData {
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("no 2d context");
  if (fit === "stretch") {
    context.drawImage(bitmap, 0, 0, width, height);
  } else {
    // Natural size in the corner: what the smaller revision does not cover
    // stays transparent and compares as changed, which is the truth about it.
    context.drawImage(bitmap, 0, 0);
  }
  return context.getImageData(0, 0, width, height);
}

scope.onmessage = (event) => {
  const request = event.data;
  void (async () => {
    try {
      const { id, width, height, fit } = request;
      if (width * height > MAX_PIXELS) {
        throw new Error("too large to compare");
      }
      // Settled, not all: one decode rejecting must not orphan the other's
      // bitmap, which is GPU-backed and released only by close().
      const decoded = await Promise.allSettled([
        createImageBitmap(request.before),
        createImageBitmap(request.after),
      ]);
      const bitmaps = decoded.flatMap((outcome) =>
        outcome.status === "fulfilled" ? [outcome.value] : []);
      let before: ImageData;
      let after: ImageData;
      try {
        const failure = decoded.find((outcome) => outcome.status === "rejected");
        if (failure) throw failure.reason;
        const [beforeBitmap, afterBitmap] = bitmaps as [ImageBitmap, ImageBitmap];
        before = rasterize(beforeBitmap, width, height, fit);
        after = rasterize(afterBitmap, width, height, fit);
      } finally {
        for (const bitmap of bitmaps) bitmap.close();
      }

      const output = new ImageData(width, height);
      const changed = pixelmatch(before.data, after.data, output.data, width, height, DIFF_OPTIONS);
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext("2d");
      if (!context) throw new Error("no 2d context");
      context.putImageData(output, 0, 0);
      const png = await canvas.convertToBlob({ type: "image/png" });
      scope.postMessage({ id, ok: true, png, changed, total: width * height });
    } catch (error) {
      scope.postMessage({
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();
};
