import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PrChipState, PrSummary } from "@pwragent/shared";
import { getMainLogger } from "../log";

const execFileAsync = promisify(execFile);
const fetcherLog = getMainLogger("pwragent:pr-fetcher");

/** Fields requested from `gh pr list --json …`. Pinned by characterization
 *  against `gh 2.88.1` against pwrdrvr/PwrAgent on 2026-05-04. */
const GH_FIELDS = [
  "number",
  "url",
  "state",
  "isDraft",
  "mergedAt",
  "headRefName",
  "headRepository",
  "headRepositoryOwner",
  "statusCheckRollup",
].join(",");

const DEFAULT_CACHE_TTL_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 5_000;

/** Subset of fields returned by `gh pr list --json …` that we actually read. */
type GhPrPayload = {
  number: number;
  url: string;
  state: string;
  isDraft: boolean;
  mergedAt: string | null;
  headRefName: string;
  headRepository: { name?: string } | null;
  headRepositoryOwner: { login?: string } | null;
  statusCheckRollup: GhCheckRunPayload[] | null;
};

type GhCheckRunPayload = {
  __typename?: string;
  conclusion?: string | null;
  status?: string;
  name?: string;
};

type CacheEntry = {
  fetchedAt: number;
  prs: PrSummary[];
};

export type GithubPrFetcherOptions = {
  cacheTtlMs?: number;
  timeoutMs?: number;
  /** Override the subprocess runner — used by tests to inject canned output. */
  exec?: (
    cwd: string,
    args: string[],
  ) => Promise<{ stdout: string; stderr: string }>;
  /** Override `gh --version` probe — used by tests. */
  probeGhAvailable?: () => Promise<boolean>;
};

export class GithubPrFetcher {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly cacheTtlMs: number;
  private readonly timeoutMs: number;
  private readonly exec: NonNullable<GithubPrFetcherOptions["exec"]>;
  private readonly probeGhAvailable: NonNullable<
    GithubPrFetcherOptions["probeGhAvailable"]
  >;
  private ghAvailableCache: boolean | undefined;

  constructor(options: GithubPrFetcherOptions = {}) {
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.exec = options.exec ?? defaultExec(this.timeoutMs);
    this.probeGhAvailable = options.probeGhAvailable ?? defaultProbeGhAvailable;
  }

  async isGhAvailable(): Promise<boolean> {
    if (this.ghAvailableCache !== undefined) {
      return this.ghAvailableCache;
    }
    this.ghAvailableCache = await this.probeGhAvailable();
    return this.ghAvailableCache;
  }

  async fetchForBranch(params: {
    cwd: string;
    branch: string;
  }): Promise<PrSummary[]> {
    const cacheKey = `${params.cwd}::${params.branch}`;
    const entry = this.cache.get(cacheKey);
    if (entry && Date.now() - entry.fetchedAt < this.cacheTtlMs) {
      return entry.prs;
    }

    if (!(await this.isGhAvailable())) {
      return [];
    }

    try {
      const { stdout } = await this.exec(params.cwd, [
        "pr",
        "list",
        "--state",
        "all",
        "--head",
        params.branch,
        "--json",
        GH_FIELDS,
        "--limit",
        "5",
      ]);
      const payload = JSON.parse(stdout) as GhPrPayload[];
      const prs = payload.map(parseGhPrPayload);
      this.cache.set(cacheKey, { fetchedAt: Date.now(), prs });
      return prs;
    } catch (error) {
      // Network out, gh auth missing, branch not pushed, etc. — log + cache
      // a stale-empty so we don't hammer the subprocess on every render.
      fetcherLog.warn("gh pr list failed", {
        cwd: params.cwd,
        branch: params.branch,
        error: error instanceof Error ? error.message : String(error),
      });
      this.cache.set(cacheKey, { fetchedAt: Date.now(), prs: [] });
      return [];
    }
  }

  /** Test/dev hook — wipe everything. */
  clearCache(): void {
    this.cache.clear();
    this.ghAvailableCache = undefined;
  }
}

/**
 * Map a `gh pr list` row to our PrSummary. Exported for direct testing
 * without invoking the subprocess.
 */
export function parseGhPrPayload(row: GhPrPayload): PrSummary {
  return {
    number: row.number,
    org: row.headRepositoryOwner?.login ?? "",
    repo: row.headRepository?.name ?? "",
    state: deriveChipState(row),
    url: row.url,
  };
}

export function deriveChipState(row: GhPrPayload): PrChipState {
  if (row.state === "MERGED") return "merged";
  if (row.state === "CLOSED") return "closed";
  // OPEN past this point.
  if (row.isDraft) return "draft";

  const checks = row.statusCheckRollup ?? [];
  if (checks.length === 0) return "unknown";

  const failingConclusions = new Set([
    "FAILURE",
    "CANCELLED",
    "TIMED_OUT",
    "STARTUP_FAILURE",
    "ACTION_REQUIRED",
  ]);
  const passingConclusions = new Set([
    "SUCCESS",
    "SKIPPED",
    "NEUTRAL",
    "STALE",
  ]);

  let pendingCount = 0;
  for (const check of checks) {
    if (check.conclusion && failingConclusions.has(check.conclusion)) {
      return "failing";
    }
    if (
      check.status &&
      check.status !== "COMPLETED" &&
      // Some legacy StatusContext entries omit status entirely.
      check.status !== "STATUS_CONTEXT"
    ) {
      pendingCount += 1;
    } else if (!check.conclusion) {
      pendingCount += 1;
    } else if (!passingConclusions.has(check.conclusion)) {
      // Conclusion we don't recognize as either pass or fail — be conservative.
      return "unknown";
    }
  }
  if (pendingCount > 0) return "pending";
  return "passing";
}

function defaultExec(
  timeoutMs: number,
): NonNullable<GithubPrFetcherOptions["exec"]> {
  return async (cwd, args) => {
    const result = await execFileAsync("gh", args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      encoding: "utf8",
    });
    return { stdout: result.stdout, stderr: result.stderr };
  };
}

async function defaultProbeGhAvailable(): Promise<boolean> {
  try {
    await execFileAsync("gh", ["--version"], { timeout: 2_000 });
    return true;
  } catch {
    return false;
  }
}
