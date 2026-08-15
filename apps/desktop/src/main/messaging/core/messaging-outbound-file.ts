import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { classifyMessagingAttachment } from "./messaging-attachment-mime.js";

export type MessagingOutboundMediaKind = "document" | "image";

export type MessagingOutboundFileRequest = {
  filename?: string;
  mediaKind?: "auto" | MessagingOutboundMediaKind;
  path: string;
};

export type MessagingOutboundFileCapabilities = {
  maxUploadBytes?: number;
  supportsFileUpload?: boolean;
  supportsImageUpload?: boolean;
};

export type MessagingOutboundFile =
  | {
      ok: true;
      data: Uint8Array;
      filename: string;
      mediaKind: MessagingOutboundMediaKind;
      mimeType: string;
      sizeBytes: number;
    }
  | {
      ok: false;
      code: "invalid_arguments" | "not_found" | "unsupported_operation";
      message: string;
    };

export async function resolveMessagingOutboundFile(
  request: MessagingOutboundFileRequest,
  capabilities: MessagingOutboundFileCapabilities,
): Promise<MessagingOutboundFile> {
  const rawPath = typeof request.path === "string" ? request.path.trim() : "";
  if (!rawPath || rawPath.includes("\0") || !path.isAbsolute(rawPath)) {
    return {
      ok: false,
      code: "invalid_arguments",
      message:
        "send_messaging_file requires an absolute local filesystem path.",
    };
  }

  let fileStat: Awaited<ReturnType<typeof stat>>;
  try {
    fileStat = await stat(rawPath);
  } catch {
    return {
      ok: false,
      code: "not_found",
      message: `File not found: ${rawPath}`,
    };
  }
  if (!fileStat.isFile()) {
    return {
      ok: false,
      code: "invalid_arguments",
      message: "send_messaging_file requires a regular file, not a directory.",
    };
  }
  if (fileStat.size <= 0) {
    return {
      ok: false,
      code: "invalid_arguments",
      message: "send_messaging_file requires a non-empty file.",
    };
  }

  const maxBytes = capabilities.maxUploadBytes ?? Infinity;
  if (fileStat.size > maxBytes) {
    return {
      ok: false,
      code: "invalid_arguments",
      message:
        `File is ${fileStat.size} bytes, which exceeds this messaging surface's `
        + `upload limit of ${maxBytes} bytes.`,
    };
  }

  const data = new Uint8Array(await readFile(rawPath));
  const filename = sanitizeOutboundFilename(
    request.filename ?? path.basename(rawPath),
  );
  const classification = classifyMessagingAttachment({
    data,
    fileName: filename,
  });
  const requestedKind = request.mediaKind ?? "auto";
  const looksLikeImage = classification.kind === "image";
  const mediaKind = resolveOutboundMediaKind({
    looksLikeImage,
    requestedKind,
    supportsFileUpload: capabilities.supportsFileUpload === true,
    supportsImageUpload: capabilities.supportsImageUpload === true,
  });
  if (!mediaKind.ok) {
    return mediaKind;
  }

  return {
    ok: true,
    data,
    filename,
    mediaKind: mediaKind.mediaKind,
    mimeType:
      classification.mimeType
      ?? (mediaKind.mediaKind === "image" ? "image/png" : "application/octet-stream"),
    sizeBytes: data.byteLength,
  };
}

export function messagingOutboundImageDataUrl(
  mimeType: string,
  data: Uint8Array,
): string {
  return `data:${mimeType};base64,${Buffer.from(data).toString("base64")}`;
}

function resolveOutboundMediaKind(params: {
  looksLikeImage: boolean;
  requestedKind: "auto" | MessagingOutboundMediaKind;
  supportsFileUpload: boolean;
  supportsImageUpload: boolean;
}):
  | { ok: true; mediaKind: MessagingOutboundMediaKind }
  | Extract<MessagingOutboundFile, { ok: false }> {
  if (params.requestedKind === "image") {
    if (!params.looksLikeImage) {
      return {
        ok: false,
        code: "invalid_arguments",
        message:
          "mediaKind=image requires an image file (PNG, JPEG, or similar).",
      };
    }
    if (!params.supportsImageUpload) {
      return {
        ok: false,
        code: "unsupported_operation",
        message: "This messaging provider cannot send images.",
      };
    }
    return { ok: true, mediaKind: "image" };
  }

  if (params.requestedKind === "document") {
    if (!params.supportsFileUpload) {
      return {
        ok: false,
        code: "unsupported_operation",
        message: "This messaging provider cannot send files.",
      };
    }
    return { ok: true, mediaKind: "document" };
  }

  if (params.looksLikeImage && params.supportsImageUpload) {
    return { ok: true, mediaKind: "image" };
  }
  if (params.supportsFileUpload) {
    return { ok: true, mediaKind: "document" };
  }
  return {
    ok: false,
    code: "unsupported_operation",
    message: params.looksLikeImage
      ? "This messaging provider cannot send files or images."
      : "This messaging provider cannot send files.",
  };
}

function sanitizeOutboundFilename(name: string): string {
  const base = path.basename(name).trim();
  return base && base !== "." && base !== ".." ? base : "file";
}
