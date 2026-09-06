import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

export type GitDirectoryObservation = {
  repository: boolean;
  relationship: string;
  head: string;
};

type FileState = Awaited<ReturnType<typeof fileState>>;

async function fileState(target: string) {
  try {
    const info = await stat(target, { bigint: true });
    // Directory mtimes change for ordinary edits, commits and sibling worktree
    // creation. Only replacement of the directory invalidates its identity.
    return {
      directory: info.isDirectory(),
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
export function createGitDirectoryObserver(): (
  cwd: string,
) => Promise<GitDirectoryObservation | undefined> {
  const files = new Map<string, { signature: string; value: string }>();
  async function pointer(target: string, state: FileState): Promise<string> {
    if (!state) {
      files.delete(target);
      return "";
    }
    if (files.get(target)?.signature === state.signature) {
      return files.get(target)!.value;
    }
    const value = await readFile(target, "utf8");
    if ((await fileState(target))?.signature !== state.signature) {
      throw new Error("Git pointer changed during directory observation");
    }
    files.set(target, { signature: state.signature, value });
    return value;
  }

  return async (cwd) => {
    const directory = await fileState(cwd);
    if (!directory?.directory) return undefined;
    const resolved = await realpath(cwd);
    let parent = cwd;
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
    const config = await fileState(path.join(commonDir, "config"));
    const worktreeConfig = await fileState(path.join(gitdir, "config.worktree"));
    const backlink = await fileState(path.join(gitdir, "gitdir"));
    const head = await fileState(path.join(gitdir, "HEAD"));
    if (!head || head.directory) return undefined;
    return {
      repository: true,
      relationship: JSON.stringify([
        resolved, directory.signature, dotGitPath, dotGit.signature, link,
        gitdir, admin.signature, common, commonInfo.signature,
        config?.signature, worktreeConfig?.signature, backlink?.signature,
      ]),
      head: head.signature,
    };
  };
}
