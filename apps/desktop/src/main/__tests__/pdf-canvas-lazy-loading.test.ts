import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

const canvasModuleLoaded = vi.hoisted(() => vi.fn());

vi.mock("@napi-rs/canvas", async () => {
  canvasModuleLoaded();
  return vi.importActual<typeof import("@napi-rs/canvas")>("@napi-rs/canvas");
});

import {
  calculateComposerPdfPreviewDimensions,
  renderComposerPdfPreview,
} from "../pdf/composer-pdf-preview";
import {
  calculatePdfRenderDimensions,
  renderPdfPages,
} from "../pdf/pdf-page-renderer";

const jeepStickerPageFixture = fileURLToPath(
  new URL("./fixtures/pdf/jeep-sticker-page-size.pdf", import.meta.url),
);

describe("PDF canvas lazy loading", () => {
  it("loads the native canvas module only when PDF pixels are requested", async () => {
    expect(canvasModuleLoaded).not.toHaveBeenCalled();

    calculateComposerPdfPreviewDimensions({ height: 792, width: 1224 });
    calculatePdfRenderDimensions({ height: 792, profile: "medium", width: 1224 });

    expect(canvasModuleLoaded).not.toHaveBeenCalled();

    const data = await readFile(jeepStickerPageFixture);
    await renderComposerPdfPreview({ data });

    expect(canvasModuleLoaded).toHaveBeenCalledTimes(1);

    await renderPdfPages({ data, profile: "low" });

    expect(canvasModuleLoaded).toHaveBeenCalledTimes(1);
  });
});
