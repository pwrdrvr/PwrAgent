import { ForgeReadError, repositoryKey, type ForgeRepository } from "./forge-tool-contract";
import { repositoryFromPr, resolveForgeRepositories, type ForgeReadScope } from "./forge-read-service";
import type { GithubToolClient, GithubToolContext } from "./github-tool-client";
import type { GithubToolArgs, GithubToolOperation } from "./github-tool-contract";

export type GithubToolScope = Pick<ForgeReadScope, "remotes" | "attached" | "branch"> & {
  directories: string[];
  privateRoots: readonly string[];
};

/** Picks the one GitHub repository a call acts in, then runs it. */
export class GithubToolService {
  constructor(private readonly options: {
    enabled: (provider: ForgeRepository["provider"]) => boolean;
    client: Pick<GithubToolClient, "execute">;
    defaultMergeMethod: GithubToolContext["defaultMergeMethod"];
  }) {}

  async execute(operation: GithubToolOperation, args: GithubToolArgs, scope: GithubToolScope, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    const linked = resolveForgeRepositories({ repository: args.repository }, scope);
    // A thread can link a GitLab remote too; without an explicit choice, act only on GitHub ones.
    const candidates = args.repository ? linked : linked.filter((r) => r.provider === "github");
    if (!candidates.length || candidates[0]!.provider !== "github") {
      throw new ForgeReadError("unsupported_provider", "These tools support GitHub and GitHub Enterprise. This thread's repository is not on GitHub; the CI read tools also cover GitLab.");
    }
    if (candidates.length !== 1) throw new ForgeReadError("ambiguous_repository", `Select repository from: ${candidates.map(repositoryKey).join(", ")}.`);
    const repository = candidates[0]!;
    if (!this.options.enabled("github")) throw new ForgeReadError("provider_disabled", "GitHub is disabled in Settings → Git.");
    const attached = scope.attached.flatMap((pr) => {
      const r = repositoryFromPr(pr.url);
      return r && repositoryKey(r) === repositoryKey(repository) && Number.isSafeInteger(pr.number) ? [{ number: pr.number, headRefName: pr.headRefName }] : [];
    });
    return await this.options.client.execute(operation, args, {
      repository, branch: scope.branch, directories: scope.directories, attached,
      privateRoots: scope.privateRoots, defaultMergeMethod: this.options.defaultMergeMethod, signal,
    });
  }
}
