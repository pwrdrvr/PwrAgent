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
 * after symlinks, must sit inside that folder and outside any hidden
 * directory, so a page cannot pull an arbitrary file off the disk into its
 * frame.
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

  // Find every file first, then spend the byte budget in page order, then
  // read what fits. Only the finding and the reading touch the disk, and
  // both run a few files at a time.
  const found = await mapConcurrently(refs, (ref) => findAsset(folder, ref));
  let budget = MAX_HTML_PREVIEW_TOTAL_ASSET_BYTES;
  const planned = found.map((asset) => {
    if ("reason" in asset) return asset;
    if (asset.size > MAX_HTML_PREVIEW_ASSET_BYTES || asset.size > budget) {
      return { reason: "too-large" as const };
    }
    budget -= asset.size;
    return asset;
  });
  const read = await mapConcurrently(planned, async (asset) =>
    "reason" in asset ? asset : await readFoundAsset(asset));

  const assets: HtmlPreviewAsset[] = [];
  const skipped: HtmlPreviewSkippedAsset[] = [];
  read.forEach((result, index) => {
    const ref = refs[index]!;
    if ("reason" in result) skipped.push({ ref, reason: result.reason });
    else assets.push({ ref, dataUrl: result.dataUrl });
  });
  return { assets, skipped };
}

type SkipReason = { reason: HtmlPreviewSkippedAsset["reason"] };
type FoundAsset = { resolved: string; mime: string; size: number };

async function findAsset(folder: string, ref: string): Promise<FoundAsset | SkipReason> {
  const candidate = htmlPreviewAssetPath(folder, ref);
  if (candidate === undefined || !isServedFrom(folder, candidate)) {
    return { reason: "outside-folder" };
  }

  let resolved: string;
  try {
    resolved = await realpath(candidate);
  } catch {
    return { reason: "missing" };
  }
  // A symlink inside the folder must not lead out of it.
  if (!isServedFrom(folder, resolved)) {
    return { reason: "outside-folder" };
  }
  const mime = htmlPreviewAssetMime(resolved);
  if (!mime) {
    return { reason: "unsupported-type" };
  }
  try {
    const fileStat = await stat(resolved);
    return fileStat.isFile()
      ? { resolved, mime, size: fileStat.size }
      : { reason: "missing" };
  } catch {
    return { reason: "missing" };
  }
}

async function readFoundAsset(asset: FoundAsset): Promise<{ dataUrl: string } | SkipReason> {
  try {
    const bytes = await readFile(asset.resolved);
    // The file grew after it was measured: it no longer fits the budget.
    if (bytes.byteLength > asset.size) {
      return { reason: "too-large" };
    }
    return { dataUrl: `data:${asset.mime};base64,${bytes.toString("base64")}` };
  } catch {
    return { reason: "missing" };
  }
}

const ASSET_IO_CONCURRENCY = 8;

async function mapConcurrently<T, R>(items: T[], map: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await map(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(ASSET_IO_CONCURRENCY, items.length) }, worker));
  return results;
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

/**
 * Inside the page's folder and not under a hidden directory or file. A page
 * saved at the top of a home folder would otherwise reach `.config`, `.aws`
 * and the like, where tools keep credentials in `.js` and `.json` files.
 */
function isServedFrom(folder: string, candidate: string): boolean {
  const relative = path.relative(folder, candidate);
  if (
    relative === ""
    || relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    return false;
  }
  return !relative.split(path.sep).some((segment) => segment.startsWith("."));
}
