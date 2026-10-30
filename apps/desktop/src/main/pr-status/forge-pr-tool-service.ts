import { ForgeReadError, repositoryKey, type ForgeRepository } from "./forge-tool-contract";
import { repositoryFromPr, resolveForgeRepositories, type ForgeReadScope } from "./forge-read-service";
import type { ForgePrToolContext } from "./forge-pr-tool-shared";
import type { ForgePrToolArgs, ForgePrToolOperation } from "./forge-pr-tool-contract";

export type ForgePrToolScope = Pick<ForgeReadScope, "remotes" | "attached" | "branch"> & {
  directories: string[];
  privateRoots: readonly string[];
};

type ProviderClient = { execute(operation: ForgePrToolOperation, args: ForgePrToolArgs, ctx: ForgePrToolContext): Promise<unknown> };

/** Picks the one GitHub or GitLab repository a call acts in, then runs it with that provider's client. */
export class ForgePrToolService {
  constructor(private readonly options: {
    enabled: (provider: ForgeRepository["provider"]) => boolean;
    clients: Record<ForgeRepository["provider"], ProviderClient>;
    defaultMergeMethod: ForgePrToolContext["defaultMergeMethod"];
    assertCanMerge?: ForgePrToolContext["assertCanMerge"];
  }) {}

  /** The repository a call would act in. Used before an approval prompt, so the card can name it. */
  resolveRepository(args: Pick<ForgePrToolArgs, "repository">, scope: ForgePrToolScope): ForgeRepository {
    const candidates = resolveForgeRepositories({ repository: args.repository }, scope);
    if (candidates.length !== 1) throw new ForgeReadError("ambiguous_repository", `Select repository from: ${candidates.map(repositoryKey).join(", ")}.`);
    const repository = candidates[0]!;
    if (!this.options.enabled(repository.provider)) throw new ForgeReadError("provider_disabled", `${repository.provider === "github" ? "GitHub" : "GitLab"} is disabled in Settings → Git.`);
    return repository;
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
      privateRoots: scope.privateRoots, defaultMergeMethod: this.options.defaultMergeMethod, assertCanMerge: this.options.assertCanMerge, signal,
    });
  }
}
