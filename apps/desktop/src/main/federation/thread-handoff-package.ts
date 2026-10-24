import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { gzip, gunzip } from "node:zlib";
import type { AppServerThreadReplay, ThreadHandoffGitReference, ThreadHandoffPackage } from "@pwragent/shared";

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

export function validateHandoffRelativePath(file: string): void {
  if (typeof file !== "string" || !file || file.length > 4096
    || file.includes("\\") || file.includes("\0")
    || file.split("/").some((segment) => !segment || segment === "." || segment === ".." || segment.toLowerCase() === ".git")) {
    throw new Error("Unsafe handoff file path.");
  }
  if (process.platform === "win32" && file.split("/").some((segment) =>
      /[<>:"|?*]/.test(segment) || Array.from(segment).some((char) => char.charCodeAt(0) < 32) || /[. ]$/.test(segment)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment))) {
    throw new Error("A handoff filename is unsupported on Windows.");
  }
}

export function validateGitHandoffReference(value: ThreadHandoffGitReference): void {
  if (!value || typeof value.head !== "string" || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(value.head)
    || typeof value.ref !== "string" || !value.ref.startsWith("refs/heads/") || value.ref.length > 1024
    || /[\s~^:?*\[\\]/.test(value.ref) || value.ref.includes("..") || value.ref.includes("@{")
    || value.ref.split("/").some((part) => !part || part.startsWith(".") || part.endsWith(".lock") || part.endsWith("."))
    || typeof value.origin !== "string" || !value.origin || value.origin.length > 4096 || value.origin.includes("\0")
    || (value.sourceBranch !== undefined && (typeof value.sourceBranch !== "string" || value.sourceBranch.length > 1024))) {
    throw new Error("Invalid published Git handoff reference.");
  }
  if (value.cwdRelative !== undefined) validateHandoffRelativePath(value.cwdRelative);
}

export async function encodeThreadHandoff(value: ThreadHandoffPackage): Promise<Buffer> {
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > THREAD_HANDOFF_MAX_BYTES) throw new Error("The handoff package exceeds 128 MiB before compression.");
  return await compress(bytes);
}

export async function decodeThreadHandoff(bytes: Buffer): Promise<ThreadHandoffPackage> {
  if (bytes.length > THREAD_HANDOFF_MAX_BYTES) throw new Error("The compressed handoff exceeds 128 MiB.");
  const value = JSON.parse((await decompress(bytes, { maxOutputLength: THREAD_HANDOFF_MAX_BYTES })).toString("utf8")) as ThreadHandoffPackage;
  if (!value || value.version !== 2 || typeof value.handoffId !== "string" || !/^[0-9a-f-]{36}$/.test(value.handoffId)
    || typeof value.sourceThreadId !== "string" || !value.sourceThreadId
    || typeof value.historyDigest !== "string" || !/^[0-9a-f]{64}$/.test(value.historyDigest)
    || (value.title !== undefined && (typeof value.title !== "string" || value.title.length > 1000))) {
    throw new Error("Unsupported or invalid thread handoff package. Update PwrAgent on both machines and retry.");
  }
  if (!decodeHandoffBytes(value.rolloutBase64).length) throw new Error("Empty thread handoff history.");
  if (value.git !== undefined) {
    validateGitHandoffReference(value.git);
  }
  if (value.workspace !== undefined) {
    if (value.git || !value.workspace || !["tar.gz", "zip"].includes(value.workspace.format)
      || !Array.isArray(value.workspace.warnings) || value.workspace.warnings.length > 100
      || value.workspace.warnings.some((warning) => typeof warning !== "string" || warning.length > 2000)) {
      throw new Error("Invalid non-Git handoff workspace.");
    }
    decodeHandoffBytes(value.workspace.dataBase64);
  }
  return value;
}
