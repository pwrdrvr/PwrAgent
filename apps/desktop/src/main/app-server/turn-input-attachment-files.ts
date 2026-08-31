import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AppServerLocalFileInputItem,
  AppServerLocalImageInputItem,
  AppServerTurnInputItem,
} from "@pwragent/shared";
import { resolveActiveProfilePath } from "../profile";
import { imageInputFileRoot } from "./image-input-files";
import { resolveReadableLocalFilePath } from "./local-file-input";

export const TURN_INPUT_ATTACHMENT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_TURN_INPUT_ATTACHMENT_BYTES = 128 * 1024 * 1024;

export type TurnInputAttachmentUpload = {
  type: "localImage" | "localFile";
  data: Uint8Array;
  name?: string;
  mimeType?: string;
};

export type StagedTurnInputAttachment =
  | AppServerLocalImageInputItem
  | AppServerLocalFileInputItem;

export function turnInputAttachmentRoot(): string {
  return resolveActiveProfilePath(path.join("state", "turn-input-attachments"));
}

/**
 * Persist cloneable renderer bytes in PwrAgent-owned storage and return the
 * path-only input shape used by local backends and the federation uploader.
 */
export async function stageTurnInputAttachment(
  upload: TurnInputAttachmentUpload,
): Promise<StagedTurnInputAttachment> {
  const data = Buffer.from(upload.data);
  if (data.byteLength > MAX_TURN_INPUT_ATTACHMENT_BYTES) {
    throw new Error(
      `Turn attachment exceeds the ${MAX_TURN_INPUT_ATTACHMENT_BYTES}-byte limit.`,
    );
  }
  if (upload.type === "localImage" && data.byteLength === 0) {
    throw new Error("Image attachments cannot be empty.");
  }

  const digest = createHash("sha256").update(data).digest("hex");
  const root = turnInputAttachmentRoot();
  const name = sanitizeTurnAttachmentName(
    upload.name,
    fallbackName(upload.type, upload.mimeType),
  );
  const filePath = path.join(root, digest, name);
  await mkdir(path.dirname(filePath), { recursive: true });
  const stagedAt = new Date();
  await utimes(path.dirname(filePath), stagedAt, stagedAt);
  const existing = await stat(filePath).catch(() => undefined);
  let reusable = false;
  if (existing?.isFile() && existing.size === data.byteLength) {
    const existingData = await readFile(filePath).catch(() => undefined);
    reusable = Boolean(
      existingData
      && createHash("sha256").update(existingData).digest("hex") === digest,
    );
  }
  if (!reusable) {
    const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, data);
      await rename(temporaryPath, filePath);
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
  } else {
    await Promise.all([
      utimes(filePath, stagedAt, stagedAt),
      utimes(path.dirname(filePath), stagedAt, stagedAt),
    ]);
  }

  void cleanupOldTurnInputAttachments(root, new Set([filePath])).catch(
    () => undefined,
  );

  return upload.type === "localImage"
    ? {
        type: "localImage",
        ...(upload.name?.trim() ? { name: upload.name.trim() } : {}),
        path: filePath,
      }
    : {
        type: "localFile",
        ...(upload.name?.trim() ? { name: upload.name.trim() } : {}),
        ...(upload.mimeType?.trim() ? { mimeType: upload.mimeType.trim() } : {}),
        sizeBytes: data.byteLength,
        path: filePath,
      };
}

export async function stageTurnInputAttachments(
  uploads: readonly TurnInputAttachmentUpload[],
): Promise<StagedTurnInputAttachment[]> {
  return await Promise.all(uploads.map(stageTurnInputAttachment));
}

export async function stageLocalTurnInputAttachment(
  item: StagedTurnInputAttachment,
  options?: { privateStorageRoots?: readonly string[] },
): Promise<StagedTurnInputAttachment> {
  const ownedStagingPath = await resolveOwnedStagingPath(item.path);
  const readable = ownedStagingPath
    ? { ok: true as const, path: ownedStagingPath }
    : await resolveReadableLocalFilePath(item.path, {
        privateStorageRoots: options?.privateStorageRoots,
      });
  if (!readable.ok) {
    throw new Error(
      readable.reason === "forbidden"
        ? "The attachment path is inside private Codex storage and cannot be transferred."
        : `The attachment file was not found: ${item.path}`,
    );
  }
  const fileInfo = await stat(readable.path).catch(() => undefined);
  if (!fileInfo?.isFile()) {
    throw new Error(`The attachment path is not a regular file: ${item.path}`);
  }
  if (fileInfo.size > MAX_TURN_INPUT_ATTACHMENT_BYTES) {
    throw new Error(
      `Turn attachment exceeds the ${MAX_TURN_INPUT_ATTACHMENT_BYTES}-byte limit.`,
    );
  }
  const data = await readFile(readable.path);
  return await stageTurnInputAttachment({
    type: item.type,
    data,
    name: item.name ?? path.basename(item.path),
    ...(item.type === "localFile" && item.mimeType
      ? { mimeType: item.mimeType }
      : {}),
  });
}

/**
 * Convert source-turn attachments to PwrAgent-owned path references before
 * retaining them for cross-thread forwarding. Inline payloads never enter the
 * registry cache.
 */
export async function stageTurnInputAttachmentsForRetention(
  input: readonly AppServerTurnInputItem[],
  options?: { privateStorageRoots?: readonly string[] },
): Promise<AppServerTurnInputItem[]> {
  const attachments: AppServerTurnInputItem[] = [];
  for (const item of input) {
    if (item.type === "text") {
      continue;
    }
    try {
      if (item.type === "localImage" || item.type === "localFile") {
        attachments.push(await stageLocalTurnInputAttachment(item, options));
        continue;
      }
      if (item.type === "file") {
        const data = decodeBase64(item.data);
        if (data) {
          attachments.push(await stageTurnInputAttachment({
            type: "localFile",
            data,
            name: item.name,
            mimeType: item.mimeType,
          }));
        }
        continue;
      }
      if (item.type === "image" && item.url.startsWith("data:")) {
        const parsed = parseImageDataUrl(item.url);
        if (parsed) {
          attachments.push(await stageTurnInputAttachment({
            type: "localImage",
            data: parsed.data,
            name: item.name,
            mimeType: parsed.mimeType,
          }));
        }
        continue;
      }
      if (item.type === "image" && item.url.startsWith("file:")) {
        const filePath = filePathFromUrl(item.url);
        if (filePath) {
          attachments.push(await stageLocalTurnInputAttachment({
            type: "localImage",
            ...(item.name ? { name: item.name } : {}),
            path: filePath,
          }, options));
        }
        continue;
      }
      attachments.push(item);
    } catch {
      // Forwarding is secondary to the already-admitted source turn. Omit an
      // unreadable attachment instead of retaining its inline payload or
      // failing the source turn after the backend accepted it.
    }
  }
  return attachments;
}

function filePathFromUrl(value: string): string | undefined {
  try {
    return fileURLToPath(value);
  } catch {
    return undefined;
  }
}

export function isStagedTurnInputAttachmentPath(filePath: string): boolean {
  const relative = path.relative(
    path.resolve(turnInputAttachmentRoot()),
    path.resolve(filePath),
  );
  return relative !== ""
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

async function resolveOwnedStagingPath(filePath: string): Promise<string | undefined> {
  const roots = [turnInputAttachmentRoot(), imageInputFileRoot()];
  if (!roots.some((root) => isPathWithinRoot(path.resolve(filePath), path.resolve(root)))) {
    return undefined;
  }
  const [resolvedPath, ...canonicalRoots] = await Promise.all([
    realpath(filePath).catch(() => undefined),
    ...roots.map(canonicalRoot),
  ]);
  return resolvedPath
    && canonicalRoots.some((root) => isPathWithinRoot(resolvedPath, root))
    ? resolvedPath
    : undefined;
}

async function canonicalRoot(root: string): Promise<string> {
  return await realpath(root).catch(() => path.resolve(root));
}

function isPathWithinRoot(filePath: string, root: string): boolean {
  const relative = path.relative(root, filePath);
  return relative !== ""
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function decodeBase64(value: string): Buffer | undefined {
  if (!/^[a-z0-9+/]*={0,2}$/iu.test(value) || value.length % 4 !== 0) {
    return undefined;
  }
  return Buffer.from(value, "base64");
}

function parseImageDataUrl(
  value: string,
): { data: Buffer; mimeType: string } | undefined {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/]*={0,2})$/iu.exec(value);
  if (!match || (match[2]?.length ?? 0) % 4 !== 0) {
    return undefined;
  }
  const data = Buffer.from(match[2] ?? "", "base64");
  return data.byteLength > 0
    ? { data, mimeType: match[1] ?? "application/octet-stream" }
    : undefined;
}

function fallbackName(
  inputType: TurnInputAttachmentUpload["type"],
  mimeType: string | undefined,
): string {
  if (inputType === "localFile") {
    return "attachment";
  }
  switch (mimeType?.trim().toLowerCase()) {
    case "image/gif":
      return "image.gif";
    case "image/jpeg":
    case "image/jpg":
      return "image.jpg";
    case "image/webp":
      return "image.webp";
    default:
      return "image.png";
  }
}

export function sanitizeTurnAttachmentName(
  value: string | undefined,
  fallback = "attachment",
): string {
  const baseName = path.basename(value?.trim() || fallback).replace(/[\0]/g, "");
  const sanitized = baseName
    .replace(/[^a-zA-Z0-9._@()+,= -]/g, "_")
    .slice(0, 160);
  return sanitized && sanitized !== "." && sanitized !== ".."
    ? sanitized
    : fallback;
}

async function cleanupOldTurnInputAttachments(
  root: string,
  excludedFiles: ReadonlySet<string>,
): Promise<void> {
  const cutoff = Date.now() - TURN_INPUT_ATTACHMENT_MAX_AGE_MS;
  const entries = await readdir(root).catch(() => []);
  await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(root, entry);
      const children = await readdir(entryPath).catch(() => []);
      if (children.some((child) => excludedFiles.has(path.join(entryPath, child)))) {
        return;
      }
      const info = await stat(entryPath).catch(() => undefined);
      if (info?.isDirectory() && info.mtimeMs < cutoff) {
        await rm(entryPath, { recursive: true, force: true }).catch(
          () => undefined,
        );
      }
    }),
  );
}
