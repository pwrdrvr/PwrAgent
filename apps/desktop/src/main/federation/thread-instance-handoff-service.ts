import { ThreadInstanceHandoffService as SharedHandoffService } from "@pwragent/federation/thread-instance-handoff-service";
import { createGitHandoffService } from "@pwragent/federation/git-instance-handoff";
import { runGitCommand } from "../app-server/git-executable";
import { computeWorktreePath, releaseWorktreePathReservation } from "../app-server/git-directory-service";
import { lockWorktreeOnSeparateVolume, unlockPwrAgentWorktreeLock } from "../app-server/worktree-volume-lock";
export { THREAD_HANDOFF_METHODS, THREAD_HANDOFF_RETRY_NOW_EVENT } from "@pwragent/federation/thread-instance-handoff-service";
export type { ImportInstanceThreadRequest, ThreadHandoffSendOptions } from "@pwragent/federation/thread-instance-handoff-service";

type Options = ConstructorParameters<typeof SharedHandoffService>[0];
export class ThreadInstanceHandoffService extends SharedHandoffService {
  constructor(options: Omit<Options, "git" | "runGitCommand" | "allocateWorktree" | "releaseWorktree">) {
    super({ ...options, git: lockingGitHandoffService(), runGitCommand,
      allocateWorktree: (repository) => computeWorktreePath({ repoRoot: repository, storage: "in-repo" }),
      releaseWorktree: releaseWorktreePathReservation });
  }
}

/**
 * The receiving worktree comes from allocateCodexWorktreePath, which can be
 * on the operator's worktree folder: lock it like every other worktree on
 * another drive, and clear that lock before a rollback removes it.
 */
function lockingGitHandoffService(): ReturnType<typeof createGitHandoffService> {
  const git = createGitHandoffService(runGitCommand);
  return {
    ...git,
    importGitHandoff: async (params) => {
      const rollback = await git.importGitHandoff(params);
      const runInRepository = (args: string[]) => runGitCommand(params.repository, args);
      await lockWorktreeOnSeparateVolume({ repoRoot: params.repository, worktreePath: params.worktree, git: runInRepository });
      return async () => {
        await unlockPwrAgentWorktreeLock({ worktreePath: params.worktree, git: runInRepository });
        await rollback();
      };
    },
  };
}
