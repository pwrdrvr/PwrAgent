export type ImageUploadQualityProfile = "low" | "medium" | "high" | "actual";

export type ImageUploadQualityProfileSettings = {
  jpegQuality: number;
  maxLongEdge: number;
  maxShortEdge: number;
  preserveActual?: boolean;
};

export const DEFAULT_IMAGE_UPLOAD_QUALITY_PROFILE: ImageUploadQualityProfile =
  "medium";
export const DEFAULT_PASTED_IMAGE_MAX_PATCHES = 1536;

export const IMAGE_UPLOAD_QUALITY_PROFILES: Record<
  ImageUploadQualityProfile,
  ImageUploadQualityProfileSettings
> = {
  low: {
    jpegQuality: 0.72,
    maxLongEdge: 1280,
    maxShortEdge: 720,
  },
  medium: {
    jpegQuality: 0.85,
    maxLongEdge: 2048,
    maxShortEdge: 1024,
  },
  high: {
    jpegQuality: 0.92,
    maxLongEdge: 3072,
    maxShortEdge: 2048,
  },
  actual: {
    jpegQuality: 0.95,
    maxLongEdge: 8192,
    maxShortEdge: 8192,
    preserveActual: true,
  },
};

export function readImageUploadQualityProfile(
  value: string | undefined,
): ImageUploadQualityProfile | undefined {
  switch (value?.trim().toLowerCase()) {
    case "low":
    case "medium":
    case "high":
    case "actual":
      return value.trim().toLowerCase() as ImageUploadQualityProfile;
    default:
      return undefined;
  }
}

export type ImageUploadFallbackRequest = {
  data: ArrayBuffer;
  fileName?: string;
  mimeType: string;
};

export type ImageUploadFallbackResponse = {
  dataUrl: string;
  mimeType: "image/jpeg" | "image/png";
  size: number;
};

export type ImageUploadNormalizationLogRequest = {
  fileName?: string;
  original: {
    height?: number;
    mimeType: string;
    size: number;
    width?: number;
  };
  normalized: {
    height: number;
    mimeType: "image/jpeg" | "image/png";
    size: number;
    width: number;
  };
  path: "renderer" | "heic-fallback";
  resized: boolean;
};
