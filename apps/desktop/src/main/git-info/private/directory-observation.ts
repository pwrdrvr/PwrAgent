import { constants } from "node:fs";
import { lstat, open, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

const MAX_POINTER_BYTES = 1024 * 1024;

/** Bound both the file opened and the bytes read if a pointer is replaced. */
export async function readBoundedGitPointer(target: string): Promise<string> {
  const before = await stat(target);
  if (!before.isFile() || before.size > MAX_POINTER_BYTES) throw new Error("Unrecognized Git pointer");
  const file = await open(target, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const opened = await file.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      throw new Error("Git pointer changed before it was read");
    }
    const buffer = Buffer.alloc(before.size + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== before.size) throw new Error("Git pointer changed during read");
    return buffer.toString("utf8", 0, bytesRead);
  } finally {
    await file.close();
  }
}

export function parseGitPathPointer(contents: string): string | undefined {
  const value = contents.replace(/[\r\n]+$/, "");
  return value && !/[\r\n\0]/.test(value) ? value : undefined;
}

export function parseGitDirPointer(contents: string): string | undefined {
  return contents.startsWith("gitdir: ") ? parseGitPathPointer(contents.slice(8)) : undefined;
}

export function gitPointerTarget(parent: string, target: string): string {
  // Let the filesystem resolve symlinks before interpreting "..".
  return path.isAbsolute(target) ? target : parent + path.sep + target;
}

export type GitDirectoryObservation = {
  repository: boolean;
  relationship: string;
  head: string;
  checkoutRoot?: string;
  gitDirectory?: string;
  dotGitDirectory?: boolean;
  separateGitDirectory?: boolean;
  commonDirectory?: string;
  commonVersion?: string;
};

type FileState = Awaited<ReturnType<typeof fileState>>;

async function fileState(target: string, signal?: AbortSignal, followSymlinks = true) {
  signal?.throwIfAborted();
  try {
    const info = await (followSymlinks ? stat : lstat)(target, { bigint: true });
    // Directory mtimes change for ordinary edits, commits and sibling worktree
    // creation. Only replacement of the directory invalidates its identity.
    return {
      directory: info.isDirectory(),
      file: info.isFile(),
      device: info.dev,
      owner: info.uid,
      size: info.size,
      signature: [
        info.dev,
        info.ino,
        info.birthtimeNs,
        ...(info.isDirectory() ? [] : [info.size, info.mtimeNs, info.ctimeNs]),
      ].join(":"),
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw error;
  }
}

/**
 * On-demand filesystem evidence, never a timer or watcher. Tiny Git pointer
 * files are read only when their stat signature changes. This reads Git's
 * workspace metadata, never the coding harness's private storage.
 */
export function createGitDirectoryObserver(options: { navigation?: boolean; requireRegularHead?: boolean } = {}): (
  cwd: string,
  onCheckoutBoundary?: (root: string) => void,
  signal?: AbortSignal,
) => Promise<GitDirectoryObservation | undefined> {
  const files = new Map<string, { signature: string; value: string }>();
  async function pointer(target: string, state: FileState, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    if (!state) {
      files.delete(target);
      return "";
    }
    if (!state.file || state.size > MAX_POINTER_BYTES) {
      throw new Error("Unrecognized Git pointer");
    }
    if (files.get(target)?.signature === state.signature) {
      return files.get(target)!.value;
    }
    const value = options.navigation ? await readBoundedGitPointer(target) : await readFile(target, "utf8");
    if ((await fileState(target, signal))?.signature !== state.signature) {
      throw new Error("Git pointer changed during directory observation");
    }
    files.set(target, { signature: state.signature, value });
    if (files.size > 4_096) files.delete(files.keys().next().value!);
    return value;
  }

  async function isBareBoundary(directory: string, signal?: AbortSignal): Promise<boolean> {
    const headPath = path.join(directory, "HEAD");
    // For checkout reuse, even a dangling HEAD symlink can change Git's
    // discovery boundary. Leave any intervening HEAD entry to Git.
    if (options.requireRegularHead) return Boolean(await fileState(headPath, signal, false));
    const head = await fileState(headPath, signal);
    if (!head?.file) return false;
    const objects = await fileState(path.join(directory, "objects"), signal);
    const refs = await fileState(path.join(directory, "refs"), signal);
    if (!objects?.directory || !refs?.directory) return false;
    return /^(?:ref:\s*refs\/[^\s]+|[a-f0-9]{40}|[a-f0-9]{64})$/i.test((await pointer(headPath, head, signal)).trim());
  }

  return async (cwd, onCheckoutBoundary, signal) => {
    const observeFile = (target: string) => fileState(target, signal);
    const directory = await observeFile(cwd);
    if (!directory?.directory) return undefined;
    signal?.throwIfAborted();
    const resolved = await realpath(cwd);
    // Git discovers repositories from the physical directory. Walking the
    // alias's parents misses .git when cwd links to a repository subdirectory.
    let parent = resolved;
    let dotGit: FileState;
    let dotGitPath: string;
    const belowCheckout: string[] = [];
    const unversioned = () => ({
      repository: false,
      relationship: JSON.stringify([resolved, directory.signature, "unversioned"]),
      head: "",
    });
    for (;;) {
      dotGitPath = path.join(parent, ".git");
      dotGit = await observeFile(dotGitPath);
      if (dotGit) break;
      const next = path.dirname(parent);
      if (parent === next) return unversioned();
      // Git stops at a filesystem boundary unless an environment override
      // permits it. Navigation does not project directories under overrides.
      if (options.navigation && (await observeFile(next))?.device !== directory.device) return undefined;
      belowCheckout.push(parent);
      parent = next;
    }
    // A bare repository can stop Git before an enclosing .git entry. Paths
    // with no enclosing checkout already use the ordinary directory fallback.
    for (const directory of belowCheckout) {
      if (await isBareBoundary(directory, signal)) {
        return options.navigation && !options.requireRegularHead ? unversioned() : undefined;
      }
    }
    onCheckoutBoundary?.(parent);
    const link = dotGit.directory ? "" : await pointer(dotGitPath, dotGit, signal);
    const gitdirPointer = parseGitDirPointer(link);
    if (!dotGit.directory && !gitdirPointer) return undefined;
    const adminTarget = gitdirPointer ? gitPointerTarget(parent, gitdirPointer) : dotGitPath;
    const admin = await observeFile(adminTarget);
    if (!admin?.directory) return undefined;
    signal?.throwIfAborted();
    const gitdir = gitdirPointer ? await realpath(adminTarget) : dotGitPath;
    const commonPath = path.join(gitdir, "commondir");
    const commonState = await observeFile(commonPath);
    const common = parseGitPathPointer(await pointer(commonPath, commonState, signal));
    if (commonState && !common) return undefined;
    signal?.throwIfAborted();
    const commonDir = common ? await realpath(gitPointerTarget(adminTarget, common)) : gitdir;
    const commonInfo = await observeFile(commonDir);
    if (!commonInfo?.directory) return undefined;
    const configPath = path.join(commonDir, "config");
    const config = await observeFile(configPath);
    const worktreeConfig = await observeFile(path.join(gitdir, "config.worktree"));
    const backlink = await observeFile(path.join(gitdir, "gitdir"));
    // A reusable checkout identity must defer to Git for HEAD symlinks. The
    // same referent can outlive a literal target change that Git rejects.
    const head = await fileState(path.join(gitdir, "HEAD"), signal, !options.requireRegularHead);
    if (!head?.file) return undefined;
    if (options.navigation) {
      const owner = process.getuid?.();
      if (owner !== undefined && (dotGit.owner !== BigInt(owner)
        || admin.owner !== BigInt(owner) || (await observeFile(parent))?.owner !== BigInt(owner))) return undefined;
      const objects = await observeFile(path.join(commonDir, "objects"));
      const configText = await pointer(configPath, config, signal);
      // A layout hint cannot account for injected configuration, an external
      // work tree or a bare main repository. Leave those layouts to Git.
      if (!objects?.directory || worktreeConfig
        || configText.split(/\r?\n/).some((line) => {
          const entry = line.trim();
          return /^\[\s*include|^worktree\b/i.test(entry)
            || (/^bare\b/i.test(entry) && !/^bare\s*=\s*false$/i.test(entry));
        })) return undefined;
    }
    // Reftable's HEAD is a static compatibility file. Ref updates atomically
    // replace tables.list instead. Observe both stacks: linked worktrees own
    // their HEAD stack while ordinary refs live in the common directory.
    const refs = await observeFile(path.join(gitdir, "reftable", "tables.list"));
    const commonRefs = commonDir === gitdir
      ? refs
      : await observeFile(path.join(commonDir, "reftable", "tables.list"));
    if (refs?.directory || commonRefs?.directory) return undefined;
    return {
      repository: true,
      checkoutRoot: parent,
      gitDirectory: gitdir,
      dotGitDirectory: dotGit.directory,
      separateGitDirectory: !dotGit.directory && !commonState && !backlink,
      commonDirectory: commonDir,
      commonVersion: JSON.stringify([commonDir, commonInfo.signature, config?.signature]),
      relationship: JSON.stringify([
        resolved, directory.signature, dotGitPath, dotGit.signature, link,
        gitdir, admin.signature, common, commonState?.signature, commonInfo.signature,
        config?.signature, worktreeConfig?.signature, backlink?.signature,
      ]),
      // Ref table contents matter to branch enrichment, but refreshing refs
      // does not change the checkout identity used by the stack reader.
      head: JSON.stringify(options.requireRegularHead ? [head.signature] : [head.signature, refs?.signature, commonRefs?.signature]),
    };
  };
}
