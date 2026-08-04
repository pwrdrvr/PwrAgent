import { open } from "node:fs/promises";
import path from "node:path";
import type {
  AppServerLocalFileInputItem,
  AppServerTurnInputItem,
} from "@pwragent/shared";

export const MAX_LOCAL_TEXT_FILE_BYTES = 10 * 1024;
export const MAX_LOCAL_TEXT_PREVIEW_BYTES = 4 * 1024;
export const MAX_TURN_LOCAL_TEXT_PREVIEW_BYTES = 16 * 1024;

type KnownLocalFileType = {
  mimeType: string;
  text?: true;
};

const KNOWN_LOCAL_FILE_TYPES = new Map<string, KnownLocalFileType>([
  [".7z", { mimeType: "application/x-7z-compressed" }],
  [".bash", { mimeType: "text/x-shellscript", text: true }],
  [".c", { mimeType: "text/x-c", text: true }],
  [".cfg", { mimeType: "text/plain", text: true }],
  [".cjs", { mimeType: "text/javascript", text: true }],
  [".conf", { mimeType: "text/plain", text: true }],
  [".cpp", { mimeType: "text/x-c++", text: true }],
  [".css", { mimeType: "text/css", text: true }],
  [".csv", { mimeType: "text/csv", text: true }],
  [".dmg", { mimeType: "application/x-apple-diskimage" }],
  [".doc", { mimeType: "application/msword" }],
  [
    ".docx",
    {
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    },
  ],
  [".gif", { mimeType: "image/gif" }],
  [".go", { mimeType: "text/x-go", text: true }],
  [".gz", { mimeType: "application/gzip" }],
  [".h", { mimeType: "text/x-c", text: true }],
  [".heic", { mimeType: "image/heic" }],
  [".heif", { mimeType: "image/heif" }],
  [".hpp", { mimeType: "text/x-c++", text: true }],
  [".htm", { mimeType: "text/html", text: true }],
  [".html", { mimeType: "text/html", text: true }],
  [".ini", { mimeType: "text/plain", text: true }],
  [".iso", { mimeType: "application/x-iso9660-image" }],
  [".java", { mimeType: "text/x-java-source", text: true }],
  [".jpeg", { mimeType: "image/jpeg" }],
  [".jpg", { mimeType: "image/jpeg" }],
  [".js", { mimeType: "text/javascript", text: true }],
  [".json", { mimeType: "application/json", text: true }],
  [".jsonl", { mimeType: "application/x-ndjson", text: true }],
  [".jsx", { mimeType: "text/jsx", text: true }],
  [".log", { mimeType: "text/plain", text: true }],
  [".md", { mimeType: "text/markdown", text: true }],
  [".mjs", { mimeType: "text/javascript", text: true }],
  [".mov", { mimeType: "video/quicktime" }],
  [".mp3", { mimeType: "audio/mpeg" }],
  [".mp4", { mimeType: "video/mp4" }],
  [".pdf", { mimeType: "application/pdf" }],
  [".png", { mimeType: "image/png" }],
  [".ps1", { mimeType: "text/plain", text: true }],
  [".py", { mimeType: "text/x-python", text: true }],
  [".rb", { mimeType: "text/x-ruby", text: true }],
  [".rs", { mimeType: "text/x-rust", text: true }],
  [".sh", { mimeType: "text/x-shellscript", text: true }],
  [".sql", { mimeType: "application/sql", text: true }],
  [".svg", { mimeType: "image/svg+xml", text: true }],
  [".tar", { mimeType: "application/x-tar" }],
  [".tif", { mimeType: "image/tiff" }],
  [".tiff", { mimeType: "image/tiff" }],
  [".toml", { mimeType: "application/toml", text: true }],
  [".ts", { mimeType: "text/typescript", text: true }],
  [".tsv", { mimeType: "text/tab-separated-values", text: true }],
  [".tsx", { mimeType: "text/tsx", text: true }],
  [".txt", { mimeType: "text/plain", text: true }],
  [".wav", { mimeType: "audio/wav" }],
  [".webp", { mimeType: "image/webp" }],
  [
    ".xlsx",
    {
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    },
  ],
  [".xml", { mimeType: "application/xml", text: true }],
  [".yaml", { mimeType: "application/yaml", text: true }],
  [".yml", { mimeType: "application/yaml", text: true }],
  [".zip", { mimeType: "application/zip" }],
  [".zsh", { mimeType: "text/x-shellscript", text: true }],
]);

const KNOWN_TEXT_BASENAMES = new Set([
  ".editorconfig",
  ".gitattributes",
  ".gitignore",
  ".npmrc",
  "dockerfile",
  "license",
  "makefile",
  "readme",
]);

/**
 * Add bounded metadata to explicit local-file references without turning them
 * into uploads. Only known text types whose entire file is at most 10 KiB are
 * read, UTF-8 validated, and given a small preview under a per-turn budget.
 */
export async function enrichLocalFileInputs(
  input: AppServerTurnInputItem[],
): Promise<AppServerTurnInputItem[]> {
  let remainingPreviewBytes = MAX_TURN_LOCAL_TEXT_PREVIEW_BYTES;
  const enriched: AppServerTurnInputItem[] = [];

  for (const item of input) {
    if (item.type !== "localFile") {
      enriched.push(item);
      continue;
    }
    const result = await inspectLocalFile(item, remainingPreviewBytes);
    enriched.push(result.item);
    remainingPreviewBytes -= result.previewBytes;
  }

  return enriched;
}

async function inspectLocalFile(
  item: AppServerLocalFileInputItem,
  remainingPreviewBytes: number,
): Promise<{ item: AppServerLocalFileInputItem; previewBytes: number }> {
  const knownType = knownLocalFileType(item.path);
  try {
    const handle = await open(item.path, "r");
    try {
      const stats = await handle.stat();
      if (!stats.isFile()) {
        return { item, previewBytes: 0 };
      }
      const metadata = {
        ...(knownType ? { mimeType: knownType.mimeType } : {}),
        sizeBytes: stats.size,
      };
      if (
        !knownType?.text
        || stats.size === 0
        || stats.size > MAX_LOCAL_TEXT_FILE_BYTES
        || remainingPreviewBytes <= 0
      ) {
        return { item: { ...item, ...metadata }, previewBytes: 0 };
      }

      const data = Buffer.allocUnsafe(stats.size);
      let bytesRead = 0;
      while (bytesRead < data.byteLength) {
        const result = await handle.read(
          data,
          bytesRead,
          data.byteLength - bytesRead,
          bytesRead,
        );
        if (result.bytesRead === 0) {
          return { item: { ...item, ...metadata }, previewBytes: 0 };
        }
        bytesRead += result.bytesRead;
      }
      const text = decodeValidatedUtf8Text(data);
      if (!text) {
        return { item: { ...item, ...metadata }, previewBytes: 0 };
      }
      const previewBudget = Math.min(
        MAX_LOCAL_TEXT_PREVIEW_BYTES,
        remainingPreviewBytes,
      );
      const textPreview = utf8Prefix(text, previewBudget);
      const previewBytes = Buffer.byteLength(textPreview, "utf8");
      return {
        item: {
          ...item,
          ...metadata,
          textPreview,
          ...(previewBytes < Buffer.byteLength(text, "utf8")
            ? { textPreviewTruncated: true }
            : {}),
        },
        previewBytes,
      };
    } finally {
      await handle.close();
    }
  } catch {
    return { item, previewBytes: 0 };
  }
}

function knownLocalFileType(filePath: string): KnownLocalFileType | undefined {
  const extension = path.extname(filePath).toLowerCase();
  const knownExtension = KNOWN_LOCAL_FILE_TYPES.get(extension);
  if (knownExtension) {
    return knownExtension;
  }
  return KNOWN_TEXT_BASENAMES.has(path.basename(filePath).toLowerCase())
    ? { mimeType: "text/plain", text: true }
    : undefined;
}

function decodeValidatedUtf8Text(data: Uint8Array): string | undefined {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    return undefined;
  }
  text = text.replace(/^\uFEFF/u, "");
  if (!text || hasDisallowedTextControl(text)) {
    return undefined;
  }
  return text;
}

function hasDisallowedTextControl(text: string): boolean {
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      codePoint <= 0x08
      || codePoint === 0x0b
      || codePoint === 0x0c
      || (codePoint >= 0x0e && codePoint <= 0x1f)
      || codePoint === 0x7f
    ) {
      return true;
    }
  }
  return false;
}

function utf8Prefix(text: string, maxBytes: number): string {
  let bytes = 0;
  let prefix = "";
  for (const character of text) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) {
      break;
    }
    prefix += character;
    bytes += characterBytes;
  }
  return prefix;
}
