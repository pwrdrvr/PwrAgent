import { createHash } from "node:crypto";
import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
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
  stat: (filePath: string) => Promise<{ isFile: () => boolean; mtimeMs: number }>;
  unlink: (filePath: string) => Promise<unknown>;
};

const defaultDependencies: ImageInputFileDependencies = {
  now: () => Date.now(),
  resolveRoot: () => resolveActiveProfilePath(path.join("state", "image-inputs")),
  writeFile,
  mkdir,
  readdir,
  stat,
  unlink,
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
      const filePath = path.join(
        root,
        `${dataImage.sha256}.${extensionForMimeType(dataImage.mimeType)}`,
      );
      await deps.writeFile(filePath, dataImage.buffer);
      materializedFilePaths.add(filePath);
      materialized.push({ type: "localImage", path: filePath });
      continue;
    }

    const filePath = filePathFromFileUrl(item.url);
    if (filePath && isSupportedImagePath(filePath)) {
      materialized.push({ type: "localImage", path: filePath });
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
    return parsed.protocol === "file:" ? decodeURIComponent(parsed.pathname) : undefined;
  } catch {
    return undefined;
  }
}

function extensionForMimeType(mimeType: "image/jpeg" | "image/png"): "jpg" | "png" {
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
      if (excludedFilePaths.has(filePath)) {
        return;
      }
      if (!isSupportedImagePath(filePath)) {
        return;
      }
      const info = await deps.stat(filePath).catch(() => undefined);
      if (!info?.isFile() || info.mtimeMs >= cutoff) {
        return;
      }
      await deps.unlink(filePath).catch(() => undefined);
    }),
  );
}
