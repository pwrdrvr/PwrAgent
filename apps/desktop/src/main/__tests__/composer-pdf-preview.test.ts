import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  COMPOSER_PDF_PREVIEW_MAX_LONG_EDGE,
  calculateComposerPdfPreviewDimensions,
  renderComposerPdfPreview,
} from "../pdf/composer-pdf-preview";
import { ComposerPdfPreviewReferences } from "../pdf/composer-pdf-preview-references";

function createSinglePagePdf(): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents 4 0 R >>",
    "<< /Length 0 >>\nstream\n\nendstream",
  ];
  let output = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(output));
    output += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(output);
  output += "xref\n0 5\n0000000000 65535 f \n";
  for (const offset of offsets) {
    output += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  output += `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(output);
}

describe("Composer PDF preview", () => {
  it("renders only page one into a small, local PNG", async () => {
    expect(
      calculateComposerPdfPreviewDimensions({ height: 792, width: 1224 }),
    ).toEqual({ height: 311, width: COMPOSER_PDF_PREVIEW_MAX_LONG_EDGE });

    const preview = await renderComposerPdfPreview({
      data: createSinglePagePdf(),
    });

    expect(preview).toMatchObject({
      dataUrl: expect.stringMatching(/^data:image\/png;base64,/),
      height: COMPOSER_PDF_PREVIEW_MAX_LONG_EDGE,
      pageCount: 1,
    });
    expect(preview.width).toBeLessThan(COMPOSER_PDF_PREVIEW_MAX_LONG_EDGE);
  });

  it("renders only capabilities issued for explicit Composer PDF references", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-composer-pdf-"));
    const pdfPath = path.join(root, "Jeep");
    const textPath = path.join(root, "notes.pdf");
    const previewReferences = new ComposerPdfPreviewReferences();
    try {
      await writeFile(pdfPath, createSinglePagePdf());
      await writeFile(textPath, "not a PDF");

      const inspected = previewReferences.inspect({
        paths: [pdfPath, textPath],
        scopeId: "thread:codex:thread-1",
      });
      expect(inspected.references).toHaveLength(1);
      expect(inspected.references[0]).toMatchObject({ path: pdfPath });
      const reference = inspected.references[0]!;

      await expect(
        previewReferences.render({
          previewId: "not-an-authorized-reference",
          scopeId: "thread:codex:thread-1",
        }),
      ).rejects.toThrow("no longer an active Composer reference");
      await expect(
        previewReferences.render({
          previewId: reference.previewId,
          scopeId: "thread:codex:other-thread",
        }),
      ).rejects.toThrow("no longer an active Composer reference");

      const preview = await previewReferences.render({
        previewId: reference.previewId,
        scopeId: "thread:codex:thread-1",
      });
      expect(preview).toMatchObject({
        dataUrl: expect.stringMatching(/^data:image\/png;base64,/),
        fileIdentity: reference.fileIdentity,
        unchanged: false,
      });
      await expect(
        previewReferences.render({
          knownFileIdentity: reference.fileIdentity,
          previewId: reference.previewId,
          scopeId: "thread:codex:thread-1",
        }),
      ).resolves.toEqual({
        fileIdentity: reference.fileIdentity,
        unchanged: true,
      });

      await writeFile(pdfPath, Buffer.concat([createSinglePagePdf(), Buffer.from("\n% changed\n")]));
      await expect(
        previewReferences.render({
          previewId: reference.previewId,
          scopeId: "thread:codex:thread-1",
        }),
      ).rejects.toThrow("selected PDF changed");

      const revalidated = previewReferences.inspect({
        paths: [pdfPath],
        scopeId: "thread:codex:thread-1",
      });
      expect(revalidated.references[0]?.fileIdentity).not.toBe(
        reference.fileIdentity,
      );
      expect(revalidated.references[0]?.previewId).not.toBe(reference.previewId);
    } finally {
      previewReferences.clear();
      await rm(root, { force: true, recursive: true });
    }
  });
});
