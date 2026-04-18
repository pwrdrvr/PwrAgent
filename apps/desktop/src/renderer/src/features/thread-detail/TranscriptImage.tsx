import { useEffect, useState } from "react";
import type { ImgHTMLAttributes } from "react";

type TranscriptImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> & {
  src: string;
};

export function TranscriptImage(props: TranscriptImageProps) {
  const { src, ...imageProps } = props;
  const resolvedSrc = useResolvedTranscriptImageSrc(src);

  return <img {...imageProps} src={resolvedSrc} />;
}

function useResolvedTranscriptImageSrc(src: string): string {
  const [resolvedSrc, setResolvedSrc] = useState(src);

  useEffect(() => {
    if (!isEmbeddedImageDataUrl(src) || typeof URL.createObjectURL !== "function") {
      setResolvedSrc(src);
      return;
    }

    const objectUrl = createObjectUrlFromDataUrl(src);
    setResolvedSrc(objectUrl ?? src);

    return () => {
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [src]);

  return resolvedSrc;
}

function isEmbeddedImageDataUrl(src: string): boolean {
  return src.startsWith("data:image/");
}

function createObjectUrlFromDataUrl(src: string): string | undefined {
  const commaIndex = src.indexOf(",");
  if (commaIndex <= "data:".length) {
    return undefined;
  }

  const metadata = src.slice("data:".length, commaIndex);
  const payload = src.slice(commaIndex + 1);
  if (!payload) {
    return undefined;
  }

  const segments = metadata.split(";");
  const mimeType = segments[0] || "application/octet-stream";
  const isBase64 = segments.includes("base64");

  try {
    const bytes = isBase64
      ? decodeBase64Payload(payload)
      : new TextEncoder().encode(decodeURIComponent(payload));
    return URL.createObjectURL(new Blob([toArrayBuffer(bytes)], { type: mimeType }));
  } catch {
    return undefined;
  }
}

function decodeBase64Payload(payload: string): Uint8Array {
  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}
