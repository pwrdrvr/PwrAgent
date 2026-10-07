import { lstat, mkdir, readFile, readdir, readlink, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import { unzipSync, zipSync } from "fflate";
import * as tar from "tar";
import type { ThreadHandoffPackage } from "@pwragent/shared";
import { decodeHandoffBytes, THREAD_HANDOFF_MAX_BYTES, validateHandoffRelativePath } from "./thread-handoff-package";

type WorkspaceArchive = NonNullable<ThreadHandoffPackage["workspace"]>;
const decompress = promisify(gunzip);
const MAX_ENTRIES = 100_000;

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Walk links as links. Never include bytes from an external target. */
export async function exportWorkspaceArchive(cwd: string, staging: string, targetPlatform: string): Promise<WorkspaceArchive> {
  const format = process.platform === "win32" || targetPlatform === "win32" ? "zip" : "tar.gz";
  const root = await realpath(cwd);
  const paths: string[] = [];
  const zipFiles: Record<string, Uint8Array> = Object.create(null);
  let size = 0;
  let skippedLinks = 0;
  let entryCount = 0;
  const walk = async (relative: string): Promise<void> => {
    const entries = await readdir(path.join(root, relative), { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const file = relative ? `${relative}/${entry.name}` : entry.name;
      validateHandoffRelativePath(file);
      if (++entryCount > MAX_ENTRIES) throw new Error("The non-Git workspace exceeds 100,000 entries.");
      const absolute = path.join(root, ...file.split("/"));
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) {
        const target = await readlink(absolute);
        const resolved = path.resolve(path.dirname(absolute), target);
        const canonical = await realpath(absolute).catch(() => resolved);
        if (format === "zip" || !inside(root, resolved) || !inside(root, canonical) || path.isAbsolute(target)) {
          skippedLinks++;
          continue;
        }
        paths.push(file);
      } else if (info.isDirectory()) {
        paths.push(file);
        if (format === "zip") zipFiles[`${file}/`] = new Uint8Array();
        await walk(file);
      } else if (info.isFile()) {
        size += info.size;
        if (size > THREAD_HANDOFF_MAX_BYTES) throw new Error("The non-Git workspace exceeds 128 MiB.");
        paths.push(file);
        if (format === "zip") {
          const bytes = await readFile(absolute);
          size += bytes.length - info.size;
          if (size > THREAD_HANDOFF_MAX_BYTES) throw new Error("The non-Git workspace exceeds 128 MiB.");
          zipFiles[file] = bytes;
        }
      } else {
        throw new Error(`Unsupported non-Git workspace entry: ${file}`);
      }
    }
  };
  await walk("");
  const archive = path.join(staging, `workspace.${format}`);
  let bytes: Buffer;
  if (format === "zip") {
    bytes = Buffer.from(zipSync(zipFiles));
  } else {
    await tar.c({ cwd: root, file: archive, gzip: true, portable: true, follow: false, noDirRecurse: true, strict: true }, paths.length ? paths : ["."]);
    bytes = await readFile(archive);
  }
  if (bytes.length > THREAD_HANDOFF_MAX_BYTES) throw new Error("The non-Git archive exceeds 128 MiB.");
  const warnings = format === "zip"
    ? ["ZIP workspaces do not transfer symlinks."]
    : ["Symlinks pointing outside the archived workspace are not transferred."];
  if (skippedLinks) warnings.push(`${skippedLinks} symlink(s) were omitted from the workspace archive.`);
  return { format, dataBase64: bytes.toString("base64"), warnings };
}

function validateArchiveEntries(entries: { path: string; directory: boolean; target?: string; hardlink?: boolean }[]): void {
  if (entries.length > MAX_ENTRIES) throw new Error("The workspace archive exceeds 100,000 entries.");
  const seen = new Map<string, boolean>();
  const key = (file: string) => process.platform === "win32" || process.platform === "darwin" ? file.toLowerCase() : file;
  for (const entry of entries) {
    validateHandoffRelativePath(entry.path);
    const normalized = key(entry.path);
    if (seen.has(normalized)) throw new Error("Duplicate or case-colliding archive paths.");
    seen.set(normalized, entry.directory);
    if (entry.target !== undefined) {
      if (!entry.target || entry.target.includes("\\") || path.posix.isAbsolute(entry.target) || /^[a-z]:/i.test(entry.target)) {
        throw new Error("Unsafe workspace archive link.");
      }
      const target = path.posix.normalize(entry.hardlink ? entry.target : path.posix.join(path.posix.dirname(entry.path), entry.target));
      if (target !== ".") validateHandoffRelativePath(target);
    }
  }
  for (const entry of entries) {
    const parts = key(entry.path).split("/");
    for (let length = 1; length < parts.length; length++) {
      if (seen.get(parts.slice(0, length).join("/")) === false) {
        throw new Error("An archive entry cannot be nested under a file or symlink.");
      }
    }
  }
}

/** Validate the full archive before writing any workspace entries. */
export async function importWorkspaceArchive(workspace: string, staging: string, archive: WorkspaceArchive): Promise<void> {
  const bytes = decodeHandoffBytes(archive.dataBase64);
  if (archive.format === "zip") {
    let size = 0;
    const files = unzipSync(bytes, { filter: (file) => {
      size += file.originalSize;
      if (size > THREAD_HANDOFF_MAX_BYTES) throw new Error("The expanded workspace exceeds 128 MiB.");
      return true;
    } });
    const entries = Object.keys(files).map((file) => ({ path: file.replace(/\/$/, ""), directory: file.endsWith("/") }));
    validateArchiveEntries(entries);
    for (const entry of entries) {
      const destination = path.join(workspace, ...entry.path.split("/"));
      if (entry.directory) {
        await mkdir(destination, { recursive: true });
      } else {
        await mkdir(path.dirname(destination), { recursive: true });
        await writeFile(destination, files[entry.path], { flag: "wx" });
      }
    }
    return;
  }
  const expanded = await decompress(bytes, { maxOutputLength: THREAD_HANDOFF_MAX_BYTES });
  const file = path.join(staging, "workspace.tar");
  await writeFile(file, expanded, { flag: "wx", mode: 0o600 });
  const entries: { path: string; directory: boolean; target?: string; hardlink?: boolean }[] = [];
  let unsupported = false;
  await tar.t({ file, strict: true, onReadEntry: (entry) => {
    if (entry.type === "Directory" && (entry.path === "." || entry.path === "./")) return;
    if (!["File", "Directory", "SymbolicLink", "Link"].includes(entry.type)) unsupported = true;
    entries.push({ path: entry.path.replace(/\/$/, ""), directory: entry.type === "Directory",
      ...(["SymbolicLink", "Link"].includes(entry.type) ? { target: entry.linkpath, hardlink: entry.type === "Link" } : {}) });
  } });
  if (unsupported) throw new Error("Unsupported workspace archive entry type.");
  validateArchiveEntries(entries);
  await tar.x({ file, cwd: workspace, strict: true, preservePaths: false });
}
