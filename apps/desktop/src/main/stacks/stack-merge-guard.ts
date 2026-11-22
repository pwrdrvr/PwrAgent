import type { GhStackCatalog } from "@pwragent/shared/stacks/catalog";
import { catalogMergeBlock } from "@pwragent/shared/stacks/stack-status";
import { ForgeReadError, type ForgeRepository } from "../pr-status/forge-tool-contract";

export function githubStackRepository(repository: ForgeRepository): string {
  return `${repository.host}:${repository.owner}/${repository.repo}`.toLowerCase();
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
}): Promise<void> {
  const { candidate } = input;
  for (const catalog of input.catalogs) {
    if (input.repository.provider !== "github" || catalog.repository.toLowerCase() !== githubStackRepository(input.repository)) continue;
    for (const stack of catalog.stacks) {
      const position = stack.branches.findIndex((branch) =>
        branch.pullRequest?.number === candidate.number
        || (!branch.pullRequest && candidate.fromRepository && branch.branch === candidate.head));
      if (position < 0) continue;
      const merged = new Set<number>();
      if (candidate.base === stack.trunk.branch) {
        for (const branch of stack.branches.slice(0, position)) {
          const number = branch.pullRequest?.number;
          if (!number || !(await input.readMerged(number))) break;
          merged.add(number);
        }
      }
      const block = catalogMergeBlock(stack, position, candidate.base, merged);
      if (block) throw new ForgeReadError("stack_parent_open", block);
    }
  }

  if (candidate.base && candidate.base !== candidate.defaultBranch) {
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
      const params = new URLSearchParams({ state: "all", head: `${repository.owner}:${branch}`, per_page: "100" });
      const parents = await get(`/pulls?${params}`) as GithubMergeRead[];
      return parents.find((pr) =>
        pr.head?.ref === branch && pr.head.repo?.full_name?.toLowerCase() === repo
        && (pr.state === "open" || (pr.merged_at && current.created_at && pr.merged_at >= current.created_at)))?.number;
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
