import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { buildThreadIdentityKey, type NavigationThreadSummary, type PrSummary } from "@pwragent/shared/contracts/navigation";
import { parseGhStackCatalog, type GhStack, type GhStackBranch, type GhStackCatalogRead } from "@pwragent/shared/stacks/catalog";
import {
  inferPullRequestStacks, stackLayerBinding, stackLayerHealth,
  type StackLayer, type StackSummary, type StackThread, type StackWorktree, type ThreadStackMembership,
} from "@pwragent/shared/stacks/stack-status";
import { resolveCheckState } from "@pwragent/shared/pull-request-rollup";
import { stackAutomationGates } from "@pwragent/shared/stacks/stack-automation";
import { PR_METADATA_PRIORITY, runPrMetadataGit, type PrMetadataDemand } from "../pr-status/pr-metadata-process";
import { createStackCheckoutHints, stackCatalogCandidates } from "../git-info/stack-checkout-store";

type CatalogRead = GhStackCatalogRead | { status: "missing" | "unavailable" };

const CATALOG_BYTES = 1024 * 1024;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export async function readGhStackCatalog(commonDir: string): Promise<CatalogRead> {
  try {
    const file = await open(path.join(commonDir, "gh-stack"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > CATALOG_BYTES) return { status: "catalog_invalid" };
      const bytes = Buffer.alloc(stat.size + 1);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead !== stat.size) return { status: "catalog_invalid" };
      return parseGhStackCatalog(bytes.toString("utf8", 0, bytesRead));
    } finally {
      await file.close();
    }
  } catch (error) {
    return { status: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unavailable" };
  }
}

async function git(cwd: string, args: string[], demand?: PrMetadataDemand, checkout = false): Promise<string> {
  return (await runPrMetadataGit(cwd, args, {
    timeout: 3_000, signal: demand?.signal, purpose: checkout ? "stack-checkout" : "stack-status",
  }, demand)).stdout;
}

type Checkout = { cwd: string; root: string; commonDir: string };
type Clone = Checkout & { catalog: CatalogRead };

async function stackJournalInFlight(commonDir: string): Promise<boolean> {
  const journals = ["gh-stack-rebase-state", "gh-stack-modify-state", "gh-stack-migration", "pwrgit-stack-op.json", "pwragent-stack-op.json"];
  const observed = await Promise.all(journals.map((name) => lstat(path.join(commonDir, name))
    .then(() => true, (error: unknown) => (error as NodeJS.ErrnoException).code !== "ENOENT")));
  return observed.some(Boolean);
}

async function locateCheckout(cwd: string, demand?: PrMetadataDemand): Promise<Checkout | undefined> {
  try {
    const args = ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"];
    const fields = (await git(cwd, args, demand, true)).replace(/\r?\n$/, "").split(/\r?\n/);
    if (fields.length !== 2 || !fields[0] || !fields[1]) return undefined;
    const [root, commonDir] = await Promise.all([realpath(fields[0]), realpath(fields[1])]);
    demand?.signal?.throwIfAborted();
    return { cwd, root, commonDir };
  } catch {
    demand?.signal?.throwIfAborted();
    return undefined;
  }
}

export async function readStackClones(directories: readonly string[], signal?: AbortSignal): Promise<Clone[]> {
  const demand = { signal, priority: () => PR_METADATA_PRIORITY.selected };
  const checkouts = await Promise.all([...new Set(directories)].map((cwd) => locateCheckout(cwd, demand)));
  signal?.throwIfAborted();
  const clones = new Map(checkouts.flatMap((entry) => entry ? [[entry.commonDir, entry] as const] : []));
  const catalogs = await Promise.all([...clones.values()].map(async (clone) => ({
    ...clone, catalog: await readGhStackCatalog(clone.commonDir),
  })));
  signal?.throwIfAborted();
  return catalogs;
}

function checkedOutWorktrees(output: string): StackWorktree[] {
  return output.split("\0\0").flatMap((record) => {
    const entries = record.split("\0");
    const worktree = entries.find((entry) => entry.startsWith("worktree "))?.slice(9);
    const branch = entries.find((entry) => entry.startsWith("branch refs/heads/"))?.slice(18);
    return worktree && branch ? [{ path: path.normalize(worktree), branch }] : [];
  });
}

type Refs = Map<string, { head?: string; upstream?: string }>;

function parseRefs(output: string): Refs {
  return new Map(output.trimEnd().split("\n").flatMap((line) => {
    const [ref, head, upstream] = line.split("\0");
    return ref && head ? [[ref, { head, upstream }]] : [];
  }));
}

async function isAncestor(
  cwd: string, ancestor: string | undefined, head: string | undefined, demand?: PrMetadataDemand,
): Promise<boolean | undefined> {
  if (!ancestor || !head || !SHA.test(ancestor) || !SHA.test(head)) return undefined;
  if (ancestor === head) return true;
  try {
    await git(cwd, ["merge-base", "--is-ancestor", ancestor, head], demand);
    return true;
  } catch (error) {
    return (error as { code?: number }).code === 1 ? false : undefined;
  }
}

function prRepository(pr: PrSummary): string {
  return `${pr.provider}:${pr.org}/${pr.repo}`.toLowerCase();
}

function sameRepositoryHead(pr: PrSummary): boolean {
  const source = pr.sourceRepository;
  return !source || `${source.provider}:${source.org}/${source.repo}`.toLowerCase() === prRepository(pr);
}

type StackThreadRow = Pick<NavigationThreadSummary, "id" | "source" | "title" | "linkedDirectories" | "prs" | "federation">;

function threadDirectories(thread: StackThreadRow): string[] {
  return (thread.linkedDirectories ?? []).map((directory) => directory.worktreePath ?? directory.path);
}

type CloneThread = { row: StackThreadRow; paths: string[] };

async function projectCatalogLayers(input: {
  stack: GhStack;
  clone: Clone;
  refs: Refs;
  prs: readonly PrSummary[];
  worktrees: readonly StackWorktree[];
  threads: readonly StackThread[];
  demand?: PrMetadataDemand;
}): Promise<StackLayer[]> {
  const { stack, clone, refs, prs, worktrees, threads, demand } = input;
  const local = (branch: GhStackBranch) => refs.get(`refs/heads/${branch.branch}`);
  const byBranch = new Map<string, PrSummary[]>();
  for (const pr of prs) {
    if (!pr.headRefName || !sameRepositoryHead(pr)) continue;
    const matches = byBranch.get(pr.headRefName) ?? [];
    matches.push(pr);
    byBranch.set(pr.headRefName, matches);
  }
  const byNumber = new Map(prs.map((pr) => [pr.number, pr]));
  const pullRequest = (branch: GhStackBranch, below: GhStackBranch, lowerMerged: boolean) => {
    if (branch.pullRequest) return byNumber.get(branch.pullRequest.number);
    const candidates = byBranch.get(branch.branch) ?? [];
    const open = candidates.filter((pr) => pr.lifecycleState === "open");
    if (open.length) return open.length === 1 ? open[0] : undefined;
    // A recycled branch name is insufficient to associate a historical merge.
    const merged = candidates.filter((pr) => pr.lifecycleState === "merged"
      && (pr.baseRefName === below.branch || (lowerMerged && pr.baseRefName === stack.trunk.branch))
      && pr.headSha && (pr.headSha === local(branch)?.head || pr.headSha === branch.head));
    return merged.length === 1 ? merged[0] : undefined;
  };
  const allBelowMerged = [true];
  const associated = stack.branches.map((branch, index) => {
    const belowMerged = allBelowMerged[index]!;
    const pr = pullRequest(branch, stack.branches[index - 1] ?? stack.trunk, belowMerged);
    allBelowMerged.push(belowMerged && (pr ? pr.lifecycleState === "merged" : branch.pullRequest?.merged === true));
    return pr;
  });
  return await Promise.all(stack.branches.map(async (branch, index) => {
    const parent = stack.branches[index - 1] ?? stack.trunk;
    const pr = associated[index];
    const parentPr = associated[index - 1];
    const retargeted = index > 0 && pr?.baseRefName === stack.trunk.branch && allBelowMerged[index];
    const number = branch.pullRequest?.number ?? pr?.number;
    const binding = stackLayerBinding({ branch: branch.branch, pullRequest: number, worktrees, threads });
    const current = local(branch);
    const localHead = current?.head;
    const activeParent = retargeted ? stack.trunk : parent;
    const parentTip = retargeted ? stack.trunk.head : local(activeParent)?.head;
    const remoteHead = current?.upstream ? refs.get(current.upstream)?.head : undefined;
    const compareBase = branch.base === parentTip ? parentTip : undefined;
    const compareRemote = remoteHead !== branch.head && remoteHead !== pr?.headSha ? remoteHead : undefined;
    const trunkTip = local(stack.trunk)?.head;
    const parentIntegrated = !retargeted && !parentPr && !parent.pullRequest && index > 0
      && trunkTip && parentTip && SHA.test(trunkTip) && SHA.test(parentTip)
      ? await git(clone.cwd, ["cherry", trunkTip, parentTip], demand).then((output) => !output.trim(), () => undefined)
      : undefined;
    const [baseIsAncestor, remoteIsAncestor] = await Promise.all([
      isAncestor(clone.cwd, compareBase, localHead, demand),
      isAncestor(clone.cwd, compareRemote, localHead, demand),
    ]);
    return {
      branch: branch.branch, parent: parent.branch, role: binding.role,
      ...(retargeted ? { activeBase: activeParent.branch } : {}),
      health: retargeted && branch.base !== parentTip && !branch.pullRequest?.merged ? "parent_merged" : stackLayerHealth({
        branch,
        parent: activeParent, pr, parentPr: retargeted ? undefined : parentPr, localHead, parentTip, remoteHead,
        baseIsAncestor, remoteIsAncestor, parentIntegrated, ambiguous: binding.role === "ambiguous",
      }),
      ...(number !== undefined ? { pullRequest: {
        number, lifecycleState: pr?.lifecycleState ?? (branch.pullRequest?.merged ? "merged" : undefined),
      } } : {}),
      ...("thread" in binding ? { thread: { key: binding.thread.key, title: binding.thread.title } } : {}),
    };
  }));
}

function clonePrs(threads: readonly CloneThread[], knownPrs: readonly PrSummary[], repository: string): PrSummary[] {
  const prs = [...threads.flatMap(({ row }) => row.prs ?? []), ...knownPrs];
  return [...new Map(prs.filter((pr) => prRepository(pr) === repository).map((pr) => [pr.number, pr])).values()];
}

async function projectClone(
  clone: Clone, threads: readonly CloneThread[], knownPrs: readonly PrSummary[], demand?: PrMetadataDemand,
) {
  const catalog = clone.catalog.status === "ok" ? clone.catalog.catalog : undefined;
  const repositories = new Set(threads.flatMap(({ row }) => (row.prs ?? []).map(prRepository)));
  if (catalog?.stacks.length) repositories.add(catalog.repository.toLowerCase());
  const stacks: StackSummary[] = [];
  if (!repositories.size) return stacks;
  const plans = [...repositories].sort().flatMap((repository) => {
    const catalogStacks = catalog?.repository.toLowerCase() === repository ? catalog.stacks : [];
    const prs = clonePrs(threads, knownPrs, repository);
    const catalogBranches = new Set(catalogStacks.flatMap((stack) => stack.branches.map((branch) => branch.branch)));
    const bindings: StackThread[] = threads.map(({ row, paths }) => ({
      key: buildThreadIdentityKey(row.source, row.id),
      title: row.title,
      paths,
      attached: (row.prs ?? []).filter((pr) => prRepository(pr) === repository).map((pr) => pr.number),
    }));
    const attached = new Set(bindings.flatMap((thread) => thread.attached));
    // Infer from this clone's attachments. The registry is repository-wide and
    // can include PRs observed through a different clone.
    const inferred = inferPullRequestStacks(prs.filter((pr) => attached.has(pr.number) && sameRepositoryHead(pr)), catalogBranches);
    return catalogStacks.length || inferred.length ? [{ repository, catalogStacks, prs, bindings, inferred }] : [];
  });
  if (!plans.length) return stacks;
  const [worktreeOutput, refOutput] = await Promise.all([
    git(clone.cwd, ["worktree", "list", "--porcelain", "-z"], demand).catch(() => ""),
    git(clone.cwd, ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(upstream)", "refs/heads/", "refs/remotes/"], demand).catch(() => ""),
  ]);
  const worktrees = checkedOutWorktrees(worktreeOutput);
  const refs = parseRefs(refOutput);
  const cloneKey = createHash("sha256").update(clone.commonDir).digest("hex").slice(0, 24);
  const busy = Boolean(catalog?.stacks.length) && await stackJournalInFlight(clone.commonDir);
  for (const { repository, catalogStacks, prs, bindings, inferred } of plans) {
    const prefix = `${cloneKey}:${repository}`;
    for (const stack of catalogStacks) {
      if (!stack.branches.length) continue;
      const name = stack.branches[0]!.branch;
      const layers = await projectCatalogLayers({ stack, clone, refs, prs, worktrees, threads: bindings, demand });
      const identity = stack.id ?? name;
      const key = `${prefix}:catalog:${identity}`;
      stacks.push({
        key: key.length <= 512 ? key : createHash("sha256").update(key).digest("hex"),
        name, repository, inferred: false, trunk: stack.trunk.branch,
        layers: busy ? layers.map((layer) => ({ ...layer, health: "held" })) : layers,
      });
    }
    for (const chain of inferred) {
      const name = chain[0]!.headRefName!;
      const layers = await Promise.all(chain.map(async (pr): Promise<StackLayer> => {
        const branch = pr.headRefName!;
        const binding = stackLayerBinding({ branch, pullRequest: pr.number, worktrees, threads: bindings });
        return {
          branch, parent: pr.baseRefName!, role: binding.role,
          health: binding.role === "ambiguous" ? "ambiguous"
            : pr.headSha && pr.baseSha && refs.get(`refs/heads/${branch}`)?.head === pr.headSha
              && (chain.find((parent) => parent.headRefName === pr.baseRefName)?.headSha ?? pr.baseSha) === pr.baseSha
              && await isAncestor(clone.cwd, pr.baseSha, pr.headSha, demand) ? "in_sync" : "unknown",
          pullRequest: { number: pr.number, lifecycleState: pr.lifecycleState },
          ...("thread" in binding ? { thread: { key: binding.thread.key, title: binding.thread.title } } : {}),
        };
      }));
      stacks.push({ key: `${prefix}:inferred:${chain[0]!.number}`, name, repository, inferred: true, trunk: chain[0]!.baseRefName!, layers });
    }
  }
  return stacks;
}

function prIdentity(pr: PrSummary): string {
  return `${prRepository(pr)}#${pr.number}`;
}

/** A chain needs two distinct, attached PRs whose raw head/base refs meet. */
function possibleInferredLayers(threads: readonly StackThreadRow[], knownPrs: readonly PrSummary[]): Set<string> {
  const attached = threads.flatMap((row) => row.prs ?? []);
  const attachedIds = new Set(attached.map(prIdentity));
  // Any clone's attachments or the registry may supply the effective refs.
  // Keep all variants here, leaving the actual chain decision to projectClone.
  const refs = [...attached, ...knownPrs].filter((pr) => pr.lifecycleState === "open"
    && pr.headRefName && pr.baseRefName && sameRepositoryHead(pr) && attachedIds.has(prIdentity(pr)));
  const byHead = new Map<string, Set<string>>();
  const byBase = new Map<string, Set<string>>();
  for (const pr of refs) {
    for (const [index, ref] of [[byHead, pr.headRefName], [byBase, pr.baseRefName]] as const) {
      const key = `${prRepository(pr)}:${ref}`;
      const ids = index.get(key) ?? new Set<string>();
      ids.add(prIdentity(pr));
      index.set(key, ids);
    }
  }
  const eligible = new Set<string>();
  for (const [key, parents] of byHead) {
    const children = byBase.get(key);
    if (!children || (parents.size === 1 && children.size === 1 && children.has(parents.values().next().value!))) continue;
    for (const id of parents) eligible.add(id);
    for (const id of children) eligible.add(id);
  }
  return eligible;
}

export class StackReader {
  async readPresentCatalogs(directories: readonly string[]): Promise<CatalogRead[]> {
    return (await readStackClones(await stackCatalogCandidates(directories))).map(({ catalog }) => catalog);
  }

  async read(threads: readonly StackThreadRow[], knownPrs: readonly PrSummary[], directories?: readonly string[],
    activity?: (threadKey: string) => Promise<{ held?: boolean; repair?: boolean }>,
    demand: PrMetadataDemand = { priority: () => directories ? PR_METADATA_PRIORITY.selected : PR_METADATA_PRIORITY.background },
  ) {
    demand.signal?.throwIfAborted();
    const local = threads.filter((row) => !row.federation);
    const hints = createStackCheckoutHints(demand.signal);
    const reads = new Map<string, Promise<Checkout | undefined>>();
    const locate = (cwd: string) => {
      let read = reads.get(cwd);
      if (!read) {
        read = locateCheckout(cwd, demand);
        reads.set(cwd, read);
      }
      return read;
    };
    const anchors = await Promise.all([...new Set(directories)].map(locate));
    const scopedClones = new Map(anchors.flatMap((entry) => entry ? [[entry.commonDir, entry] as const] : []));
    if (directories && !scopedClones.size) return { stacks: [], catalogs: [] };

    const eligible = possibleInferredLayers(local, knownPrs);
    const wanted = new Set<string>();
    // Read explicitly requested catalogs even when there is nothing to bind.
    const scopedCatalogs = new Map(await Promise.all([...scopedClones.keys()].map(async (commonDir) => {
      const catalog = await readGhStackCatalog(commonDir);
      if (catalog.status === "ok" && catalog.catalog.stacks.length) wanted.add(commonDir);
      return [commonDir, catalog] as const;
    })));
    const paths = !directories || wanted.size || eligible.size
      ? [...new Set(local.flatMap(threadDirectories))].sort() : [];
    const possible = new Map(await Promise.all(paths.map(async (cwd) => {
      const found = reads.has(cwd) ? undefined : await hints.possibleCommonDirs(cwd);
      if (found) return [cwd, found] as const;
      const checkout = await locate(cwd);
      return [cwd, checkout ? [checkout.commonDir] : []] as const;
    })));
    if (!directories) {
      const candidateDirs = new Set([...possible.values()].flat());
      await Promise.all([...candidateDirs].map(async (commonDir) => {
        if (await hints.hasCatalog(commonDir)) wanted.add(commonDir);
      }));
    }
    for (const row of local) {
      if (!row.prs?.some((pr) => eligible.has(prIdentity(pr)))) continue;
      for (const cwd of threadDirectories(row)) {
        for (const commonDir of possible.get(cwd) ?? []) {
          if (!directories || scopedClones.has(commonDir)) wanted.add(commonDir);
        }
      }
    }
    const participates = (cwd: string) => possible.get(cwd)?.some((commonDir) => wanted.has(commonDir));
    const admitted = new Set(paths.filter(participates));
    // An attachment without path provenance is attributed only when the row
    // belongs to exactly one clone. Include its other paths for that decision.
    for (const row of local) {
      if (!row.prs?.some((pr) => !pr.linkedDirectoryPaths?.length)) continue;
      const paths = threadDirectories(row);
      if (!paths.some(participates)) continue;
      for (const cwd of paths) if (possible.get(cwd)?.length) admitted.add(cwd);
    }
    const located = await Promise.all([...admitted].map(locate));
    const checkouts = new Map([...anchors, ...located].flatMap((entry) => entry ? [[entry.cwd, entry] as const] : []));
    const cloneCheckouts = directories ? scopedClones : new Map([...checkouts.values()]
      .filter((checkout) => wanted.has(checkout.commonDir)).map((checkout) => [checkout.commonDir, checkout]));
    const cloneThreads = new Map<string, CloneThread[]>();
    for (const row of local) {
      const pathsByClone = new Map<string, string[]>();
      for (const cwd of threadDirectories(row)) {
        const checkout = checkouts.get(cwd);
        if (!checkout) continue;
        pathsByClone.set(checkout.commonDir, [...pathsByClone.get(checkout.commonDir) ?? [], checkout.root]);
      }
      for (const [commonDir, paths] of pathsByClone) {
        const entries = cloneThreads.get(commonDir) ?? [];
        const prs = row.prs?.filter((pr) => pr.linkedDirectoryPaths?.length
          ? pr.linkedDirectoryPaths.some((directory) => paths.includes(checkouts.get(directory)?.root ?? directory))
          : pathsByClone.size === 1);
        entries.push({ row: { ...row, prs }, paths });
        cloneThreads.set(commonDir, entries);
      }
    }
    const results = await Promise.all([...cloneCheckouts.values()].map(async (checkout) => {
      const catalog = scopedCatalogs.get(checkout.commonDir) ?? await readGhStackCatalog(checkout.commonDir);
      return {
        catalog,
        stacks: await projectClone({ ...checkout, catalog }, cloneThreads.get(checkout.commonDir) ?? [], knownPrs, demand),
      };
    }));
    demand.signal?.throwIfAborted();
    const observed = new Map([...threads.flatMap((row) => row.prs ?? []), ...knownPrs].map((pr) => [prIdentity(pr), pr]));
    const stacks = results.flatMap((result) => result.stacks);
    const threadKeys = new Set(stacks.flatMap((stack) => stack.layers.flatMap((layer) => layer.thread ? [layer.thread.key] : [])));
    const activityByThread = new Map(await Promise.all([...threadKeys].map(async (key) => [key, await activity?.(key)] as const)));
    demand.signal?.throwIfAborted();
    return { stacks: stacks.map((stack) => {
      const layers = stack.layers.map((layer) => {
        const state = layer.thread && activityByThread.get(layer.thread.key);
        return state && state.held ? { ...layer, health: "held" as const } : layer;
      });
      const gates = stackAutomationGates(layers.map((layer) => {
        const pr = layer.pullRequest && observed.get(`${stack.repository}#${layer.pullRequest.number}`);
        const state = layer.thread && activityByThread.get(layer.thread.key);
        return {
          branch: layer.branch, health: layer.health, number: layer.pullRequest?.number,
          merged: layer.pullRequest?.lifecycleState === "merged",
          closed: layer.pullRequest?.lifecycleState === "closed",
          merging: pr?.mergeQueue?.state === "merging" || pr?.mergeQueue?.state === "queued",
          conflict: pr?.mergeState === "mergeable" ? false : pr?.mergeState === "conflicting" ? true : undefined,
          repair: Boolean(state && state.repair),
          checks: pr?.headSha ? resolveCheckState(pr) : undefined,
          checksRunning: pr?.checksStillRunning,
        };
      }));
      return { ...stack, layers: layers.map((layer, index) => ({ ...layer, ...gates[index] })) };
    }), catalogs: results.map(({ catalog }) => catalog) };
  }
}

export function stackMemberships(stacks: readonly StackSummary[]): Map<string, ThreadStackMembership[]> {
  const memberships = new Map<string, ThreadStackMembership[]>();
  for (const stack of stacks) {
    for (const [index, layer] of stack.layers.entries()) {
      if (!layer.thread) continue;
      const { key } = layer.thread;
      const current = memberships.get(key) ?? [];
      current.push({ stack, position: index + 1 });
      memberships.set(key, current);
    }
  }
  return memberships;
}
