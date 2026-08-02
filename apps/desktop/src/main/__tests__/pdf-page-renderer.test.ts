import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  calculatePdfRenderDimensions,
  renderPdfPages,
} from "../messaging/pdf-page-renderer";

const jeepStickerPageFixture = fileURLToPath(
  new URL("./fixtures/pdf/jeep-sticker-page-size.pdf", import.meta.url),
);

describe("PDF page renderer", () => {
  it("uses the full high-profile bounds to rasterize a landscape vector page", () => {
    expect(
      calculatePdfRenderDimensions({
        height: 792,
        profile: "high",
        width: 1224,
      }),
    ).toEqual({ height: 1988, width: 3072 });
  });

  it("preserves the aspect ratio inside every profile's bounds", () => {
    expect(
      calculatePdfRenderDimensions({
        height: 792,
        profile: "medium",
        width: 1224,
      }),
    ).toEqual({ height: 1024, width: 1583 });
    expect(
      calculatePdfRenderDimensions({
        height: 1224,
        profile: "high",
        width: 792,
      }),
    ).toEqual({ height: 3072, width: 1988 });
  });

  it("renders a Jeep-sticker-sized PDF page at the selected high-profile resolution", async () => {
    const pages = await renderPdfPages({
      data: await readFile(jeepStickerPageFixture),
      profile: "high",
    });

    expect(pages).toEqual([
      expect.objectContaining({
        height: 1988,
        pageNumber: 1,
        width: 3072,
      }),
    ]);
    expect(pages[0]).toMatchObject({
      base64: expect.any(String),
      mimeType: "image/png",
    });
  });

  it("rejects a render before allocating a page canvas when the pixel budget is too small", async () => {
    await expect(
      renderPdfPages({
        data: await readFile(jeepStickerPageFixture),
        limits: { maxPixels: 1 },
        pageNumbers: [1],
        profile: "high",
      }),
    ).rejects.toThrow("pixel limit");
  });

  it("rejects a render when the encoded image budget is exceeded", async () => {
    await expect(
      renderPdfPages({
        data: await readFile(jeepStickerPageFixture),
        limits: { maxEncodedBytes: 1 },
        pageNumbers: [1],
        profile: "high",
      }),
    ).rejects.toThrow("image-data limit");
  });

  it("rejects a render when one rendered page exceeds the per-image limit", async () => {
    await expect(
      renderPdfPages({
        data: await readFile(jeepStickerPageFixture),
        limits: { maxPageEncodedBytes: 1 },
        pageNumbers: [1],
        profile: "high",
      }),
    ).rejects.toThrow("per-image limit");
  });

  it("rejects a render when base64 expansion exceeds the model-input limit", async () => {
    await expect(
      renderPdfPages({
        data: await readFile(jeepStickerPageFixture),
        limits: { maxWireBytes: 1 },
        pageNumbers: [1],
        profile: "high",
      }),
    ).rejects.toThrow("model-input limit");
  });
});
