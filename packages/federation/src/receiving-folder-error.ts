export function receivingFolderError(error: unknown, directory: string, operation: string): Error {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (!code) return error instanceof Error ? error : new Error(String(error));
  const advice = code === "ENOSPC" || code === "EDQUOT"
    ? "Free disk space or choose another incoming files folder."
    : "In Settings → Federation → Capabilities, check the incoming files folder or use Browse to choose another folder."
      + (process.platform === "darwin" ? " You can also open Files & Folders to review macOS access; this error does not establish the privacy permission state." : " Check the folder’s permissions and whether the disk is writable.");
  return new Error(`Cannot ${operation} in incoming files folder "${directory}" (${code}). ${advice}`, { cause: error });
}

