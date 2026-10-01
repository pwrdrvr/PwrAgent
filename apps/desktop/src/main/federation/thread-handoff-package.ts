import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { gzip, gunzip } from "node:zlib";
import type { AppServerThreadReplay, ThreadHandoffPackage } from "@pwragent/shared";

export const THREAD_HANDOFF_MAX_BYTES = 128 * 1024 * 1024;
const compress = promisify(gzip);
const decompress = promisify(gunzip);

export function threadHistoryDigest(replay: AppServerThreadReplay): string {
  const messages = replay.messages.map((message) => ({
    role: message.role,
    text: message.text,
    parts: message.parts?.map((part) => part.type === "text"
      ? { type: "text", text: part.text }
      : part.type === "image"
        ? { type: "image", alt: part.alt ?? "", url: part.url }
        : { type: "file", mimeType: part.mimeType ?? "", name: part.name, sizeBytes: part.sizeBytes ?? 0 }),
  }));
  return createHash("sha256").update(JSON.stringify(messages)).digest("hex");
}

export function decodeHandoffBytes(value: unknown): Buffer {
  if (typeof value !== "string" || value.length > Math.ceil(THREAD_HANDOFF_MAX_BYTES / 3) * 4) {
    throw new Error("Invalid handoff file size.");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) throw new Error("Invalid handoff file encoding.");
  return bytes;
}

export function validateHandoffFilePaths(files: NonNullable<ThreadHandoffPackage["git"]>["files"]): void {
  if (!Array.isArray(files) || files.length > 100_000) throw new Error("Invalid handoff file list.");
  const seen = new Set<string>();
  for (const file of files) {
    if (!file || typeof file.path !== "string" || !file.path
      || file.path.includes("\\") || file.path.includes("\0")
      || file.path.split("/").some((segment) => !segment || segment === "." || segment === ".." || segment.toLowerCase() === ".git")
      || (file.mode !== "100644" && file.mode !== "100755")) {
      throw new Error("Unsafe handoff file path or mode.");
    }
    if (process.platform === "win32" && file.path.split("/").some((segment) =>
      /[<>:"|?*]/.test(segment) || Array.from(segment).some((char) => char.charCodeAt(0) < 32) || /[. ]$/.test(segment)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment))) {
      throw new Error("A handoff filename is unsupported on Windows.");
    }
    const key = process.platform === "win32" || process.platform === "darwin" ? file.path.toLowerCase() : file.path;
    if (seen.has(key)) throw new Error("Duplicate or case-colliding handoff file paths.");
    seen.add(key);
    decodeHandoffBytes(file.dataBase64);
  }
}

export async function encodeThreadHandoff(value: ThreadHandoffPackage): Promise<Buffer> {
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > THREAD_HANDOFF_MAX_BYTES) throw new Error("The handoff package exceeds 128 MiB before compression.");
  return await compress(bytes);
}

export async function decodeThreadHandoff(bytes: Buffer): Promise<ThreadHandoffPackage> {
  if (bytes.length > THREAD_HANDOFF_MAX_BYTES) throw new Error("The compressed handoff exceeds 128 MiB.");
  const value = JSON.parse((await decompress(bytes, { maxOutputLength: THREAD_HANDOFF_MAX_BYTES })).toString("utf8")) as ThreadHandoffPackage;
  if (!value || value.version !== 1 || typeof value.handoffId !== "string" || !/^[0-9a-f-]{36}$/.test(value.handoffId)
    || typeof value.sourceThreadId !== "string" || !value.sourceThreadId
    || typeof value.historyDigest !== "string" || !/^[0-9a-f]{64}$/.test(value.historyDigest)
    || (value.title !== undefined && (typeof value.title !== "string" || value.title.length > 1000))) {
    throw new Error("Unsupported or invalid thread handoff package.");
  }
  if (!decodeHandoffBytes(value.rolloutBase64).length) throw new Error("Empty thread handoff history.");
  if (value.git !== undefined) {
    if (!value.git || ![value.git.head, value.git.indexCommit, value.git.workingCommit].every((oid) => typeof oid === "string" && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(oid))) {
      throw new Error("Invalid Git handoff object IDs.");
    }
    decodeHandoffBytes(value.git.bundleBase64);
    validateHandoffFilePaths(value.git.files);
    if (value.git.cwdRelative !== undefined) validateHandoffFilePaths([{ path: value.git.cwdRelative, mode: "100644", dataBase64: "" }]);
  }
  return value;
}
