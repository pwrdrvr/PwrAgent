import { ANIMATED_WEBP_BASE64, STATIC_WEBP_BASE64 } from "../../../test/fixtures/animated-images";
import { describe, expect, it, vi } from "vitest";
import { getAnimationPreservingImageType, getComposerFilesFromDataTransfer, getImageFilesFromDataTransfer } from "../composer-image-files";

function imageTransfer(files: File[]): DataTransfer {
  return {
    files,
    items: files.map((file) => ({
      getAsFile: () => file,
      kind: "file",
      type: file.type,
    })),
  } as unknown as DataTransfer;
}

describe("composer image transfer formats", () => {
  it("keeps the full composer image format set available to compact surfaces", () => {
    const files = [
      new File(["gif"], "animated.gif", { type: "image/gif" }),
      new File(["heic"], "camera.heic", { type: "image/heic" }),
      new File(["heif"], "camera.heif", { type: "image/heif" }),
      new File(["jpeg"], "photo.jpeg", { type: "image/jpeg" }),
      new File(["jpg"], "photo.jpg", { type: "image/jpg" }),
      new File(["png"], "capture.png", { type: "image/png" }),
      new File(["svg"], "diagram.svg", { type: "image/svg+xml" }),
      new File(["webp"], "capture.webp", { type: "image/webp" }),
    ];

    expect(
      getImageFilesFromDataTransfer(imageTransfer(files)).map(
        ({ file, type }) => [file.name, type],
      ),
    ).toEqual(files.map((file) => [file.name, file.type]));
  });

  it("does not treat PDFs or arbitrary image MIME types as uploadable images", () => {
    const files = [
      new File(["%PDF"], "brief.pdf", { type: "application/pdf" }),
      new File(["tiff"], "scan.tiff", { type: "image/tiff" }),
    ];

    expect(getImageFilesFromDataTransfer(imageTransfer(files))).toEqual([]);
  });
});

describe("composer clipboard extraction", () => {
  it("reads each native File only once when collecting images and other files", () => {
    const image = new File(["png"], "capture.png", { type: "image/png" });
    const pdf = new File(["pdf"], "brief.pdf", { type: "application/pdf" });
    const imageRead = vi.fn(() => image);
    const pdfRead = vi.fn(() => pdf);
    const result = getComposerFilesFromDataTransfer({
      files: [image, pdf],
      items: [
        { kind: "file", type: image.type, getAsFile: imageRead },
        { kind: "file", type: pdf.type, getAsFile: pdfRead },
      ],
    } as unknown as DataTransfer);
    expect(result.images).toEqual([{ file: image, type: image.type }]);
    expect(result.files).toEqual([pdf]);
    expect(imageRead).toHaveBeenCalledOnce();
    expect(pdfRead).toHaveBeenCalledOnce();
  });

  it.each(["short", "RIFFxxxxWEBPVP8 ", "RIFFxxxxWEBPVP8L"])(
    "does not mistake a static or truncated WebP header for animation: %s",
    async (bytes) => {
      const file = new File([bytes], "image.webp", { type: "image/webp" });
      expect(await getAnimationPreservingImageType(file, file.type)).toBeUndefined();
    },
  );
});

describe("WebP animation detection", () => {
  it.each([
    [ANIMATED_WEBP_BASE64, "image/webp"],
    [STATIC_WEBP_BASE64, undefined],
  ])("distinguishes real animated and still WebP files", async (base64, expected) => {
    const bytes = Uint8Array.from(atob(base64!), (char) => char.charCodeAt(0));
    const file = new File([bytes], "image.webp", { type: "image/webp" });
    expect(await getAnimationPreservingImageType(file, file.type)).toBe(expected);
  });
});
