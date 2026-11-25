import { constants, type BigIntStats } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { IterableMapper } from "@shutterstock/p-map-iterable";
import { buildThreadIdentityKey, type NavigationThreadSummary, type PrSummary } from "@pwragent/shared/contracts/navigation";
import { parseGhStackCatalog, type GhStack, type GhStackBranch, type GhStackCatalogRead } from "@pwragent/shared/stacks/catalog";
import {
  inferPullRequestStacks, stackLayerBinding, stackLayerHealth,
  type StackLayer, type StackLayerPullRequest, type StackSummary, type StackThread, type StackWorktree, type ThreadStackMembership,
} from "@pwragent/shared/stacks/stack-status";
import { resolveCheckState } from "@pwragent/shared/pull-request-rollup";
import { stackAutomationGates } from "@pwragent/shared/stacks/stack-automation";
import { PR_METADATA_PRIORITY, runPrMetadataFileProbe, runPrMetadataGit, SharedPrMetadataRead, type PrMetadataDemand } from "../pr-status/pr-metadata-process";
import { createStoredAttachmentObservation, type PrAttachmentDemand } from "../pr-status/pr-detection";
import { createStackCheckoutHints, STACK_CHECKOUT_SCAN_LIMITS } from "../git-info/stack-checkout-store";

type CatalogRead = GhStackCatalogRead | { status: "missing" | "unavailable" };

const CATALOG_BYTES = 1024 * 1024;
const MAX_BACKGROUND_TTL_REVALIDATIONS_PER_PASS = 16;
const MAX_INVENTORY_CHECKOUTS = 2_048;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

type CatalogObservation = { catalog: CatalogRead; version?: string };

function catalogVersion(info: BigIntStats): string {
  return [info.dev, info.ino, info.mode, info.size, info.mtimeNs, info.ctimeNs].join(":");
}

async function statVersion(target: string): Promise<string> {
  try {
    return catalogVersion(await lstat(target, { bigint: true }));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? "missing" : `err:${code ?? "unknown"}`;
  }
}

async function unavailableCheckoutVersion(
  cwd: string,
  installedGitVersion: string | undefined,
  demand: PrMetadataDemand,
): Promise<string | undefined> {
  return await runPrMetadataFileProbe(async (signal) => {
    const cwdState = await statVersion(cwd);
    signal.throwIfAborted();
    const dotGitState = cwdState === "missing" ? "missing" : await statVersion(path.join(cwd, ".git"));
    return JSON.stringify(["unavailable", cwdState, dotGitState, installedGitVersion ?? "bundled"]);
  }, demand);
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
type InventoryCheckoutResult = { cwd: string; checkout: CheckoutLookup; corroborated: boolean };
type Clone = Checkout & { catalog: CatalogRead };
type CheckoutIdentity = NonNullable<Awaited<ReturnType<ReturnType<typeof createStackCheckoutHints>["checkoutIdentity"]>>>;
type WorktreeRoster = { seed: Checkout; roots: ReadonlySet<string>; configVersion: string; remoteCandidates: string[] };
type RosterMember = { roster: WorktreeRoster; gitDir: string };
type RegisteredWorktrees = {
  commonVersion: string;
  pending: Promise<WorktreeRoster | undefined>;
  ready?: WorktreeRoster;
};

function configCanVaryAcrossWorktrees(config: string, commonDir: string): boolean {
  // Standard linked worktrees have canonical Git directories immediately
  // below this path. Compare conservatively across both gitdir case modes.
  const adminPrefix = path.join(commonDir, "worktrees").split(path.sep).join("/").toLowerCase() + "/";
  return config.split("\0").some((setting) => {
    const key = setting.split("\n", 1)[0];
    // The extension permits a worktree config file. Each registered member,
    // including the seed, has independently proved that file is absent.
    if (key === "core.worktree") return true;
    if (!key.startsWith("includeif.")) return false;
    // Remote URLs are shared if all other includes and config scopes are shared.
    if (key.startsWith("includeif.hasconfig:remote.*.url:") && key.endsWith(".path")) return false;
    const pattern = /^includeif\.gitdir(?:\/i)?:((?:[A-Za-z]:)?\/[^*?\[\\\r\n]+)\.path$/.exec(key)?.[1]?.toLowerCase();
    if (!pattern) return true;
    // A trailing slash in a literal pattern includes its descendants.
    return pattern.startsWith(adminPrefix) || (pattern.endsWith("/") && adminPrefix.startsWith(pattern));
  });
}

async function readEffectiveConfig(cwd: string, demand: PrMetadataDemand): Promise<string> {
  return await git(cwd, ["config", "--includes", "--null", "--list"], demand, true);
}

function effectiveConfigVersion(config: string): string {
  return createHash("sha256").update(config).digest("hex");
}

function rosterRemoteCandidates(config: string): string[] {
  const names = new Set<string>();
  for (const setting of config.split("\0")) {
    const name = /^remote\.(.+)\.[^.]+$/.exec(setting.split("\n", 1)[0])?.[1];
    if (name) names.add(name);
  }
  return [...names];
}

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
  private readonly worktreeInventories = new Map<string, RegisteredWorktrees>();
  // A fresh lookup can replace a checkout at the same path. Its predecessor's
  // roster and identity cannot vouch for that new Git result.
  private readonly rosterByCheckout = new WeakMap<Checkout, RosterMember>();
  private readonly checkoutWitnesses = new WeakMap<Checkout, string>();
  private backgroundTtlRevalidations = 0;
  private readonly reservedTtlRevalidations = new Set<string>();

  constructor(readonly demand: PrMetadataDemand = {}) {
    // A selected request can promote the explicit checkout without putting
    // its speculative inventory work ahead of other selected reads.
    this.inventoryDemand = {
      signal: demand.signal,
      priority: () => Math.min(demand.priority?.() ?? PR_METADATA_PRIORITY.background, PR_METADATA_PRIORITY.page),
    };
    this.hints = createStackCheckoutHints(this.inventoryDemand);
  }

  reserveBackgroundTtlRevalidation(cwd: string, limit: number): boolean {
    if (this.backgroundTtlRevalidations + this.reservedTtlRevalidations.size >= limit) return false;
    this.reservedTtlRevalidations.add(cwd);
    return true;
  }

  /** Cap synchronous TTL revalidations in one background navigation pass. */
  claimBackgroundTtlRevalidation(cwd: string, limit: number): boolean {
    if (!this.reservedTtlRevalidations.delete(cwd)
      && this.backgroundTtlRevalidations + this.reservedTtlRevalidations.size >= limit) return false;
    this.backgroundTtlRevalidations += 1;
    return true;
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

  hasCheckoutLookup(cwd: string): boolean {
    return this.checkouts.has(cwd);
  }

  recordCheckoutWitness(checkout: Checkout, version: string): void {
    this.checkoutWitnesses.set(checkout, version);
  }

  async checkoutsStillMatch(checkouts: Iterable<Checkout>): Promise<boolean> {
    const hints = createStackCheckoutHints(this.inventoryDemand);
    const matches = new IterableMapper(checkouts, async (checkout) => {
      const { cwd, root, commonDir } = checkout;
      const before = this.checkoutWitnesses.get(checkout);
      if (before && (await hints.checkoutIdentity(cwd))?.version === before) return true;
      this.checkoutWitnesses.delete(checkout);
      // A live Git lookup could return the same root and common dir even
      // after this member acquired config that invalidates its attachment proof.
      if (this.rosterByCheckout.has(checkout)) return false;
      const current = await locateCheckout(cwd, this.inventoryDemand);
      return Boolean(current && current !== "unavailable" && current.root === root && current.commonDir === commonDir);
    }, STACK_CHECKOUT_SCAN_LIMITS);
    let unchanged = true;
    for await (const matchesCheckout of matches) unchanged &&= matchesCheckout;
    this.demand.signal?.throwIfAborted();
    return unchanged;
  }

  projectionCheckout(checkout: Checkout): Checkout {
    // A corroborated physical root keeps subsequent bundled Git commands on
    // this clone even if the provider's original alias moves again.
    return !this.hints.requiresGitDiscovery && this.checkoutWitnesses.has(checkout)
      ? { ...checkout, cwd: checkout.root } : checkout;
  }

  readyWorktreeInventory(commonDir: string): WorktreeRoster | undefined {
    return this.worktreeInventories.get(commonDir)?.ready;
  }

  rosterMember(checkout: Checkout): RosterMember | undefined {
    return this.rosterByCheckout.get(checkout);
  }

  async rostersStillMatch(checkouts: Iterable<Checkout>): Promise<boolean> {
    const rosters = new Set<WorktreeRoster>();
    for (const checkout of checkouts) {
      const member = this.rosterMember(checkout);
      if (member) rosters.add(member.roster);
    }
    const matches = await Promise.all([...rosters].map(async ({ seed, configVersion }) => {
      const config = await readEffectiveConfig(seed.root, this.inventoryDemand).catch(() => undefined);
      return config !== undefined && effectiveConfigVersion(config) === configVersion;
    }));
    this.demand.signal?.throwIfAborted();
    return matches.every(Boolean);
  }

  async registeredCheckout(cwd: string, before: CheckoutIdentity, ready?: WorktreeRoster): Promise<Checkout | undefined> {
    if (!before.registeredWorktree || !before.commonVersion || this.hints.requiresGitDiscovery) return undefined;
    let inventory = this.worktreeInventories.get(before.commonDir);
    if (!inventory) {
      const pending = this.readRegisteredWorktrees(cwd, before);
      const entry: RegisteredWorktrees = { commonVersion: before.commonVersion, pending };
      this.worktreeInventories.set(before.commonDir, entry);
      inventory = entry;
      ready = entry.ready = await pending;
    }
    if (inventory.commonVersion !== before.commonVersion) return undefined;
    const roster = await inventory.pending;
    if (!roster?.roots.has(before.root)) return undefined;
    // A witness taken before Git finished the inventory can have changed
    // while Git ran. A later witness already sees changes to that checkout.
    if (roster !== ready && !await this.hasCurrentRegistration(cwd, before)) return undefined;
    const checkout = { cwd, root: before.root, commonDir: before.commonDir };
    this.rosterByCheckout.set(checkout, { roster, gitDir: before.gitDir });
    return checkout;
  }

  private async hasCurrentRegistration(cwd: string, before: CheckoutIdentity): Promise<boolean> {
    const current = await this.hints.checkoutIdentity(cwd);
    return current?.registeredWorktree === true && current.version === before.version;
  }

  private async readRegisteredWorktrees(cwd: string, before: CheckoutIdentity): Promise<WorktreeRoster | undefined> {
    const demand = this.inventoryDemand;
    const seed = this.checkoutLookup(cwd, demand);
    const checkout = await seed;
    if (!checkout || checkout === "unavailable" || checkout.root !== before.root || checkout.commonDir !== before.commonDir) return undefined;
    let roster: WorktreeRoster | undefined;
    try {
      // Follow unconditional includes in all config scopes. Git reports
      // conditional directives even when their target is disabled at the seed.
      const config = await readEffectiveConfig(checkout.root, demand);
      if (!configCanVaryAcrossWorktrees(config, before.commonDir)) {
        const output = await git(checkout.root, ["worktree", "list", "--porcelain", "-z"], demand, true);
        const roots = new Set(worktreeRecords(output).filter(({ entries, branch }) =>
          (branch || entries.includes("detached")) && !entries.some((entry) => /^prunable(?: |$)/.test(entry)))
          .map(({ path }) => path));
        if (roots.has(checkout.root)) {
          roster = { seed: checkout, roots, configVersion: effectiveConfigVersion(config), remoteCandidates: rosterRemoteCandidates(config) };
        }
      }
    } catch {
      demand.signal?.throwIfAborted();
    }
    if (await this.hasCurrentRegistration(cwd, before)) return roster;
    // The exact lookup predates a changed registration. Discard it so the
    // fallback observes the seed's current checkout even if the roster failed.
    if (this.checkouts.get(cwd) === seed) this.checkouts.delete(cwd);
    return undefined;
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

  async revalidateCatalog(commonDir: string): Promise<boolean> {
    const read = this.catalogs.get(commonDir);
    if (!read) return false;
    const previous = await read;
    const current = await runPrMetadataFileProbe(async () => {
      try {
        return catalogVersion(await lstat(path.join(commonDir, "gh-stack"), { bigint: true }));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
        throw error;
      }
    }, this.inventoryDemand);
    if (current === "missing" ? previous.catalog.status === "missing"
      : current !== undefined && current === previous.version) return false;
    const refreshed = observeCatalog(commonDir);
    this.catalogs.set(commonDir, refreshed);
    const next = await refreshed;
    return previous.version !== next.version || previous.catalog.status !== next.catalog.status;
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
    const catalogs = [...this.catalogs.keys()].map((commonDir) => this.revalidateCatalog(commonDir));
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

function worktreeRecords(output: string) {
  return output.split("\0\0").flatMap((record) => {
    const entries = record.split("\0");
    const worktree = entries.find((entry) => entry.startsWith("worktree "))?.slice(9);
    const branch = entries.find((entry) => entry.startsWith("branch refs/heads/"))?.slice(18);
    return worktree ? [{ path: path.normalize(worktree), branch, entries }] : [];
  });
}

function checkedOutWorktrees(output: string): StackWorktree[] {
  return worktreeRecords(output).flatMap(({ path, branch }) => branch ? [{ path, branch }] : []);
}

type Refs = Map<string, { head?: string; upstream?: string }>;

function parseRefs(output: string): Refs {
  return new Map(output.trimEnd().split("\n").flatMap((line) => {
    const [ref, head, upstream] = line.split("\0");
    return ref && head ? [[ref, { head, upstream }]] : [];
  }));
}

const COMMIT_GRAPH_ANSWERS = 4_096;

/**
 * Whether one commit reaches another, and whether every patch of a range is
 * already upstream, are fixed for a pair of commit ids. Only metadata that
 * rewrites the graph can change them: a shallow boundary, grafts, or loose
 * replace refs. Their state scopes a clone's answers, so a projection whose
 * refs are unchanged spends no Git on its layers. Replace refs kept in
 * packed-refs or a reftable are not observed: their scope would change on
 * every ref update and defeat the memo, and stacks do not use replace refs.
 * A reader created after such a change starts with no answers.
 */
class CommitGraphMemo {
  private readonly answers = new Map<string, boolean>();

  async scope(commonDir: string): Promise<string | undefined> {
    const names = ["shallow", path.join("info", "grafts"), path.join("refs", "replace")];
    try {
      const stats = await Promise.all(names.map((name) => lstat(path.join(commonDir, name), { bigint: true })
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
          throw error;
        })));
      return JSON.stringify([commonDir, ...stats.map((stat) => stat && catalogVersion(stat))]);
    } catch {
      // Unknown graph metadata leaves this projection unmemoized.
      return undefined;
    }
  }

  async answer(scope: string | undefined, question: readonly string[], ask: () => Promise<boolean | undefined>): Promise<boolean | undefined> {
    const key = scope && JSON.stringify([scope, ...question]);
    const known = key ? this.answers.get(key) : undefined;
    if (known !== undefined) {
      this.answers.delete(key!);
      this.answers.set(key!, known);
      return known;
    }
    // Failures, timeouts and cancellation are not facts about the graph.
    const answer = await ask();
    if (key && answer !== undefined) {
      this.answers.set(key, answer);
      if (this.answers.size > COMMIT_GRAPH_ANSWERS) this.answers.delete(this.answers.keys().next().value!);
    }
    return answer;
  }
}

/** One clone's commit-graph questions within a projection. */
type CommitGraph = {
  isAncestor(ancestor: string | undefined, head: string | undefined): Promise<boolean | undefined>;
  patchesUpstream(upstream: string, head: string): Promise<boolean | undefined>;
};

function commitGraph(cwd: string, memo: CommitGraphMemo, scope: string | undefined, demand?: PrMetadataDemand): CommitGraph {
  return {
    async isAncestor(ancestor, head) {
      if (!ancestor || !head || !SHA.test(ancestor) || !SHA.test(head)) return undefined;
      if (ancestor === head) return true;
      return await memo.answer(scope, ["is-ancestor", ancestor, head], async () => {
        try {
          await git(cwd, ["merge-base", "--is-ancestor", ancestor, head], demand);
          return true;
        } catch (error) {
          return (error as { code?: number }).code === 1 ? false : undefined;
        }
      });
    },
    async patchesUpstream(upstream, head) {
      if (!SHA.test(upstream) || !SHA.test(head)) return undefined;
      return await memo.answer(scope, ["cherry", upstream, head], async () =>
        await git(cwd, ["cherry", upstream, head], demand).then((output) => !output.trim(), () => undefined));
    },
  };
}

function prRepository(pr: PrSummary): string {
  return `${pr.provider}:${pr.org}/${pr.repo}`.toLowerCase();
}

function sameRepositoryHead(pr: PrSummary): boolean {
  const source = pr.sourceRepository;
  return !source || `${source.provider}:${source.org}/${source.repo}`.toLowerCase() === prRepository(pr);
}

type StackThreadRow = Pick<NavigationThreadSummary, "id" | "source" | "title" | "linkedDirectories" | "prs" | "federation">;
type ValidateStackAttachments = (row: StackThreadRow & { prs: PrSummary[] }, demand: PrAttachmentDemand) => Promise<PrSummary[]>;

function threadDirectories(thread: StackThreadRow): string[] {
  return (thread.linkedDirectories ?? []).map((directory) => directory.worktreePath ?? directory.path);
}

function rosteredCheckoutRoots(checkouts: ReadonlyMap<string, Checkout>, observation: StackReadObservation) {
  const roots = new Map<string, RosterMember & { checkout: Checkout }>();
  for (const checkout of checkouts.values()) {
    const member = observation.rosterMember(checkout);
    if (member) roots.set(checkout.root, { checkout, ...member });
  }
  return roots;
}

function observeStackAttachments(checkouts: ReadonlyMap<string, Checkout>, observation: StackReadObservation, retried: boolean) {
  const { demand, inventoryDemand } = observation;
  // The shared ref proof uses the files backend and no-follow reads.
  const roots = process.platform === "win32" ? undefined : rosteredCheckoutRoots(checkouts, observation);
  const aliasReads = new Map<string, Promise<string | undefined>>();
  const resolveAlias = (cwd: string) => runPrMetadataFileProbe(() => realpath(cwd), inventoryDemand);
  const representative = (member: RosterMember | undefined) => member && {
    root: member.roster.seed.root, gitDir: member.gitDir, remoteCandidates: member.roster.remoteCandidates,
  };
  const storedAttachmentObservation = createStoredAttachmentObservation(async (cwd) => {
    if (!roots?.size) return undefined;
    const exact = checkouts.get(cwd);
    if (exact) return representative(observation.rosterMember(exact));
    if (!path.isAbsolute(cwd)) return undefined;
    let physical = aliasReads.get(cwd);
    if (!physical) {
      physical = resolveAlias(cwd);
      aliasReads.set(cwd, physical);
    }
    const root = await physical;
    return root ? representative(roots.get(root)) : undefined;
  }, retried);
  return {
    demand: { ...demand, storedAttachmentObservation },
    async unchanged() {
      // An alias can move into the roster after exact-path validation has
      // rejected its attachment. Recheck even those that did not share Git.
      const aliases = new IterableMapper(aliasReads, async ([cwd, read]) =>
        await resolveAlias(cwd) === await read, STACK_CHECKOUT_SCAN_LIMITS);
      let aliasesUnchanged = true;
      for await (const unchanged of aliases) aliasesUnchanged &&= unchanged;
      const refsUnchanged = await storedAttachmentObservation.unchanged();
      demand.signal?.throwIfAborted();
      return aliasesUnchanged && refsUnchanged;
    },
  };
}

async function resolveAttachmentCheckouts(
  rows: readonly StackThreadRow[], checkouts: ReadonlyMap<string, Checkout>, clones: ReadonlyMap<string, Checkout>,
  observation: StackReadObservation,
): Promise<Map<string, CheckoutLookup>> {
  const { hints, inventoryDemand } = observation;
  const resolved = new Map<string, CheckoutLookup>();
  if (!clones.size) return resolved;
  const aliases = new Set<string>();
  for (const row of rows) {
    if (!row.prs?.length || !threadDirectories(row).some((cwd) => {
      const checkout = checkouts.get(cwd);
      return checkout && clones.has(checkout.commonDir);
    })) continue;
    for (const pr of row.prs) {
      for (const cwd of pr.linkedDirectoryPaths ?? []) {
        if (!checkouts.has(cwd) && path.isAbsolute(cwd)) aliases.add(cwd);
      }
    }
  }
  const rosteredRoots = rosteredCheckoutRoots(checkouts, observation);
  const scan = new IterableMapper(aliases, async (cwd) => {
    if (!hints.requiresGitDiscovery) {
      const physical = await runPrMetadataFileProbe(() => realpath(cwd).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
        throw error;
      }), inventoryDemand);
      if (physical === null) return [cwd, undefined] as const;
      // Reuse Git's result for the very directory it inspected. A worktree
      // root alone can also be reported by a different clone's core.worktree.
      const known = physical && checkouts.get(physical);
      if (known && known.root === physical) return [cwd, known] as const;
      const registered = physical && rosteredRoots.get(physical);
      if (registered) return [cwd, registered.checkout] as const;
    }
    // An unrecognized or inconclusive filesystem result needs Git. Keep the
    // fallback local to this projection so a retarget is observed on retry.
    return [cwd, await locateCheckout(cwd, inventoryDemand)] as const;
  }, STACK_CHECKOUT_SCAN_LIMITS);
  for await (const [cwd, checkout] of scan) resolved.set(cwd, checkout);
  return resolved;
}

type CloneThread = { row: StackThreadRow; paths: string[] };

function stackPullRequest(pr: PrSummary): StackLayerPullRequest {
  return {
    number: pr.number, lifecycleState: pr.lifecycleState, url: pr.url, title: pr.title?.slice(0, 1024),
    state: pr.state, checkState: resolveCheckState(pr), reviewState: pr.reviewState, mergeState: pr.mergeState,
    checksStillRunning: pr.checksStillRunning, mergeQueue: pr.mergeQueue, mergedAt: pr.mergedAt,
  };
}

async function projectCatalogLayers(input: {
  stack: GhStack;
  refs: Refs;
  prs: readonly PrSummary[];
  worktrees: readonly StackWorktree[];
  threads: readonly StackThread[];
  graph: CommitGraph;
}): Promise<StackLayer[]> {
  const { stack, refs, prs, worktrees, threads, graph } = input;
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
    const parentIntegrated = !retargeted && !parentPr && !parent.pullRequest && index > 0 && trunkTip && parentTip
      ? await graph.patchesUpstream(trunkTip, parentTip)
      : undefined;
    const [baseIsAncestor, remoteIsAncestor] = await Promise.all([
      graph.isAncestor(compareBase, localHead),
      graph.isAncestor(compareRemote, localHead),
    ]);
    return {
      branch: branch.branch, parent: parent.branch, role: binding.role,
      ...(retargeted ? { activeBase: activeParent.branch } : {}),
      health: retargeted && branch.base !== parentTip && !branch.pullRequest?.merged ? "parent_merged" : stackLayerHealth({
        branch,
        parent: activeParent, pr, parentPr: retargeted ? undefined : parentPr, localHead, parentTip, remoteHead,
        baseIsAncestor, remoteIsAncestor, parentIntegrated, ambiguous: binding.role === "ambiguous",
      }),
      ...(pr ? { pullRequest: stackPullRequest(pr) } : number !== undefined ? { pullRequest: {
        number, lifecycleState: branch.pullRequest?.merged ? "merged" : undefined,
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
  clone: Clone, threads: readonly CloneThread[], knownPrs: readonly PrSummary[], memo: CommitGraphMemo, demand?: PrMetadataDemand,
): Promise<{ stacks: StackSummary[]; worktrees: StackWorktree[]; observed: Map<string, PrSummary> }> {
  const catalog = clone.catalog.status === "ok" ? clone.catalog.catalog : undefined;
  const repositories = new Set(threads.flatMap(({ row }) => (row.prs ?? []).map(prRepository)));
  if (catalog?.stacks.length) repositories.add(catalog.repository.toLowerCase());
  const stacks: StackSummary[] = [];
  const observed = new Map<string, PrSummary>();
  if (!repositories.size) return { stacks, worktrees: [], observed };
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
  if (!plans.length) return { stacks, worktrees: [], observed };
  const [worktreeOutput, refOutput, graphScope] = await Promise.all([
    git(clone.cwd, ["worktree", "list", "--porcelain", "-z"], demand).catch(() => ""),
    git(clone.cwd, ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(upstream)", "refs/heads/", "refs/remotes/"], demand).catch(() => ""),
    memo.scope(clone.commonDir),
  ]);
  const graph = commitGraph(clone.cwd, memo, graphScope, demand);
  const worktrees = checkedOutWorktrees(worktreeOutput);
  const refs = parseRefs(refOutput);
  const cloneKey = createHash("sha256").update(clone.commonDir).digest("hex").slice(0, 24);
  const busy = Boolean(catalog?.stacks.length) && await stackJournalInFlight(clone.commonDir);
  for (const { repository, catalogStacks, prs, bindings, inferred } of plans) {
    for (const pr of prs) observed.set(prIdentity(pr), pr);
    const prefix = `${cloneKey}:${repository}`;
    for (const stack of catalogStacks) {
      if (!stack.branches.length) continue;
      const name = stack.branches[0]!.branch;
      const layers = await projectCatalogLayers({ stack, refs, prs, worktrees, threads: bindings, graph });
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
              && await graph.isAncestor(pr.baseSha, pr.headSha) ? "in_sync" : "unknown",
          pullRequest: stackPullRequest(pr),
          ...("thread" in binding ? { thread: { key: binding.thread.key, title: binding.thread.title } } : {}),
        };
      }));
      stacks.push({ key: `${prefix}:inferred:${chain[0]!.number}`, name, repository, inferred: true, trunk: chain[0]!.baseRefName!, layers });
    }
  }
  return { stacks, worktrees, observed };
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
  private readonly pendingInventoryCheckouts = new Map<string, SharedPrMetadataRead<InventoryCheckoutResult>>();
  private readonly inventoryCheckouts = new Map<string, {
    version: string; checkout: CheckoutLookup; expiresAt: number;
  }>();
  private readonly deferredTtlRevalidations = new Set<string>();

  /** Lives as long as this reader, so every projection it makes shares the answers. */
  private readonly commitGraph = new CommitGraphMemo();

  constructor(
    private readonly now: () => number = () => performance.now(),
    private readonly backgroundTtlRevalidationBudget = MAX_BACKGROUND_TTL_REVALIDATIONS_PER_PASS,
  ) {}

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
    cwd: string, version: string, demand: PrMetadataDemand, load: (demand: PrMetadataDemand) => Promise<InventoryCheckoutResult>,
  ): Promise<InventoryCheckoutResult> {
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

  private claimBackgroundTtlRevalidation(cwd: string, observation: StackReadObservation): boolean {
    if (observation.claimBackgroundTtlRevalidation(cwd, this.backgroundTtlRevalidationBudget)) {
      this.deferredTtlRevalidations.delete(cwd);
      return true;
    }
    this.deferredTtlRevalidations.add(cwd);
    if (this.deferredTtlRevalidations.size > MAX_INVENTORY_CHECKOUTS) {
      this.deferredTtlRevalidations.delete(this.deferredTtlRevalidations.values().next().value!);
    }
    return false;
  }

  private async readInventoryCheckout(
    cwd: string,
    observation: StackReadObservation,
    candidates: readonly string[],
    useWorktreeInventory = false,
    options: { allowUnavailableCache?: boolean; budgetTtlRevalidation?: boolean; hasHints?: boolean } = {},
  ): Promise<CheckoutLookup> {
    const { hints, inventoryDemand } = observation;
    const hasHints = options.hasHints !== false;
    const allowUnavailableCache = options.allowUnavailableCache === true;
    const budgetTtlRevalidation = options.budgetTtlRevalidation === true;
    const ready = hasHints && useWorktreeInventory ? observation.readyWorktreeInventory(candidates[0]!) : undefined;
    const identity = hasHints && candidates.length ? await hints.checkoutIdentity(cwd) : undefined;
    const before = identity && candidates.includes(identity.commonDir) ? identity : undefined;
    const checkRegistration = hasHints && useWorktreeInventory && before?.registeredWorktree;
    // If hints find a repository but cannot verify its checkout, the .git
    // marker alone cannot witness changes such as edits to config.worktree.
    const version = before?.version
      ?? (candidates.length ? undefined
        : hasHints ? hints.installedGitVersion
        : allowUnavailableCache
          ? await unavailableCheckoutVersion(cwd, hints.installedGitVersion, inventoryDemand)
          : undefined);
    const key = (!hints.requiresGitDiscovery ? before?.physicalDirectory : undefined) ?? cwd;
    const recordWitness = (checkout: CheckoutLookup, corroborated: boolean) => {
      if (before && checkout && checkout !== "unavailable" && corroborated) {
        observation.recordCheckoutWitness(checkout, before.version);
      }
      return checkout;
    };
    const cached = this.inventoryCheckouts.get(key);
    if (
      !checkRegistration
      && version
      && cached?.version === version
      && (cached.checkout !== "unavailable" || allowUnavailableCache)
    ) {
      const fresh = cached.expiresAt > this.now();
      if (fresh || (budgetTtlRevalidation && !this.claimBackgroundTtlRevalidation(cwd, observation))) {
        return cached.checkout === "unavailable"
          ? "unavailable"
          : recordWitness(cached.checkout && { ...cached.checkout, cwd }, true);
      }
    }
    if (!cached || cached.version !== version) {
      this.inventoryCheckouts.delete(key);
    }

    const remember = (checkout: CheckoutLookup) => {
      // Roster admission depends on effective config that can change between
      // observations, including protected config outside this repository.
      if (!version || checkRegistration) return;
      if (checkout === "unavailable" && !allowUnavailableCache) return;
      const expiresAt = checkout === "unavailable" || hints.installedGitVersion ? this.now() + 30_000 : Infinity;
      this.deferredTtlRevalidations.delete(cwd);
      this.inventoryCheckouts.delete(key);
      this.inventoryCheckouts.set(key, { version, checkout, expiresAt });
      if (this.inventoryCheckouts.size > MAX_INVENTORY_CHECKOUTS) this.inventoryCheckouts.delete(this.inventoryCheckouts.keys().next().value!);
    };
    if (checkRegistration) {
      const checkout = await observation.registeredCheckout(cwd, before, ready);
      if (checkout) {
        inventoryDemand.signal?.throwIfAborted();
        return recordWitness(checkout, true);
      }
    }

    const read = async (demand: PrMetadataDemand, locate: () => Promise<CheckoutLookup>, currentHints = hints) => {
      const checkout = await locate();
      if (checkout === "unavailable") {
        if (allowUnavailableCache && version) {
          const stillSame = before
            ? (await currentHints.checkoutIdentity(cwd))?.version === version
            : (await unavailableCheckoutVersion(cwd, currentHints.installedGitVersion, demand)) === version;
          demand.signal?.throwIfAborted();
          if (stillSame) remember("unavailable");
        }
        return { cwd, checkout, corroborated: false };
      }
      const corroborated = before ? checkout?.root === before.root && checkout.commonDir === before.commonDir
        && (await currentHints.checkoutIdentity(cwd))?.version === version : hasHints && !checkout;
      demand.signal?.throwIfAborted();
      if (corroborated) remember(checkout);
      return { cwd, checkout, corroborated };
    };
    if (!version || observation.hasCheckoutLookup(cwd)) {
      const result = await read(inventoryDemand, () => observation.checkoutLookup(cwd, inventoryDemand));
      return recordWitness(result.checkout, result.corroborated);
    }
    const result = await this.sharedInventoryCheckout(key, version, inventoryDemand,
      (demand) => read(demand, () => locateCheckout(cwd, demand), createStackCheckoutHints(demand)));
    const { checkout } = result;
    if (result.cwd === cwd) return recordWitness(checkout, result.corroborated);
    // Another spelling can use only positive evidence for its verified
    // physical checkout. A moved or unreadable alias speaks for itself.
    if (before && result.corroborated && checkout && checkout !== "unavailable"
      && checkout.root === before.root && checkout.commonDir === before.commonDir
      && (await hints.checkoutIdentity(cwd))?.version === version) return recordWitness({ ...checkout, cwd }, true);
    return await observation.checkoutLookup(cwd, inventoryDemand);
  }

  async read(threads: readonly StackThreadRow[], knownPrs: readonly PrSummary[], directories?: readonly string[],
    activity?: (threadKey: string) => Promise<{ held?: boolean; repair?: boolean }>,
    observation = new StackReadObservation(), validateAttachments?: ValidateStackAttachments,
  ) {
    return await this.readProjection(threads, knownPrs, directories, activity, observation, false, validateAttachments);
  }

  private async readProjection(threads: readonly StackThreadRow[], knownPrs: readonly PrSummary[],
    directories: readonly string[] | undefined, activity: ((threadKey: string) => Promise<{ held?: boolean; repair?: boolean }>) | undefined,
    observation: StackReadObservation, retried: boolean, validateAttachments?: ValidateStackAttachments,
  ): Promise<{ stacks: StackSummary[]; catalogs: CatalogRead[] }> {
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
    const backgroundNavigation = !directories
      && (demand.priority?.() ?? PR_METADATA_PRIORITY.background) === PR_METADATA_PRIORITY.background;
    if (backgroundNavigation && this.deferredTtlRevalidations.size) {
      const currentPaths = new Set(paths);
      // Reserve slots before the concurrent probes so faster checkouts cannot
      // take them again after another TTL window elapses.
      for (const cwd of this.deferredTtlRevalidations) {
        if (!currentPaths.has(cwd)) continue;
        if (!observation.reserveBackgroundTtlRevalidation(cwd, this.backgroundTtlRevalidationBudget)) break;
        this.deferredTtlRevalidations.delete(cwd);
      }
    }
    const scan = new IterableMapper(paths, async (cwd) => {
      const found = anchorPaths.has(cwd) ? undefined : await hints.possibleCommonDirs(cwd);
      if (found && !hints.requiresGitDiscovery) {
        if (found.length) hinted.add(cwd);
        return [cwd, found] as const;
      }
      const checkout = (found && hints.installedGitVersion) || (backgroundNavigation && !anchorPaths.has(cwd))
        ? await this.readInventoryCheckout(cwd, observation, found ?? [], false, {
            allowUnavailableCache: backgroundNavigation,
            budgetTtlRevalidation: backgroundNavigation,
            hasHints: found !== undefined,
          })
        : await observation.checkoutLookup(cwd, inventoryDemand);
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
    const unprovenAttachments = local.filter((row) => row.prs?.some((pr) => !pr.linkedDirectoryPaths?.length));
    for (const row of unprovenAttachments) {
      const paths = threadDirectories(row);
      if (!paths.some(participates)) continue;
      for (const cwd of paths) if (possible.get(cwd)?.length) admitted.add(cwd);
    }
    const checkoutCounts = new Map<string, number>();
    if (!directories && !hints.requiresGitDiscovery
      && (demand.priority?.() ?? PR_METADATA_PRIORITY.background) === PR_METADATA_PRIORITY.background) {
      for (const cwd of admitted) {
        const candidates = possible.get(cwd);
        if (candidates?.length === 1) checkoutCounts.set(candidates[0]!, (checkoutCounts.get(candidates[0]!) ?? 0) + 1);
      }
    }
    let retargetedHints: typeof hints | undefined;
    const rediscoveredClones = new Set<string>();
    const verify = new IterableMapper(admitted, async (cwd) => {
      // Explicit anchors already have a live result in this observation.
      const candidates = possible.get(cwd)!;
      // A seed, config read and roster must save work even when the clone
      // has a primary checkout alongside its linked worktrees.
      const useWorktreeInventory = candidates.length === 1 && (checkoutCounts.get(candidates[0]!) ?? 0) >= 5;
      const checkout = hinted.has(cwd)
        ? await this.readInventoryCheckout(cwd, observation, candidates, useWorktreeInventory, {
            allowUnavailableCache: backgroundNavigation,
            budgetTtlRevalidation: backgroundNavigation,
          })
        : located.get(cwd);
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
        if (checkout === "unavailable") unavailablePaths.add(cwd);
        else unavailablePaths.delete(cwd);
        if (checkout && checkout !== "unavailable") verified.set(cwd, checkout);
        else verified.delete(cwd);
      }
      // A row newly admitted through the destination may have other linked
      // clones. Verify those before assigning any attachment without paths.
      const otherPaths = new Set<string>();
      for (const row of unprovenAttachments) {
        const paths = threadDirectories(row);
        if (!paths.some((cwd) => rediscoveredClones.has(verified.get(cwd)?.commonDir ?? ""))) continue;
        for (const cwd of paths) if (!verified.has(cwd)) otherPaths.add(cwd);
      }
      const verifyOtherPaths = new IterableMapper(otherPaths, async (cwd) => {
        const candidates = await refreshed.possibleCommonDirs(cwd);
        const checkout = candidates?.length === 0 && !refreshed.requiresGitDiscovery
          ? undefined : await locateCheckout(cwd, inventoryDemand);
        return { cwd, checkout };
      }, STACK_CHECKOUT_SCAN_LIMITS);
      for await (const { cwd, checkout } of verifyOtherPaths) {
        if (checkout === "unavailable") unavailablePaths.add(cwd);
        else {
          unavailablePaths.delete(cwd);
          if (checkout) verified.set(cwd, checkout);
        }
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
    const attachments = validateAttachments && observeStackAttachments(checkouts, observation, retried);
    let validatedAny = false;
    const rows = validateAttachments && attachments ? await Promise.all(local.map(async (row) => {
      if (!row.prs?.length || !threadDirectories(row).some((cwd) => {
        const checkout = checkouts.get(cwd);
        return checkout && cloneCheckouts.has(checkout.commonDir);
      })) return row;
      validatedAny = true;
      return { ...row, prs: await validateAttachments({ ...row, prs: row.prs }, attachments.demand) };
    })) : local;
    demand.signal?.throwIfAborted();
    const attachmentCheckouts = await resolveAttachmentCheckouts(rows, checkouts, cloneCheckouts, observation);
    // Scoped admission used the initial catalog. A change during discovery
    // requires fresh admission before projection can assert settlement.
    if (scopedClones.size && (await Promise.all(
      [...scopedClones.keys()].map((commonDir) => observation.revalidateCatalog(commonDir)),
    )).some(Boolean)) {
      if (retried) return { stacks: [], catalogs: [{ status: "unavailable" }] };
      return await this.readProjection(threads, knownPrs, directories, activity, new StackReadObservation(demand), true, validateAttachments);
    }
    const cloneThreads = new Map<string, CloneThread[]>();
    for (const row of rows) {
      const pathsByClone = new Map<string, string[]>();
      const rowPaths = threadDirectories(row);
      for (const cwd of rowPaths) {
        const checkout = checkouts.get(cwd);
        if (!checkout) continue;
        pathsByClone.set(checkout.commonDir, [...pathsByClone.get(checkout.commonDir) ?? [], checkout.root]);
      }
      for (const [commonDir, paths] of pathsByClone) {
        const entries = cloneThreads.get(commonDir) ?? [];
        const prs = row.prs?.filter((pr) => {
          if (!pr.linkedDirectoryPaths?.length) {
            return pathsByClone.size === 1 && !rowPaths.some((cwd) => unavailablePaths.has(cwd));
          }
          const provenance = pr.linkedDirectoryPaths.map((cwd) => checkouts.get(cwd) ?? attachmentCheckouts.get(cwd));
          if (provenance.some((checkout) => checkout && checkout !== "unavailable"
            && checkout.commonDir === commonDir && paths.includes(checkout.root))) return true;
          // An unresolved attachment can hide a layer the scoped gate needs.
          if (!unavailable.length && scopedClones.has(commonDir) && provenance.includes("unavailable")) {
            unavailable.push({ status: "unavailable" });
          }
          return false;
        });
        entries.push({ row: { ...row, prs }, paths });
        cloneThreads.set(commonDir, entries);
      }
    }
    const results = await Promise.all([...cloneCheckouts.values()].map(async (checkout) => {
      const catalog = await observation.catalog(checkout.commonDir);
      return {
        catalog,
        ...await projectClone({ ...(validatedAny ? observation.projectionCheckout(checkout) : checkout), catalog },
          cloneThreads.get(checkout.commonDir) ?? [], knownPrs, this.commitGraph, demand),
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
    const stacks = results.flatMap(({ stacks, observed }) => stacks.map((stack) => ({ stack, observed })));
    const threadKeys = new Set(stacks.flatMap(({ stack }) => stack.layers.flatMap((layer) => layer.thread ? [layer.thread.key] : [])));
    const activityByThread = new Map(await Promise.all([...threadKeys].map(async (key) => [key, await activity?.(key)] as const)));
    demand.signal?.throwIfAborted();
    const witnessedCheckouts = validatedAny ? checkouts.values() : [...checkouts.values()].filter((checkout) => observation.rosterMember(checkout));
    if (!await observation.checkoutsStillMatch(witnessedCheckouts) || !await observation.rostersStillMatch(checkouts.values())
      || (validatedAny && !await attachments!.unchanged())) {
      if (retried) return { stacks: [], catalogs: [{ status: "unavailable" }] };
      return await this.readProjection(threads, knownPrs, directories, activity, new StackReadObservation(demand), true, validateAttachments);
    }
    return { stacks: stacks.map(({ stack, observed }) => {
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

let desktopStackReader: StackReader | undefined;

/** Share inventory checkout and commit-graph caches across navigation and PR services. */
export function getDesktopStackReader(): StackReader {
  return desktopStackReader ??= new StackReader();
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
