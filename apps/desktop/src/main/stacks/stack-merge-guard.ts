import type { GhStackCatalog } from "@pwragent/shared/stacks/catalog";
import type { PrSummary } from "@pwragent/shared/contracts/navigation";
import { catalogMergeBlock } from "@pwragent/shared/stacks/stack-status";
import { ForgeReadError, type ForgeRepository } from "../pr-status/forge-tool-contract";
import { githubStackBlock, readGithubStackParents, type GithubStackGraphql, type GithubStackPull } from "./github-stack-evidence";

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
  findParent?: (branch: string) => Promise<number | undefined>;
  findLayer?: (branch: string, bases: readonly string[]) => Promise<number | undefined>;
  observeLower?: (number: number) => void;
  checkInferred?: () => Promise<void>;
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
      for (const branch of checked.slice(0, position)) {
        if (branch.pullRequest) input.observeLower?.(branch.pullRequest.number);
      }
      const merged = new Set<number>();
      if (candidate.base === stack.trunk.branch) {
        for (let index = 0; index < position; index++) {
          const branch = checked[index]!;
          const parent = checked[index - 1]?.branch ?? stack.trunk.branch;
          const number = branch.pullRequest?.number ?? await input.findLayer?.(branch.branch, [parent, stack.trunk.branch]);
          if (!number) break;
          input.observeLower?.(number);
          checked[index] = { ...branch, pullRequest: { number } };
          if (!(await input.readMerged(number))) break;
          merged.add(number);
        }
      }
      const block = catalogMergeBlock({ ...stack, branches: checked }, position, candidate.base, merged);
      if (block) throw new ForgeReadError("stack_parent_open", block);
    }
  }

  if (matched) return;
  if (input.checkInferred) await input.checkInferred();
  else if (candidate.base && candidate.base !== candidate.defaultBranch) {
    const parent = await input.findParent?.(candidate.base);
    if (parent !== undefined && parent !== candidate.number) {
      throw new ForgeReadError("stack_parent_open", `This pull request targets ${candidate.base}, the head of layer #${parent}. Wait for lower layers to merge, then retarget this pull request to trunk.`);
    }
  }
}

/** A pull request in one of GitHub's own stacks, which merges only through the asynchronous merge API. */
export type GithubNativeStack = {
  number: number;
  position: number;
  size: number;
  /** Every pull request in the stack, bottom first, when its member list was read. */
  layers?: Array<{ number: number; open: boolean }>;
};

type GithubNativeStackLayer = { number?: number; state?: string; merged_at?: string | null };

/**
 * GitHub merges a stacked pull request together with every open layer below
 * it. One merge must land one pull request, so refuse while a lower layer is
 * open. Returns the stack, or undefined for a pull request outside one.
 *
 * The pull request read every merge already makes carries the membership, so
 * a pull request outside a stack, or at its bottom, costs no request here.
 * Only a higher layer reads the stack: GitHub would land its open layers.
 * `readLayers` reads it for any layer: a stack PwrAgent only learned of when
 * GitHub refused a merge is read whole, so its result names every member.
 */
export async function assertGithubNativeStackMergeAllowed(
  number: number,
  pull: GithubStackPull,
  get: (route: string) => Promise<unknown>,
  observeLower?: (number: number) => void,
  options: { readLayers?: boolean } = {},
): Promise<GithubNativeStack | undefined> {
  const stack = pull?.stack;
  if (!stack) return undefined;
  const unreadable = () => new ForgeReadError("stack_parent_open",
    `Could not read the GitHub stack of pull request #${number}. Confirm its lower layers have merged, then retry.`);
  if (!Number.isInteger(stack.number) || !Number.isInteger(stack.position) || !Number.isInteger(stack.size)
    || stack.position! < 1 || stack.position! > stack.size!) throw unreadable();
  const known = { number: stack.number!, position: stack.position!, size: stack.size! };
  if (known.position === 1 && !options.readLayers) return known;
  let layers: GithubNativeStackLayer[] | undefined;
  try {
    layers = (await get(`/stacks/${stack.number}`) as { pull_requests?: GithubNativeStackLayer[] } | undefined)?.pull_requests;
  } catch (error) {
    if (error instanceof ForgeReadError && error.code === "not_found") throw unreadable();
    throw error;
  }
  const index = layers?.findIndex((layer) => layer?.number === number) ?? -1;
  if (!layers || index < 0) throw unreadable();
  const lower = layers.slice(0, index);
  for (const layer of lower) {
    if (layer.number) observeLower?.(layer.number);
  }
  const open = lower.filter((layer) => !layer.merged_at && layer.state !== "closed");
  if (open.length) {
    const named = open.map((layer) => `#${layer.number}`).join(", ");
    throw new ForgeReadError("stack_parent_open", `Pull request #${number} is layer ${index + 1} of ${layers.length} in a GitHub stack, and ${named} below it ${open.length === 1 ? "is" : "are"} still open. GitHub would merge ${open.length === 1 ? "it" : "them"} too: merge ${named} first.`);
  }
  return {
    ...known, position: index + 1, size: layers.length,
    layers: layers.flatMap((layer) => Number.isSafeInteger(layer.number) && layer.number! > 0
      ? [{ number: layer.number!, open: !layer.merged_at && layer.state !== "closed" }] : []),
  };
}

/** Said after merging one layer of a GitHub stack while layers above it stay open. */
export function githubStackLayersAboveNote(number: number, stack: GithubNativeStack | undefined): string | undefined {
  if (!stack || stack.position >= stack.size) return undefined;
  const lead = `#${number} was layer ${stack.position} of ${stack.size} in a GitHub stack`;
  if (stack.layers) {
    const open = stack.layers.slice(stack.position).filter((layer) => layer.open && layer.number !== number);
    if (!open.length) return undefined;
    const named = open.map((layer) => `#${layer.number}`).join(", ");
    return `${lead}: ${named} above it ${open.length === 1 ? "is" : "are"} still open.`;
  }
  const above = stack.size - stack.position;
  return `${lead}: the ${above === 1 ? "layer" : `${above} layers`} above it ${above === 1 ? "is" : "are"} still open.`;
}

export type GithubStackMergeCheck = { base: string; headSha?: string; nativeStack?: GithubNativeStack };

export async function assertGithubStackMergeAllowed(
  repository: ForgeRepository,
  number: number,
  catalogs: readonly GhStackCatalog[],
  get: (route: string) => Promise<unknown>,
  graphql: GithubStackGraphql,
  observeLower?: (number: number) => void,
): Promise<string> {
  return (await checkGithubStackMerge(repository, number, catalogs, get, graphql, observeLower)).base;
}

/** The stack-order check, plus what a merge needs to know: whether GitHub stacks the pull request itself. */
export async function checkGithubStackMerge(
  repository: ForgeRepository,
  number: number,
  catalogs: readonly GhStackCatalog[],
  get: (route: string) => Promise<unknown>,
  graphql: GithubStackGraphql,
  observeLower?: (number: number) => void,
  options: { readLayers?: boolean } = {},
): Promise<GithubStackMergeCheck> {
  const current = await get(`/pulls/${number}`) as GithubStackPull;
  const base = current?.base?.ref;
  if (!base) throw new ForgeReadError("unavailable", `Could not confirm the base of pull request #${number}.`);
  const nativeStack = await assertGithubNativeStackMergeAllowed(number, current, get, observeLower, options);
  const repo = `${repository.owner}/${repository.repo}`.toLowerCase();
  const fromBranch = async (branch: string) => {
    const params = new URLSearchParams({ state: "all", head: `${repository.owner}:${branch}`, per_page: "100" });
    const parents = await get(`/pulls?${params}`) as GithubStackPull[];
    return parents.filter((pr) => pr.head?.ref === branch && pr.head.repo?.full_name?.toLowerCase() === repo);
  };
  await assertStackMergeAllowed({
    repository, catalogs,
    observeLower,
    candidate: { number, base, head: current.head?.ref, fromRepository: current.head?.repo?.full_name?.toLowerCase() === repo },
    readMerged: async (parent) => {
      try {
        return (await get(`/pulls/${parent}`) as GithubStackPull)?.merged === true;
      } catch (error) {
        if (error instanceof ForgeReadError && error.code === "not_found") return false;
        throw error;
      }
    },
    findLayer: async (branch, bases) => {
      const candidates = (await fromBranch(branch)).filter((pr) => pr.base?.ref && bases.includes(pr.base.ref)
        && (pr.state === "open" || pr.merged_at));
      return candidates.length === 1 ? candidates[0]?.number : undefined;
    },
    checkInferred: async () => {
      const evidence = await readGithubStackParents({ repository, child: current, number, get, graphql });
      for (const parent of evidence.parents) observeLower?.(parent.number);
      const block = githubStackBlock(number, base, evidence);
      if (block) throw block;
    },
  });
  return { base, ...(current.head?.sha ? { headSha: current.head.sha } : {}), ...(nativeStack ? { nativeStack } : {}) };
}

/** A retarget can leave the head SHA unchanged. The queue read must agree with the guard. */
export function assertStackMergeBaseUnchanged(checked: string, current: string | undefined): void {
  if (current !== checked) {
    throw new ForgeReadError("stack_parent_open", "The pull request base changed while checking stack order. Read it again before merging.");
  }
}
