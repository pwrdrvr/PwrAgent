import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

const canvasModuleLoaded = vi.hoisted(() => vi.fn());
const pdfModuleLoaded = vi.hoisted(() => vi.fn());

// PDF.js requires native canvas internally during module initialization. A
// canvas import mock alone cannot observe that dependency's CommonJS require.
vi.mock("pdfjs-dist/legacy/build/pdf.mjs", async () => {
  pdfModuleLoaded();
  return vi.importActual<typeof import("pdfjs-dist/legacy/build/pdf.mjs")>(
    "pdfjs-dist/legacy/build/pdf.mjs",
  );
});

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

describe("PDF runtime lazy loading", () => {
  it("loads PDF.js and native canvas only when PDF work is requested", async () => {
    expect(pdfModuleLoaded).not.toHaveBeenCalled();
    expect(canvasModuleLoaded).not.toHaveBeenCalled();

    calculateComposerPdfPreviewDimensions({ height: 792, width: 1224 });
    calculatePdfRenderDimensions({ height: 792, profile: "medium", width: 1224 });

    expect(canvasModuleLoaded).not.toHaveBeenCalled();

    const data = await readFile(jeepStickerPageFixture);
    expect(pdfModuleLoaded).not.toHaveBeenCalled();
    await renderComposerPdfPreview({ data });

    expect(pdfModuleLoaded).toHaveBeenCalledTimes(1);
    expect(canvasModuleLoaded).toHaveBeenCalledTimes(1);

    await renderPdfPages({ data, profile: "low" });

    expect(pdfModuleLoaded).toHaveBeenCalledTimes(1);
    expect(canvasModuleLoaded).toHaveBeenCalledTimes(1);
  });
});
