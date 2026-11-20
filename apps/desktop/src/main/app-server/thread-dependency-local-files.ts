import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { ThreadDependencyLocalFile } from "@pwragent/shared";
import { nativeRelayPath } from "../native-relay-path";

export const LOCAL_FILE_CHECK_INTERVAL_MS = 30_000;

const runProbe = promisify(execFile);
const WINDOWS_FILESYSTEM_ROOT = /^\\\\\?\\(?:[a-z]:\\|Volume\{[\da-f-]{36}\}\\|UNC\\[^\\/:]+\\[^\\/:]+\\)/i;

function markerPathParts(filename: string): [root: string, relative: string] {
  if (process.platform === "win32") {
    // Reject drive-relative, device and dot-component paths before passing a
    // volume or share root to Win32. The helper validates each relative name.
    if (path.isAbsolute(filename) && path.parse(filename).root.length > 1
      && !filename.split(/[\\/]/).some((name) => name === "." || name === "..")) {
      const namespaced = path.toNamespacedPath(filename);
      const root = WINDOWS_FILESYSTEM_ROOT.exec(namespaced)?.[0];
      if (root) return [root, namespaced.slice(root.length)];
    }
  } else if (filename.startsWith("/")) {
    return ["/", filename.slice(1)];
  }
  throw new Error("The watcher marker path is unsafe.");
}

async function authorizePath(filename: string, workspace: string): Promise<string> {
  if (!path.isAbsolute(filename)) throw new Error("Use an absolute watcher marker path in the waiting thread's workspace.");
  const name = path.basename(filename);
  if (!name || name === "." || name === "..") throw new Error("The watcher marker path is unsafe.");
  const parent = await realpath(path.dirname(filename));
  const relative = path.relative(workspace, parent);
  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new Error("The watcher marker must be inside the waiting thread's workspace.");
  }
  return path.join(parent, name);
}

/** Canonicalize the existing parent of an authorized marker that may not exist yet. */
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
  const parts = markerPathParts(filename);
  try {
    const { stdout } = await runProbe(nativeRelayPath(), ["--local-file-marker", ...parts], {
      env: process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {},
      maxBuffer: 1024,
      timeout: 10_000,
      windowsHide: true,
    });
    const value = stdout.trim();
    const mtime = Number(value);
    if (value && Number.isFinite(mtime)) return mtime >= since;
  } catch (error) {
    // Native exit status 2 means a missing or nonregular marker. An absent
    // executable has a string error code and is a failed inspection.
    const code = (error as { code?: number | string }).code;
    if (code === 2) return false;
    if (code === 3) throw new Error("The watcher marker directory changed.");
  }
  throw new Error("The watcher marker metadata could not be verified.");
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
