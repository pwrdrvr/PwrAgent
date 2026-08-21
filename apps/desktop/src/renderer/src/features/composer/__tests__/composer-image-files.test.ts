import { describe, expect, it } from "vitest";
import { getImageFilesFromDataTransfer } from "../composer-image-files";

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
