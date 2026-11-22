import type { DecisionImageCapabilities, DecisionImageMimeType } from "@pwragent/shared/decision-models";
import {
  DECISION_IMAGE_SCHEMA_KEY,
  isDecisionImagePart,
  validateOpenAIDecisionInput,
  type DecisionImageInput,
  type OpenAIDecisionInputSchema,
} from "@pwragent/shared/openai-decisions";
import {
  DECISION_IMAGE_THUMBNAIL_MAX_LENGTH,
  type DecisionsRailInputImage,
} from "@pwragent/shared/decisions-rail";
import type { OwnerHostServices } from "../owner-host";

type ImageLimits = Extract<DecisionImageCapabilities, { supported: true }>;
type PreparedImage = DecisionImageInput & Omit<DecisionsRailInputImage, "thumbnail"> & { bytes: number };

export type PreparedDecisionInput = {
  value: unknown;
  images: PreparedImage[];
};

type InputFailure = { code: "invalid_input" | "invalid_image" | "images_unsupported"; message: string };
type PreparedInput = { ok: true; value: PreparedDecisionInput } | ({ ok: false } & InputFailure);

const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");
const DATA_URL = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/]+={0,2})$/;
const THUMBNAIL_SIDE = 96;

export function hasDecisionImageParts(value: unknown): boolean {
  return Array.isArray(value) && value.some(isDecisionImagePart);
}

export function prepareDecisionInput(
  input: unknown,
  schema: OpenAIDecisionInputSchema | undefined,
  capability: DecisionImageCapabilities,
  unsupportedMessage: string,
): PreparedInput {
  if (Array.isArray(input) && hasDecisionImageParts(input)) {
    if (capability.supported) return prepareImageParts(input, schema, capability);
    return { ok: false, code: "images_unsupported", message: unsupportedMessage };
  }
  if (schema?.[DECISION_IMAGE_SCHEMA_KEY] === true) {
    return imageFailure("This decision requires at least one input_image part.");
  }
  return validateValue(input, schema, []);
}

function prepareImageParts(
  parts: unknown[],
  schema: OpenAIDecisionInputSchema | undefined,
  limits: ImageLimits,
): PreparedInput {
  if (parts.length > limits.maxImages + 1) return imageFailure(`Input allows up to ${limits.maxImages} images.`);
  const [first, ...rest] = parts;
  const valuePart = isRecord(first) && Object.keys(first).length === 2 && (
    (first.type === "input_text" && typeof first.text === "string")
    || (first.type === "input_json" && isRecord(first.data))
  ) ? first : undefined;
  const imageParts = valuePart ? rest : parts;
  if (imageParts.length < 1 || imageParts.length > limits.maxImages) {
    return imageFailure(`Pass 1 to ${limits.maxImages} input_image parts after optional input_text or input_json.`);
  }
  let totalBytes = 0;
  const images: PreparedImage[] = [];
  for (const [index, part] of imageParts.entries()) {
    if (!isRecord(part) || Object.keys(part).length !== 2 || part.type !== "input_image" || typeof part.image_url !== "string") {
      return imageFailure("Each image part must have type input_image and a PNG or JPEG base64 data URL in image_url.");
    }
    const image = parseImage(part.image_url, limits);
    if (typeof image === "string") return imageFailure(`Image ${index + 1}: ${image}`);
    totalBytes += image.bytes;
    if (totalBytes > limits.maxTotalBytes) {
      return imageFailure(`Images must total at most ${limits.maxTotalBytes} decoded bytes per item.`);
    }
    images.push(image);
  }
  const value = valuePart ? valuePart.type === "input_text" ? valuePart.text : valuePart.data : "";
  return validateValue(value, schema, images);
}

function validateValue(
  value: unknown,
  schema: OpenAIDecisionInputSchema | undefined,
  images: PreparedImage[],
): PreparedInput {
  const validated = validateOpenAIDecisionInput(schema, value);
  return validated.ok
    ? { ok: true, value: { value: validated.value, images } }
    : { ok: false, code: "invalid_input", message: validated.message };
}

function imageFailure(message: string): PreparedInput {
  return { ok: false, code: "invalid_image", message };
}

function parseImage(dataUrl: string, limits: ImageLimits): PreparedImage | string {
  const byteError = `Each image must be at most ${limits.maxBytesPerImage} decoded bytes.`;
  if (dataUrl.length > Math.ceil(limits.maxBytesPerImage / 3) * 4 + 23) return byteError;
  const match = DATA_URL.exec(dataUrl);
  if (!match || match[0] !== dataUrl || match[2]!.length % 4 !== 0) {
    return "Use a PNG or JPEG data URL with padded standard base64.";
  }
  const mimeType = match[1] as DecisionImageMimeType;
  if (!limits.mimeTypes.includes(mimeType)) return "The provider does not accept this image type.";
  const encoded = match[2]!;
  const buffer = Buffer.from(encoded, "base64");
  if (buffer.length > limits.maxBytesPerImage) return byteError;
  if (buffer.toString("base64") !== encoded) return "Use canonical standard base64 for the image bytes.";
  const size = mimeType === "image/png" ? pngSize(buffer) : jpegSize(buffer);
  if (!size) return "The bytes must match the declared type and contain a still image.";
  const { width, height } = size;
  if ([width, height].some((side) => side < limits.minSide || side > limits.maxSide)) {
    return `Each side must be ${limits.minSide}–${limits.maxSide} pixels.`;
  }
  return { mimeType, dataUrl, width, height, bytes: buffer.length };
}

function pngSize(buffer: Buffer): { width: number; height: number } | undefined {
  if (buffer.length < 33 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)
    || buffer.readUInt32BE(8) !== 13 || buffer.toString("ascii", 12, 16) !== "IHDR") return undefined;
  const size = { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  // Check chunks for animation without decompressing untrusted pixels.
  let offset = 33;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const next = offset + length + 12;
    const chunk = buffer.toString("ascii", offset + 4, offset + 8);
    if (next > buffer.length || chunk === "acTL") return undefined;
    if (chunk === "IEND") return length === 0 && next === buffer.length ? size : undefined;
    offset = next;
  }
  return undefined;
}

function jpegSize(buffer: Buffer): { width: number; height: number } | undefined {
  if (buffer.length < 4 || buffer.readUInt16BE(0) !== 0xffd8) return undefined;
  let offset = 2;
  while (offset + 4 <= buffer.length && buffer[offset] === 0xff) {
    while (buffer[offset] === 0xff) offset += 1;
    const marker = buffer[offset++]!;
    if (marker === 0xda || marker === 0xd9 || offset + 2 > buffer.length) return undefined;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) return undefined;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return length >= 8
        ? { width: buffer.readUInt16BE(offset + 5), height: buffer.readUInt16BE(offset + 3) }
        : undefined;
    }
    offset += length;
  }
  return undefined;
}

/** Decodes within the header-checked pixel bounds and keeps at most a tiny re-encoded thumbnail. */
export async function decisionImageReferences(
  images: readonly PreparedImage[],
  decode: OwnerHostServices["images"]["createFromBuffer"],
  thumbnail: boolean,
): Promise<DecisionsRailInputImage[] | undefined> {
  const references: DecisionsRailInputImage[] = [];
  for (const { mimeType, width, height, dataUrl } of images) {
    const decoded = await decode(Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64")).catch(() => undefined);
    if (!decoded || decoded.isEmpty()) return undefined;
    const size = decoded.getSize();
    // JPEG may be rotated by its EXIF orientation on the desktop host.
    if (!((size.width === width && size.height === height) || (size.width === height && size.height === width))) return undefined;
    const preview = thumbnail ? imageThumbnail(decoded, size.width, size.height) : undefined;
    references.push({ mimeType, width, height, ...(preview ? { thumbnail: preview } : {}) });
  }
  return references;
}

function imageThumbnail(
  image: Awaited<ReturnType<OwnerHostServices["images"]["createFromBuffer"]>>,
  width: number,
  height: number,
): string | undefined {
  const scale = Math.min(1, THUMBNAIL_SIDE / Math.max(width, height));
  const tiny = image.resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) });
  const thumbnail = `data:image/jpeg;base64,${tiny.toJPEG(65).toString("base64")}`;
  return thumbnail.length <= DECISION_IMAGE_THUMBNAIL_MAX_LENGTH ? thumbnail : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
