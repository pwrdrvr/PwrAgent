export type ComposerImageFile = {
  file: File;
  type: string;
};

export function getComposerFilesFromDataTransfer(
  dataTransfer: DataTransfer,
): { images: ComposerImageFile[]; files: File[]; readMs: number } {
  const start = performance.now();
  const images: ComposerImageFile[] = [];
  const files: File[] = [];
  const seenImages = new Set<string>();
  const seenFiles = new Set<string>();
  let foundImageItem = false;
  let foundFileItem = false;

  for (const item of Array.from(dataTransfer.items)) {
    if (item.kind !== "file") continue;
    // Native clipboard extraction can be expensive. Classify each File once
    // instead of calling getAsFile again to collect non-image attachments.
    const file = item.getAsFile();
    if (!file) continue;
    foundFileItem = true;
    const type = isSupportedComposerImageMimeType(item.type)
      ? item.type
      : inferTransferImageType(file);
    const key = buildFileKey(file);
    if (type) {
      foundImageItem = true;
      if (!seenImages.has(key)) {
        images.push({ file, type });
        seenImages.add(key);
      }
    } else if (!seenFiles.has(key)) {
      files.push(file);
      seenFiles.add(key);
    }
  }

  if (!foundImageItem || !foundFileItem) {
    for (const file of Array.from(dataTransfer.files)) {
      const type = inferTransferImageType(file);
      const key = buildFileKey(file);
      if (type && !foundImageItem && !seenImages.has(key)) {
        images.push({ file, type });
        seenImages.add(key);
      } else if (!type && !foundFileItem && !seenFiles.has(key)) {
        files.push(file);
        seenFiles.add(key);
      }
    }
  }
  return { images, files, readMs: performance.now() - start };
}

export function getImageFilesFromDataTransfer(
  dataTransfer: DataTransfer,
): ComposerImageFile[] {
  return getComposerFilesFromDataTransfer(dataTransfer).images;
}

/** Non-image files remain path references, never implicit image uploads. */
export function getNonImageFilesFromDataTransfer(
  dataTransfer: DataTransfer,
): File[] {
  return getComposerFilesFromDataTransfer(dataTransfer).files;
}

export function hasAnyFiles(dataTransfer: DataTransfer): boolean {
  for (const item of Array.from(dataTransfer.items)) {
    if (item.kind === "file") {
      return true;
    }
  }

  return dataTransfer.files.length > 0;
}

function buildFileKey(file: File): string {
  return `${file.name}:${file.type}:${file.size}:${file.lastModified}`;
}

function inferTransferImageType(file: File): string | undefined {
  if (isSupportedComposerImageMimeType(file.type)) {
    return file.type;
  }

  const extension = file.name.toLowerCase().split(".").pop();
  return extension === "gif" ? "image/gif" : undefined;
}

// Keep this list aligned with formats the composer deliberately normalizes or
// preserves. An arbitrary image MIME such as TIFF remains a local file rather
// than authorization to read and upload its contents.
function isSupportedComposerImageMimeType(type: string): boolean {
  switch (type.trim().toLowerCase()) {
    case "image/gif":
    case "image/heic":
    case "image/heif":
    case "image/jpeg":
    case "image/jpg":
    case "image/png":
    case "image/svg+xml":
    case "image/webp":
      return true;
    default:
      return false;
  }
}

export function isGifFile(file: File, type: string): boolean {
  return inferTransferImageType(file) === "image/gif"
    || type.toLowerCase() === "image/gif";
}

export async function getAnimationPreservingImageType(
  file: File,
  type: string,
): Promise<"image/gif" | "image/webp" | undefined> {
  if (isGifFile(file, type)) {
    return "image/gif";
  }
  if ((type || file.type).trim().toLowerCase() !== "image/webp") {
    return undefined;
  }

  // Extended WebP puts VP8X first and stores its animation flag in bit 1.
  // Read only the header; decoding through canvas would flatten the animation.
  // https://developers.google.com/speed/webp/docs/riff_container#extended_file_format
  const blob = file.slice(0, 30);
  const buffer = typeof blob.arrayBuffer === "function"
    ? await blob.arrayBuffer()
    : await new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener("load", () => resolve(reader.result as ArrayBuffer));
      reader.addEventListener("error", () => reject(reader.error));
      reader.readAsArrayBuffer(blob);
    });
  const header = new Uint8Array(buffer);
  if (header.length < 30) {
    return undefined;
  }
  const view = new DataView(header.buffer);
  if (
    view.getUint32(0) === 0x52494646
    && view.getUint32(8) === 0x57454250
    && view.getUint32(12) === 0x56503858
    && view.getUint32(16, true) === 10
    && (header[20]! & 0x02) !== 0
  ) {
    return "image/webp";
  }
  return undefined;
}

export function readFileAsImageDataUrl(
  file: File,
  mimeType: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") {
        if (reader.result.startsWith(`data:${mimeType}`)) {
          resolve(reader.result);
          return;
        }
        if (/^data:[^,]*,/i.test(reader.result)) {
          resolve(
            reader.result.replace(
              /^data:[^,]*,/i,
              `data:${mimeType};base64,`,
            ),
          );
          return;
        }
      }
      reject(new Error("The image did not produce an image data URL."));
    });
    reader.addEventListener("error", () => {
      reject(reader.error ?? new Error("The image could not be read."));
    });
    reader.readAsDataURL(file);
  });
}

export function formatPastedImageName(type: string, index: number): string {
  const extension = type.split("/")[1] || "png";
  return `pasted-image-${index + 1}.${extension}`;
}

export function formatPastedImageAlt(
  attachment: { name: string },
  index: number,
): string {
  return attachment.name || `Pasted image ${index + 1}`;
}

/** An image fetched by the main process, as a file the composer can attach. */
export function composerImageFileFromBase64(image: {
  name: string;
  mimeType: string;
  dataBase64: string;
}): ComposerImageFile {
  const binary = atob(image.dataBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return {
    file: new File([bytes], image.name, { type: image.mimeType }),
    type: image.mimeType,
  };
}
