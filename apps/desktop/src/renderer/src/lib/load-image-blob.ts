import { getDesktopApi } from "./desktop-api";

/** Chromium can display our image protocol, but renderer fetch is CORS-blocked. */
export async function loadImageBlob(src: string, signal?: AbortSignal): Promise<Blob> {
  const readTranscriptImage = getDesktopApi()?.readTranscriptImage;
  if (src.startsWith("pwragent-image://file/") && readTranscriptImage) {
    const image = await readTranscriptImage(src);
    if (signal?.aborted) throw new DOMException("Image load aborted", "AbortError");
    const binary = atob(image.dataBase64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return new Blob([bytes], { type: image.mimeType });
  }

  const response = signal ? await fetch(src, { signal }) : await fetch(src);
  if (!response.ok) throw new Error("Image could not be loaded");
  return await response.blob();
}
