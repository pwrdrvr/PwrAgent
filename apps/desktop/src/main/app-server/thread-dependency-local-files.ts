import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import type { ThreadDependencyLocalFile } from "@pwragent/shared";

export const LOCAL_FILE_CHECK_INTERVAL_MS = 30_000;

async function authorizePath(filename: string, workspace: string): Promise<string> {
  if (!path.isAbsolute(filename)) throw new Error("Use an absolute watcher marker path in the waiting thread's workspace.");
  const parent = await realpath(path.dirname(filename));
  const relative = path.relative(workspace, parent);
  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new Error("The watcher marker must be inside the waiting thread's workspace.");
  }
  return path.join(parent, path.basename(filename));
}

/** Pin the existing directory of an authorized marker, which may not exist yet. */
export async function authorizeLocalFile(
  cwd: string | undefined,
  file: ThreadDependencyLocalFile,
): Promise<ThreadDependencyLocalFile> {
  if (!cwd || !path.isAbsolute(cwd)) throw new Error("The waiting thread needs a local workspace.");
  const workspace = await realpath(cwd);
  return {
    path: await authorizePath(file.path, workspace),
    since: file.since,
    ...(file.exitPath ? { exitPath: await authorizePath(file.exitPath, workspace) } : {}),
  };
}

async function markerReady(filename: string, since: number): Promise<boolean> {
  try {
    const parent = path.dirname(filename);
    if (await realpath(parent) !== parent) throw new Error("The watcher marker directory changed.");
    // Check metadata only. Symlinks, directories and special files are not results.
    const info = await lstat(filename);
    return info.isFile() && info.mtimeMs >= since;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function readLocalFile(file: ThreadDependencyLocalFile): Promise<"result" | "exited" | undefined> {
  if (await markerReady(file.path, file.since)) return "result";
  if (file.exitPath && await markerReady(file.exitPath, file.since)) {
    // A result may have been committed between the first probe and command exit.
    return await markerReady(file.path, file.since) ? "result" : "exited";
  }
  return undefined;
}

/** Polls only while there are active registrations and never overlaps a check. */
export class LocalFilePoller {
  private timer?: NodeJS.Timeout;
  private checking = false;
  private disposed = false;

  constructor(private readonly options: {
    hasPending: () => boolean;
    check: () => Promise<void>;
    onError: (error: unknown) => void;
  }) {}

  sync(delay = LOCAL_FILE_CHECK_INTERVAL_MS): void {
    if (this.disposed || this.checking) return;
    if (!this.options.hasPending()) {
      this.clear();
      return;
    }
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      this.checking = true;
      void this.options.check().catch(this.options.onError).finally(() => {
        this.checking = false;
        this.sync();
      });
    }, delay);
    this.timer.unref();
  }

  dispose(): void {
    this.disposed = true;
    this.clear();
  }

  private clear(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
