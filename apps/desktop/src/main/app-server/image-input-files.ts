import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AppServerTurnInputItem } from "@pwragent/shared";
import { resolveActiveProfilePath } from "../profile";

const LOCAL_IMAGE_INPUT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type ImageInputFileDependencies = {
  now: () => number;
  readFile: (filePath: string) => Promise<Buffer>;
  resolveRoot: () => string;
  writeFile: (filePath: string, data: Buffer) => Promise<unknown>;
  mkdir: (dirPath: string, options: { recursive: true }) => Promise<unknown>;
  readdir: (dirPath: string) => Promise<string[]>;
  stat: (filePath: string) => Promise<{
    isFile: () => boolean;
    isDirectory?: () => boolean;
    mtimeMs: number;
  }>;
  unlink: (filePath: string) => Promise<unknown>;
  rm: (
    filePath: string,
    options: { recursive?: boolean; force?: boolean },
  ) => Promise<unknown>;
};

const defaultDependencies: ImageInputFileDependencies = {
  now: () => Date.now(),
  readFile,
  resolveRoot: () => resolveActiveProfilePath(path.join("state", "image-inputs")),
  writeFile,
  mkdir,
  readdir,
  stat,
  unlink,
  rm,
};

export async function materializeLocalImageInputs(
  input: AppServerTurnInputItem[],
  dependencies: Partial<ImageInputFileDependencies> = {},
): Promise<AppServerTurnInputItem[]> {
  const deps = { ...defaultDependencies, ...dependencies };
  const materialized: AppServerTurnInputItem[] = [];
  const materializedFilePaths = new Set<string>();
  let materializedRoot: string | undefined;

  for (const item of input) {
    if (item.type !== "image" && item.type !== "localImage") {
      materialized.push(item);
      continue;
    }

    const dataImage = item.type === "image"
      ? parseSupportedImageDataUrl(item.url)
      : undefined;
    if (dataImage) {
      const root = deps.resolveRoot();
      materializedRoot = root;
      await deps.mkdir(root, { recursive: true });
      const filePath = materializedImageFilePath(root, item.name, {
        extension: extensionForMimeType(dataImage.mimeType),
        sha256: dataImage.sha256,
      });
      await deps.mkdir(path.dirname(filePath), { recursive: true });
      await deps.writeFile(filePath, dataImage.buffer);
      materializedFilePaths.add(filePath);
      materialized.push({
        type: "localImage",
        ...(item.name ? { name: item.name } : {}),
        path: filePath,
      });
      continue;
    }

    const filePath = item.type === "localImage"
      ? item.path
      : filePathFromFileUrl(item.url);
    if (filePath && isSupportedImagePath(filePath)) {
      const root = deps.resolveRoot();
      materializedRoot = root;
      const buffer = await deps.readFile(filePath);
      const extension = normalizedImageExtension(filePath);
      const materializedPath = materializedImageFilePath(root, item.name, {
        extension,
        sha256: createHash("sha256").update(buffer).digest("hex"),
      });
      await deps.mkdir(path.dirname(materializedPath), { recursive: true });
      await deps.writeFile(materializedPath, buffer);
      materializedFilePaths.add(materializedPath);
      materialized.push({
        type: "localImage",
        ...(item.name ? { name: item.name } : {}),
        path: materializedPath,
      });
      continue;
    }

    materialized.push(item);
  }

  if (materializedRoot) {
    void cleanupOldImageInputs(
      materializedRoot,
      deps,
      materializedFilePaths,
    ).catch(() => undefined);
  }

  return materialized;
}

function parseSupportedImageDataUrl(
  url: string,
): { buffer: Buffer; mimeType: "image/jpeg" | "image/png"; sha256: string } | undefined {
  const match = /^data:(image\/(?:jpeg|jpg|png));base64,([a-z0-9+/=]+)$/iu.exec(url);
  if (!match) {
    return undefined;
  }

  const mimeType = match[1]?.toLowerCase() === "image/png" ? "image/png" : "image/jpeg";
  const payload = match[2] ?? "";
  const buffer = Buffer.from(payload, "base64");
  if (buffer.byteLength === 0) {
    return undefined;
  }

  return {
    buffer,
    mimeType,
    sha256: createHash("sha256").update(buffer).digest("hex"),
  };
}

function filePathFromFileUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "file:" ? fileURLToPath(parsed) : undefined;
  } catch {
    return undefined;
  }
}

function materializedImageFilePath(
  root: string,
  name: string | undefined,
  image: { extension: string; sha256: string },
): string {
  const fallback = path.join(root, `${image.sha256}.${image.extension}`);
  const basename = sanitizeImageBasename(name, image.extension);
  if (!basename) {
    return fallback;
  }

  return path.join(root, image.sha256, basename);
}

function sanitizeImageBasename(
  name: string | undefined,
  extension: string,
): string | undefined {
  const basename = name
    ?.trim()
    .replace(/\\/g, "/")
    .split("/")
    .pop();
  const normalized = basename
    ? stripAsciiControlCharacters(basename).trim()
    : basename;
  if (!normalized) {
    return undefined;
  }

  const parsed = path.parse(normalized);
  const stem = (parsed.name || normalized)
    .replace(/[^a-zA-Z0-9._ -]+/g, "-")
    .replace(/^[.\s-]+|[.\s-]+$/g, "")
    .slice(0, 96);
  if (!stem) {
    return undefined;
  }

  return `${stem}.${extension}`;
}

function stripAsciiControlCharacters(value: string): string {
  let result = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint > 0x1f && codePoint !== 0x7f) {
      result += character;
    }
  }
  return result;
}

function extensionForMimeType(mimeType: "image/jpeg" | "image/png"): "jpg" | "png" {
  return mimeType === "image/png" ? "png" : "jpg";
}

function isSupportedImagePath(filePath: string): boolean {
  return SUPPORTED_LOCAL_IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

const SUPPORTED_LOCAL_IMAGE_EXTENSIONS = new Set([
  ".avif",
  ".bmp",
  ".gif",
  ".jpeg",
  ".jpg",
  ".png",
  ".webp",
]);

function normalizedImageExtension(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase().slice(1);
  return extension === "jpeg" ? "jpg" : extension;
}

async function cleanupOldImageInputs(
  root: string,
  deps: ImageInputFileDependencies,
  excludedFilePaths: ReadonlySet<string>,
): Promise<void> {
  const cutoff = deps.now() - LOCAL_IMAGE_INPUT_MAX_AGE_MS;
  const entries = await deps.readdir(root).catch(() => []);
  await Promise.all(
    entries.map(async (entry) => {
      const filePath = path.join(root, entry);
      if (isExcludedImageInputPath(filePath, excludedFilePaths)) {
        return;
      }
      const info = await deps.stat(filePath).catch(() => undefined);
      if (info?.isDirectory?.()) {
        if (
          info.mtimeMs < cutoff &&
          !(await containsFreshImageInput(filePath, deps, cutoff, excludedFilePaths))
        ) {
          await deps
            .rm(filePath, { recursive: true, force: true })
            .catch(() => undefined);
        }
        return;
      }
      if (!info?.isFile() || info.mtimeMs >= cutoff) {
        return;
      }
      if (!isSupportedImagePath(filePath)) {
        return;
      }
      await deps.unlink(filePath).catch(() => undefined);
    }),
  );
}

async function containsFreshImageInput(
  dirPath: string,
  deps: ImageInputFileDependencies,
  cutoff: number,
  excludedFilePaths: ReadonlySet<string>,
): Promise<boolean> {
  const entries = await deps.readdir(dirPath).catch(() => undefined);
  if (!entries) {
    return true;
  }

  for (const entry of entries) {
    const childPath = path.join(dirPath, entry);
    if (isExcludedImageInputPath(childPath, excludedFilePaths)) {
      return true;
    }
    if (!isSupportedImagePath(childPath)) {
      continue;
    }
    const info = await deps.stat(childPath).catch(() => undefined);
    if (info?.isFile() && info.mtimeMs >= cutoff) {
      return true;
    }
  }

  return false;
}

function isExcludedImageInputPath(
  filePath: string,
  excludedFilePaths: ReadonlySet<string>,
): boolean {
  for (const excludedPath of excludedFilePaths) {
    if (excludedPath === filePath || excludedPath.startsWith(`${filePath}${path.sep}`)) {
      return true;
    }
  }
  return false;
}
