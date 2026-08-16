import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { resolveReadableLocalFilePath } from "../../app-server/local-file-input.js";
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

export type MessagingOutboundFileAccess = {
  allowedRoots: readonly string[];
  privateStorageRoots?: readonly string[];
};

export type MessagingOutboundFile =
  | {
      ok: true;
      data: Uint8Array;
      filename: string;
      mediaKind: MessagingOutboundMediaKind;
      mimeType: string;
      path: string;
      sizeBytes: number;
    }
  | {
      ok: false;
      code:
        | "forbidden"
        | "invalid_arguments"
        | "not_found"
        | "unsupported_operation";
      message: string;
    };

const OUTSIDE_ALLOWED_ROOTS_MESSAGE =
  "send_messaging_file can only send files from this thread's workspace "
  + "or a PwrAgent generated-output directory.";

export async function resolveMessagingOutboundFile(
  request: MessagingOutboundFileRequest,
  capabilities: MessagingOutboundFileCapabilities,
  access: MessagingOutboundFileAccess,
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

  const readable = await resolveReadableLocalFilePath(rawPath, {
    allowedRoots: access.allowedRoots,
    privateStorageRoots: access.privateStorageRoots,
  });
  if (!readable.ok) {
    return readable.reason === "not_found"
      ? {
          ok: false,
          code: "not_found",
          message: `File not found: ${rawPath}`,
        }
      : {
          ok: false,
          code: "forbidden",
          message: OUTSIDE_ALLOWED_ROOTS_MESSAGE,
        };
  }

  let fileStat: Awaited<ReturnType<typeof stat>>;
  try {
    fileStat = await stat(readable.path);
  } catch (error) {
    return mapOutboundFileSystemError(error, rawPath);
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
    return oversizedFileError(fileStat.size, maxBytes);
  }

  let data: Uint8Array;
  try {
    data = new Uint8Array(await readFile(readable.path));
  } catch (error) {
    return mapOutboundFileSystemError(error, rawPath);
  }
  if (data.byteLength <= 0) {
    return {
      ok: false,
      code: "invalid_arguments",
      message: "send_messaging_file requires a non-empty file.",
    };
  }
  if (data.byteLength > maxBytes) {
    return oversizedFileError(data.byteLength, maxBytes);
  }
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
    path: readable.path,
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

function oversizedFileError(
  sizeBytes: number,
  maxBytes: number,
): Extract<MessagingOutboundFile, { ok: false }> {
  return {
    ok: false,
    code: "invalid_arguments",
    message:
      `File is ${sizeBytes} bytes, which exceeds this messaging surface's `
      + `upload limit of ${maxBytes} bytes.`,
  };
}

function mapOutboundFileSystemError(
  error: unknown,
  rawPath: string,
): Extract<MessagingOutboundFile, { ok: false }> {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT") {
    return {
      ok: false,
      code: "not_found",
      message: `File not found: ${rawPath}`,
    };
  }
  if (code === "EACCES" || code === "EPERM") {
    return {
      ok: false,
      code: "forbidden",
      message: OUTSIDE_ALLOWED_ROOTS_MESSAGE,
    };
  }
  return {
    ok: false,
    code: "invalid_arguments",
    message: "Could not read the file for send_messaging_file.",
  };
}
