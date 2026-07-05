import { createHash } from "node:crypto";
import { mkdir, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AppServerTurnInputItem } from "@pwragent/shared";
import { resolveActiveProfilePath } from "../profile";

const LOCAL_IMAGE_INPUT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type ImageInputFileDependencies = {
  now: () => number;
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
  resolveRoot: () =>
    resolveActiveProfilePath(path.join("state", "image-inputs")),
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
    if (item.type !== "image") {
      materialized.push(item);
      continue;
    }

    const dataImage = parseSupportedImageDataUrl(item.url);
    if (dataImage) {
      const root = deps.resolveRoot();
      materializedRoot = root;
      await deps.mkdir(root, { recursive: true });
      const filePath = materializedImageFilePath(root, item.name, dataImage);
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

    const filePath = filePathFromFileUrl(item.url);
    if (filePath && isSupportedImagePath(filePath)) {
      materialized.push({
        type: "localImage",
        ...(item.name ? { name: item.name } : {}),
        path: filePath,
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
):
  | { buffer: Buffer; mimeType: "image/jpeg" | "image/png"; sha256: string }
  | undefined {
  const match = /^data:(image\/(?:jpeg|jpg|png));base64,([a-z0-9+/=]+)$/iu.exec(
    url,
  );
  if (!match) {
    return undefined;
  }

  const mimeType =
    match[1]?.toLowerCase() === "image/png" ? "image/png" : "image/jpeg";
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
    return parsed.protocol === "file:"
      ? decodeURIComponent(parsed.pathname)
      : undefined;
  } catch {
    return undefined;
  }
}

function materializedImageFilePath(
  root: string,
  name: string | undefined,
  dataImage: { mimeType: "image/jpeg" | "image/png"; sha256: string },
): string {
  const extension = extensionForMimeType(dataImage.mimeType);
  const fallback = path.join(root, `${dataImage.sha256}.${extension}`);
  const basename = sanitizeImageBasename(name, extension);
  if (!basename) {
    return fallback;
  }

  return path.join(root, dataImage.sha256, basename);
}

function sanitizeImageBasename(
  name: string | undefined,
  extension: "jpg" | "png",
): string | undefined {
  const normalized = name
    ?.trim()
    .replace(/\\/g, "/")
    .split("/")
    .pop()
    ?.replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
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

function extensionForMimeType(
  mimeType: "image/jpeg" | "image/png",
): "jpg" | "png" {
  return mimeType === "image/png" ? "png" : "jpg";
}

function isSupportedImagePath(filePath: string): boolean {
  const extension = path.extname(filePath).toLowerCase();
  return extension === ".jpg" || extension === ".jpeg" || extension === ".png";
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
          info.mtimeMs < cutoff
          && !(await containsFreshImageInput(
            filePath,
            deps,
            cutoff,
            excludedFilePaths,
          ))
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
    if (
      excludedPath === filePath
      || excludedPath.startsWith(`${filePath}${path.sep}`)
    ) {
      return true;
    }
  }
  return false;
}
