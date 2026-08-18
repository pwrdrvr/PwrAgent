import { open, realpath } from "node:fs/promises";
import os from "node:os";
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

const PRIVATE_STORAGE_DIRECTORIES = new Set([
  "archived_sessions",
  "rollouts",
  "sessions",
  // A PwrAgent profile keeps its database, runtime-instance markers, and
  // focus requests under `state/`. The root-file patterns below only match a
  // database sitting directly in the profile directory, which is not where the
  // app actually writes one.
  "state",
]);

const PRIVATE_STORAGE_ROOT_FILES = [
  /^history\.jsonl$/u,
  /^state(?:_[^.]+)?\.sqlite(?:-(?:shm|wal))?$/u,
  /^state\.db(?:-(?:shm|wal))?$/u,
];

/**
 * Add bounded metadata to explicit local-file references without turning them
 * into uploads. Only known text types whose entire file is at most 10 KiB are
 * read, UTF-8 validated, and given a small preview under a per-turn budget.
 */
export async function enrichLocalFileInputs(
  input: AppServerTurnInputItem[],
  options?: { privateStorageRoots?: readonly string[] },
): Promise<AppServerTurnInputItem[]> {
  let remainingPreviewBytes = MAX_TURN_LOCAL_TEXT_PREVIEW_BYTES;
  const enriched: AppServerTurnInputItem[] = [];

  for (const item of input) {
    if (item.type !== "localFile") {
      enriched.push(item);
      continue;
    }
    const result = await inspectLocalFile(
      item,
      remainingPreviewBytes,
      options?.privateStorageRoots ?? [],
    );
    enriched.push(result.item);
    remainingPreviewBytes -= result.previewBytes;
  }

  return enriched;
}

async function inspectLocalFile(
  item: AppServerLocalFileInputItem,
  remainingPreviewBytes: number,
  privateStorageRoots: readonly string[],
): Promise<{ item: AppServerLocalFileInputItem; previewBytes: number }> {
  const cleanItem = discardDerivedContext(item);
  const inspected = await resolveReadableLocalFilePath(cleanItem.path, {
    privateStorageRoots,
  });
  if (!inspected.ok) {
    return { item: cleanItem, previewBytes: 0 };
  }
  const inspectedPath = inspected.path;
  const knownType = knownLocalFileType(cleanItem.path);
  try {
    const handle = await open(inspectedPath, "r");
    try {
      const stats = await handle.stat();
      if (!stats.isFile()) {
        return { item: cleanItem, previewBytes: 0 };
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
        return { item: { ...cleanItem, ...metadata }, previewBytes: 0 };
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
          return { item: { ...cleanItem, ...metadata }, previewBytes: 0 };
        }
        bytesRead += result.bytesRead;
      }
      const text = decodeValidatedUtf8Text(data);
      if (!text) {
        return { item: { ...cleanItem, ...metadata }, previewBytes: 0 };
      }
      const previewBudget = Math.min(
        MAX_LOCAL_TEXT_PREVIEW_BYTES,
        remainingPreviewBytes,
      );
      const textPreview = utf8Prefix(text, previewBudget);
      const previewBytes = Buffer.byteLength(textPreview, "utf8");
      return {
        item: {
          ...cleanItem,
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
    return { item: cleanItem, previewBytes: 0 };
  }
}

function discardDerivedContext(
  item: AppServerLocalFileInputItem,
): AppServerLocalFileInputItem {
  const cleanItem = { ...item };
  delete cleanItem.mimeType;
  delete cleanItem.sizeBytes;
  delete cleanItem.textPreview;
  delete cleanItem.textPreviewTruncated;
  return cleanItem;
}

export type ReadableLocalFilePathResult =
  | { ok: true; path: string }
  | { ok: false; reason: "forbidden" | "not_found" };

/**
 * Canonicalize a local path and refuse Codex/PwrAgent private storage.
 * When `allowedRoots` is provided, the resolved file must sit inside one of
 * those roots. Callers that omit `allowedRoots` keep the historical
 * inspect-anywhere-except-private-storage behavior.
 */
export async function resolveReadableLocalFilePath(
  filePath: string,
  options?: {
    allowedRoots?: readonly string[];
    privateStorageRoots?: readonly string[];
  },
): Promise<ReadableLocalFilePathResult> {
  const configuredRoots = configuredPrivateStorageRoots(
    options?.privateStorageRoots ?? [],
  );
  if (isPrivateStoragePath(filePath, configuredRoots)) {
    return { ok: false, reason: "forbidden" };
  }
  let resolvedPath: string;
  try {
    resolvedPath = await realpath(filePath);
  } catch {
    return { ok: false, reason: "not_found" };
  }
  const canonicalPrivateRoots = await canonicalizeRoots(configuredRoots);
  if (isPrivateStoragePath(resolvedPath, canonicalPrivateRoots)) {
    return { ok: false, reason: "forbidden" };
  }
  if (options?.allowedRoots) {
    const canonicalAllowedRoots = await canonicalizeRoots(options.allowedRoots);
    const allowed = canonicalAllowedRoots.some((root) =>
      isPathInsideRoot(path.relative(root, resolvedPath)),
    );
    if (!allowed) {
      return { ok: false, reason: "forbidden" };
    }
  }
  return { ok: true, path: resolvedPath };
}

async function canonicalizeRoots(roots: readonly string[]): Promise<string[]> {
  return await Promise.all(
    roots.map(async (root) => {
      try {
        return await realpath(root);
      } catch {
        return path.resolve(root);
      }
    }),
  );
}

function configuredPrivateStorageRoots(
  privateStorageRoots: readonly string[],
): string[] {
  return [
    path.join(os.homedir(), ".codex"),
    process.env.CODEX_HOME?.trim(),
    ...privateStorageRoots,
  ].filter((root): root is string => Boolean(root));
}

function isPrivateStoragePath(
  filePath: string,
  privateStorageRoots: readonly string[],
): boolean {
  const resolvedPath = path.resolve(filePath);
  for (const root of privateStorageRoots) {
    const relativePath = path.relative(path.resolve(root), resolvedPath);
    if (
      isPathInsideRoot(relativePath)
      && isPrivateStorageRelativePath(relativePath)
    ) {
      return true;
    }
  }

  const components = resolvedPath.split(path.sep);
  for (let index = 0; index < components.length; index += 1) {
    if (components[index]?.toLowerCase() !== ".codex") {
      continue;
    }
    const relativePath = components.slice(index + 1).join(path.sep);
    if (isPrivateStorageRelativePath(relativePath)) {
      return true;
    }
  }
  return false;
}

function isPathInsideRoot(relativePath: string): boolean {
  return relativePath !== ""
    && relativePath !== ".."
    && !relativePath.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relativePath);
}

function isPrivateStorageRelativePath(relativePath: string): boolean {
  let components = relativePath.split(path.sep).filter(Boolean);
  if (components[0]?.toLowerCase() === "profiles" && components.length >= 3) {
    components = components.slice(2);
  }
  const first = components[0]?.toLowerCase();
  if (!first || first === "worktrees") {
    return false;
  }
  if (PRIVATE_STORAGE_DIRECTORIES.has(first)) {
    return true;
  }
  return components.length === 1
    && PRIVATE_STORAGE_ROOT_FILES.some((pattern) => pattern.test(first));
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
