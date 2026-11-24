import { constants, type BigIntStats } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { IterableMapper } from "@shutterstock/p-map-iterable";
import { buildThreadIdentityKey, type NavigationThreadSummary, type PrSummary } from "@pwragent/shared/contracts/navigation";
import { parseGhStackCatalog, type GhStack, type GhStackBranch, type GhStackCatalogRead } from "@pwragent/shared/stacks/catalog";
import {
  inferPullRequestStacks, stackLayerBinding, stackLayerHealth,
  type StackLayer, type StackSummary, type StackThread, type StackWorktree, type ThreadStackMembership,
} from "@pwragent/shared/stacks/stack-status";
import { resolveCheckState } from "@pwragent/shared/pull-request-rollup";
import { stackAutomationGates } from "@pwragent/shared/stacks/stack-automation";
import { PR_METADATA_PRIORITY, runPrMetadataFileProbe, runPrMetadataGit, SharedPrMetadataRead, type PrMetadataDemand } from "../pr-status/pr-metadata-process";
import { createStackCheckoutHints, STACK_CHECKOUT_SCAN_LIMITS } from "../git-info/stack-checkout-store";

type CatalogRead = GhStackCatalogRead | { status: "missing" | "unavailable" };

const CATALOG_BYTES = 1024 * 1024;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

type CatalogObservation = { catalog: CatalogRead; version?: string };

function catalogVersion(info: BigIntStats): string {
  return [info.dev, info.ino, info.mode, info.size, info.mtimeNs, info.ctimeNs].join(":");
}

async function readCatalogFile(catalogPath: string): Promise<CatalogObservation | undefined> {
  try {
    const file = await open(catalogPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat({ bigint: true });
      if (!stat.isFile() || stat.size > CATALOG_BYTES) return { catalog: { status: "catalog_invalid" } };
      const bytes = Buffer.alloc(Number(stat.size) + 1);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      const version = catalogVersion(stat);
      if (bytesRead !== Number(stat.size) || version !== catalogVersion(await file.stat({ bigint: true }))) return undefined;
      const published = await lstat(catalogPath, { bigint: true }).catch(() => undefined);
      if (!published || version !== catalogVersion(published)) return undefined;
      return { catalog: parseGhStackCatalog(bytes.toString("utf8", 0, bytesRead)), version };
    } finally {
      await file.close();
    }
  } catch (error) {
    return { catalog: { status: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unavailable" } };
  }
}

async function observeCatalog(commonDir: string): Promise<CatalogObservation> {
  const catalogPath = path.join(commonDir, "gh-stack");
  // A concurrent write can replace the published inode while the old handle
  // still reads its bytes. Close it, then reopen the path once.
  return await readCatalogFile(catalogPath) ?? await readCatalogFile(catalogPath) ?? { catalog: { status: "unavailable" } };
}

export async function readGhStackCatalog(commonDir: string): Promise<CatalogRead> {
  return (await observeCatalog(commonDir)).catalog;
}

async function git(cwd: string, args: string[], demand?: PrMetadataDemand, checkout = false): Promise<string> {
  return (await runPrMetadataGit(cwd, args, {
    timeout: 3_000, signal: demand?.signal, purpose: checkout ? "stack-checkout" : "stack-status",
    ownProcessTree: demand?.signal !== undefined,
    ...(checkout && { env: { ...process.env, LC_ALL: "C", LANGUAGE: "C" } }),
  }, demand)).stdout;
}

type Checkout = { cwd: string; root: string; commonDir: string };
type CheckoutLookup = Checkout | "unavailable" | undefined;
type Clone = Checkout & { catalog: CatalogRead };

async function stackJournalInFlight(commonDir: string): Promise<boolean> {
  const journals = ["gh-stack-rebase-state", "gh-stack-modify-state", "gh-stack-migration", "pwrgit-stack-op.json", "pwragent-stack-op.json"];
  const observed = await Promise.all(journals.map((name) => lstat(path.join(commonDir, name))
    .then(() => true, (error: unknown) => (error as NodeJS.ErrnoException).code !== "ENOENT")));
  return observed.some(Boolean);
}

async function locateCheckout(cwd: string, demand?: PrMetadataDemand): Promise<CheckoutLookup> {
  try {
    const args = ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"];
    const stdout = await git(cwd, args, demand, true);
    const fields = (process.platform === "win32" ? stdout.replace(/\r\n/g, "\n") : stdout).replace(/\n$/, "").split("\n");
    if (fields.length !== 2 || !fields[0] || !fields[1]) return "unavailable";
    const [root, commonDir] = await Promise.all([realpath(fields[0]), realpath(fields[1])]);
    demand?.signal?.throwIfAborted();
    return { cwd, root, commonDir };
  } catch (error) {
    demand?.signal?.throwIfAborted();
    // Git uses exit 128 for both confirmed absence and errors such as unsafe
    // ownership or a broken gitdir pointer. Only its negative discovery
    // messages establish absence. Timeouts and malformed output stay unknown.
    const failure = error as { code?: number; killed?: boolean; stderr?: string };
    if (failure?.code === 128 && !failure.killed
      && /^fatal: (?:not a git repository \(or any |this operation must be run in a work tree\r?$|cannot change to .*: (?:No such file or directory|Not a directory)\r?$)/m
        .test(failure.stderr ?? "")) return undefined;
    return "unavailable";
  }
}

/** Directory hints and live reads shared within one stack request. */
export class StackReadObservation {
  hints: ReturnType<typeof createStackCheckoutHints>;
  readonly inventoryDemand: PrMetadataDemand;
  private readonly checkouts = new Map<string, Promise<CheckoutLookup>>();
  private readonly preflightCheckoutVersions = new Map<string, string | undefined>();
  private readonly catalogs = new Map<string, Promise<CatalogObservation>>();

  constructor(readonly demand: PrMetadataDemand = {}) {
    // A selected request can promote the explicit checkout without putting
    // its speculative inventory work ahead of other selected reads.
    this.inventoryDemand = {
      signal: demand.signal,
      priority: () => Math.min(demand.priority?.() ?? PR_METADATA_PRIORITY.background, PR_METADATA_PRIORITY.page),
    };
    this.hints = createStackCheckoutHints(this.inventoryDemand);
  }

  checkoutLookup(cwd: string, demand = this.demand): Promise<CheckoutLookup> {
    this.demand.signal?.throwIfAborted();
    let read = this.checkouts.get(cwd);
    if (!read) {
      read = locateCheckout(cwd, demand);
      this.checkouts.set(cwd, read);
    }
    return read;
  }

  async checkout(cwd: string, demand = this.demand): Promise<Checkout | undefined> {
    const result = await this.checkoutLookup(cwd, demand);
    return result === "unavailable" ? undefined : result;
  }

  async catalog(commonDir: string): Promise<CatalogRead> {
    this.demand.signal?.throwIfAborted();
    let read = this.catalogs.get(commonDir);
    if (!read) {
      read = observeCatalog(commonDir);
      this.catalogs.set(commonDir, read);
    }
    return (await read).catalog;
  }

  private async recordCheckout(cwd: string, lookup?: (cwd: string) => Promise<CheckoutLookup>): Promise<CheckoutLookup> {
    const before = await this.hints.checkoutIdentity(cwd);
    const checkout = await (lookup ? lookup(cwd) : this.checkoutLookup(cwd));
    this.checkouts.set(cwd, Promise.resolve(checkout));
    if (checkout && checkout !== "unavailable") {
      const unchanged = before && checkout.root === before.root && checkout.commonDir === before.commonDir
        && (await this.hints.checkoutIdentity(cwd))?.version === before.version;
      this.preflightCheckoutVersions.set(cwd, unchanged ? before.version : undefined);
    }
    return checkout;
  }

  async checkoutsByClone(directories: readonly string[], lookup = (cwd: string) => this.checkout(cwd)): Promise<Checkout[]> {
    const checkouts = await Promise.all([...new Set(directories)].map(lookup));
    this.demand.signal?.throwIfAborted();
    const clones = new Map(checkouts.flatMap((entry) => entry ? [[entry.commonDir, entry] as const] : []));
    return [...clones.values()];
  }

  async clones(directories: readonly string[], lookup?: (cwd: string) => Promise<Checkout | undefined>): Promise<Clone[]> {
    const clones = await this.checkoutsByClone(directories, lookup);
    const catalogs = await Promise.all(clones.map(async (clone) => ({
      ...clone, catalog: await this.catalog(clone.commonDir),
    })));
    this.demand.signal?.throwIfAborted();
    return catalogs;
  }

  async checkoutCatalogs(directories: readonly string[], lookup = (cwd: string) => this.checkoutLookup(cwd)): Promise<CatalogRead[]> {
    let unavailable = false;
    const clones = await this.clones(directories, async (cwd) => {
      const checkout = await lookup(cwd);
      if (checkout !== "unavailable") return checkout;
      unavailable = true;
    });
    const catalogs = clones.map(({ catalog }) => catalog);
    if (unavailable) catalogs.push({ status: "unavailable" });
    return catalogs;
  }

  async preflightCatalogs(directories: readonly string[], lookup?: (cwd: string) => Promise<CheckoutLookup>): Promise<CatalogRead[]> {
    const candidates = await this.hints.markerCandidates(directories);
    return await this.checkoutCatalogs(candidates, (cwd) => this.recordCheckout(cwd, lookup));
  }

  async revalidateAfterListing(): Promise<void> {
    // A provider listing can block. Reuse the preflight only when both its
    // checkout relationship and the exact catalog file still match.
    this.hints = createStackCheckoutHints(this.inventoryDemand);
    const checkouts = [...this.checkouts.keys()].map(async (cwd) => {
      const version = this.preflightCheckoutVersions.get(cwd);
      if (version && (await this.hints.checkoutIdentity(cwd))?.version === version) return;
      this.checkouts.delete(cwd);
      if (this.preflightCheckoutVersions.has(cwd) && !await this.checkout(cwd)) {
        // We previously confirmed a checkout for this gate. A failed lookup
        // cannot establish that its stack settled while listing threads.
        throw new Error("Stack checkout evidence is unavailable.");
      }
    });
    const catalogs = [...this.catalogs].map(async ([commonDir, read]) => {
      const previous = (await read).version;
      const current = previous && await runPrMetadataFileProbe(async () =>
        catalogVersion(await lstat(path.join(commonDir, "gh-stack"), { bigint: true })), this.inventoryDemand);
      if (!previous || previous !== current) this.catalogs.delete(commonDir);
    });
    await Promise.all([...checkouts, ...catalogs]);
    this.demand.signal?.throwIfAborted();
  }
}

export async function readStackClones(directories: readonly string[], demand?: PrMetadataDemand): Promise<Clone[]> {
  return await new StackReadObservation({ priority: () => PR_METADATA_PRIORITY.selected, ...demand }).clones(directories);
}

export async function readLiveStackCatalogs(directories: readonly string[], demand?: PrMetadataDemand): Promise<CatalogRead[]> {
  return await new StackReadObservation({ priority: () => PR_METADATA_PRIORITY.selected, ...demand }).checkoutCatalogs(directories);
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
): Promise<{ stacks: StackSummary[]; worktrees: StackWorktree[] }> {
  const catalog = clone.catalog.status === "ok" ? clone.catalog.catalog : undefined;
  const repositories = new Set(threads.flatMap(({ row }) => (row.prs ?? []).map(prRepository)));
  if (catalog?.stacks.length) repositories.add(catalog.repository.toLowerCase());
  const stacks: StackSummary[] = [];
  if (!repositories.size) return { stacks, worktrees: [] };
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
  if (!plans.length) return { stacks, worktrees: [] };
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
  return { stacks, worktrees };
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
  private readonly pendingInventoryCheckouts = new Map<string, SharedPrMetadataRead<CheckoutLookup>>();
  private readonly inventoryCheckouts = new Map<string, {
    version: string; checkout: Checkout | undefined; expiresAt: number;
  }>();

  constructor(private readonly now: () => number = () => performance.now()) {}

  async preflightCatalogs(directories: readonly string[], observation: StackReadObservation): Promise<CatalogRead[]> {
    if ((observation.demand.priority?.() ?? PR_METADATA_PRIORITY.background) !== PR_METADATA_PRIORITY.background
      || !observation.hints.installedGitVersion) {
      return await observation.preflightCatalogs(directories);
    }
    return await observation.preflightCatalogs(directories, async (cwd) => {
      const candidates = await observation.hints.possibleCommonDirs(cwd);
      return candidates ? await this.readInventoryCheckout(cwd, observation, candidates) : await observation.checkoutLookup(cwd);
    });
  }

  private async sharedInventoryCheckout(
    cwd: string, version: string, demand: PrMetadataDemand, load: (demand: PrMetadataDemand) => Promise<CheckoutLookup>,
  ): Promise<CheckoutLookup> {
    demand.signal?.throwIfAborted();
    const key = JSON.stringify([cwd, version]);
    let pending = this.pendingInventoryCheckouts.get(key);
    if (!pending || pending.signal.aborted) {
      const read = new SharedPrMetadataRead(async (sharedDemand) => {
        try {
          return await load(sharedDemand);
        } finally {
          if (this.pendingInventoryCheckouts.get(key) === read) this.pendingInventoryCheckouts.delete(key);
        }
      });
      this.pendingInventoryCheckouts.set(key, read);
      pending = read;
    }
    return await pending.read(demand);
  }

  private async readInventoryCheckout(
    cwd: string, observation: StackReadObservation, candidates: readonly string[],
  ): Promise<CheckoutLookup> {
    const { hints, inventoryDemand } = observation;
    const identity = candidates.length ? await hints.checkoutIdentity(cwd) : undefined;
    const before = identity && candidates.includes(identity.commonDir) ? identity : undefined;
    const version = before?.version ?? (!candidates.length ? hints.installedGitVersion : undefined);
    const cached = this.inventoryCheckouts.get(cwd);
    if (version && cached?.version === version && cached.expiresAt > this.now()) return cached.checkout;
    this.inventoryCheckouts.delete(cwd);

    const read = async (demand: PrMetadataDemand, locate: () => Promise<CheckoutLookup>, currentHints = hints) => {
      const checkout = await locate();
      if (checkout === "unavailable") return checkout;
      const agreed = before ? checkout?.root === before.root && checkout.commonDir === before.commonDir
        && (await currentHints.checkoutIdentity(cwd))?.version === version : !checkout;
      demand.signal?.throwIfAborted();
      if (version && agreed) {
        const expiresAt = hints.installedGitVersion ? this.now() + 30_000 : Infinity;
        this.inventoryCheckouts.set(cwd, { version, checkout, expiresAt });
        if (this.inventoryCheckouts.size > 2_048) this.inventoryCheckouts.delete(this.inventoryCheckouts.keys().next().value!);
      }
      return checkout;
    };
    return version
      ? await this.sharedInventoryCheckout(cwd, version, inventoryDemand,
        (demand) => read(demand, () => locateCheckout(cwd, demand), createStackCheckoutHints(demand)))
      : await read(inventoryDemand, () => observation.checkoutLookup(cwd, inventoryDemand));
  }

  async read(threads: readonly StackThreadRow[], knownPrs: readonly PrSummary[], directories?: readonly string[],
    activity?: (threadKey: string) => Promise<{ held?: boolean; repair?: boolean }>,
    observation = new StackReadObservation(),
  ) {
    const { demand, hints, inventoryDemand } = observation;
    demand.signal?.throwIfAborted();
    const local = threads.filter((row) => !row.federation);
    const anchorLookups = await Promise.all([...new Set(directories)].map((cwd) => observation.checkoutLookup(cwd)));
    const anchors = anchorLookups.filter((entry) => entry !== undefined && entry !== "unavailable");
    const unavailable: CatalogRead[] = anchorLookups.includes("unavailable") ? [{ status: "unavailable" }] : [];
    const anchorPaths = new Set(directories);
    const scopedClones = new Map(anchors.map((entry) => [entry.commonDir, entry] as const));
    if (directories && !scopedClones.size) return { stacks: [], catalogs: unavailable };

    const eligible = possibleInferredLayers(local, knownPrs);
    const wanted = new Set<string>();
    // Read explicitly requested catalogs even when there is nothing to bind.
    await Promise.all([...scopedClones.keys()].map(async (commonDir) => {
      const catalog = await observation.catalog(commonDir);
      if (catalog.status === "ok" && catalog.catalog.stacks.length) wanted.add(commonDir);
    }));
    const paths = !directories || wanted.size || eligible.size
      ? [...new Set(local.flatMap(threadDirectories))].sort() : [];
    const hinted = new Set<string>();
    const located = new Map<string, Checkout>();
    const unavailablePaths = new Set<string>();
    const scan = new IterableMapper(paths, async (cwd) => {
      const found = anchorPaths.has(cwd) ? undefined : await hints.possibleCommonDirs(cwd);
      if (found && !hints.requiresGitDiscovery) {
        if (found.length) hinted.add(cwd);
        return [cwd, found] as const;
      }
      const checkout = found && hints.installedGitVersion
        ? await this.readInventoryCheckout(cwd, observation, found) : await observation.checkoutLookup(cwd, inventoryDemand);
      if (checkout === "unavailable") {
        unavailablePaths.add(cwd);
        return [cwd, found ?? []] as const;
      }
      if (!checkout) return [cwd, []] as const;
      located.set(cwd, checkout);
      return [cwd, [checkout.commonDir]] as const;
    }, STACK_CHECKOUT_SCAN_LIMITS);
    const possible = new Map<string, readonly string[]>();
    for await (const [cwd, commonDirs] of scan) possible.set(cwd, commonDirs);
    if (!directories) {
      const candidateDirs = new Set([...possible.values()].flat());
      const catalogs = new IterableMapper(candidateDirs, async (commonDir) => ({
        commonDir, present: await hints.hasMarker(commonDir),
      }), STACK_CHECKOUT_SCAN_LIMITS);
      for await (const { commonDir, present } of catalogs) if (present) wanted.add(commonDir);
    }
    const inferredRows = local.filter((row) => row.prs?.some((pr) => eligible.has(prIdentity(pr))));
    const inferredPaths = new Set<string>();
    for (const row of inferredRows) {
      for (const cwd of threadDirectories(row)) {
        inferredPaths.add(cwd);
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
    let retargetedHints: typeof hints | undefined;
    const rediscoveredClones = new Set<string>();
    const verify = new IterableMapper(admitted, async (cwd) => {
      // Explicit anchors already have a live result in this observation.
      const candidates = possible.get(cwd)!;
      const checkout = hinted.has(cwd) ? await this.readInventoryCheckout(cwd, observation, candidates) : located.get(cwd);
      if (checkout === "unavailable") {
        unavailablePaths.add(cwd);
        return { checkout: undefined };
      }
      if (checkout && !directories && !candidates.includes(checkout.commonDir)
        && (inferredPaths.has(cwd)
          || await (retargetedHints ??= createStackCheckoutHints(inventoryDemand)).hasMarker(checkout.commonDir))) {
        wanted.add(checkout.commonDir);
        rediscoveredClones.add(checkout.commonDir);
      }
      return { checkout };
    }, STACK_CHECKOUT_SCAN_LIMITS);
    const verified = new Map<string, Checkout>();
    for await (const { checkout } of verify) if (checkout) verified.set(checkout.cwd, checkout);
    if (rediscoveredClones.size) {
      // A shared alias can move more than the path that exposed the retarget.
      // Refresh hints once for other rows before binding the new clone.
      const refreshed = retargetedHints ??= createStackCheckoutHints(inventoryDemand);
      const siblings = paths.filter((cwd) => !rediscoveredClones.has(verified.get(cwd)?.commonDir ?? ""));
      const recheck = new IterableMapper(siblings, async (cwd) => {
        const candidates = await refreshed.possibleCommonDirs(cwd);
        if (!candidates?.some((commonDir) => rediscoveredClones.has(commonDir))) return { cwd };
        return { cwd, checkout: await locateCheckout(cwd, inventoryDemand) };
      }, STACK_CHECKOUT_SCAN_LIMITS);
      for await (const result of recheck) {
        if (!("checkout" in result)) continue;
        const { cwd, checkout } = result;
        if (!checkout || checkout === "unavailable") verified.delete(cwd);
        else verified.set(cwd, checkout);
      }
    }
    const checkouts = new Map(anchors.map((entry) => [entry.cwd, entry] as const));
    // Keep the existing path order regardless of which probes finish first.
    for (const cwd of paths) {
      const checkout = verified.get(cwd);
      if (checkout) checkouts.set(cwd, checkout);
    }
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
      const catalog = await observation.catalog(checkout.commonDir);
      return {
        catalog,
        ...await projectClone({ ...checkout, catalog }, cloneThreads.get(checkout.commonDir) ?? [], knownPrs, demand),
      };
    }));
    if (directories && unavailablePaths.size && !unavailable.length) {
      const inScope = (cwd: string) => possible.get(cwd)?.some((commonDir) => scopedClones.has(commonDir));
      const scopedRepositories = new Set(inferredRows.filter((row) => threadDirectories(row).some(inScope))
        .flatMap((row) => (row.prs ?? []).filter((pr) => eligible.has(prIdentity(pr))).map(prRepository)));
      const missingSibling = inferredRows.some((row) => {
        const sharesRepository = row.prs?.some((pr) =>
          eligible.has(prIdentity(pr)) && scopedRepositories.has(prRepository(pr)));
        return sharesRepository && threadDirectories(row).some((cwd) =>
          unavailablePaths.has(cwd) && !possible.get(cwd)?.length);
      });
      if ([...unavailablePaths].some(inScope) || missingSibling) {
        unavailable.push({ status: "unavailable" });
      } else {
        // Git's own inventory can identify a catalog-bound thread even when
        // filesystem discovery hints were disabled or inconclusive.
        const trackedWorktrees = results.flatMap(({ stacks, worktrees }) => {
          const branches = new Set(stacks.filter((stack) => !stack.inferred).flatMap((stack) => stack.layers.map(({ branch }) => branch)));
          return worktrees.filter(({ branch }) => branches.has(branch)).map(({ path }) => path);
        });
        const inTrackedWorktree = (cwd: string) => trackedWorktrees.some((root) => {
          const relative = path.relative(root, cwd);
          return !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(".." + path.sep);
        });
        if (trackedWorktrees.length) {
          const unknown = [...unavailablePaths].filter((cwd) => !possible.get(cwd)?.length);
          const matches = new IterableMapper(unknown, async (cwd) => {
            if (inTrackedWorktree(cwd)) return true;
            const resolved = await runPrMetadataFileProbe(() => realpath(cwd), inventoryDemand);
            return Boolean(resolved && inTrackedWorktree(resolved));
          }, STACK_CHECKOUT_SCAN_LIMITS);
          for await (const match of matches) {
            if (match) {
              unavailable.push({ status: "unavailable" });
              break;
            }
          }
        }
      }
    }
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
    }), catalogs: [...results.map(({ catalog }) => catalog), ...unavailable] };
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
