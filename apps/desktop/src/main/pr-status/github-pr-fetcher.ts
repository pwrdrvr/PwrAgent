import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GhStatus, PrChipState, PrSummary } from "@pwragent/shared";
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

/** Default per-call subprocess timeout. */
const DEFAULT_TIMEOUT_MS = 5_000;
/** Re-probe `gh --version` no more than this often. */
const GH_AVAILABLE_CACHE_TTL_MS = 60_000;
/**
 * Re-probe `gh auth status` no more than this often. The auth-status
 * call spawns a subprocess and parses its output; the Applications
 * settings panel mounts every time the user opens that section (and
 * twice in development under React StrictMode). Without this cache
 * each panel open ran `gh auth status` twice. The cached value is
 * still considered fresh enough that switching between panels shows
 * an instant pill instead of a "Checking…" flash.
 *
 * Five minutes matches the ballpark of how often gh's session token
 * could change in practice (login, scope grant, sign-out). Users who
 * just changed their gh login can click "Re-check" — that bypasses
 * the cache via `invalidateGhCaches()`.
 */
const GH_AUTH_STATUS_CACHE_TTL_MS = 5 * 60_000;

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

/**
 * Parsed result of `gh auth status --hostname github.com`. Re-exports the
 * shared `GhStatus` type so tests and the IPC layer can refer to either name.
 */
export type GhAuthStatus = GhStatus;

export type GithubPrFetcherOptions = {
  timeoutMs?: number;
  /** Override the subprocess runner — used by tests to inject canned output. */
  exec?: (
    cwd: string,
    args: string[],
  ) => Promise<{ stdout: string; stderr: string }>;
  /** Override `gh --version` probe — used by tests. */
  probeGhAvailable?: () => Promise<boolean>;
  /** Override `gh auth status` runner — used by tests. */
  runGhAuthStatus?: () => Promise<{ stdout: string; stderr: string; ok: boolean }>;
};

export class GithubPrFetcher {
  private readonly timeoutMs: number;
  private readonly exec: NonNullable<GithubPrFetcherOptions["exec"]>;
  private readonly probeGhAvailable: NonNullable<
    GithubPrFetcherOptions["probeGhAvailable"]
  >;
  private readonly runGhAuthStatus: NonNullable<
    GithubPrFetcherOptions["runGhAuthStatus"]
  >;
  private ghAvailableCache: { value: boolean; fetchedAt: number } | undefined;
  private authStatusCache:
    | { value: GhAuthStatus; fetchedAt: number }
    | undefined;

  constructor(options: GithubPrFetcherOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.exec = options.exec ?? defaultExec(this.timeoutMs);
    this.probeGhAvailable = options.probeGhAvailable ?? defaultProbeGhAvailable;
    this.runGhAuthStatus = options.runGhAuthStatus ?? defaultRunGhAuthStatus;
  }

  async isGhAvailable(): Promise<boolean> {
    if (
      this.ghAvailableCache
      && Date.now() - this.ghAvailableCache.fetchedAt < GH_AVAILABLE_CACHE_TTL_MS
    ) {
      return this.ghAvailableCache.value;
    }
    const value = await this.probeGhAvailable();
    this.ghAvailableCache = { value, fetchedAt: Date.now() };
    return value;
  }

  /**
   * Fetch all open PRs for the given branches in a single `gh pr list` call.
   * Caller batches by cwd (each cwd is a separate repo from gh's POV).
   *
   * Why open-only: merged/closed PRs are terminal states. Once we've stored
   * a `merged` chip on the overlay, we never re-fetch — so this call only
   * needs to surface non-terminal PRs we might want to refresh.
   *
   * Filter by headRefName client-side: gh's `--head` flag accepts only one
   * branch, but `--state open --json …` over the whole repo returns at most
   * a few dozen open PRs which we filter cheaply.
   */
  async fetchOpenPullRequests(params: {
    cwd: string;
    branches: string[];
  }): Promise<PrSummary[]> {
    if (params.branches.length === 0) {
      return [];
    }
    if (!(await this.isGhAvailable())) {
      return [];
    }

    const wanted = new Set(params.branches);
    try {
      const { stdout } = await this.exec(params.cwd, [
        "pr",
        "list",
        "--state",
        "open",
        "--json",
        GH_FIELDS,
        "--limit",
        "30",
      ]);
      const payload = JSON.parse(stdout) as GhPrPayload[];
      return payload
        .filter((row) => wanted.has(row.headRefName))
        .map(parseGhPrPayload);
    } catch (error) {
      fetcherLog.warn("gh pr list failed", {
        cwd: params.cwd,
        branchCount: params.branches.length,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Fetch the latest state for a single (possibly terminal) PR. Uses
   * `gh pr list --state all --head <branch>` so we catch merged/closed
   * states too — this is the one place the renderer asks "give me the
   * authoritative state for this PR right now," typically on first
   * selection of a thread.
   */
  async fetchAllPullRequestsForBranch(params: {
    cwd: string;
    branch: string;
  }): Promise<PrSummary[]> {
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
      return payload.map(parseGhPrPayload);
    } catch (error) {
      fetcherLog.warn("gh pr list (single-branch) failed", {
        cwd: params.cwd,
        branch: params.branch,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Probe `gh auth status` and return parsed installed / logged-in /
   * scopes info for the Applications settings panel. Result is cached
   * for `GH_AUTH_STATUS_CACHE_TTL_MS` so reopening the Applications
   * pane (or React StrictMode's intentional double-mount in dev) does
   * not re-spawn the subprocess. Use `invalidateGhCaches()` (which
   * the Re-check button drives via `recheck: true`) to force a
   * fresh probe.
   *
   * Returns `{ cached }` so callers can decide whether to log — the
   * value is otherwise identical regardless of cache state.
   */
  async getAuthStatus(): Promise<GhAuthStatus & { cached: boolean }> {
    if (
      this.authStatusCache
      && Date.now() - this.authStatusCache.fetchedAt < GH_AUTH_STATUS_CACHE_TTL_MS
    ) {
      return { ...this.authStatusCache.value, cached: true };
    }

    let value: GhAuthStatus;
    if (!(await this.isGhAvailable())) {
      value = {
        installed: false,
        loggedIn: false,
        scopes: [],
        hasRepoScope: false,
        reason: "gh CLI is not installed",
      };
    } else {
      const result = await this.runGhAuthStatus();
      value = parseGhAuthStatus(result);
    }

    this.authStatusCache = { value, fetchedAt: Date.now() };
    return { ...value, cached: false };
  }

  /** Force the next `isGhAvailable` call to re-probe — used by Re-check. */
  invalidateGhAvailable(): void {
    this.ghAvailableCache = undefined;
  }

  /**
   * Clear both the gh-availability cache AND the parsed-auth-status
   * cache. The IPC handler for `getGhStatus({ recheck: true })`
   * routes here so the Re-check button starts from a clean slate.
   */
  invalidateGhCaches(): void {
    this.ghAvailableCache = undefined;
    this.authStatusCache = undefined;
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
      check.status
      && check.status !== "COMPLETED"
      // Some legacy StatusContext entries omit status entirely.
      && check.status !== "STATUS_CONTEXT"
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

/**
 * Parse `gh auth status --hostname github.com` text. Pinned against gh 2.88.1
 * output. Sample (Logged in):
 *
 *     github.com
 *       ✓ Logged in to github.com account huntharo (keyring)
 *       - Active account: true
 *       - Git operations protocol: ssh
 *       - Token: gho_************************************
 *       - Token scopes: 'repo', 'read:org', 'workflow'
 *
 * Sample (Not logged in): "You are not logged into any GitHub hosts."
 */
export function parseGhAuthStatus(input: {
  stdout: string;
  stderr: string;
  ok: boolean;
}): GhAuthStatus {
  // gh writes the human-readable status to stderr; older versions used
  // stdout. Handle both.
  const text = `${input.stdout}\n${input.stderr}`;
  const accountMatch = text.match(
    /Logged in to github\.com account ([^\s]+)/i,
  )
    ?? text.match(/Logged in to github\.com as ([^\s]+)/i);
  const scopesMatch = text.match(/Token scopes:\s*(.+)/i);
  const scopes = scopesMatch
    ? scopesMatch[1]!
        .split(",")
        .map((scope) => scope.trim().replace(/^['"]|['"]$/g, ""))
        .filter(Boolean)
    : [];
  const hasRepoScope = scopes.includes("repo") || scopes.includes("public_repo");
  const loggedIn = Boolean(accountMatch) || /Logged in to github\.com/i.test(text);

  return {
    installed: true,
    loggedIn,
    account: accountMatch?.[1],
    scopes,
    hasRepoScope,
    rawOutput: text.trim(),
    reason: loggedIn
      ? hasRepoScope
        ? undefined
        : "Token is missing the `repo` scope. Run `gh auth refresh -s repo` to grant it."
      : "Run `gh auth login` to sign in to github.com.",
  };
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

async function defaultRunGhAuthStatus(): Promise<{
  stdout: string;
  stderr: string;
  ok: boolean;
}> {
  try {
    const result = await execFileAsync(
      "gh",
      ["auth", "status", "--hostname", "github.com"],
      { timeout: 5_000, encoding: "utf8" },
    );
    return { stdout: result.stdout, stderr: result.stderr, ok: true };
  } catch (error) {
    // gh exits non-zero when not logged in; capture its stderr/stdout for parsing.
    const err = error as { stdout?: string; stderr?: string };
    return {
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? (error instanceof Error ? error.message : ""),
      ok: false,
    };
  }
}
