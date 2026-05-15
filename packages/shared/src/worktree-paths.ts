export function isToolManagedWorktreePath(value: string | undefined): boolean {
  if (!value?.trim()) {
    return false;
  }

  return /[\\/]\.(?:codex|pwrag(?:ent|nt))(?:[\\/]profiles[\\/][^\\/]+)?[\\/]worktrees[\\/][^\\/]+[\\/][^\\/]+(?:[\\/].*)?$/.test(
    value,
  );
}
