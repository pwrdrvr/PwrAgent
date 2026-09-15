export type DiagramImage = { src: string; width: number; height: number };

/** Native Copy Image copies this PNG's pixels, independently of preview size. */
export async function createDiagramImage(svg: string, background: string): Promise<DiagramImage> {
  const image = new Image();
  image.src = svg;
  await image.decode();
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  if (!width || !height) throw new Error("Invalid diagram dimensions");
  // 2x for sharp pasting, with finite canvas/memory limits for large diagrams.
  const scale = Math.min(2, 8192 / width, 8192 / height, Math.sqrt(16_000_000 / (width * height)));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.floor(width * scale));
  canvas.height = Math.max(1, Math.floor(height * scale));
  try {
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image rendering unavailable");
    context.fillStyle = background;
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return { src: canvas.toDataURL("image/png"), width, height };
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}
