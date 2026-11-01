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
  it("allows event-loop work while decode is pending and retains the eventual image", async () => {
    type DecodedImage = Awaited<ReturnType<ImageNormalizationDependencies["decodeImage"]>>;
    let finishDecode!: (image: DecodedImage) => void;
    const decodeResult = new Promise<DecodedImage>((resolve) => {
      finishDecode = resolve;
    });
    const close = vi.fn();
    const dependencies = makeDependencies({ decode: () => decodeResult });
    const normalized = normalizeImageFile(
      new File([new Uint8Array([1, 2, 3])], "delayed.png", { type: "image/png" }),
      { dependencies },
    );
    const settled = vi.fn();
    void normalized.then(settled);

    // This exercises a pending asynchronous decoder, not a blocked native
    // clipboard read. No system clipboard or real decoder is involved.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(settled).not.toHaveBeenCalled();
    expect(dependencies.readBlobAsDataUrl).not.toHaveBeenCalled();

    finishDecode({ width: 1024, height: 1024, draw: vi.fn(), close });
    await expect(normalized).resolves.toMatchObject({
      dataUrl: "data:image/png;base64,AQID",
      original: { name: "delayed.png", size: 3 },
      width: 1024,
      height: 1024,
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it("releases the decoded image when encoding fails", async () => {
    const close = vi.fn();
    const failure = new Error("injected encoder failure");
    const dependencies = makeDependencies({
      decode: async () => ({ width: 2880, height: 1920, draw: vi.fn(), close }),
      encode: async () => { throw failure; },
    });

    await expect(normalizeImageFile(
      new File([new Uint8Array([1, 2, 3])], "capture.png", { type: "image/png" }),
      { dependencies },
    )).rejects.toBe(failure);
    expect(close).toHaveBeenCalledOnce();
    expect(dependencies.readBlobAsDataUrl).not.toHaveBeenCalled();
  });

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
        { dependencies, maxPatchCount: 1536 },
      ),
    ).resolves.toEqual({
      timing: {
        decodeMs: expect.any(Number),
        encodeCount: 1,
        encodeMs: expect.any(Number),
        readMs: expect.any(Number),
        totalMs: expect.any(Number),
      },
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

  it.each(["image/png", "image/jpeg"])(
    "encodes %s once at the patch limit even when the result has more bytes",
    async (mimeType) => {
      const dependencies = makeDependencies({
        decode: async () => ({ width: 4096, height: 4096, draw: vi.fn() }),
        encode: vi.fn(async () => new Blob([new Uint8Array(140)], { type: mimeType })),
      });
      const normalized = await normalizeImageFile(
        new File([new Uint8Array(100)], "image", { type: mimeType }),
        { dependencies },
      );

      expect(normalized).toMatchObject({
        height: 2048,
        width: 2048,
        mimeType,
        size: 140,
      });
      expect(dependencies.encodeCanvas).toHaveBeenCalledExactlyOnceWith(
        expect.anything(), mimeType, 0.85,
      );
    },
  );

  it("preserves ordinary screenshot bytes under the default safety limit", async () => {
    const dependencies = makeDependencies({
      decode: async () => ({ width: 1820, height: 1153, draw: vi.fn() }),
    });
    const normalized = await normalizeImageFile(
      new File([new Uint8Array(112022)], "screenshot.png", { type: "image/png" }),
      { dependencies },
    );
    expect(normalized).toMatchObject({ width: 1820, height: 1153, size: 112022 });
    expect(dependencies.encodeCanvas).not.toHaveBeenCalled();
    expect(dependencies.hasAlpha).not.toHaveBeenCalled();
  });

  it("bounds extreme still-image dimensions without upscaling or exceeding the budget", () => {
    const dimensions = calculatePatchBoundedImageDimensions({
      width: 20_000_000, height: 20_000_000, maxPatchCount: 4096,
    });
    expect(dimensions).toEqual({ width: 2048, height: 2048 });
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

  it("preserves PNG bytes when clipboard item MIME fills an empty File type", async () => {
    const dependencies = makeDependencies({
      decode: vi.fn(async () => ({
        width: 640,
        height: 480,
        draw: vi.fn(),
      })),
    });

    const normalized = await normalizeImageFile(
      new File([new Uint8Array([1, 2, 3])], "image"),
      {
        dependencies,
        maxPatchCount: 1536,
        sourceMimeType: "image/png",
      },
    );

    expect(dependencies.encodeCanvas).not.toHaveBeenCalled();
    expect(normalized).toMatchObject({
      dataUrl: "data:image/png;base64,AQID",
      height: 480,
      mimeType: "image/png",
      original: {
        mimeType: "image/png",
        size: 3,
      },
      size: 3,
      width: 640,
    });
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

  it("preserves extension-inferred JPEG files with empty blob MIME types", async () => {
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

    expect(dependencies.encodeCanvas).not.toHaveBeenCalled();
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
