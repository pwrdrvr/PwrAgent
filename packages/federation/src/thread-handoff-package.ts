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

// PWH3: magic, uint32 manifest length, UTF-8 manifest, gzip(raw rollout),
// raw workspace archive. Archives are already compressed and pass through once.
const HANDOFF_MAGIC = Buffer.from("PWH3");
const MAX_MANIFEST_BYTES = 64 * 1024;

export async function encodeThreadHandoff(value: ThreadHandoffPackage, binary = true): Promise<Buffer> {
  if (!binary) {
    const bytes = Buffer.from(JSON.stringify(value));
    if (bytes.length > THREAD_HANDOFF_MAX_BYTES) throw new Error("The handoff package exceeds 128 MiB before compression.");
    return await compress(bytes);
  }
  const { rolloutBase64, workspace, ...metadata } = value;
  const rollout = decodeHandoffBytes(rolloutBase64);
  const archive = workspace ? decodeHandoffBytes(workspace.dataBase64) : Buffer.alloc(0);
  if (rollout.length + archive.length > THREAD_HANDOFF_MAX_BYTES) throw new Error("The handoff package exceeds 128 MiB before compression.");
  const compressed = await compress(rollout);
  const manifest = Buffer.from(JSON.stringify({ ...metadata,
    rolloutBytes: compressed.length,
    ...(workspace ? { workspace: { format: workspace.format, warnings: workspace.warnings, sizeBytes: archive.length } } : {}),
  }));
  if (manifest.length > MAX_MANIFEST_BYTES) throw new Error("The handoff manifest is too large.");
  const prefix = Buffer.alloc(8);
  HANDOFF_MAGIC.copy(prefix);
  prefix.writeUInt32BE(manifest.length, 4);
  const bytes = Buffer.concat([prefix, manifest, compressed, archive]);
  if (bytes.length > THREAD_HANDOFF_MAX_BYTES) throw new Error("The compressed handoff exceeds 128 MiB.");
  return bytes;
}

export async function decodeThreadHandoff(bytes: Buffer): Promise<ThreadHandoffPackage> {
  if (bytes.length > THREAD_HANDOFF_MAX_BYTES) throw new Error("The compressed handoff exceeds 128 MiB.");
  let value: ThreadHandoffPackage;
  if (bytes.subarray(0, 4).equals(HANDOFF_MAGIC)) {
    if (bytes.length < 8) throw new Error("Truncated handoff prefix.");
    const length = bytes.readUInt32BE(4);
    if (length > MAX_MANIFEST_BYTES || 8 + length > bytes.length) throw new Error("Invalid handoff manifest length.");
    const manifest = JSON.parse(bytes.subarray(8, 8 + length).toString("utf8"));
    const start = 8 + length;
    if (!Number.isSafeInteger(manifest.rolloutBytes) || manifest.rolloutBytes < 1
      || start + manifest.rolloutBytes > bytes.length
      || (manifest.workspace && (!Number.isSafeInteger(manifest.workspace.sizeBytes) || manifest.workspace.sizeBytes < 0))
      || start + manifest.rolloutBytes + (manifest.workspace?.sizeBytes ?? 0) !== bytes.length) {
      throw new Error("Invalid handoff section lengths.");
    }
    const archive = bytes.subarray(start + manifest.rolloutBytes);
    const rollout = await decompress(bytes.subarray(start, start + manifest.rolloutBytes), {
      maxOutputLength: THREAD_HANDOFF_MAX_BYTES - archive.length,
    });
    value = { ...manifest, rolloutBase64: rollout.toString("base64"),
      ...(manifest.workspace ? { workspace: { ...manifest.workspace, dataBase64: archive.toString("base64") } } : {}),
    };
    delete (value as unknown as Record<string, unknown>).rolloutBytes;
    if (value.workspace) delete (value.workspace as unknown as Record<string, unknown>).sizeBytes;
  } else {
    value = JSON.parse((await decompress(bytes, { maxOutputLength: THREAD_HANDOFF_MAX_BYTES })).toString("utf8")) as ThreadHandoffPackage;
  }
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
