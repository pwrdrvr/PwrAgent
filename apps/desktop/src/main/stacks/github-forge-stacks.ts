import type { PrSummary } from "@pwragent/shared/contracts/navigation";
import type { GhStack } from "@pwragent/shared/stacks/catalog";
import type { ForgeRepository } from "../pr-status/forge-tool-contract";
import { getMainLogger } from "../log";

/**
 * Stacks that exist on GitHub: made on github.com or with `gh stack`. PwrAgent
 * otherwise knows a stack only from a `gh stack` catalog in a clone or from
 * open PRs chained by base branch. A stack made on github.com has no catalog,
 * and its chain disappears when GitHub retargets a layer to trunk after the
 * layers below it merge, though GitHub still holds that layer in the stack.
 *
 * The status poll carries each PR's place in its stack for free
 * (`PrSummary.githubStack`), but not the other members. Their list costs one
 * `GET /stacks/{number}`, made only when it can have changed: a stack seen for
 * the first time, a new size, a member that merged, closed or was retargeted
 * since the last read, or a merge that read the stack anyway. In memory only:
 * the next poll after a restart learns it again.
 */

const log = getMainLogger("pwragent:github-forge-stacks");

export type GithubForgeStackLayer = {
  number: number;
  branch: string;
  head?: string;
  base?: string;
  open: boolean;
  merged: boolean;
};

export type GithubForgeStack = {
  /** `host:owner/repo`, lowercase, as the stack reader keys repositories. */
  repository: string;
  number: number;
  trunk: string;
  /** Bottom first. */
  layers: GithubForgeStackLayer[];
};

/** The same repository key the stack reader and merge guard use. */
export function githubForgeStackRepository(repository: Pick<ForgeRepository, "host" | "owner" | "repo">): string {
  return `${repository.host}:${repository.owner}/${repository.repo}`.toLowerCase();
}

const MAX_STACKS = 256;
/** Least time between two reads of one stack's members that the poll asks for. */
const MIN_READ_INTERVAL_MS = 60_000;

const stacks = new Map<string, GithubForgeStack>();

const stackKey = (repository: string, number: number) => `${repository}#${number}`;

type RawLayer = {
  number?: unknown;
  state?: unknown;
  merged_at?: unknown;
  head?: { ref?: unknown; sha?: unknown } | null;
  base?: { ref?: unknown; sha?: unknown } | null;
};

/** Read a `GET /stacks/{number}` answer. Undefined unless every member is whole. */
export function parseGithubForgeStack(
  repository: Pick<ForgeRepository, "host" | "owner" | "repo">,
  number: number,
  value: unknown,
): GithubForgeStack | undefined {
  const body = value && typeof value === "object" ? value as { base?: { ref?: unknown } | null; pull_requests?: unknown } : undefined;
  const trunk = typeof body?.base?.ref === "string" && body.base.ref ? body.base.ref : undefined;
  if (!trunk || !Array.isArray(body?.pull_requests) || !body.pull_requests.length) return undefined;
  const layers: GithubForgeStackLayer[] = [];
  for (const raw of body.pull_requests as RawLayer[]) {
    const layerNumber = raw?.number;
    const branch = raw?.head?.ref;
    if (typeof layerNumber !== "number" || !Number.isSafeInteger(layerNumber) || layerNumber < 1
      || typeof branch !== "string" || !branch) return undefined;
    const merged = typeof raw.merged_at === "string" && raw.merged_at.length > 0;
    layers.push({
      number: layerNumber, branch,
      ...(typeof raw.head?.sha === "string" && raw.head.sha ? { head: raw.head.sha } : {}),
      ...(typeof raw.base?.ref === "string" && raw.base.ref ? { base: raw.base.ref } : {}),
      open: !merged && raw.state === "open",
      merged,
    });
  }
  return { repository: githubForgeStackRepository(repository), number, trunk, layers };
}

export function recordGithubForgeStack(stack: GithubForgeStack): void {
  const key = stackKey(stack.repository, stack.number);
  stacks.delete(key);
  stacks.set(key, stack);
  if (stacks.size > MAX_STACKS) stacks.delete(stacks.keys().next().value!);
}

export function readGithubForgeStack(repository: string, number: number): GithubForgeStack | undefined {
  return stacks.get(stackKey(repository.toLowerCase(), number));
}

export function githubForgeStacksIn(repository: string): GithubForgeStack[] {
  const prefix = `${repository.toLowerCase()}#`;
  return [...stacks.entries()].filter(([key]) => key.startsWith(prefix)).map(([, stack]) => stack);
}

/** For tests: start from a process that has read no stack. */
export function forgetGithubForgeStacks(): void {
  stacks.clear();
}

/**
 * The stack as a `gh stack` catalog entry, which the stack reader already
 * projects, merged and retargeted layers included. No fork point is known
 * for a layer, so the reader claims no local sync state for it.
 */
export function githubForgeStackCatalog(stack: GithubForgeStack): GhStack {
  return {
    id: `github-stack-${stack.number}`,
    number: stack.number,
    trunk: { branch: stack.trunk },
    branches: stack.layers.map((layer) => ({
      branch: layer.branch,
      ...(layer.head ? { head: layer.head } : {}),
      pullRequest: { number: layer.number, merged: layer.merged },
    })),
  };
}

/** Why a poll's view of `pr` says its stack's member list may have changed, or undefined. */
export function githubForgeStackReadReason(pr: PrSummary, known: GithubForgeStack | undefined): string | undefined {
  const place = pr.githubStack;
  if (!place) return undefined;
  if (!known) return "first seen";
  if (known.layers.length !== place.size) return "size changed";
  const layer = known.layers.find((candidate) => candidate.number === pr.number);
  if (!layer) return "member missing";
  if (layer.open !== (pr.lifecycleState === "open")) return "member state changed";
  if (pr.baseRefName && layer.base && pr.baseRefName !== layer.base) return "member retargeted";
  return undefined;
}

/**
 * Reads a stack's members when the poll shows they may have changed. One
 * read per stack at a time, at most one a minute per stack.
 */
export class GithubForgeStackDiscovery {
  private readonly inFlight = new Set<string>();
  private readonly lastRead = new Map<string, number>();

  constructor(private readonly options: {
    read: (repository: ForgeRepository, path: string) => Promise<unknown>;
    learned: (stack: GithubForgeStack) => void;
    now?: () => number;
  }) {}

  observe(prs: readonly PrSummary[]): void {
    for (const pr of prs) {
      const place = pr.githubStack;
      if (!place || !pr.org || !pr.repo) continue;
      const repository: ForgeRepository = { provider: "github", host: pr.provider, owner: pr.org, repo: pr.repo };
      const key = stackKey(githubForgeStackRepository(repository), place.number);
      const reason = githubForgeStackReadReason(pr, stacks.get(key));
      if (!reason || this.inFlight.has(key)) continue;
      const now = (this.options.now ?? Date.now)();
      if (now - (this.lastRead.get(key) ?? -Infinity) < MIN_READ_INTERVAL_MS) continue;
      this.lastRead.set(key, now);
      if (this.lastRead.size > MAX_STACKS) this.lastRead.delete(this.lastRead.keys().next().value!);
      this.inFlight.add(key);
      const path = `repos/${encodeURIComponent(pr.org)}/${encodeURIComponent(pr.repo)}/stacks/${place.number}`;
      void this.options.read(repository, path)
        .then((value) => {
          const stack = parseGithubForgeStack(repository, place.number, value);
          if (!stack) {
            log.debug("GitHub stack read returned no usable members", { stack: key, reason });
            return;
          }
          recordGithubForgeStack(stack);
          this.options.learned(stack);
        })
        .catch((error: unknown) => log.debug("GitHub stack read failed", {
          stack: key, reason, error: error instanceof Error ? error.message : String(error),
        }))
        .finally(() => this.inFlight.delete(key));
    }
  }
}
