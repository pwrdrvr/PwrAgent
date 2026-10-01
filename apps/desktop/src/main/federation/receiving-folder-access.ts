import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ReceivingFolderResponse } from "../../shared/federation-receiving-folder";

export function resolveReceivingFolder(configured: string, downloads: string): string {
  const directory = configured.trim() || downloads;
  if (!path.isAbsolute(directory) || directory.includes("\0")) {
    throw new Error("Incoming files folder must be an absolute path.");
  }
  return directory;
}

export function receivingFolderError(error: unknown, directory: string, operation: string): Error {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (!code) return error instanceof Error ? error : new Error(String(error));
  const advice = code === "ENOSPC" || code === "EDQUOT"
    ? "Free disk space or choose another incoming files folder."
    : "In Settings → Federation → Capabilities, check the incoming files folder or use Browse to choose another folder."
      + (process.platform === "darwin" ? " You can also open Files & Folders to review macOS access; this error does not establish the privacy permission state." : " Check the folder’s permissions and whether the disk is writable.");
  return new Error(`Cannot ${operation} in incoming files folder "${directory}" (${code}). ${advice}`, { cause: error });
}

/** Test an existing folder using an exclusively created, private temporary file.
 * No mkdir, chmod, settings changes, or permission-database inspection. */
export async function checkReceivingFolder(directory: string): Promise<NonNullable<ReceivingFolderResponse["access"]>> {
  let probe: string | undefined;
  try {
    if (!(await fs.stat(directory)).isDirectory()) {
      return { status: "failed", message: "The incoming files path is not a folder. Use Browse to choose a folder." };
    }
    const candidate = path.join(directory, `.pwragent-access-check-${randomUUID()}`);
    const file = await fs.open(candidate, "wx", 0o600);
    probe = candidate;
    try {
      await file.writeFile("PwrAgent folder access check\n");
      await file.sync();
    } finally {
      await file.close();
    }
    await fs.readFile(probe);
    await fs.unlink(probe);
    probe = undefined;
    return { status: "writable", message: "Write check passed: PwrAgent created, read, and removed a temporary file. Access can change; this does not verify OS privacy permission or every transfer operation." };
  } catch (error) {
    let message = receivingFolderError(error, directory, "check access").message;
    if (probe) {
      try {
        await fs.unlink(probe);
      } catch {
        message += ` The temporary check file could not be removed: "${probe}".`;
      }
    }
    return { status: "failed", message };
  }
}
