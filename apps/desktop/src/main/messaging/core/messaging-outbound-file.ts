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

/** Mirrors the `filename` maxLength advertised in the tool's input schema. */
const MAX_OUTBOUND_FILENAME_LENGTH = 255;

const OUTSIDE_ALLOWED_ROOTS_MESSAGE =
  "send_messaging_file can only send files from this thread's workspace "
  + "or a PwrAgent generated-output directory.";

export async function resolveMessagingOutboundFile(
  request: MessagingOutboundFileRequest,
  capabilities: MessagingOutboundFileCapabilities,
  access: MessagingOutboundFileAccess,
): Promise<MessagingOutboundFile> {
  const rawPath = typeof request.path === "string" ? request.path : "";
  if (!rawPath.trim() || rawPath.includes("\0") || !path.isAbsolute(rawPath)) {
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
    // readFile already returns a Uint8Array (a Buffer). Re-wrapping it copies
    // the whole file a second time, which matters at a 100 MB upload ceiling.
    data = await readFile(readable.path);
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
  // A GIF is an image everywhere this tool can deliver one. Treating it as a
  // separate classification kind here only produced a rejection whose message
  // claimed the file was not an image.
  const looksLikeImage =
    classification.kind === "image" || classification.kind === "gif";
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
  if (!base || base === "." || base === "..") {
    return "file";
  }
  // The advertised schema caps this at 255, but nothing validates tool
  // arguments against that schema before dispatch, so bound it here too.
  if (base.length <= MAX_OUTBOUND_FILENAME_LENGTH) {
    return base;
  }
  const extension = path.extname(base);
  const stem = base.slice(0, base.length - extension.length);
  if (extension.length >= MAX_OUTBOUND_FILENAME_LENGTH || !stem) {
    return truncateCodePoints(base, MAX_OUTBOUND_FILENAME_LENGTH);
  }
  return (
    truncateCodePoints(stem, MAX_OUTBOUND_FILENAME_LENGTH - extension.length)
    + extension
  );
}

/**
 * Truncate without splitting a surrogate pair. A plain `slice` cuts on UTF-16
 * code units, so a name made of astral characters can end on a lone surrogate
 * and reach the provider as an unencodable filename.
 */
function truncateCodePoints(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  let end = maxLength;
  const code = value.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) {
    end -= 1;
  }
  return value.slice(0, end);
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
