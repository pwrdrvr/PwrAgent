import { describe, expect, it, vi } from "vitest";
import {
  calculateBoundedImageDimensions,
  calculatePatchBoundedImageDimensions,
  chooseNormalizedImageMimeType,
  normalizeImageFile,
  type ImageNormalizationDependencies,
} from "../image-normalization";

function makeDependencies(params: {
  decode?: ImageNormalizationDependencies["decodeImage"];
  encode?: ImageNormalizationDependencies["encodeCanvas"];
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
    encodeCanvas:
      params.encode ??
      vi.fn(async (_canvas, mimeType) =>
        new Blob([new Uint8Array(params.outputBytes ?? [1, 2, 3])], {
          type: mimeType,
        }),
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

  it("caps images by a patch budget when provided", () => {
    expect(
      calculatePatchBoundedImageDimensions({
        width: 2048,
        height: 2048,
        maxPatchCount: 1024,
      }),
    ).toEqual({ width: 1024, height: 1024 });
    expect(
      calculatePatchBoundedImageDimensions({
        width: 2048,
        height: 2048,
        maxPatchCount: 0,
      }),
    ).toEqual({ width: 2048, height: 2048 });
  });

  it("leaves images within 20 percent of the patch budget alone", () => {
    expect(
      calculatePatchBoundedImageDimensions({
        width: 1120,
        height: 1024,
        maxPatchCount: 1024,
      }),
    ).toEqual({ width: 1120, height: 1024 });
  });

  it("only reduces dimensions and keeps the aspect ratio when patch capping", () => {
    const dimensions = calculatePatchBoundedImageDimensions({
      width: 2880,
      height: 1920,
      maxPatchCount: 1024,
    });

    expect(dimensions.width).toBeLessThan(2880);
    expect(dimensions.height).toBeLessThan(1920);
    expect(dimensions.width / dimensions.height).toBeCloseTo(2880 / 1920, 2);
  });

  it("does not upscale images below the selected patch budget", () => {
    expect(
      calculatePatchBoundedImageDimensions({
        width: 800,
        height: 533,
        maxPatchCount: 4096,
      }),
    ).toEqual({ width: 800, height: 533 });
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

  it("passes the pasted image patch budget into normalization", async () => {
    const dependencies = makeDependencies({
      decode: vi.fn(async () => ({
        width: 2048,
        height: 2048,
        draw: vi.fn(),
      })),
    });

    const normalized = await normalizeImageFile(
      new File([new Uint8Array([1, 2, 3, 4])], "screenshot.png", {
        type: "image/png",
      }),
      { dependencies, maxPatchCount: 1024 },
    );

    expect(normalized.width).toBe(1024);
    expect(normalized.height).toBe(1024);
  });

  it("does not let resized PNG encoding grow beyond the source size", async () => {
    const encodeCanvas = vi.fn(async (canvas, mimeType) => {
      const size = canvas.width < 1024 ? 90 : 140;
      return new Blob([new Uint8Array(size)], { type: mimeType });
    });
    const dependencies = makeDependencies({
      decode: vi.fn(async () => ({
        width: 2048,
        height: 2048,
        draw: vi.fn(),
      })),
      encode: encodeCanvas,
    });

    const normalized = await normalizeImageFile(
      new File([new Uint8Array(100)], "screenshot.png", { type: "image/png" }),
      { dependencies, maxPatchCount: 1024 },
    );

    expect(normalized).toMatchObject({
      height: 972,
      mimeType: "image/png",
      size: 90,
      width: 972,
    });
    expect(encodeCanvas).toHaveBeenCalledTimes(2);
  });

  it("preserves the patch cap when every resized PNG encoding is larger", async () => {
    const encodeCanvas = vi.fn(async (_canvas, mimeType) =>
      new Blob([new Uint8Array(140)], { type: mimeType }),
    );
    const dependencies = makeDependencies({
      decode: vi.fn(async () => ({
        width: 2048,
        height: 2048,
        draw: vi.fn(),
      })),
      encode: encodeCanvas,
    });

    const normalized = await normalizeImageFile(
      new File([new Uint8Array(100)], "screenshot.png", { type: "image/png" }),
      { dependencies, maxPatchCount: 1024 },
    );

    expect(normalized).toMatchObject({
      dataUrl: "data:image/png;base64,AQID",
      height: 1024,
      mimeType: "image/png",
      size: 140,
      width: 1024,
    });
  });

  it("preserves PNG bytes when actual size is selected", async () => {
    const dependencies = makeDependencies({
      decode: vi.fn(async () => ({
        width: 2880,
        height: 1920,
        draw: vi.fn(),
      })),
    });

    const normalized = await normalizeImageFile(
      new File([new Uint8Array(329 * 1024)], "screenshot.png", {
        type: "image/png",
      }),
      { dependencies, maxPatchCount: 0 },
    );

    expect(dependencies.encodeCanvas).not.toHaveBeenCalled();
    expect(normalized).toMatchObject({
      dataUrl: "data:image/png;base64,AQID",
      height: 1920,
      mimeType: "image/png",
      size: 329 * 1024,
      width: 2880,
    });
  });

  it("retries JPEG encoding when a resized output is larger than the source", async () => {
    const encodeCanvas = vi.fn(async (_canvas, mimeType, quality) => {
      const size = quality >= 0.85 ? 140 : 90;
      return new Blob([new Uint8Array(size)], { type: mimeType });
    });
    const dependencies = makeDependencies({
      decode: vi.fn(async () => ({
        width: 2048,
        height: 2048,
        draw: vi.fn(),
      })),
      encode: encodeCanvas,
    });

    const normalized = await normalizeImageFile(
      new File([new Uint8Array(100)], "photo.jpeg", { type: "image/jpeg" }),
      { dependencies, maxPatchCount: 1024 },
    );

    expect(normalized.size).toBe(90);
    expect(encodeCanvas).toHaveBeenCalledWith(
      expect.anything(),
      "image/jpeg",
      expect.closeTo(0.85),
    );
    expect(encodeCanvas).toHaveBeenCalledWith(
      expect.anything(),
      "image/jpeg",
      0.84,
    );
  });

  it("preserves JPEG bytes when dimensions already fit", async () => {
    const dependencies = makeDependencies({
      decode: vi.fn(async () => ({
        width: 640,
        height: 480,
        draw: vi.fn(),
      })),
    });

    const normalized = await normalizeImageFile(
      new File([new Uint8Array([1, 2, 3])], "screenshot.jpeg", {
        type: "image/jpeg",
      }),
      { dependencies, maxPatchCount: 1536 },
    );

    expect(dependencies.encodeCanvas).not.toHaveBeenCalled();
    expect(normalized).toMatchObject({
      dataUrl: "data:image/jpeg;base64,AQID",
      height: 480,
      mimeType: "image/jpeg",
      size: 3,
      width: 640,
    });
  });

  it("normalizes extension-inferred JPEG files with empty blob MIME types", async () => {
    const dependencies = makeDependencies({
      decode: vi.fn(async () => ({
        width: 640,
        height: 480,
        draw: vi.fn(),
      })),
    });

    const normalized = await normalizeImageFile(
      new File([new Uint8Array([1, 2, 3])], "screenshot.jpg"),
      { dependencies, maxPatchCount: 1536 },
    );

    expect(dependencies.encodeCanvas).toHaveBeenCalledWith(
      expect.anything(),
      "image/jpeg",
      expect.any(Number),
    );
    expect(normalized).toMatchObject({
      dataUrl: "data:image/jpeg;base64,AQID",
      height: 480,
      mimeType: "image/jpeg",
      size: 3,
      width: 640,
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
