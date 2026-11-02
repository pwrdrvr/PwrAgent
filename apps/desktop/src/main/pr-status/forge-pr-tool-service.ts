import { ForgeReadError, repositoryKey, type ForgeRepository } from "./forge-tool-contract";
import { repositoryFromPr, resolveForgeRepositories, type ForgeReadScope } from "./forge-read-service";
import type { ForgePrToolContext } from "./forge-pr-tool-shared";
import type { ForgePrToolArgs, ForgePrToolOperation } from "./forge-pr-tool-contract";

export type ForgePrToolScope = Pick<ForgeReadScope, "remotes" | "attached" | "branch"> & {
  directories: string[];
  privateRoots: readonly string[];
};

/** What a call acts on, settled before the operator is asked. */
export type ForgePrToolPreparedCall = { repository: ForgeRepository; args: ForgePrToolArgs };

type ProviderClient = {
  execute(operation: ForgePrToolOperation, args: ForgePrToolArgs, ctx: ForgePrToolContext): Promise<unknown>;
  /** Whether a branch exists on the forge. Undefined when that cannot be told. */
  headBranchExists?(repository: ForgeRepository, head: string, signal?: AbortSignal): Promise<boolean | undefined>;
};

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
   * Settles what a call acts on before any approval card, so a call that
   * would fail is refused without asking. An approved pull request whose
   * head was never pushed fails at the forge, and the agent's retry asks
   * the operator a second time.
   */
  async prepare(operation: ForgePrToolOperation, args: ForgePrToolArgs, scope: ForgePrToolScope, signal?: AbortSignal): Promise<ForgePrToolPreparedCall> {
    const repository = this.resolveRepository(args, scope);
    if (operation === "create_pull_request" && args.head) {
      const exists = await this.options.clients[repository.provider].headBranchExists?.(repository, args.head, signal);
      if (exists === false) {
        throw new ForgeReadError("invalid_arguments", `Branch ${args.head} is not on ${repository.owner}/${repository.repo}. Push it, then open the pull request.`);
      }
    }
    return { repository, args };
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
