import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const MAIN_ROOT = fileURLToPath(new URL("../", import.meta.url));
const HELPER = path.join("app-server", "managed-worktree.ts");
const LOCKS = path.join("app-server", "worktree-volume-lock.ts");

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
    const offenders: string[] = [];
    for (const file of sourceFiles(MAIN_ROOT)) {
      const relative = path.relative(MAIN_ROOT, file);
      const source = readFileSync(file, "utf8");
      if (relative !== HELPER && /"worktree"\s*,\s*"(add|remove)"/.test(source)) {
        offenders.push(`${relative}: raw git worktree add/remove`);
      }
      if (relative !== HELPER && relative !== LOCKS
        && (/"worktree"\s*,\s*"(lock|unlock)"/.test(source)
          || /\b(lockWorktreeOnSeparateVolume|unlockPwrAgentWorktreeLock)\b/.test(source))) {
        offenders.push(`${relative}: drive lock handled outside the helper`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
