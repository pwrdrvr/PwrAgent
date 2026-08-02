import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  COMPOSER_PDF_PREVIEW_MAX_LONG_EDGE,
  calculateComposerPdfPreviewDimensions,
  renderComposerPdfPreview,
} from "../pdf/composer-pdf-preview";

const jeepStickerPageFixture = fileURLToPath(
  new URL("./fixtures/pdf/jeep-sticker-page-size.pdf", import.meta.url),
);

describe("Composer PDF preview renderer", () => {
  it("caps the first-page thumbnail independently of model image profiles", () => {
    expect(
      calculateComposerPdfPreviewDimensions({
        height: 792,
        width: 1224,
      }),
    ).toEqual({ height: 311, width: COMPOSER_PDF_PREVIEW_MAX_LONG_EDGE });
  });

  it("renders just page one into a small local PNG data URL", async () => {
    const preview = await renderComposerPdfPreview({
      data: await readFile(jeepStickerPageFixture),
    });

    expect(preview).toMatchObject({
      dataUrl: expect.stringMatching(/^data:image\/png;base64,/),
      pageCount: 1,
      width: COMPOSER_PDF_PREVIEW_MAX_LONG_EDGE,
    });
    expect(preview.height).toBeLessThan(COMPOSER_PDF_PREVIEW_MAX_LONG_EDGE);
  });
});
