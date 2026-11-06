const TOOL_WORKTREE_ROOT = /[\\/]\.(codex|pwrag(?:ent|nt))(?:[\\/]profiles[\\/][^\\/]+)?[\\/]worktrees[\\/][^\\/]+[\\/][^\\/]+/;

/** Whose worktree root a path is in. The first root in the path decides, so a
 * Codex worktree with a folder named `.pwragent` inside it is still Codex's. */
export function toolWorktreeRootOwner(value: string | undefined): "codex" | "pwragent" | undefined {
  if (!isToolManagedWorktreePath(value)) return undefined;
  const owner = TOOL_WORKTREE_ROOT.exec(value!)?.[1];
  return owner === undefined ? undefined : owner === "codex" ? "codex" : "pwragent";
}

export function isToolManagedWorktreePath(value: string | undefined): boolean {
  if (!value?.trim()) {
    return false;
  }

  return /[\\/]\.(?:codex|pwrag(?:ent|nt))(?:[\\/]profiles[\\/][^\\/]+)?[\\/]worktrees[\\/][^\\/]+[\\/][^\\/]+(?:[\\/].*)?$/.test(
    value,
  );
}
