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
