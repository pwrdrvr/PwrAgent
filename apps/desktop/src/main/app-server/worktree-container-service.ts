import { lstat, readdir, realpath, rmdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type WorktreeContainerCleanup = {
  worktreePath: string;
  containerPath: string;
  removed: boolean;
  skippedReason?: string;
  error?: string;
  identity?: { dev: number; ino: number };
};

/** Removes only the empty id directory directly below the selected Codex
 * worktree root. Never removes a checkout, follows a container symlink, climbs
 * to a grandparent, or uses recursive deletion. */
export class WorktreeContainerService {
  private readonly root: string;
  private canonicalRoot?: string;

  constructor(options: { codexHome?: string } = {}) {
    this.root = path.resolve(options.codexHome?.trim() || process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex"), "worktrees");
  }

  async containerPath(worktreePath: string): Promise<string | undefined> {
    const container = path.dirname(path.resolve(worktreePath));
    const parent = path.dirname(container);
    try {
      const root = await realpath(this.root);
      this.canonicalRoot = root;
      if (parent !== this.root && parent !== root) return undefined;
      // Canonicalize the root, not the id itself: following an id symlink
      // would defeat the ordinary-directory check in inspect/prune.
      return path.join(root, path.basename(container));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  comparisonPaths(containerPath: string): string[] {
    return path.dirname(containerPath) === this.canonicalRoot
      ? [containerPath, path.join(this.root, path.basename(containerPath))]
      : [containerPath];
  }

  worktreeComparisonPaths(worktreePath: string): string[] {
    const resolved = path.resolve(worktreePath);
    const container = path.dirname(resolved);
    const parent = path.dirname(container);
    return this.canonicalRoot && (parent === this.root || parent === this.canonicalRoot)
      ? this.comparisonPaths(path.join(this.canonicalRoot, path.basename(container))).map((value) => path.join(value, path.basename(resolved)))
      : [resolved];
  }

  async inspect(worktreePath: string): Promise<WorktreeContainerCleanup | undefined> {
    let result: WorktreeContainerCleanup = { worktreePath, containerPath: path.dirname(path.resolve(worktreePath)), removed: false };
    try {
      const containerPath = await this.containerPath(worktreePath);
      if (!containerPath) return undefined;
      result = { ...result, containerPath };
      const container = await lstat(containerPath);
      if (!container.isDirectory() || container.isSymbolicLink()) {
        return { ...result, skippedReason: "Container is not an ordinary directory." };
      }
      result = { ...result, identity: { dev: container.dev, ino: container.ino } };
      const root = await realpath(this.root);
      if (path.dirname(await realpath(containerPath)) !== root) {
        return { ...result, skippedReason: "Container is outside the selected worktree root." };
      }
      if ((await readdir(containerPath)).length > 0) {
        return { ...result, skippedReason: "Container is not empty." };
      }
      // A direct empty container implies its checkout is gone. No stat of a
      // possibly dangling checkout symlink, and no inspection of private data.
      return result;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { ...result, skippedReason: "Container no longer exists." };
      }
      return { ...result, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async prune(worktreePath: string, assertCurrent?: () => void, expectedIdentity?: WorktreeContainerCleanup["identity"]): Promise<WorktreeContainerCleanup | undefined> {
    let result = { worktreePath, containerPath: path.dirname(path.resolve(worktreePath)), removed: false };
    try {
      const containerPath = await this.containerPath(worktreePath);
      if (!containerPath) return undefined;
      result = { ...result, containerPath };
      const before = await lstat(containerPath);
      if (expectedIdentity && (before.dev !== expectedIdentity.dev || before.ino !== expectedIdentity.ino)) {
        return { ...result, skippedReason: "Container identity changed since discovery." };
      }
      const root = await realpath(this.root);
      const inspection = await this.inspect(worktreePath);
      if (!inspection || inspection.skippedReason || inspection.error) return inspection;
      const current = await lstat(containerPath);
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== before.dev || current.ino !== before.ino
        || await realpath(this.root) !== root || path.dirname(await realpath(containerPath)) !== root) {
        return { ...result, skippedReason: "Container identity changed before removal." };
      }
      assertCurrent?.();
      // rmdir checks emptiness at the syscall, including content created after
      // inspection. A symlink swapped in during inspection is never followed.
      await rmdir(result.containerPath);
      return { ...result, removed: true };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTEMPTY" || code === "EEXIST" || code === "ENOTDIR") {
        return { ...result, skippedReason: "Container disappeared or changed before removal." };
      }
      return { ...result, error: error instanceof Error ? error.message : String(error) };
    }
  }
}
