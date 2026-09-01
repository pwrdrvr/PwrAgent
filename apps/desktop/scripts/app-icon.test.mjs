import { createCanvas, loadImage } from "@napi-rs/canvas";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const macOSIcon = resolve(here, "../build/icon-macos.png");

describe("macOS app icon", () => {
  it("keeps the tile inside Apple's legacy safe area", async () => {
    const image = await loadImage(macOSIcon);
    const canvas = createCanvas(image.width, image.height);
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, image.width, image.height).data;
    let left = image.width;
    let top = image.height;
    let right = -1;
    let bottom = -1;
    for (let y = 0; y < image.height; y += 1) {
      for (let x = 0; x < image.width; x += 1) {
        const alpha = pixels[(y * image.width + x) * 4 + 3];
        if (alpha < 128) continue;
        left = Math.min(left, x);
        top = Math.min(top, y);
        right = Math.max(right, x);
        bottom = Math.max(bottom, y);
      }
    }

    expect({
      x: left,
      y: top,
      width: right - left + 1,
      height: bottom - top + 1,
    }).toEqual({ x: 100, y: 100, width: 824, height: 824 });
  });
});
