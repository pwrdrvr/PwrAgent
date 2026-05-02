import { nativeImage } from "electron";
import {
  DEFAULT_IMAGE_UPLOAD_QUALITY_PROFILE,
  IMAGE_UPLOAD_QUALITY_PROFILES,
  type ImageUploadQualityProfile,
} from "../../shared/image-normalization";

export type MessagingNormalizedImage = {
  dataUrl: string;
  height: number;
  mimeType: "image/jpeg" | "image/png";
  original: {
    height: number;
    mimeType?: string;
    size: number;
    width: number;
  };
  size: number;
  width: number;
};

export type MessagingImageNormalizationDependencies = {
  createImageFromBuffer: (buffer: Buffer) => Electron.NativeImage;
};

const DEFAULT_DEPENDENCIES: MessagingImageNormalizationDependencies = {
  createImageFromBuffer: (buffer) => nativeImage.createFromBuffer(buffer),
};

export async function normalizeMessagingImageAttachment(params: {
  data: Uint8Array;
  mimeType?: string;
  profile?: ImageUploadQualityProfile;
  dependencies?: Partial<MessagingImageNormalizationDependencies>;
}): Promise<MessagingNormalizedImage> {
  const dependencies = {
    ...DEFAULT_DEPENDENCIES,
    ...params.dependencies,
  };
  const source = dependencies.createImageFromBuffer(Buffer.from(params.data));
  if (source.isEmpty()) {
    throw new Error("Attachment image could not be decoded.");
  }

  const original = source.getSize();
  if (original.width <= 0 || original.height <= 0) {
    throw new Error("Attachment image has invalid dimensions.");
  }

  const profile =
    IMAGE_UPLOAD_QUALITY_PROFILES[
      params.profile ?? DEFAULT_IMAGE_UPLOAD_QUALITY_PROFILE
    ];
  const dimensions = calculateBoundedDimensions({
    height: original.height,
    maxLongEdge: profile.maxLongEdge,
    maxShortEdge: profile.maxShortEdge,
    preserveActual: profile.preserveActual,
    width: original.width,
  });
  const image =
    dimensions.width === original.width && dimensions.height === original.height
      ? source
      : source.resize({
          height: dimensions.height,
          quality: "best",
          width: dimensions.width,
        });

  const outputMimeType = chooseOutputMimeType(params.mimeType);
  const output =
    outputMimeType === "image/png"
      ? image.toPNG()
      : image.toJPEG(Math.round(profile.jpegQuality * 100));

  return {
    dataUrl: `data:${outputMimeType};base64,${output.toString("base64")}`,
    height: dimensions.height,
    mimeType: outputMimeType,
    original: {
      height: original.height,
      mimeType: params.mimeType,
      size: params.data.byteLength,
      width: original.width,
    },
    size: output.byteLength,
    width: dimensions.width,
  };
}

export function calculateBoundedDimensions(params: {
  height: number;
  maxLongEdge: number;
  maxShortEdge: number;
  preserveActual?: boolean;
  width: number;
}): { height: number; width: number } {
  const width = Math.max(1, Math.round(params.width));
  const height = Math.max(1, Math.round(params.height));
  if (params.preserveActual) {
    return { height, width };
  }

  const longEdge = Math.max(width, height);
  const shortEdge = Math.min(width, height);
  const scale = Math.min(
    1,
    params.maxLongEdge / longEdge,
    params.maxShortEdge / shortEdge,
  );

  return {
    height: Math.max(1, Math.round(height * scale)),
    width: Math.max(1, Math.round(width * scale)),
  };
}

function chooseOutputMimeType(mimeType: string | undefined): "image/jpeg" | "image/png" {
  const normalized = mimeType?.trim().toLowerCase();
  return normalized === "image/png" ||
    normalized === "image/gif" ||
    normalized === "image/svg+xml"
    ? "image/png"
    : "image/jpeg";
}
