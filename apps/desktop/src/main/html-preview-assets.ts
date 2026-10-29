import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  filePreviewKind,
  isRemoteFederationTarget,
  type HtmlPreviewAsset,
  type HtmlPreviewSkippedAsset,
  type ReadHtmlPreviewAssetsRequest,
  type ReadHtmlPreviewAssetsResponse,
} from "@pwragent/shared";

/**
 * An HTML preview may be a self-contained export with its media inlined, so
 * it gets more room than the 2 MiB the text kinds do.
 */
export const MAX_HTML_PREVIEW_FILE_BYTES = 24 * 1024 * 1024;
export const MAX_HTML_PREVIEW_ASSET_BYTES = 16 * 1024 * 1024;
export const MAX_HTML_PREVIEW_TOTAL_ASSET_BYTES = 48 * 1024 * 1024;
export const MAX_HTML_PREVIEW_ASSET_REFS = 500;

/**
 * What a page can load from beside it. Every type here is inert in the
 * preview frame or runs under its sandbox: no documents, archives, or data
 * files that a script could read back.
 */
const ASSET_MIME_BY_EXTENSION: Record<string, string> = {
  apng: "image/apng",
  avif: "image/avif",
  bmp: "image/bmp",
  gif: "image/gif",
  ico: "image/x-icon",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  svg: "image/svg+xml",
  webp: "image/webp",
  otf: "font/otf",
  ttf: "font/ttf",
  woff: "font/woff",
  woff2: "font/woff2",
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  oga: "audio/ogg",
  ogg: "audio/ogg",
  wav: "audio/wav",
  mp4: "video/mp4",
  webm: "video/webm",
};

export function htmlPreviewAssetMime(filePath: string): string | undefined {
  const extension = /\.([a-z0-9]+)$/i.exec(filePath)?.[1]?.toLowerCase();
  return extension ? ASSET_MIME_BY_EXTENSION[extension] : undefined;
}

/**
 * Read the files an HTML preview names by relative path, as `data:` URLs.
 *
 * A relative ref resolves against the folder of the HTML file it came from.
 * An absolute path or a `file:` URL is taken as written. Either way the file,
 * after symlinks, must sit inside that folder, so a page cannot pull an
 * arbitrary file off the disk into its frame.
 */
export async function readHtmlPreviewAssets(
  request: ReadHtmlPreviewAssetsRequest,
): Promise<ReadHtmlPreviewAssetsResponse> {
  if (request.federationTarget && isRemoteFederationTarget(request.federationTarget)) {
    return { assets: [], skipped: [], error: "Files beside a peer's page are not loaded." };
  }
  const target = request.path?.trim();
  if (!target || filePreviewKind(target) !== "html") {
    return { assets: [], skipped: [], error: "This file is not an HTML page." };
  }

  let folder: string;
  try {
    const resolved = await realpath(target);
    if (filePreviewKind(resolved) !== "html") {
      return { assets: [], skipped: [], error: "This file is not an HTML page." };
    }
    folder = path.dirname(resolved);
  } catch {
    return { assets: [], skipped: [], error: `Path does not exist: ${target}` };
  }

  const refs = [...new Set(Array.isArray(request.refs) ? request.refs : [])]
    .filter((ref): ref is string => typeof ref === "string" && ref.length > 0)
    .slice(0, MAX_HTML_PREVIEW_ASSET_REFS);
  const assets: HtmlPreviewAsset[] = [];
  const skipped: HtmlPreviewSkippedAsset[] = [];
  let totalBytes = 0;

  for (const ref of refs) {
    const result = await readAsset(folder, ref, MAX_HTML_PREVIEW_TOTAL_ASSET_BYTES - totalBytes);
    if ("reason" in result) {
      skipped.push({ ref, reason: result.reason });
      continue;
    }
    totalBytes += result.bytes;
    assets.push({ ref, dataUrl: result.dataUrl });
  }

  return { assets, skipped };
}

async function readAsset(
  folder: string,
  ref: string,
  remainingBytes: number,
): Promise<{ dataUrl: string; bytes: number } | { reason: HtmlPreviewSkippedAsset["reason"] }> {
  const candidate = htmlPreviewAssetPath(folder, ref);
  if (candidate === undefined || !isInside(folder, candidate)) {
    return { reason: "outside-folder" };
  }

  let resolved: string;
  try {
    resolved = await realpath(candidate);
  } catch {
    return { reason: "missing" };
  }
  // A symlink inside the folder must not lead out of it.
  if (!isInside(folder, resolved)) {
    return { reason: "outside-folder" };
  }
  const mime = htmlPreviewAssetMime(resolved);
  if (!mime) {
    return { reason: "unsupported-type" };
  }

  try {
    const fileStat = await stat(resolved);
    if (!fileStat.isFile()) {
      return { reason: "missing" };
    }
    if (fileStat.size > MAX_HTML_PREVIEW_ASSET_BYTES || fileStat.size > remainingBytes) {
      return { reason: "too-large" };
    }
    const bytes = await readFile(resolved);
    if (bytes.byteLength > MAX_HTML_PREVIEW_ASSET_BYTES || bytes.byteLength > remainingBytes) {
      return { reason: "too-large" };
    }
    return { dataUrl: `data:${mime};base64,${bytes.toString("base64")}`, bytes: bytes.byteLength };
  } catch {
    return { reason: "missing" };
  }
}

/**
 * The filesystem path a ref names, or undefined for a ref that is not a local
 * file: another scheme, a protocol-relative URL, or a bare fragment. Query
 * strings and fragments are dropped.
 */
export function htmlPreviewAssetPath(folder: string, ref: string): string | undefined {
  const trimmed = ref.trim();
  if (!trimmed || trimmed.startsWith("#") || /^[/\\]{2}/.test(trimmed)) {
    return undefined;
  }
  if (/^file:/i.test(trimmed)) {
    try {
      return path.resolve(fileURLToPath(trimmed.split("#", 1)[0] ?? ""));
    } catch {
      return undefined;
    }
  }
  // A drive letter is a path, not a scheme.
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !/^[a-z]:[/\\]/i.test(trimmed)) {
    return undefined;
  }
  const pathPart = trimmed.split(/[?#]/, 1)[0] ?? "";
  if (!pathPart) {
    return undefined;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathPart);
  } catch {
    decoded = pathPart;
  }
  if (decoded.includes("\0")) {
    return undefined;
  }
  return path.resolve(folder, decoded);
}

function isInside(folder: string, candidate: string): boolean {
  const relative = path.relative(folder, candidate);
  return relative !== ""
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}
