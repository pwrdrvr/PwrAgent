import { describe, expect, it, vi } from "vitest";
import {
  calculateBoundedImageDimensions,
  chooseNormalizedImageMimeType,
  normalizeImageFile,
  type ImageNormalizationDependencies,
} from "../image-normalization";

function makeDependencies(params: {
  decode?: ImageNormalizationDependencies["decodeImage"];
  hasAlpha?: boolean;
  outputBytes?: number[];
}): ImageNormalizationDependencies {
  return {
    createCanvas: (width, height) => ({
      canvas: { height, width } as HTMLCanvasElement,
      context: {
        drawImage: vi.fn(),
        getImageData: vi.fn(),
      } as unknown as CanvasRenderingContext2D,
    }),
    decodeImage:
      params.decode ??
      vi.fn(async () => ({
        width: 1024,
        height: 1024,
        draw: vi.fn(),
      })),
    encodeCanvas: vi.fn(async (_canvas, mimeType) =>
      new Blob([new Uint8Array(params.outputBytes ?? [1, 2, 3])], { type: mimeType }),
    ),
    hasAlpha: vi.fn(() => Boolean(params.hasAlpha)),
    readBlobAsDataUrl: vi.fn(async (blob) => `data:${blob.type};base64,AQID`),
  };
}

describe("image normalization", () => {
  it("keeps square 1024 images unchanged", () => {
    expect(calculateBoundedImageDimensions({ width: 1024, height: 1024 })).toEqual({
      width: 1024,
      height: 1024,
    });
  });

  it("allows 1536x1024 images unchanged", () => {
    expect(calculateBoundedImageDimensions({ width: 1536, height: 1024 })).toEqual({
      width: 1536,
      height: 1024,
    });
  });

  it("caps landscape images by the short edge", () => {
    expect(calculateBoundedImageDimensions({ width: 3000, height: 2000 })).toEqual({
      width: 1536,
      height: 1024,
    });
  });

  it("caps portrait images by the short edge", () => {
    expect(calculateBoundedImageDimensions({ width: 2000, height: 3000 })).toEqual({
      width: 1024,
      height: 1536,
    });
  });

  it("does not upscale small images", () => {
    expect(calculateBoundedImageDimensions({ width: 640, height: 480 })).toEqual({
      width: 640,
      height: 480,
    });
  });

  it("uses PNG for alpha or PNG/SVG sources and JPEG otherwise", () => {
    expect(
      chooseNormalizedImageMimeType({
        hasAlpha: true,
        sourceMimeType: "image/jpeg",
      }),
    ).toBe("image/png");
    expect(
      chooseNormalizedImageMimeType({
        hasAlpha: false,
        sourceMimeType: "image/png",
      }),
    ).toBe("image/png");
    expect(
      chooseNormalizedImageMimeType({
        hasAlpha: false,
        sourceMimeType: "image/webp",
      }),
    ).toBe("image/jpeg");
  });

  it("normalizes decoded images to bounded dimensions and final data URL", async () => {
    const dependencies = makeDependencies({
      decode: vi.fn(async () => ({
        width: 3000,
        height: 2000,
        draw: vi.fn(),
      })),
    });

    await expect(
      normalizeImageFile(
        new File([new Uint8Array([1])], "photo.webp", { type: "image/webp" }),
        { dependencies },
      ),
    ).resolves.toEqual({
      conversionPath: "renderer",
      dataUrl: "data:image/jpeg;base64,AQID",
      height: 1024,
      mimeType: "image/jpeg",
      original: {
        height: 2000,
        mimeType: "image/webp",
        name: "photo.webp",
        size: 1,
        width: 3000,
      },
      size: 3,
      width: 1536,
    });
  });

  it("routes HEIC decode failures through the fallback and normalizes the result", async () => {
    const decode = vi
      .fn<ImageNormalizationDependencies["decodeImage"]>()
      .mockRejectedValueOnce(new Error("unsupported"))
      .mockResolvedValueOnce({
        width: 1536,
        height: 1024,
        draw: vi.fn(),
      });
    const dependencies = makeDependencies({ decode });
    const fallback = vi.fn(async () => ({
      dataUrl: "data:image/png;base64,AQID",
      mimeType: "image/png" as const,
      size: 3,
    }));

    const normalized = await normalizeImageFile(
      new File([new Uint8Array([1, 2, 3, 4])], "photo.heic", {
        type: "image/heic",
      }),
      { dependencies, fallback },
    );

    expect(fallback).toHaveBeenCalledWith({
      data: expect.any(ArrayBuffer),
      fileName: "photo.heic",
      mimeType: "image/heic",
    });
    expect(decode).toHaveBeenCalledTimes(2);
    expect(normalized).toMatchObject({
      conversionPath: "heic-fallback",
      dataUrl: "data:image/png;base64,AQID",
      height: 1024,
      mimeType: "image/png",
      width: 1536,
    });
  });

  it("infers HEIC fallback routing from the file extension when MIME is missing", async () => {
    const dependencies = makeDependencies({
      decode: vi
        .fn<ImageNormalizationDependencies["decodeImage"]>()
        .mockRejectedValueOnce(new Error("unsupported"))
        .mockResolvedValueOnce({
          width: 1024,
          height: 1024,
          draw: vi.fn(),
        }),
    });
    const fallback = vi.fn(async () => ({
      dataUrl: "data:image/png;base64,AQID",
      mimeType: "image/png" as const,
      size: 3,
    }));

    await normalizeImageFile(new File([new Uint8Array([1])], "photo.heic"), {
      dependencies,
      fallback,
    });

    expect(fallback).toHaveBeenCalledWith({
      data: expect.any(ArrayBuffer),
      fileName: "photo.heic",
      mimeType: "image/heic",
    });
  });

  it("rejects unreadable non-HEIC images without calling the fallback", async () => {
    const fallback = vi.fn();
    const dependencies = makeDependencies({
      decode: vi.fn(async () => {
        throw new Error("unsupported");
      }),
    });

    await expect(
      normalizeImageFile(
        new File([new Uint8Array([1])], "bad.bmp", { type: "image/bmp" }),
        { dependencies, fallback },
      ),
    ).rejects.toThrow("Unsupported or unreadable image format: image/bmp");
    expect(fallback).not.toHaveBeenCalled();
  });
});
