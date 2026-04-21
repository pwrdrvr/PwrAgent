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
