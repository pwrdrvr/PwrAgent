/** Copy original PNG bytes, never the fitted preview. Other images are
 * rasterized to PNG because the clipboard requires PNG. */
export async function copyImage(src: string): Promise<void> {
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
    throw new Error("Image clipboard is unavailable");
  }
  const response = await fetch(src);
  if (!response.ok) throw new Error("Image could not be loaded");
  let blob = await response.blob();
  if (blob.type !== "image/png") {
    blob = blob.type === "image/svg+xml"
      ? await rasterizeSvg(blob)
      : await rasterizeBitmap(blob);
  }
  await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
}

async function rasterizeSvg(blob: Blob): Promise<Blob> {
  const url = URL.createObjectURL(blob);
  const image = new Image();
  try {
    image.src = url;
    await image.decode();
    const width = image.naturalWidth;
    const height = image.naturalHeight;
    if (!width || !height) throw new Error("Image has invalid dimensions");
    const scale = Math.min(1, 8192 / width, 8192 / height, Math.sqrt(16_000_000 / (width * height)));
    return await encodePng(image, Math.max(1, Math.floor(width * scale)), Math.max(1, Math.floor(height * scale)));
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function rasterizeBitmap(blob: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  try {
    return await encodePng(bitmap, bitmap.width, bitmap.height);
  } finally {
    bitmap.close();
  }
}

async function encodePng(image: CanvasImageSource, width: number, height: number): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  try {
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image could not be decoded");
    context.drawImage(image, 0, 0, width, height);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob(
      (png) => png ? resolve(png) : reject(new Error("Image could not be encoded")), "image/png",
    ));
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}
