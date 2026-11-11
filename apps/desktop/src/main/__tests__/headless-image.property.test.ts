import { createCanvas } from "@napi-rs/canvas";
import fc from "fast-check";
import { expect, it } from "vitest";
import { createHeadlessImage } from "../headless/image";

it("decodes and resizes generated images through the owner's image contract", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 64 }), fc.integer({ min: 1, max: 64 }),
    fc.integer({ min: 1, max: 64 }), fc.integer({ min: 1, max: 64 }), async (width, height, nextWidth, nextHeight) => {
      const canvas = createCanvas(width, height);
      canvas.getContext("2d").fillRect(0, 0, width, height);
      const image = await createHeadlessImage(canvas.toBuffer("image/png"));
      expect(image.isEmpty()).toBe(false);
      expect(image.getSize()).toEqual({ width, height });
      const resized = image.resize({ width: nextWidth, height: nextHeight, quality: "best" });
      const dimensions = { width: nextWidth, height: nextHeight };
      expect((await createHeadlessImage(resized.toPNG())).getSize()).toEqual(dimensions);
      expect((await createHeadlessImage(resized.toJPEG(90))).getSize()).toEqual(dimensions);
      expect(resized.toDataURL()).toMatch(/^data:image\/png;base64,/);
    }));
  expect((await createHeadlessImage(Buffer.from("invalid image"))).isEmpty()).toBe(true);
});
