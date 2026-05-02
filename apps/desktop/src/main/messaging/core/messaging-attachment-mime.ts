import path from "node:path";

export type MessagingAttachmentClassification =
  | {
      kind: "image";
      mimeType: string;
    }
  | {
      kind: "gif";
      mimeType: "image/gif";
    }
  | {
      kind: "pdf";
      mimeType: "application/pdf";
    }
  | {
      kind: "text";
      mimeType: string;
    }
  | {
      kind: "binary";
      mimeType?: string;
    };

const TEXT_EXTENSIONS = new Set([
  ".csv",
  ".json",
  ".jsonl",
  ".log",
  ".md",
  ".markdown",
  ".toml",
  ".txt",
  ".yaml",
  ".yml",
]);

export function classifyMessagingAttachment(params: {
  data: Uint8Array;
  fileName: string;
  mimeType?: string;
}): MessagingAttachmentClassification {
  const magic = classifyMagicBytes(params.data);
  if (magic) {
    return magic;
  }

  const mimeType = normalizeMimeType(params.mimeType);
  if (mimeType) {
    if (mimeType === "image/gif") {
      return { kind: "gif", mimeType };
    }
    if (mimeType.startsWith("image/")) {
      return { kind: "image", mimeType };
    }
    if (mimeType === "application/pdf") {
      return { kind: "pdf", mimeType };
    }
    if (isTextLikeMimeType(mimeType)) {
      return isProbablyUtf8Text(params.data)
        ? { kind: "text", mimeType }
        : { kind: "binary", mimeType };
    }
  }

  const extension = path.extname(params.fileName).toLowerCase();
  if (extension === ".pdf") {
    return { kind: "pdf", mimeType: "application/pdf" };
  }
  if (extension === ".gif") {
    return { kind: "gif", mimeType: "image/gif" };
  }
  if ([".jpg", ".jpeg"].includes(extension)) {
    return { kind: "image", mimeType: "image/jpeg" };
  }
  if (extension === ".png") {
    return { kind: "image", mimeType: "image/png" };
  }
  if (TEXT_EXTENSIONS.has(extension)) {
    return isProbablyUtf8Text(params.data)
      ? { kind: "text", mimeType: mimeType ?? mimeTypeForTextExtension(extension) }
      : { kind: "binary", mimeType };
  }

  return isProbablyUtf8Text(params.data)
    ? { kind: "text", mimeType: mimeType ?? "text/plain" }
    : { kind: "binary", mimeType };
}

export function decodeMessagingTextAttachment(data: Uint8Array): string | undefined {
  if (!isProbablyUtf8Text(data)) {
    return undefined;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(data);
}

function classifyMagicBytes(
  data: Uint8Array,
): MessagingAttachmentClassification | undefined {
  if (data.length >= 4) {
    if (
      data[0] === 0x89 &&
      data[1] === 0x50 &&
      data[2] === 0x4e &&
      data[3] === 0x47
    ) {
      return { kind: "image", mimeType: "image/png" };
    }
    if (data[0] === 0xff && data[1] === 0xd8) {
      return { kind: "image", mimeType: "image/jpeg" };
    }
    if (
      data[0] === 0x47 &&
      data[1] === 0x49 &&
      data[2] === 0x46 &&
      data[3] === 0x38
    ) {
      return { kind: "gif", mimeType: "image/gif" };
    }
    if (
      data[0] === 0x25 &&
      data[1] === 0x50 &&
      data[2] === 0x44 &&
      data[3] === 0x46
    ) {
      return { kind: "pdf", mimeType: "application/pdf" };
    }
  }
  return undefined;
}

function isTextLikeMimeType(mimeType: string): boolean {
  return (
    mimeType.startsWith("text/") ||
    [
      "application/json",
      "application/jsonl",
      "application/toml",
      "application/x-jsonlines",
      "application/x-ndjson",
      "application/x-yaml",
      "application/yaml",
      "application/yml",
    ].includes(mimeType)
  );
}

function isProbablyUtf8Text(data: Uint8Array): boolean {
  if (data.length === 0) {
    return true;
  }
  const sample = data.slice(0, Math.min(data.length, 4096));
  let controlBytes = 0;
  for (const byte of sample) {
    if (byte === 0) {
      return false;
    }
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) {
      controlBytes += 1;
    }
  }
  return controlBytes / sample.length < 0.02;
}

function normalizeMimeType(mimeType: string | undefined): string | undefined {
  const normalized = mimeType?.trim().toLowerCase();
  return normalized || undefined;
}

function mimeTypeForTextExtension(extension: string): string {
  switch (extension) {
    case ".csv":
      return "text/csv";
    case ".json":
      return "application/json";
    case ".jsonl":
      return "application/x-ndjson";
    case ".toml":
      return "application/toml";
    case ".yaml":
    case ".yml":
      return "application/x-yaml";
    case ".md":
    case ".markdown":
      return "text/markdown";
    default:
      return "text/plain";
  }
}
