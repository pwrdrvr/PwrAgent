import type { GhStackCatalog } from "@pwragent/shared/stacks/catalog";
import type { PrSummary } from "@pwragent/shared/contracts/navigation";
import { catalogMergeBlock } from "@pwragent/shared/stacks/stack-status";
import { ForgeReadError, type ForgeRepository } from "../pr-status/forge-tool-contract";

export function githubStackRepository(repository: ForgeRepository): string {
  return `${repository.host}:${repository.owner}/${repository.repo}`.toLowerCase();
}

export function isObservedStackParent(parent: PrSummary, child: PrSummary): boolean {
  const repo = (pr: { provider: string; org: string; repo: string }) => `${pr.provider}:${pr.org}/${pr.repo}`.toLowerCase();
  return parent.number !== child.number && parent.headRefName !== undefined && parent.headRefName === child.baseRefName
    && repo(parent) === repo(child) && (!parent.sourceRepository || repo(parent.sourceRepository) === repo(child))
    && (parent.lifecycleState === "open" || (parent.lifecycleState === "merged"
      && parent.mergedAt !== undefined && child.createdAt !== undefined && parent.mergedAt >= child.createdAt));
}

type MergeCandidate = {
  number: number;
  head?: string;
  base?: string;
  defaultBranch?: string;
  fromRepository?: boolean;
};

export async function assertStackMergeAllowed(input: {
  repository: ForgeRepository;
  catalogs: readonly GhStackCatalog[];
  candidate: MergeCandidate;
  readMerged: (number: number) => Promise<boolean>;
  findParent: (branch: string) => Promise<number | undefined>;
  findLayer?: (branch: string, bases: readonly string[]) => Promise<number | undefined>;
}): Promise<void> {
  const { candidate } = input;
  let matched = false;
  for (const catalog of input.catalogs) {
    if (input.repository.provider !== "github" || catalog.repository.toLowerCase() !== githubStackRepository(input.repository)) continue;
    for (const stack of catalog.stacks) {
      const position = stack.branches.findIndex((branch) =>
        branch.pullRequest?.number === candidate.number
        || (!branch.pullRequest && candidate.fromRepository && branch.branch === candidate.head));
      if (position < 0) continue;
      matched = true;
      const checked = [...stack.branches];
      const merged = new Set<number>();
      if (candidate.base === stack.trunk.branch) {
        for (let index = 0; index < position; index++) {
          const branch = checked[index]!;
          const parent = checked[index - 1]?.branch ?? stack.trunk.branch;
          const number = branch.pullRequest?.number ?? await input.findLayer?.(branch.branch, [parent, stack.trunk.branch]);
          if (!number || !(await input.readMerged(number))) break;
          checked[index] = { ...branch, pullRequest: { number } };
          merged.add(number);
        }
      }
      const block = catalogMergeBlock({ ...stack, branches: checked }, position, candidate.base, merged);
      if (block) throw new ForgeReadError("stack_parent_open", block);
    }
  }

  if (!matched && candidate.base && candidate.base !== candidate.defaultBranch) {
    const parent = await input.findParent(candidate.base);
    if (parent !== undefined && parent !== candidate.number) {
      throw new ForgeReadError("stack_parent_open", `This pull request targets ${candidate.base}, the head of layer #${parent}. Wait for lower layers to merge, then retarget this pull request to trunk.`);
    }
  }
}

type GithubMergeRead = {
  state?: string;
  number?: number;
  merged?: boolean;
  merged_at?: string;
  created_at?: string;
  head?: { ref?: string; repo?: { full_name?: string } };
  base?: { ref?: string; repo?: { default_branch?: string } };
};

export async function assertGithubStackMergeAllowed(
  repository: ForgeRepository,
  number: number,
  catalogs: readonly GhStackCatalog[],
  get: (route: string) => Promise<unknown>,
): Promise<string> {
  const current = await get(`/pulls/${number}`) as GithubMergeRead;
  const base = current?.base?.ref;
  if (!base) throw new ForgeReadError("unavailable", `Could not confirm the base of pull request #${number}.`);
  const repo = `${repository.owner}/${repository.repo}`.toLowerCase();
  const fromBranch = async (branch: string) => {
    const params = new URLSearchParams({ state: "all", head: `${repository.owner}:${branch}`, per_page: "100" });
    const parents = await get(`/pulls?${params}`) as GithubMergeRead[];
    return parents.filter((pr) => pr.head?.ref === branch && pr.head.repo?.full_name?.toLowerCase() === repo);
  };
  await assertStackMergeAllowed({
    repository, catalogs,
    candidate: { number, base, head: current.head?.ref, defaultBranch: current.base?.repo?.default_branch, fromRepository: current.head?.repo?.full_name?.toLowerCase() === repo },
    readMerged: async (parent) => {
      try {
        return (await get(`/pulls/${parent}`) as GithubMergeRead)?.merged === true;
      } catch (error) {
        if (error instanceof ForgeReadError && error.code === "not_found") return false;
        throw error;
      }
    },
    findParent: async (branch) => {
      return (await fromBranch(branch)).find((pr) => pr.state === "open"
        || (pr.merged_at && current.created_at && pr.merged_at >= current.created_at))?.number;
    },
    findLayer: async (branch, bases) => {
      const candidates = (await fromBranch(branch)).filter((pr) => pr.base?.ref && bases.includes(pr.base.ref)
        && (pr.state === "open" || pr.merged_at));
      return candidates.length === 1 ? candidates[0]?.number : undefined;
    },
  });
  return base;
}

/** A retarget can leave the head SHA unchanged. The queue read must agree with the guard. */
export function assertStackMergeBaseUnchanged(checked: string, current: string | undefined): void {
  if (current !== checked) {
    throw new ForgeReadError("stack_parent_open", "The pull request base changed while checking stack order. Read it again before merging.");
  }
}
