import fc from "fast-check";
import { expect, it, vi } from "vitest";
import { federationImageDimensions, normalizeFederationImage } from "../federation/federation-image-normalization";

vi.mock("electron", () => ({ nativeImage: { createFromBuffer: vi.fn() } }));

// The provider counts ceil(width / 32) * ceil(height / 32), not pixel area.
it("provider images meet the patch oracle for every aspect ratio", () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 100_000 }), fc.integer({ min: 1, max: 100_000 }),
    (width, height) => {
      const dimensions = federationImageDimensions(width, height);
      expect(Math.ceil(dimensions.width / 32) * Math.ceil(dimensions.height / 32)).toBeLessThanOrEqual(4096);
      expect(dimensions.width).toBeLessThanOrEqual(width);
      expect(dimensions.height).toBeLessThanOrEqual(height);
    }));
});

it("keeps larger re-encodings off the wire while always reducing provider pixels", () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 128 }), fc.integer({ min: 1, max: 256 }),
    (originalSize, reducedSize) => {
      const original = Buffer.alloc(originalSize, 1);
      const reduced = Buffer.alloc(reducedSize, 2);
      const resized = { getSize: () => ({ width: 1024, height: 1024 }), isEmpty: () => false, toPNG: () => reduced };
      const image = { getSize: () => ({ width: 6000, height: 4000 }), isEmpty: () => false,
        resize: () => resized } as unknown as Electron.NativeImage;
      const sending = normalizeFederationImage(original, { sending: true, createImage: () => image });
      expect(sending.length).toBeLessThanOrEqual(original.length);
      if (reducedSize >= originalSize) expect(sending).toBe(original);
      expect(normalizeFederationImage(original, { sending: false, createImage: () => image })).toBe(reduced);
    }));
});
