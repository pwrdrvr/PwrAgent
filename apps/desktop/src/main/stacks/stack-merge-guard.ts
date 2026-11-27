import type { GhStackCatalog } from "@pwragent/shared/stacks/catalog";
import type { PrSummary } from "@pwragent/shared/contracts/navigation";
import { catalogMergeBlock } from "@pwragent/shared/stacks/stack-status";
import { ForgeReadError, type ForgeRepository } from "../pr-status/forge-tool-contract";
import { githubStackBlock, readGithubStackParents, type GithubStackGraphql, type GithubStackPull } from "./github-stack-evidence";
import { parseGithubForgeStack, recordGithubForgeStack } from "./github-forge-stacks";

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
  // Separate clones can carry overlapping catalogs for the same repository.
  const merged = new Set<number>();
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
      if (candidate.base === stack.trunk.branch) {
        for (let index = 0; index < position; index++) {
          const branch = checked[index]!;
          const parent = checked[index - 1]?.branch ?? stack.trunk.branch;
          const number = branch.pullRequest?.number ?? await input.findLayer?.(branch.branch, [parent, stack.trunk.branch]);
          if (!number) break;
          input.observeLower?.(number);
          checked[index] = { ...branch, pullRequest: { number } };
          if (!merged.has(number)) {
            if (!(await input.readMerged(number))) break;
            merged.add(number);
          }
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
  /** Open layers below that the operator chose to merge with this one, bottom first. GitHub lands them first. */
  mergesWith?: number[];
};

type GithubNativeStackLayer = { number?: number; state?: string; merged_at?: string | null };

/** What a merge may do with a GitHub stack's open lower layers. */
export type GithubStackMergeOptions = {
  /** Read the member list even for a bottom layer: a stack only GitHub's refusal revealed. */
  readLayers?: boolean;
  /**
   * The open lower layers the operator saw and chose to merge with this one.
   * GitHub's asynchronous merge lands every open layer below the one merged,
   * so the merge goes ahead only when each of them is in this list.
   */
  mergeOpenLayersBelow?: readonly number[];
  /** Records the member list the read returned, so stack views can show the stack. */
  repository?: ForgeRepository;
};

/**
 * GitHub merges a stacked pull request together with every open layer below
 * it. One merge lands one pull request unless the operator chose the open
 * layers below as well (`mergeOpenLayersBelow`), so refuse while any other
 * lower layer is open. Returns the stack, or undefined for a pull request
 * outside one.
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
  options: GithubStackMergeOptions = {},
): Promise<GithubNativeStack | undefined> {
  const stack = pull?.stack;
  if (!stack) return undefined;
  const unreadable = () => new ForgeReadError("stack_parent_open",
    `Could not read the GitHub stack of pull request #${number}. Confirm its lower layers have merged, then retry.`);
  if (!Number.isInteger(stack.number) || !Number.isInteger(stack.position) || !Number.isInteger(stack.size)
    || stack.position! < 1 || stack.position! > stack.size!) throw unreadable();
  const known = { number: stack.number!, position: stack.position!, size: stack.size! };
  if (known.position === 1 && !options.readLayers) return known;
  let response: unknown;
  try {
    response = await get(`/stacks/${stack.number}`);
  } catch (error) {
    if (error instanceof ForgeReadError && error.code === "not_found") throw unreadable();
    throw error;
  }
  if (options.repository) {
    const read = parseGithubForgeStack(options.repository, known.number, response);
    if (read) recordGithubForgeStack(read);
  }
  const layers = (response as { pull_requests?: GithubNativeStackLayer[] } | undefined)?.pull_requests;
  const index = Array.isArray(layers) ? layers.findIndex((layer) => layer?.number === number) : -1;
  if (!Array.isArray(layers) || index < 0) throw unreadable();
  const lower = layers.slice(0, index);
  for (const layer of lower) {
    if (layer.number) observeLower?.(layer.number);
  }
  const isOpen = (layer: GithubNativeStackLayer) => !layer.merged_at && layer.state !== "closed";
  const open = lower.filter(isOpen);
  const chosen = new Set(options.mergeOpenLayersBelow ?? []);
  const unchosen = open.filter((layer) => !chosen.has(layer.number!));
  if (unchosen.length) {
    const named = unchosen.map((layer) => `#${layer.number}`).join(", ");
    throw new ForgeReadError("stack_parent_open", chosen.size
      ? `Pull request #${number} is layer ${index + 1} of ${layers.length} in a GitHub stack, and ${named} below it ${unchosen.length === 1 ? "is" : "are"} open but ${unchosen.length === 1 ? "was" : "were"} not part of this merge. GitHub would merge ${unchosen.length === 1 ? "it" : "them"} too: review the stack again.`
      : `Pull request #${number} is layer ${index + 1} of ${layers.length} in a GitHub stack, and ${named} below it ${open.length === 1 ? "is" : "are"} still open. GitHub would merge ${open.length === 1 ? "it" : "them"} too: merge ${named} first.`);
  }
  return {
    ...known, position: index + 1, size: layers.length,
    layers: layers.flatMap((layer) => Number.isSafeInteger(layer.number) && layer.number! > 0
      ? [{ number: layer.number!, open: isOpen(layer) }] : []),
    ...(open.length ? { mergesWith: open.map((layer) => layer.number!) } : {}),
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
  options: GithubStackMergeOptions = {},
): Promise<GithubStackMergeCheck> {
  const current = await get(`/pulls/${number}`) as GithubStackPull;
  const base = current?.base?.ref;
  if (!base) throw new ForgeReadError("unavailable", `Could not confirm the base of pull request #${number}.`);
  const nativeStack = await assertGithubNativeStackMergeAllowed(number, current, get, observeLower, { repository, ...options });
  const checked = { base, ...(current.head?.sha ? { headSha: current.head.sha } : {}), ...(nativeStack ? { nativeStack } : {}) };
  // The operator chose this layer's open lower layers too, and GitHub's own
  // stack orders them: its asynchronous merge lands them bottom first.
  if (nativeStack?.mergesWith?.length) return checked;
  const repo = `${repository.owner}/${repository.repo}`.toLowerCase();
  const layersByBranch = new Map<string, { base: string; number?: number }[]>();
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
      let layers = layersByBranch.get(branch);
      if (!layers) {
        const params = new URLSearchParams({ state: "all", head: `${repository.owner}:${branch}`, per_page: "100" });
        const parents = await get(`/pulls?${params}`) as GithubStackPull[];
        layers = parents.flatMap((pr) => {
          const base = pr.base?.ref;
          return base && pr.head?.ref === branch && pr.head.repo?.full_name?.toLowerCase() === repo
            && (pr.state === "open" || pr.merged_at) ? [{ base, number: pr.number }] : [];
        });
        layersByBranch.set(branch, layers);
      }
      const candidates = layers.filter((pr) => bases.includes(pr.base));
      return candidates.length === 1 ? candidates[0]?.number : undefined;
    },
    checkInferred: async () => {
      const evidence = await readGithubStackParents({ repository, child: current, number, get, graphql });
      for (const parent of evidence.parents) observeLower?.(parent.number);
      const block = githubStackBlock(number, base, evidence);
      if (block) throw block;
    },
  });
  return checked;
}

/** A retarget can leave the head SHA unchanged. The queue read must agree with the guard. */
export function assertStackMergeBaseUnchanged(checked: string, current: string | undefined): void {
  if (current !== checked) {
    throw new ForgeReadError("stack_parent_open", "The pull request base changed while checking stack order. Read it again before merging.");
  }
}
