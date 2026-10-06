import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import {
  isAppServerBackendKind,
  type AppServerThreadSummary,
  type ReadMarkdownFileResponse,
} from "@pwragent/shared";

import type { DesktopBackendRegistry } from "../app-server/backend-registry";

export const FILE_PULL_MARKDOWN_METHOD = "file.pull.markdown";
export const FILE_PULL_MAX_BYTES = 2 * 1024 * 1024;

type Options = {
  permissions: () => { filePull: boolean; filePullOutsideThreadDirectories: boolean };
  resolveThread: (backend: AppServerThreadSummary["source"], threadId: string) => Promise<AppServerThreadSummary | undefined>;
};

/** Resolve ownership for both current and archived threads. Refresh the archive
 * on a miss so archiving a thread does not break an already-open file viewer. */
export async function resolveFilePullThread(
  registry: Pick<DesktopBackendRegistry, "resolveThread" | "listThreads">,
  backend: AppServerThreadSummary["source"],
  threadId: string,
): Promise<AppServerThreadSummary | undefined> {
  const thread = await registry.resolveThread({ backend, threadId });
  if (thread) return thread;
  const archivedThreads = await registry.listThreads({
    backend,
    archived: true,
    forceRefresh: true,
    enrichDirectories: false,
    callerReason: "federation-file-pull",
  });
  return archivedThreads.find((candidate) => candidate.source === backend && candidate.id === threadId);
}

/** Owner-side authorization. Paths and directory membership supplied by the
 * viewer are never trusted. Reads are bounded and create no persistent copy. */
export class FederationFilePullReader {
  private active = 0;

  constructor(private readonly options: Options) {}

  async readMarkdown(input: unknown): Promise<ReadMarkdownFileResponse> {
    if (this.active >= 4) throw new Error("File pull is busy. Try again.");
    this.active++;
    try {
      return await this.read(input);
    } finally {
      this.active--;
    }
  }

  private async read(input: unknown): Promise<ReadMarkdownFileResponse> {
    const permissions = { ...this.options.permissions() };
    if (!permissions.filePull) throw new Error("File pull is disabled on the owning machine. Enable Allow file pull in its Federation settings.");
    const request = input as { path?: unknown; thread?: { backend?: unknown; threadId?: unknown } } | null;
    if (!request || typeof request.path !== "string" || !path.isAbsolute(request.path)
      || request.path.includes("\0") || !/\.(md|markdown|json)$/i.test(request.path)) {
      throw new Error("Select an absolute Markdown or JSON file path.");
    }
    const identity = request.thread;
    if (!identity || typeof identity.backend !== "string" || !isAppServerBackendKind(identity.backend)
      || typeof identity.threadId !== "string" || !identity.threadId) {
      throw new Error("File pull requires an owning thread.");
    }
    const thread = await this.options.resolveThread(identity.backend, identity.threadId);
    if (!thread) throw new Error("File pull thread was not found on the owning machine.");
    const target = await realpath(request.path);
    if (!permissions.filePullOutsideThreadDirectories) {
      const directories = thread.linkedDirectories.flatMap((directory) =>
        [directory.path, directory.worktreePath]);
      if (thread.projectKey) directories.push(thread.projectKey);
      const roots = await Promise.all(directories.filter((directory): directory is string =>
        Boolean(directory && path.isAbsolute(directory)))
        .map((directory) => realpath(directory).catch(() => undefined)));
      if (!roots.some((root) => root && isWithin(root, target))) {
        throw new Error("File is outside the thread’s directories. The owning machine has not allowed file pull outside thread directories.");
      }
    }
    // NOFOLLOW rejects a substituted final symlink; NONBLOCK prevents special
    // files such as FIFOs from hanging before the regular-file check.
    const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await file.stat();
      if (!before.isFile()) throw new Error("File pull requires a regular file.");
      if (before.size > FILE_PULL_MAX_BYTES) throw new Error("File is too large to preview (maximum 2 MiB).");
      const buffer = Buffer.alloc(FILE_PULL_MAX_BYTES + 1);
      let size = 0;
      while (size < buffer.length) {
        const { bytesRead } = await file.read(buffer, size, buffer.length - size, size);
        if (!bytesRead) break;
        size += bytesRead;
      }
      const after = await file.stat();
      const currentPath = await stat(target);
      if (size > FILE_PULL_MAX_BYTES || size !== before.size || after.size !== before.size
        || after.mtimeMs !== before.mtimeMs || currentPath.dev !== before.dev || currentPath.ino !== before.ino
        || await realpath(request.path) !== target || await realpath(target) !== target) {
        throw new Error("File changed during pull. Try again.");
      }
      const current = this.options.permissions();
      if (!current.filePull || (permissions.filePullOutsideThreadDirectories && !current.filePullOutsideThreadDirectories)) {
        throw new Error("File pull permissions changed. Try again.");
      }
      return { path: request.path, content: buffer.subarray(0, size).toString("utf8") };
    } finally {
      await file.close();
    }
  }
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
