/** Copy original PNG bytes, never the fitted preview. Other raster formats
 * are decoded at their natural dimensions because the clipboard requires PNG. */
export async function copyImage(src: string): Promise<void> {
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
    throw new Error("Image clipboard is unavailable");
  }
  const response = await fetch(src);
  if (!response.ok) throw new Error("Image could not be loaded");
  let blob = await response.blob();
  if (blob.type !== "image/png") {
    const bitmap = await createImageBitmap(blob);
    try {
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Image could not be decoded");
      context.drawImage(bitmap, 0, 0);
      blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(
        (png) => png ? resolve(png) : reject(new Error("Image could not be encoded")), "image/png",
      ));
    } finally {
      bitmap.close();
    }
  }
  await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
}
