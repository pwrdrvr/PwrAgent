import {
  DEFAULT_IMAGE_UPLOAD_QUALITY_PROFILE,
  DEFAULT_PASTED_IMAGE_MAX_PATCHES,
  IMAGE_UPLOAD_QUALITY_PROFILES,
  type ImageUploadQualityProfile,
} from "../../../shared/image-normalization";

export const NORMALIZED_IMAGE_MAX_LONG_EDGE =
  IMAGE_UPLOAD_QUALITY_PROFILES.medium.maxLongEdge;
export const NORMALIZED_IMAGE_MAX_SHORT_EDGE =
  IMAGE_UPLOAD_QUALITY_PROFILES.medium.maxShortEdge;
export const NORMALIZED_IMAGE_JPEG_QUALITY =
  IMAGE_UPLOAD_QUALITY_PROFILES.medium.jpegQuality;

export type NormalizedImageMimeType = "image/jpeg" | "image/png";

export type ImageFallbackRequest = {
  data: ArrayBuffer;
  fileName?: string;
  mimeType: string;
};

export type ImageFallbackResponse = {
  dataUrl: string;
  mimeType: NormalizedImageMimeType;
  size: number;
};

export type NormalizedImage = {
  conversionPath: "renderer" | "heic-fallback";
  dataUrl: string;
  height: number;
  mimeType: NormalizedImageMimeType;
  original: {
    height: number;
    mimeType: string;
    name: string;
    size: number;
    width: number;
  };
  size: number;
  width: number;
};

type DecodedImage = {
  height: number;
  width: number;
  close?: () => void;
  draw: (
    context: CanvasRenderingContext2D,
    width: number,
    height: number,
  ) => void;
};

type CanvasHandle = {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
};

type NormalizeImageFileOptions = {
  fallback?: (request: ImageFallbackRequest) => Promise<ImageFallbackResponse>;
  jpegQuality?: number;
  maxPatchCount?: number;
  maxLongEdge?: number;
  maxShortEdge?: number;
  qualityProfile?: ImageUploadQualityProfile;
  dependencies?: Partial<ImageNormalizationDependencies>;
};

export type ImageNormalizationDependencies = {
  createCanvas: (width: number, height: number) => CanvasHandle;
  decodeImage: (blob: Blob) => Promise<DecodedImage>;
  encodeCanvas: (
    canvas: HTMLCanvasElement,
    mimeType: NormalizedImageMimeType,
    quality: number,
  ) => Promise<Blob>;
  hasAlpha: (
    context: CanvasRenderingContext2D,
    width: number,
    height: number,
  ) => boolean;
  readBlobAsDataUrl: (blob: Blob) => Promise<string>;
};

export function calculateBoundedImageDimensions(params: {
  height: number;
  maxLongEdge?: number;
  maxPatchCount?: number;
  maxShortEdge?: number;
  width: number;
}): { height: number; width: number } {
  const width = Math.max(1, Math.round(params.width));
  const height = Math.max(1, Math.round(params.height));
  if (params.maxPatchCount !== undefined) {
    return calculatePatchBoundedImageDimensions({
      width,
      height,
      maxPatchCount: params.maxPatchCount,
    });
  }
  const maxLongEdge = params.maxLongEdge ?? NORMALIZED_IMAGE_MAX_LONG_EDGE;
  const maxShortEdge = params.maxShortEdge ?? NORMALIZED_IMAGE_MAX_SHORT_EDGE;
  const longEdge = Math.max(width, height);
  const shortEdge = Math.min(width, height);
  const scale = Math.min(1, maxLongEdge / longEdge, maxShortEdge / shortEdge);

  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export function calculatePatchBoundedImageDimensions(params: {
  height: number;
  maxPatchCount: number;
  width: number;
}): { height: number; width: number } {
  const width = Math.max(1, Math.round(params.width));
  const height = Math.max(1, Math.round(params.height));
  const maxPatchCount = Math.floor(params.maxPatchCount);
  if (maxPatchCount <= 0) {
    return { width, height };
  }

  const patchCount = imagePatchCount(width, height);
  if (patchCount <= maxPatchCount) {
    return { width, height };
  }

  let scale = Math.sqrt((maxPatchCount * 32 * 32) / (width * height));
  let nextWidth = Math.max(1, Math.floor(width * scale));
  let nextHeight = Math.max(1, Math.floor(height * scale));

  while (imagePatchCount(nextWidth, nextHeight) > maxPatchCount) {
    scale *= 0.99;
    nextWidth = Math.max(1, Math.floor(width * scale));
    nextHeight = Math.max(1, Math.floor(height * scale));
  }

  return {
    width: nextWidth,
    height: nextHeight,
  };
}

function imagePatchCount(width: number, height: number): number {
  return Math.ceil(width / 32) * Math.ceil(height / 32);
}

export function chooseNormalizedImageMimeType(params: {
  hasAlpha: boolean;
  sourceMimeType: string;
}): NormalizedImageMimeType {
  if (params.hasAlpha) {
    return "image/png";
  }
  const sourceMimeType = normalizeSourceMimeType(params.sourceMimeType);
  return sourceMimeType === "image/png" || sourceMimeType === "image/svg+xml"
    ? "image/png"
    : "image/jpeg";
}

export function isHeicMimeType(mimeType: string): boolean {
  const normalized = normalizeSourceMimeType(mimeType);
  return normalized === "image/heic" || normalized === "image/heif";
}

export async function normalizeImageFile(
  file: File,
  options: NormalizeImageFileOptions = {},
): Promise<NormalizedImage> {
  const profile =
    IMAGE_UPLOAD_QUALITY_PROFILES[
      options.qualityProfile ?? DEFAULT_IMAGE_UPLOAD_QUALITY_PROFILE
    ];
  return await normalizeBlob({
    blob: file,
    fallback: options.fallback,
    fileName: file.name || "pasted-image",
    jpegQuality: options.jpegQuality ?? profile.jpegQuality,
    maxLongEdge: options.maxLongEdge ?? profile.maxLongEdge,
    maxPatchCount:
      options.maxPatchCount ??
      (options.qualityProfile ? undefined : DEFAULT_PASTED_IMAGE_MAX_PATCHES),
    maxShortEdge: options.maxShortEdge ?? profile.maxShortEdge,
    originalMimeType: inferImageMimeType(file),
    originalSize: file.size,
    dependencies: {
      ...defaultImageNormalizationDependencies,
      ...options.dependencies,
    },
    allowFallback: true,
    conversionPath: "renderer",
  });
}

async function normalizeBlob(params: {
  allowFallback: boolean;
  blob: Blob;
  conversionPath: NormalizedImage["conversionPath"];
  dependencies: ImageNormalizationDependencies;
  fallback?: (request: ImageFallbackRequest) => Promise<ImageFallbackResponse>;
  fileName: string;
  jpegQuality: number;
  maxLongEdge: number;
  maxPatchCount?: number;
  maxShortEdge: number;
  originalMimeType: string;
  originalSize: number;
}): Promise<NormalizedImage> {
  let decoded: DecodedImage;
  try {
    decoded = await params.dependencies.decodeImage(params.blob);
  } catch (error) {
    if (params.allowFallback && isHeicMimeType(params.originalMimeType) && params.fallback) {
      const response = await params.fallback({
        data: await params.blob.arrayBuffer(),
        fileName: params.fileName,
        mimeType: params.originalMimeType,
      });
      const fallbackBlob = dataUrlToBlob(response.dataUrl, response.mimeType);
      return await normalizeBlob({
        ...params,
        allowFallback: false,
        blob: fallbackBlob,
        conversionPath: "heic-fallback",
        originalMimeType: response.mimeType,
        originalSize: response.size,
      });
    }
    throw new Error(
      isHeicMimeType(params.originalMimeType)
        ? "HEIC/HEIF images could not be converted on this system."
        : `Unsupported or unreadable image format: ${params.originalMimeType || "unknown"}`,
      { cause: error },
    );
  }

  try {
    const dimensions = calculateBoundedImageDimensions({
      width: decoded.width,
      height: decoded.height,
      maxLongEdge: params.maxLongEdge,
      maxPatchCount: params.maxPatchCount,
      maxShortEdge: params.maxShortEdge,
    });
    const sourceMimeType = normalizeSourceMimeType(params.originalMimeType);
    const blobMimeType = normalizeSourceMimeType(params.blob.type);
    if (
      dimensions.width === decoded.width &&
      dimensions.height === decoded.height &&
      (sourceMimeType === "image/jpeg" || sourceMimeType === "image/png") &&
      blobMimeType === sourceMimeType
    ) {
      return {
        conversionPath: params.conversionPath,
        dataUrl: await params.dependencies.readBlobAsDataUrl(params.blob),
        height: decoded.height,
        mimeType: sourceMimeType,
        original: {
          height: decoded.height,
          mimeType: params.originalMimeType,
          name: params.fileName,
          size: params.originalSize,
          width: decoded.width,
        },
        size: params.blob.size,
        width: decoded.width,
      };
    }

    const { canvas, context } = params.dependencies.createCanvas(
      dimensions.width,
      dimensions.height,
    );
    decoded.draw(context, dimensions.width, dimensions.height);
    const hasAlpha = params.dependencies.hasAlpha(
      context,
      dimensions.width,
      dimensions.height,
    );
    const mimeType = chooseNormalizedImageMimeType({
      hasAlpha,
      sourceMimeType: params.originalMimeType,
    });
    const outputBlob = await encodeNormalizedCanvas({
      canvas,
      dependencies: params.dependencies,
      jpegQuality: params.jpegQuality,
      mimeType,
      originalSize: params.originalSize,
    });

    return {
      conversionPath: params.conversionPath,
      dataUrl: await params.dependencies.readBlobAsDataUrl(outputBlob),
      height: dimensions.height,
      mimeType,
      original: {
        height: decoded.height,
        mimeType: params.originalMimeType,
        name: params.fileName,
        size: params.originalSize,
        width: decoded.width,
      },
      size: outputBlob.size,
      width: dimensions.width,
    };
  } finally {
    decoded.close?.();
  }
}

async function encodeNormalizedCanvas(params: {
  canvas: HTMLCanvasElement;
  dependencies: ImageNormalizationDependencies;
  jpegQuality: number;
  mimeType: NormalizedImageMimeType;
  originalSize: number;
}): Promise<Blob> {
  const initial = await params.dependencies.encodeCanvas(
    params.canvas,
    params.mimeType,
    params.jpegQuality,
  );
  if (params.mimeType !== "image/jpeg" || initial.size <= params.originalSize) {
    return initial;
  }

  let smallest = initial;
  const retryQualities = [0.88, 0.84, 0.8, 0.76, 0.72, 0.66, 0.6].filter(
    (quality) => quality < params.jpegQuality,
  );
  for (const quality of retryQualities) {
    const candidate = await params.dependencies.encodeCanvas(
      params.canvas,
      params.mimeType,
      quality,
    );
    if (candidate.size < smallest.size) {
      smallest = candidate;
    }
    if (candidate.size <= params.originalSize) {
      return candidate;
    }
  }

  return smallest;
}

function normalizeSourceMimeType(mimeType: string): string {
  const normalized = mimeType.trim().toLowerCase();
  return normalized === "image/jpg" ? "image/jpeg" : normalized;
}

function dataUrlToBlob(dataUrl: string, fallbackMimeType: string): Blob {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/i.exec(dataUrl);
  if (!match) {
    throw new Error("Image fallback returned an invalid data URL.");
  }

  const mimeType = (match[1] || fallbackMimeType || "image/png").toLowerCase();
  const isBase64 = Boolean(match[2]);
  const payload = match[3] ?? "";
  const binary = isBase64 ? atob(payload) : decodeURIComponent(payload);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: mimeType });
}

const defaultImageNormalizationDependencies: ImageNormalizationDependencies = {
  createCanvas: (width, height) => {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) {
      throw new Error("Could not create an image canvas.");
    }
    return { canvas, context };
  },
  decodeImage: async (blob) => {
    if (typeof createImageBitmap === "function") {
      try {
        const bitmap = await createImageBitmap(blob);
        return {
          width: bitmap.width,
          height: bitmap.height,
          close: () => bitmap.close(),
          draw: (context, width, height) => {
            context.drawImage(bitmap, 0, 0, width, height);
          },
        };
      } catch {
        return await decodeImageWithElement(blob);
      }
    }
    return await decodeImageWithElement(blob);
  },
  encodeCanvas: async (canvas, mimeType, quality) =>
    await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => {
          if (!blob) {
            reject(new Error(`Could not encode image as ${mimeType}.`));
            return;
          }
          resolve(blob);
        },
        mimeType,
        mimeType === "image/jpeg" ? quality : undefined,
      );
    }),
  hasAlpha: (context, width, height) => {
    const data = context.getImageData(0, 0, width, height).data;
    for (let index = 3; index < data.length; index += 4) {
      if (data[index] < 255) {
        return true;
      }
    }
    return false;
  },
  readBlobAsDataUrl: async (blob) =>
    await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener("load", () => {
        if (typeof reader.result === "string" && reader.result.startsWith("data:image/")) {
          resolve(reader.result);
          return;
        }
        reject(new Error("The normalized image did not produce an image data URL."));
      });
      reader.addEventListener("error", () => {
        reject(reader.error ?? new Error("The normalized image could not be read."));
      });
      reader.readAsDataURL(blob);
    }),
};

function inferImageMimeType(file: File): string {
  const sourceType = normalizeSourceMimeType(file.type);
  if (sourceType) {
    return sourceType;
  }
  const extension = file.name.toLowerCase().split(".").pop();
  switch (extension) {
    case "heic":
      return "image/heic";
    case "heif":
      return "image/heif";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "svg":
      return "image/svg+xml";
    default:
      return "";
  }
}

function decodeImageWithElement(blob: Blob): Promise<DecodedImage> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.addEventListener(
      "load",
      () => {
        URL.revokeObjectURL(url);
        resolve({
          width: image.naturalWidth,
          height: image.naturalHeight,
          draw: (context, width, height) => {
            context.drawImage(image, 0, 0, width, height);
          },
        });
      },
      { once: true },
    );
    image.addEventListener(
      "error",
      () => {
        URL.revokeObjectURL(url);
        reject(new Error("Could not decode image."));
      },
      { once: true },
    );
    image.src = url;
  });
}
