import { createHash } from "node:crypto";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AppServerFileInputItem } from "@pwragent/shared";

const CODEX_FILE_INPUT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

type CodexFileInputDependencies = {
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
  rm: (
    filePath: string,
    options: { recursive?: boolean; force?: boolean },
  ) => Promise<unknown>;
};

const defaultDependencies: CodexFileInputDependencies = {
  now: () => Date.now(),
  resolveRoot: () => path.join(tmpdir(), "pwragent-codex-attachments"),
  writeFile: (filePath, data) => writeFile(filePath, data),
  mkdir: (dirPath, options) => mkdir(dirPath, options),
  readdir: (dirPath) => readdir(dirPath),
  stat: (filePath) => stat(filePath),
  rm: (filePath, options) => rm(filePath, options),
};

export async function persistCodexFileInput(
  file: AppServerFileInputItem,
  dependencies: Partial<CodexFileInputDependencies> = {},
): Promise<string> {
  const deps = { ...defaultDependencies, ...dependencies };
  const data = Buffer.from(file.data, "base64");
  const root = deps.resolveRoot();
  const digest = createHash("sha256").update(data).digest("hex");
  const filePath = path.join(root, digest, sanitizeAttachmentFileName(file.name));
  await deps.mkdir(path.dirname(filePath), { recursive: true });
  await deps.writeFile(filePath, data);

  void cleanupOldCodexFileInputs(
    root,
    deps,
    new Set([filePath]),
  ).catch(() => undefined);

  return filePath;
}

function sanitizeAttachmentFileName(value: string): string {
  const baseName = path.basename(value).replace(/[\0]/g, "");
  const sanitized = baseName.replace(/[^a-zA-Z0-9._@()+,= -]/g, "_").slice(0, 160);
  return sanitized && sanitized !== "." && sanitized !== ".." ? sanitized : "attachment";
}

async function cleanupOldCodexFileInputs(
  root: string,
  deps: CodexFileInputDependencies,
  excludedFilePaths: ReadonlySet<string>,
): Promise<void> {
  const cutoff = deps.now() - CODEX_FILE_INPUT_MAX_AGE_MS;
  const entries = await deps.readdir(root).catch(() => []);
  await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(root, entry);
      if (isExcludedCodexFileInputPath(entryPath, excludedFilePaths)) {
        return;
      }
      const info = await deps.stat(entryPath).catch(() => undefined);
      if (!info || info.mtimeMs >= cutoff) {
        return;
      }
      if (
        info.isDirectory?.()
        && await containsFreshCodexFileInput(
          entryPath,
          deps,
          cutoff,
          excludedFilePaths,
        )
      ) {
        return;
      }
      if (!info.isFile() && !info.isDirectory?.()) {
        return;
      }
      await deps.rm(entryPath, { recursive: true, force: true }).catch(() => undefined);
    }),
  );
}

async function containsFreshCodexFileInput(
  dirPath: string,
  deps: CodexFileInputDependencies,
  cutoff: number,
  excludedFilePaths: ReadonlySet<string>,
): Promise<boolean> {
  const entries = await deps.readdir(dirPath).catch(() => undefined);
  if (!entries) {
    return true;
  }

  for (const entry of entries) {
    const childPath = path.join(dirPath, entry);
    if (isExcludedCodexFileInputPath(childPath, excludedFilePaths)) {
      return true;
    }
    const info = await deps.stat(childPath).catch(() => undefined);
    if (info?.isFile() && info.mtimeMs >= cutoff) {
      return true;
    }
  }

  return false;
}

function isExcludedCodexFileInputPath(
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
