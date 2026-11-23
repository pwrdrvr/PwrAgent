import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { open, realpath } from "node:fs/promises";
import path from "node:path";
import { buildThreadIdentityKey, type NavigationThreadSummary, type PrSummary } from "@pwragent/shared/contracts/navigation";
import { parseGhStackCatalog, type GhStack, type GhStackBranch, type GhStackCatalogRead } from "@pwragent/shared/stacks/catalog";
import {
  inferPullRequestStacks, stackLayerBinding, stackLayerHealth,
  type StackLayer, type StackSummary, type StackThread, type StackWorktree, type ThreadStackMembership,
} from "@pwragent/shared/stacks/stack-status";
import { runGitCommand } from "../app-server/git-executable";
import { PR_METADATA_PRIORITY, runPrMetadataProcess, type PrMetadataDemand } from "../pr-status/pr-metadata-process";

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

async function git(cwd: string, args: string[], demand?: PrMetadataDemand): Promise<string> {
  return (await runPrMetadataProcess(() => runGitCommand(cwd, args, { timeout: 3_000, signal: demand?.signal }), demand)).stdout;
}

type Checkout = { cwd: string; root: string; commonDir: string };
type Clone = Checkout & { catalog: CatalogRead };

async function locateCheckout(cwd: string, demand?: PrMetadataDemand): Promise<Checkout | undefined> {
  try {
    const fields = (await git(cwd, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"], demand)).trimEnd().split("\n");
    if (fields.length !== 2 || !fields[0] || !fields[1]) return undefined;
    const [root, commonDir] = await Promise.all([realpath(fields[0]), realpath(fields[1])]);
    return { cwd, root, commonDir };
  } catch {
    return undefined;
  }
}

export async function readStackClones(directories: readonly string[], signal?: AbortSignal): Promise<Clone[]> {
  const demand = { signal, priority: () => PR_METADATA_PRIORITY.selected };
  const checkouts = await Promise.all([...new Set(directories)].map((cwd) => locateCheckout(cwd, demand)));
  signal?.throwIfAborted();
  const clones = new Map(checkouts.flatMap((entry) => entry ? [[entry.commonDir, entry] as const] : []));
  return await Promise.all([...clones.values()].map(async (clone) => ({
    ...clone, catalog: await readGhStackCatalog(clone.commonDir),
  })));
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

async function isAncestor(cwd: string, ancestor: string | undefined, head: string | undefined): Promise<boolean | undefined> {
  if (!ancestor || !head || !SHA.test(ancestor) || !SHA.test(head)) return undefined;
  if (ancestor === head) return true;
  try {
    await git(cwd, ["merge-base", "--is-ancestor", ancestor, head]);
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
}): Promise<StackLayer[]> {
  const { stack, clone, refs, prs, worktrees, threads } = input;
  const local = (branch: GhStackBranch) => refs.get(`refs/heads/${branch.branch}`);
  const pullRequest = (branch: GhStackBranch) => branch.pullRequest
    ? prs.find((pr) => pr.number === branch.pullRequest?.number)
    : prs.find((pr) => pr.headRefName === branch.branch && sameRepositoryHead(pr) && pr.lifecycleState === "open");
  return await Promise.all(stack.branches.map(async (branch, index) => {
    const parent = stack.branches[index - 1] ?? stack.trunk;
    const pr = pullRequest(branch);
    const parentPr = pullRequest(parent);
    const retargeted = index > 0 && pr?.baseRefName === stack.trunk.branch
      && stack.branches.slice(0, index).every((lower) => {
        const observed = pullRequest(lower)?.lifecycleState;
        return observed ? observed === "merged" : lower.pullRequest?.merged === true;
      });
    const number = branch.pullRequest?.number ?? pr?.number;
    const binding = stackLayerBinding({ branch: branch.branch, pullRequest: number, worktrees, threads });
    const current = local(branch);
    const localHead = current?.head;
    const activeParent = retargeted ? stack.trunk : parent;
    const parentTip = local(activeParent)?.head;
    const remoteHead = current?.upstream ? refs.get(current.upstream)?.head : undefined;
    const compareBase = retargeted || branch.base === parentTip ? parentTip : undefined;
    const compareRemote = remoteHead !== branch.head && remoteHead !== pr?.headSha ? remoteHead : undefined;
    const trunkTip = local(stack.trunk)?.head;
    const parentIntegrated = !retargeted && !parentPr && !parent.pullRequest && index > 0
      && trunkTip && parentTip && SHA.test(trunkTip) && SHA.test(parentTip)
      ? await git(clone.cwd, ["cherry", trunkTip, parentTip]).then((output) => !output.trim(), () => undefined)
      : undefined;
    const [baseIsAncestor, remoteIsAncestor] = await Promise.all([
      isAncestor(clone.cwd, compareBase, localHead),
      isAncestor(clone.cwd, compareRemote, localHead),
    ]);
    return {
      branch: branch.branch, parent: parent.branch, role: binding.role,
      ...(retargeted ? { activeBase: activeParent.branch } : {}),
      health: stackLayerHealth({
        branch: retargeted && parentTip ? { ...branch, base: parentTip } : branch,
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

async function projectClone(clone: Clone, threads: readonly CloneThread[], knownPrs: readonly PrSummary[]) {
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
    git(clone.cwd, ["worktree", "list", "--porcelain", "-z"]).catch(() => ""),
    catalog?.stacks.length
      ? git(clone.cwd, ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(upstream)", "refs/heads/", "refs/remotes/"]).catch(() => "")
      : "",
  ]);
  const worktrees = checkedOutWorktrees(worktreeOutput);
  const refs = parseRefs(refOutput);
  const cloneKey = createHash("sha256").update(clone.commonDir).digest("hex").slice(0, 24);
  for (const { repository, catalogStacks, prs, bindings, inferred } of plans) {
    const prefix = `${cloneKey}:${repository}`;
    for (const stack of catalogStacks) {
      if (!stack.branches.length) continue;
      const name = stack.branches[0]!.branch;
      const layers = await projectCatalogLayers({ stack, clone, refs, prs, worktrees, threads: bindings });
      stacks.push({ key: `${prefix}:catalog:${stack.id ?? name}`, name, repository, inferred: false, trunk: stack.trunk.branch, layers });
    }
    for (const chain of inferred) {
      const name = chain[0]!.headRefName!;
      const layers = chain.map((pr): StackLayer => {
        const branch = pr.headRefName!;
        const binding = stackLayerBinding({ branch, pullRequest: pr.number, worktrees, threads: bindings });
        return {
          branch, parent: pr.baseRefName!, role: binding.role,
          health: binding.role === "ambiguous" ? "ambiguous" : "unknown",
          pullRequest: { number: pr.number, lifecycleState: pr.lifecycleState },
          ...("thread" in binding ? { thread: { key: binding.thread.key, title: binding.thread.title } } : {}),
        };
      });
      stacks.push({ key: `${prefix}:inferred:${chain[0]!.number}`, name, repository, inferred: true, trunk: chain[0]!.baseRefName!, layers });
    }
  }
  return stacks;
}

export class StackReader {
  private readonly checkouts = new Map<string, { expiresAt: number; value: Promise<Checkout | undefined> }>();

  private checkout(cwd: string): Promise<Checkout | undefined> {
    const now = Date.now();
    const cached = this.checkouts.get(cwd);
    if (cached && cached.expiresAt > now) return cached.value;
    const value = locateCheckout(cwd);
    this.checkouts.set(cwd, { expiresAt: now + 30_000, value });
    if (this.checkouts.size > 2048) this.checkouts.delete(this.checkouts.keys().next().value!);
    return value;
  }

  async readCatalogs(directories: readonly string[]): Promise<CatalogRead[]> {
    const checkouts = await Promise.all(directories.map((cwd) => this.checkout(cwd)));
    const commonDirs = new Set(checkouts.flatMap((checkout) => checkout ? [checkout.commonDir] : []));
    return await Promise.all([...commonDirs].map(readGhStackCatalog));
  }

  async read(threads: readonly StackThreadRow[], knownPrs: readonly PrSummary[], directories?: readonly string[]) {
    const paths = new Set([...threads.filter((row) => !row.federation).flatMap(threadDirectories), ...directories ?? []]);
    const located = await Promise.all([...paths].sort().map((cwd) => this.checkout(cwd)));
    const checkouts = new Map(located.flatMap((entry) => entry ? [[entry.cwd, entry] as const] : []));
    const cloneCheckouts = new Map([...checkouts.values()].map((checkout) => [checkout.commonDir, checkout]));
    const cloneThreads = new Map<string, CloneThread[]>();
    for (const row of threads) {
      if (row.federation) continue;
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
    const scope = directories && new Set(directories.map((cwd) => checkouts.get(cwd)?.commonDir));
    const results = await Promise.all([...cloneCheckouts.values()].filter(({ commonDir }) => !scope || scope.has(commonDir)).map(async (checkout) => {
      const catalog = await readGhStackCatalog(checkout.commonDir);
      return {
        catalog,
        stacks: await projectClone({ ...checkout, catalog }, cloneThreads.get(checkout.commonDir) ?? [], knownPrs),
      };
    }));
    return { stacks: results.flatMap(({ stacks }) => stacks), catalogs: results.map(({ catalog }) => catalog) };
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
