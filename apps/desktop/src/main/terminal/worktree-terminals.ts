import type { IntegratedTerminalService } from "./integrated-terminal-service";

let owner: Pick<IntegratedTerminalService, "withWorktreeClosed"> | undefined;

export function registerWorktreeTerminalOwner(service: Pick<IntegratedTerminalService, "withWorktreeClosed">): () => void {
  owner = service;
  return () => { if (owner === service) owner = undefined; };
}

export async function withWorktreeTerminalsClosed<T>(worktreePath: string, work: () => Promise<T>): Promise<T> {
  return owner ? await owner.withWorktreeClosed(worktreePath, work) : await work();
}
