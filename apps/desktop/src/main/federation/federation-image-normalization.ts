import { readFile } from "node:fs/promises";
import { nativeImage } from "electron";
import { DEFAULT_PASTED_IMAGE_MAX_PATCHES } from "../../shared/image-normalization";
import { stageTurnInputAttachment, type StagedTurnInputAttachment } from "../app-server/turn-input-attachment-files";

export function federationImageDimensions(width: number, height: number, maxPatches = DEFAULT_PASTED_IMAGE_MAX_PATCHES): {
  width: number; height: number;
} {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
    || !Number.isSafeInteger(maxPatches) || maxPatches < 1) throw new Error("Invalid image dimensions or patch budget.");
  if (Math.ceil(width / 32) * Math.ceil(height / 32) <= maxPatches) return { width, height };
  // Binary search integer pixel dimensions. Ceil-to-patch, rather than area,
  // is the oracle, including very thin images and patch-edge rounding.
  let low = 0;
  let high = 1;
  for (let i = 0; i < 40; i++) {
    const scale = (low + high) / 2;
    const w = Math.max(1, Math.floor(width * scale));
    const h = Math.max(1, Math.floor(height * scale));
    if (Math.ceil(w / 32) * Math.ceil(h / 32) <= maxPatches) low = scale;
    else high = scale;
  }
  return { width: Math.max(1, Math.floor(width * low)), height: Math.max(1, Math.floor(height * low)) };
}

export function normalizeFederationImage(bytes: Buffer, options: {
  sending: boolean;
  createImage?: (bytes: Buffer) => Electron.NativeImage;
}): Buffer {
  const source = (options.createImage ?? ((data) => nativeImage.createFromBuffer(data)))(bytes);
  if (source.isEmpty()) throw new Error("Federation image could not be decoded.");
  const original = source.getSize();
  const dimensions = federationImageDimensions(original.width, original.height);
  if (dimensions.width === original.width && dimensions.height === original.height) return bytes;
  const image = source.resize({ ...dimensions, quality: "best" });
  const actual = image.getSize();
  if (image.isEmpty() || Math.ceil(actual.width / 32) * Math.ceil(actual.height / 32) > DEFAULT_PASTED_IMAGE_MAX_PATCHES) {
    throw new Error("Federation image exceeds the provider patch budget.");
  }
  const reduced = image.toPNG();
  return options.sending && reduced.length >= bytes.length ? bytes : reduced;
}

export async function normalizeFederationImageFile(attachment: StagedTurnInputAttachment, sending: boolean): Promise<StagedTurnInputAttachment> {
  if (attachment.type !== "localImage") return attachment;
  const original = await readFile(attachment.path);
  const bytes = normalizeFederationImage(original, { sending });
  if (bytes === original) return attachment;
  return await stageTurnInputAttachment({ type: "localImage", data: bytes, name: attachment.name, mimeType: "image/png" });
}
