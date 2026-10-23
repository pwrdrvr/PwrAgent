type WorktreeTerminalOwner = {
  withWorktreeClosed<T>(worktreePath: string, work: () => Promise<T>, assertCurrent?: () => void): Promise<T>;
};

let owner: WorktreeTerminalOwner | undefined;

export function registerWorktreeTerminalOwner(service: WorktreeTerminalOwner): () => void {
  owner = service;
  return () => { if (owner === service) owner = undefined; };
}

export async function withWorktreeTerminalsClosed<T>(worktreePath: string, work: () => Promise<T>, assertCurrent?: () => void): Promise<T> {
  return owner ? await owner.withWorktreeClosed(worktreePath, work, assertCurrent) : await work();
}
