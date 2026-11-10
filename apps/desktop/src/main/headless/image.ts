import { createCanvas, Image, type Canvas } from "@napi-rs/canvas";
import type { HostImage } from "../owner-host";

function fromCanvas(canvas: Canvas): HostImage {
  return {
    isEmpty: () => canvas.width < 1 || canvas.height < 1,
    getSize: () => ({ width: canvas.width, height: canvas.height }),
    resize: ({ width = canvas.width, height = canvas.height }) => {
      const resized = createCanvas(width, height);
      const context = resized.getContext("2d");
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.drawImage(canvas, 0, 0, width, height);
      return fromCanvas(resized);
    },
    toPNG: () => canvas.toBuffer("image/png"),
    toJPEG: (quality) => canvas.toBuffer("image/jpeg", quality),
    toDataURL: () => canvas.toDataURL("image/png"),
  };
}

export function createHeadlessImage(buffer: Buffer): HostImage {
  const image = new Image();
  try { image.src = buffer; } catch { /* The image contract reports decoding failures as empty. */ }
  const width = image.width;
  const height = image.height;
  const canvas = createCanvas(Math.max(1, width), Math.max(1, height));
  if (width > 0 && height > 0) canvas.getContext("2d").drawImage(image, 0, 0);
  const value = fromCanvas(canvas);
  return { ...value, isEmpty: () => width < 1 || height < 1, getSize: () => ({ width, height }) };
}
