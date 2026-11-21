import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import {
  isToolManagedWorktreePath,
  setConfiguredWorktreeFolder,
  toolWorktreeRootOwner,
} from "../worktree-paths";

afterEach(() => setConfiguredWorktreeFolder(undefined));

const segment = fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9_-]{0,7}$/).filter((value) => value !== "codex");

/**
 * Rule: with a worktree folder configured, a path is a worktree exactly when
 * it is `<folder>/<hash>/<project>` (PwrAgent's) or
 * `<folder>/codex/<hash>/<project>` (Codex's), or anything inside one. The
 * folder itself, a hash folder, a hidden entry, and a sibling folder sharing
 * the folder's name as a prefix are not. Paths under the tool roots
 * (`.pwragent/worktrees`, `.codex/worktrees`) are recognized with or without
 * the folder. Windows folders compare without case and either separator.
 */
describe("worktree path recognition", () => {
  it("recognizes exactly the worktrees in the configured folder", () => {
    fc.assert(fc.property(
      fc.boolean(),
      fc.array(segment, { minLength: 1, maxLength: 3 }),
      segment,
      segment,
      fc.array(segment, { maxLength: 2 }),
      fc.boolean(),
      (windows, folderParts, hash, project, inside, configured) => {
        const sep = windows ? "\\" : "/";
        const folder = windows ? `D:\\${folderParts.join("\\")}` : `/Volumes/${folderParts.join("/")}`;
        const join = (...parts: string[]) => parts.join(sep);
        setConfiguredWorktreeFolder(configured ? `${folder}${sep}` : undefined);
        // Windows paths may arrive with forward slashes and the folder in another case.
        const spell = (value: string) => windows
          ? (value.startsWith(folder) ? folder.toUpperCase() + value.slice(folder.length) : value).replace(/\\/g, "/")
          : value;

        const cases: Array<[string, "codex" | "pwragent" | undefined]> = [
          [join(folder, hash, project, ...inside), configured ? "pwragent" : undefined],
          [join(folder, "codex", hash, project, ...inside), configured ? "codex" : undefined],
          [folder, undefined],
          [join(folder, hash), undefined],
          [join(folder, "codex"), undefined],
          [join(folder, "codex", hash), undefined],
          [join(folder, `.${hash}`, project), undefined],
          [join(`${folder}-other`, hash, project), undefined],
          [join(folder, ".pwragent", "worktrees", hash, project), "pwragent"],
          [join(windows ? "C:\\Users\\me" : "/Users/me", ".codex", "worktrees", hash, project), "codex"],
        ];
        for (const [value, owner] of cases) {
          for (const spelled of [value, spell(value)]) {
            expect(toolWorktreeRootOwner(spelled), spelled).toBe(owner);
            expect(isToolManagedWorktreePath(spelled), spelled).toBe(owner !== undefined);
          }
        }
      },
    ), { numRuns: 200 });
  });
});
