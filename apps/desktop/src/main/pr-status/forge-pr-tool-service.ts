import { ForgeReadError, repositoryKey, type ForgeRepository } from "./forge-tool-contract";
import { repositoryFromPr, resolveForgeRepositories, sameRepository, type ForgeReadScope } from "./forge-read-service";
import { readCheckedOutBranch, readForgeRepositoryRemotes } from "./git-remote";
import type { ForgePrToolContext } from "./forge-pr-tool-shared";
import type { ForgePrToolArgs, ForgePrToolOperation } from "./forge-pr-tool-contract";

export type ForgePrToolScope = Pick<ForgeReadScope, "remotes" | "attached" | "branch"> & {
  directories: string[];
  privateRoots: readonly string[];
  /**
   * The branch checked out now in the thread's directories for one repository.
   * Thread metadata can lag a branch the agent made during the turn.
   */
  readCheckedOutBranch?: (repository: ForgeRepository) => Promise<string | undefined>;
};

/** What a call acts on, settled before the operator is asked. */
export type ForgePrToolPreparedCall = { repository: ForgeRepository; args: ForgePrToolArgs };

/**
 * The branch checked out in the directories whose remotes name `repository`.
 * Undefined when HEAD is detached, git fails, or the directories disagree.
 */
export async function readCheckedOutBranchForRepository(directories: readonly string[], repository: ForgeRepository): Promise<string | undefined> {
  const branches = new Set<string>();
  await Promise.all(directories.map(async (cwd) => {
    const remotes = await readForgeRepositoryRemotes(cwd);
    if (!remotes.some((remote) => sameRepository(remote, repository))) return;
    const branch = await readCheckedOutBranch(cwd);
    if (branch) branches.add(branch);
  }));
  return branches.size === 1 ? [...branches][0] : undefined;
}

type ProviderClient = { execute(operation: ForgePrToolOperation, args: ForgePrToolArgs, ctx: ForgePrToolContext): Promise<unknown> };

/** Picks the one GitHub or GitLab repository a call acts in, then runs it with that provider's client. */
export class ForgePrToolService {
  constructor(private readonly options: {
    enabled: (provider: ForgeRepository["provider"]) => boolean;
    clients: Record<ForgeRepository["provider"], ProviderClient>;
    defaultMergeMethod: ForgePrToolContext["defaultMergeMethod"];
  }) {}

  /** The repository a call would act in. Used before an approval prompt, so the card can name it. */
  resolveRepository(args: Pick<ForgePrToolArgs, "repository">, scope: ForgePrToolScope): ForgeRepository {
    const candidates = resolveForgeRepositories({ repository: args.repository }, scope);
    if (candidates.length !== 1) throw new ForgeReadError("ambiguous_repository", `Select repository from: ${candidates.map(repositoryKey).join(", ")}.`);
    const repository = candidates[0]!;
    if (!this.options.enabled(repository.provider)) throw new ForgeReadError("provider_disabled", `${repository.provider === "github" ? "GitHub" : "GitLab"} is disabled in Settings → Git.`);
    return repository;
  }

  /**
   * Settles the repository and the pull request head before any approval
   * card, so a call that would fail is refused without asking and the card
   * names the branch it opens from.
   */
  async prepare(operation: ForgePrToolOperation, args: ForgePrToolArgs, scope: ForgePrToolScope): Promise<ForgePrToolPreparedCall> {
    const repository = this.resolveRepository(args, scope);
    if (operation !== "create_pull_request" || args.head) return { repository, args };
    const head = await scope.readCheckedOutBranch?.(repository) ?? scope.branch;
    if (!head || head === "HEAD") throw new ForgeReadError("invalid_arguments", "Pass head: this thread has no checked-out branch. Push the branch first.");
    return { repository, args: { ...args, head } };
  }

  async execute(operation: ForgePrToolOperation, args: ForgePrToolArgs, scope: ForgePrToolScope, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    const repository = this.resolveRepository(args, scope);
    const attached = scope.attached.flatMap((pr) => {
      const r = repositoryFromPr(pr.url);
      return r && repositoryKey(r) === repositoryKey(repository) && Number.isSafeInteger(pr.number) ? [{ number: pr.number, headRefName: pr.headRefName }] : [];
    });
    return await this.options.clients[repository.provider].execute(operation, args, {
      repository, branch: scope.branch, directories: scope.directories, attached,
      privateRoots: scope.privateRoots, defaultMergeMethod: this.options.defaultMergeMethod, signal,
    });
  }
}
