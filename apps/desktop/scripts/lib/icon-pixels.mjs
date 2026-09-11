// Pixel measurement shared by the icon tests in this directory: app-icon.test.mjs
// measures the macOS icon inputs, pwrsuite-brand-icons.test.mjs the sister apps'
// brand marks. Both need to decode a PNG and find what part of it is drawn on,
// and a second copy of an alpha-bbox scanner is a copy that can disagree with
// the first about what "opaque" means.
import { createCanvas, loadImage } from "@napi-rs/canvas";

/** Decoded RGBA pixels plus the canvas they cover. */
export async function readPixels(source) {
  const image = await loadImage(source);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  return {
    width: image.width,
    height: image.height,
    data: context.getImageData(0, 0, image.width, image.height).data,
  };
}

/** The RGBA channels at one pixel, as a plain array. */
export function pixelAt(pixels, x, y) {
  const offset = (y * pixels.width + x) * 4;
  return Array.from(pixels.data.subarray(offset, offset + 4));
}

/**
 * Bounding box of pixels at or above the alpha threshold, or null when none is.
 * The null matters: a caller that treats "nothing is drawn" as a box gets
 * negative dimensions that compare equal to each other and can satisfy a
 * symmetry assertion, so a blank image reads as a healthy one.
 */
export function opaqueBounds(pixels, threshold = 128) {
  let left = pixels.width;
  let top = pixels.height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < pixels.height; y += 1) {
    for (let x = 0; x < pixels.width; x += 1) {
      if (pixels.data[(y * pixels.width + x) * 4 + 3] < threshold) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }
  if (right < 0) return null;
  return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}
