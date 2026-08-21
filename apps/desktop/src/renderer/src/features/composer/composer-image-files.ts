export type ComposerImageFile = {
  file: File;
  type: string;
};

export function getImageFilesFromDataTransfer(
  dataTransfer: DataTransfer,
): ComposerImageFile[] {
  const files: ComposerImageFile[] = [];
  const seenFiles = new Set<string>();
  let foundImageItem = false;

  for (const item of Array.from(dataTransfer.items)) {
    if (item.kind !== "file") {
      continue;
    }

    const file = item.getAsFile();
    if (!file) {
      continue;
    }

    const type = isSupportedComposerImageMimeType(item.type)
      ? item.type
      : inferTransferImageType(file);
    if (!type) {
      continue;
    }

    foundImageItem = true;
    const key = buildFileKey(file);
    if (!seenFiles.has(key)) {
      files.push({ file, type });
      seenFiles.add(key);
    }
  }

  if (foundImageItem) {
    return files;
  }

  for (const file of Array.from(dataTransfer.files)) {
    const type = inferTransferImageType(file);
    if (!type) {
      continue;
    }

    const key = buildFileKey(file);
    if (!seenFiles.has(key)) {
      files.push({ file, type });
      seenFiles.add(key);
    }
  }

  return files;
}

/**
 * Every dropped/pasted File that is not an image. Image files stay on the
 * upload path; callers can turn the rest into path-only references.
 */
export function getNonImageFilesFromDataTransfer(
  dataTransfer: DataTransfer,
): File[] {
  const files: File[] = [];
  const seenFiles = new Set<string>();
  let foundFileItem = false;

  for (const item of Array.from(dataTransfer.items)) {
    if (item.kind !== "file") {
      continue;
    }

    const file = item.getAsFile();
    if (!file) {
      continue;
    }

    foundFileItem = true;
    if (
      isSupportedComposerImageMimeType(item.type)
      || inferTransferImageType(file)
    ) {
      continue;
    }

    const key = buildFileKey(file);
    if (!seenFiles.has(key)) {
      files.push(file);
      seenFiles.add(key);
    }
  }

  if (foundFileItem) {
    return files;
  }

  for (const file of Array.from(dataTransfer.files)) {
    if (inferTransferImageType(file)) {
      continue;
    }

    const key = buildFileKey(file);
    if (!seenFiles.has(key)) {
      files.push(file);
      seenFiles.add(key);
    }
  }

  return files;
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
