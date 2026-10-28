import { ThreadInstanceHandoffService as SharedHandoffService } from "@pwragent/federation/thread-instance-handoff-service";
import { createGitHandoffService } from "@pwragent/federation/git-instance-handoff";
import { runGitCommand } from "../app-server/git-executable";
import { computeWorktreePath, releaseWorktreePathReservation } from "../app-server/git-directory-service";
export { THREAD_HANDOFF_METHODS } from "@pwragent/federation/thread-instance-handoff-service";
export type { ImportInstanceThreadRequest } from "@pwragent/federation/thread-instance-handoff-service";

type Options = ConstructorParameters<typeof SharedHandoffService>[0];
export class ThreadInstanceHandoffService extends SharedHandoffService {
  constructor(options: Omit<Options, "git" | "runGitCommand" | "allocateWorktree" | "releaseWorktree">) {
    super({ ...options, git: createGitHandoffService(runGitCommand), runGitCommand,
      allocateWorktree: (repository) => computeWorktreePath({ repoRoot: repository, storage: "in-repo" }),
      releaseWorktree: releaseWorktreePathReservation });
  }
}
