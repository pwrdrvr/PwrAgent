import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const MAIN_ROOT = fileURLToPath(new URL("../", import.meta.url));
const HELPER = path.join("app-server", "managed-worktree.ts");
const LOCKS = path.join("app-server", "worktree-volume-lock.ts");
/**
 * A Git argument array whose command is `worktree` (after any `-C dir`,
 * `-c key=value`, or spread prefix) with anything but a literal `"list"`
 * next: add, remove, lock, unlock, or a subcommand passed as a variable.
 */
const GIT_WORKTREE_WRITE = /\[\s*(?:(?:\.\.\.[\w.]+|"-[\w-]+"|[\w.]+)\s*,\s*)*"worktree"\s*,(?!\s*"list")/;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" ? [] : sourceFiles(target);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [target] : [];
  });
}

/**
 * Rule: the desktop main process creates and removes worktrees only through
 * managed-worktree.ts, which applies the drive lock after every add and
 * clears it before every remove. A raw `git worktree add` elsewhere leaves a
 * worktree on another drive unlocked (a prune while the drive is unplugged
 * deletes its records); a raw remove fails on PwrAgent's own lock.
 */
describe("managed worktree guard", () => {
  it("keeps every worktree add, remove, lock, and unlock in the managed-worktree helper", () => {
    // The pattern itself: written-out and variable subcommands count; list and plain values do not.
    for (const form of ['["worktree", "add", p]', '[...HOOKS, "worktree", ...args]', '["-C", repo, "worktree", action]']) {
      expect(GIT_WORKTREE_WRITE.test(form), form).toBe(true);
    }
    for (const form of ['["worktree", "list", "--porcelain"]', '{ kind: "worktree", label }']) {
      expect(GIT_WORKTREE_WRITE.test(form), form).toBe(false);
    }

    const offenders: string[] = [];
    for (const file of sourceFiles(MAIN_ROOT)) {
      const relative = path.relative(MAIN_ROOT, file);
      const source = readFileSync(file, "utf8");
      if (relative === HELPER || relative === LOCKS) continue;
      if (GIT_WORKTREE_WRITE.test(source)) {
        offenders.push(`${relative}: git worktree command other than list`);
      }
      if (/\b(lockWorktreeOnSeparateVolume|unlockPwrAgentWorktreeLock)\b/.test(source)) {
        offenders.push(`${relative}: drive lock handled outside the helper`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
