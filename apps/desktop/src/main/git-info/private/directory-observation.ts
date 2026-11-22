import { constants } from "node:fs";
import { open, readFile, realpath, stat } from "node:fs/promises";
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

export type GitDirectoryObservation = {
  repository: boolean;
  relationship: string;
  head: string;
  checkoutRoot?: string;
  gitDirectory?: string;
  dotGitDirectory?: boolean;
  commonDirectory?: string;
  commonVersion?: string;
};

type FileState = Awaited<ReturnType<typeof fileState>>;

async function fileState(target: string) {
  try {
    const info = await stat(target, { bigint: true });
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
export function createGitDirectoryObserver(options: { navigation?: boolean } = {}): (
  cwd: string,
) => Promise<GitDirectoryObservation | undefined> {
  const files = new Map<string, { signature: string; value: string }>();
  async function pointer(target: string, state: FileState): Promise<string> {
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
    if ((await fileState(target))?.signature !== state.signature) {
      throw new Error("Git pointer changed during directory observation");
    }
    files.set(target, { signature: state.signature, value });
    if (files.size > 4_096) files.delete(files.keys().next().value!);
    return value;
  }

  return async (cwd) => {
    const directory = await fileState(cwd);
    if (!directory?.directory) return undefined;
    const resolved = await realpath(cwd);
    // Git discovers repositories from the physical directory. Walking the
    // alias's parents misses .git when cwd links to a repository subdirectory.
    let parent = resolved;
    let dotGit: FileState;
    let dotGitPath: string;
    for (;;) {
      dotGitPath = path.join(parent, ".git");
      dotGit = await fileState(dotGitPath);
      if (dotGit) break;
      const next = path.dirname(parent);
      if (parent === next) {
        return {
          repository: false,
          relationship: JSON.stringify([resolved, directory.signature, "unversioned"]),
          head: "",
        };
      }
      // Git stops at a filesystem boundary unless an environment override
      // permits it. Navigation does not project directories under overrides.
      if (options.navigation && (await fileState(next))?.device !== directory.device) return undefined;
      parent = next;
    }
    const link = dotGit.directory ? "" : await pointer(dotGitPath, dotGit);
    const gitdirMatch = link.match(/^gitdir:\s*(.+?)\s*$/m);
    if (!dotGit.directory && !gitdirMatch) return undefined;
    const gitdir = gitdirMatch ? path.resolve(parent, gitdirMatch[1]) : dotGitPath;
    const admin = await fileState(gitdir);
    if (!admin?.directory) return undefined;
    const commonPath = path.join(gitdir, "commondir");
    const commonState = await fileState(commonPath);
    const common = (await pointer(commonPath, commonState)).trim();
    const commonDir = common ? path.resolve(gitdir, common) : gitdir;
    const commonInfo = await fileState(commonDir);
    if (!commonInfo?.directory) return undefined;
    const configPath = path.join(commonDir, "config");
    const config = await fileState(configPath);
    const worktreeConfig = await fileState(path.join(gitdir, "config.worktree"));
    const backlink = await fileState(path.join(gitdir, "gitdir"));
    const head = await fileState(path.join(gitdir, "HEAD"));
    if (!head?.file) return undefined;
    if (options.navigation) {
      const owner = process.getuid?.();
      if (owner !== undefined && (dotGit.owner !== BigInt(owner)
        || admin.owner !== BigInt(owner) || (await fileState(parent))?.owner !== BigInt(owner))) return undefined;
      const [objects, configText] = await Promise.all([
        fileState(path.join(commonDir, "objects")),
        pointer(configPath, config),
      ]);
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
    const refs = await fileState(path.join(gitdir, "reftable", "tables.list"));
    const commonRefs = commonDir === gitdir
      ? refs
      : await fileState(path.join(commonDir, "reftable", "tables.list"));
    if (refs?.directory || commonRefs?.directory) return undefined;
    return {
      repository: true,
      checkoutRoot: parent,
      gitDirectory: gitdir,
      dotGitDirectory: dotGit.directory,
      commonDirectory: commonDir,
      commonVersion: JSON.stringify([commonDir, commonInfo.signature, config?.signature]),
      relationship: JSON.stringify([
        resolved, directory.signature, dotGitPath, dotGit.signature, link,
        gitdir, admin.signature, common, commonInfo.signature,
        config?.signature, worktreeConfig?.signature, backlink?.signature,
      ]),
      head: JSON.stringify([head.signature, refs?.signature, commonRefs?.signature]),
    };
  };
}
