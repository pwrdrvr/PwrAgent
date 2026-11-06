import fc from "fast-check";
import { expect, it } from "vitest";
import { normalizeImageFile, type ImageNormalizationDependencies } from "../image-normalization";

// The user's File is the byte oracle, independent of canvas encoding size.
it("remote image normalization never sends more bytes than the user's original", async () => {
  await fc.assert(fc.asyncProperty(
    fc.uint8Array({ minLength: 1, maxLength: 128 }),
    fc.integer({ min: 1, max: 256 }),
    async (original, encodedSize) => {
      const encoded = new Uint8Array(encodedSize).fill(7);
      const dependencies: ImageNormalizationDependencies = {
        createCanvas: (width, height) => ({ canvas: { width, height } as HTMLCanvasElement, context: {} as CanvasRenderingContext2D }),
        decodeImage: async () => ({ width: 6000, height: 4000, draw: () => undefined }),
        hasAlpha: () => false,
        encodeCanvas: async () => new Blob([encoded], { type: "image/png" }),
        readBlobAsDataUrl: async (blob) => `data:${blob.type};base64,${Buffer.from(await blob.arrayBuffer()).toString("base64")}`,
      };
      const file = new File([original], "fixture.png", { type: "image/png" });
      const result = await normalizeImageFile(file, { preserveOriginalIfLarger: true, dependencies });
      const sent = Buffer.from(result.dataUrl.split(",")[1], "base64");
      expect(sent.length).toBeLessThanOrEqual(file.size);
      if (encodedSize >= file.size) expect(sent).toEqual(Buffer.from(original));
    },
  ));
});
