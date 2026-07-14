import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { graphql } from "@octokit/graphql";
import type { PrSummary } from "@pwragent/shared";
import { getMainLogger } from "../log";
import {
  deriveChipStateFromRollup,
  deriveLifecycleState,
  deriveMergeState,
  deriveReviewState,
  normalizeCommitShas,
  parsePullRequestProvider,
} from "./pr-derivations";

const execFileAsync = promisify(execFile);
const graphqlLog = getMainLogger("pwragent:pr-graphql");

/**
 * In-process batched GitHub client for the background PR-status poller.
 *
 * Why this exists alongside `github-pr-fetcher.ts` (the `gh pr list`
 * subprocess): `gh` has no way to ask about many PRs across DIFFERENT repos in
 * one call — it is one invocation per branch, per repo. That is fine for the
 * one selected thread, and far too expensive to sweep 20-30 open projects on a
 * timer.
 *
 * GraphQL can: aliased top-level `repository(...)` selections put N PRs from
 * arbitrary repos into ONE request. GitHub bills GraphQL on a node/point model
 * against 5,000 points/hr with a floor of 1 point per request, and every field
 * we select is a single node (or a `commits(last: 1)` connection), so a batch
 * of ~40 PRs across ~40 repos costs about the floor. That is the entire reason
 * the poller does not shell out to `gh`.
 *
 * Auth is still `gh`'s: we mint a token with `gh auth token` rather than asking
 * the operator for a PAT, so there is no new credential to store.
 */

/** How many aliased PR lookups go into one GraphQL request. */
const DEFAULT_BATCH_SIZE = 40;
/** Retries per request before giving up on a batch. */
const MAX_RETRIES = 4;
/** Upper bound on any single backoff wait. */
const MAX_BACKOFF_MS = 60_000;
/** How long a minted `gh auth token` stays fresh in memory. */
const TOKEN_TTL_MS = 5 * 60_000;

/**
 * The repo + number that identify a PR *for querying*. This is the PR's BASE
 * repo — a PR number belongs to the repo it was opened against, which for a
 * fork-originated PR is NOT the same as `PrSummary.org`/`repo` (those track the
 * HEAD repo, matching what `gh` reports). Derive this from the PR's URL.
 */
export type PrRef = {
  owner: string;
  repo: string;
  number: number;
};

/**
 * Parse the base-repo ref out of a PR URL
 * (`https://github.com/<owner>/<repo>/pull/<number>`).
 */
export function parsePrRefFromUrl(url: string): PrRef | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const match = parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/);
  if (!match) {
    return undefined;
  }
  const number = Number.parseInt(match[3]!, 10);
  if (!Number.isSafeInteger(number) || number <= 0) {
    return undefined;
  }
  return { owner: match[1]!, repo: match[2]!, number };
}

/** The PullRequest fields the poller reads. Kept minimal — see the cost note above. */
const PR_STATUS_FRAGMENT = `
fragment PrStatus on PullRequest {
  number
  title
  url
  state
  isDraft
  mergeable
  headRepository { name }
  headRepositoryOwner { login }
  commits(last: 1) {
    nodes {
      commit {
        oid
        statusCheckRollup { state }
      }
    }
  }
}`;

export type GraphqlPrNode = {
  number: number;
  title?: string | null;
  url: string;
  state: string;
  isDraft: boolean;
  mergeable?: string | null;
  headRepository?: { name?: string | null } | null;
  headRepositoryOwner?: { login?: string | null } | null;
  commits?: {
    nodes?: (
      | {
        commit?: {
          oid?: string | null;
          statusCheckRollup?: { state?: string | null } | null;
        } | null;
      }
      | null
    )[] | null;
  } | null;
};

/** A single aliased `repository { pullRequest }` selection in the response. */
type BatchedPrResponse = Record<
  string,
  { pullRequest?: GraphqlPrNode | null } | null
>;

/**
 * Build one GraphQL document that looks up every ref by number, each under its
 * own alias.
 *
 * Owner/name/number are passed as GraphQL VARIABLES, never interpolated into
 * the query string — a repo named `") { … }` must not be able to rewrite the
 * document. Only the alias names (`r0`, `r1`, …) and variable names are
 * generated, and those are derived from the index, not from input.
 */
export function buildBatchedPrQuery(refs: PrRef[]): {
  query: string;
  variables: Record<string, string | number>;
} {
  const variableDecls: string[] = [];
  const selections: string[] = [];
  const variables: Record<string, string | number> = {};

  refs.forEach((ref, index) => {
    const owner = `o${index}`;
    const name = `n${index}`;
    const number = `p${index}`;
    variableDecls.push(`$${owner}: String!`, `$${name}: String!`, `$${number}: Int!`);
    selections.push(
      `  r${index}: repository(owner: $${owner}, name: $${name}) {`
      + ` pullRequest(number: $${number}) { ...PrStatus } }`,
    );
    variables[owner] = ref.owner;
    variables[name] = ref.repo;
    variables[number] = ref.number;
  });

  const query = `query PollPullRequests(${variableDecls.join(", ")}) {
${selections.join("\n")}
}
${PR_STATUS_FRAGMENT}`;

  return { query, variables };
}

/** Map one GraphQL PullRequest node onto our shared PrSummary. */
export function mapGraphqlPrNode(node: GraphqlPrNode): PrSummary {
  const headCommit = node.commits?.nodes?.[0]?.commit ?? undefined;
  const checkState = deriveChipStateFromRollup(
    headCommit?.statusCheckRollup?.state,
  );
  // `mergeStateStatus` is deliberately absent: GraphQL gates it behind a preview
  // Accept header, and `mergeable` alone already answers mergeable/conflicting.
  const shaped = {
    state: node.state,
    isDraft: node.isDraft,
    mergeable: node.mergeable ?? null,
    mergeStateStatus: null,
  };
  const commitShas = normalizeCommitShas([headCommit?.oid]);

  return {
    provider: parsePullRequestProvider(node.url),
    number: node.number,
    // Head repo, NOT the base repo we queried — matches what the `gh` path
    // writes, so both transports produce the same `buildPullRequestStatusKey`.
    org: node.headRepositoryOwner?.login ?? "",
    repo: node.headRepository?.name ?? "",
    ...(node.title?.trim() ? { title: node.title.trim() } : {}),
    state: checkState,
    checkState,
    lifecycleState: deriveLifecycleState(shaped),
    reviewState: deriveReviewState(shaped),
    mergeState: deriveMergeState(shaped),
    ...(commitShas.length > 0 ? { commitShas } : {}),
    url: node.url,
  };
}

/**
 * Compute how long to wait before retrying, or `null` to give up.
 *
 * Mirrors the semantics PwrGit settled on rather than pulling in
 * `@octokit/plugin-retry` + `@octokit/plugin-throttling`, which drag a
 * `bottleneck` transitive dependency into the tree for behavior we need ~40
 * lines of to express.
 */
export function retryDelayMs(error: unknown, attempt: number): number | null {
  const status = readErrorStatus(error);
  const headers = readErrorHeaders(error);

  // GitHub told us exactly how long to wait (secondary rate limit, usually).
  const retryAfter = Number(headers["retry-after"]);
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return clampBackoff(retryAfter * 1000);
  }

  // Primary rate limit exhausted: wait for the reset, not a blind backoff.
  if (
    (status === 403 || status === 429)
    && headers["x-ratelimit-remaining"] === "0"
  ) {
    const resetSeconds = Number(headers["x-ratelimit-reset"]);
    if (Number.isFinite(resetSeconds) && resetSeconds > 0) {
      return clampBackoff(resetSeconds * 1000 - Date.now());
    }
  }

  // Transient: too-many-requests, server errors, or a transport failure with no
  // status at all (DNS, socket reset, offline).
  if (status === 429 || status === undefined || status >= 500) {
    return clampBackoff(1000 * 2 ** Math.max(0, attempt - 1));
  }

  // 401 / 403-without-rate-limit / 404 / 422 — retrying cannot help.
  return null;
}

function clampBackoff(ms: number): number {
  if (!Number.isFinite(ms)) return 0;
  return Math.min(Math.max(ms, 0), MAX_BACKOFF_MS);
}

function readErrorStatus(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : undefined;
}

function readErrorHeaders(error: unknown): Record<string, string> {
  const candidate = error as
    | {
      headers?: Record<string, string>;
      response?: { headers?: Record<string, string> };
    }
    | null;
  const headers = candidate?.headers ?? candidate?.response?.headers ?? {};
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    normalized[key.toLowerCase()] = String(value);
  }
  return normalized;
}

export type GithubGraphqlPrClientOptions = {
  /** Override the GraphQL transport — tests inject canned responses. */
  request?: (
    query: string,
    variables: Record<string, string | number>,
  ) => Promise<unknown>;
  /** Override token acquisition — tests inject a fixed token. */
  getToken?: () => Promise<string | null>;
  /** Override the retry sleep — tests make backoff instant. */
  sleep?: (ms: number) => Promise<void>;
  batchSize?: number;
};

export class GithubGraphqlPrClient {
  private readonly requestOverride: GithubGraphqlPrClientOptions["request"];
  private readonly getTokenOverride: GithubGraphqlPrClientOptions["getToken"];
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly batchSize: number;
  private tokenCache: { token: string; fetchedAt: number } | undefined;

  constructor(options: GithubGraphqlPrClientOptions = {}) {
    this.requestOverride = options.request;
    this.getTokenOverride = options.getToken;
    this.sleep =
      options.sleep
      ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE);
  }

  /** Force the next request to re-mint a token (e.g. after `gh auth login`). */
  invalidateToken(): void {
    this.tokenCache = undefined;
  }

  /**
   * Fetch the current status of every ref, batching across repos.
   *
   * Best-effort by design: a batch that fails after retries contributes nothing
   * rather than failing the sweep, and a single bad alias inside an otherwise
   * good batch (repo renamed, PR deleted, no access) is skipped while its
   * siblings are kept. The poller's job is freshness, not transactional
   * correctness — a stale chip beats a crashed sweep.
   */
  async fetchPullRequests(refs: PrRef[]): Promise<PrSummary[]> {
    if (refs.length === 0) {
      return [];
    }
    const token = await this.resolveToken();
    if (!token) {
      graphqlLog.debug("skipping PR poll: no GitHub token from gh");
      return [];
    }

    const results: PrSummary[] = [];
    for (const batch of chunk(refs, this.batchSize)) {
      const prs = await this.fetchBatch(batch, token);
      results.push(...prs);
    }
    return results;
  }

  private async fetchBatch(refs: PrRef[], token: string): Promise<PrSummary[]> {
    const { query, variables } = buildBatchedPrQuery(refs);

    let data: BatchedPrResponse | undefined;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
      try {
        data = (await this.runRequest(query, variables, token)) as BatchedPrResponse;
        break;
      } catch (error) {
        // A GraphQL-level error still carries whatever aliases DID resolve.
        // One missing repo must not blank out the other 39 PRs in the batch.
        const partial = (error as { data?: BatchedPrResponse } | null)?.data;
        if (partial) {
          graphqlLog.debug("PR poll batch returned partial data", {
            refCount: refs.length,
            error: error instanceof Error ? error.message : String(error),
          });
          data = partial;
          break;
        }

        const delay = retryDelayMs(error, attempt);
        if (delay === null || attempt === MAX_RETRIES) {
          graphqlLog.warn("PR poll batch failed", {
            refCount: refs.length,
            attempt,
            retryable: delay !== null,
            error: error instanceof Error ? error.message : String(error),
          });
          return [];
        }
        await this.sleep(delay);
      }
    }

    if (!data) {
      return [];
    }

    const prs: PrSummary[] = [];
    let dropped = 0;
    refs.forEach((ref, index) => {
      const node = data[`r${index}`]?.pullRequest;
      if (!node) {
        dropped += 1;
        return;
      }
      prs.push(mapGraphqlPrNode(node));
    });

    if (dropped > 0) {
      // Never silently truncate — a dropped alias means we polled a PR and got
      // nothing back, which is a real (if benign) coverage gap worth seeing.
      graphqlLog.debug("PR poll batch dropped unresolved aliases", {
        refCount: refs.length,
        dropped,
      });
    }
    return prs;
  }

  private async runRequest(
    query: string,
    variables: Record<string, string | number>,
    token: string,
  ): Promise<unknown> {
    if (this.requestOverride) {
      return await this.requestOverride(query, variables);
    }
    const client = graphql.defaults({
      headers: { authorization: `token ${token}` },
    });
    return await client(query, variables);
  }

  private async resolveToken(): Promise<string | null> {
    if (this.getTokenOverride) {
      return await this.getTokenOverride();
    }
    if (
      this.tokenCache
      && Date.now() - this.tokenCache.fetchedAt < TOKEN_TTL_MS
    ) {
      return this.tokenCache.token;
    }

    const envToken = process.env.GITHUB_TOKEN?.trim();
    if (envToken) {
      this.tokenCache = { token: envToken, fetchedAt: Date.now() };
      return envToken;
    }

    try {
      // Imported lazily: gh discovery reaches the desktop settings singleton,
      // which pulls Electron-only packages into the module graph. Keeping it
      // out of the top-level imports means this client can be exercised (and
      // unit-tested) as a plain Node module.
      const [{ discoverGhCommands }, { getDesktopSettingsService }] =
        await Promise.all([
          import("../settings/gh-discovery"),
          import("../settings/desktop-settings-singleton"),
        ]);
      const discovery = await discoverGhCommands({
        configuredCommand: getDesktopSettingsService().resolveGhCommandPreference(),
        env: process.env,
      });
      const command = discovery.selectedCommand;
      if (!command) {
        return null;
      }
      const { stdout } = await execFileAsync(command, ["auth", "token"], {
        timeout: 10_000,
        encoding: "utf8",
      });
      const token = stdout.trim();
      if (!token) {
        return null;
      }
      this.tokenCache = { token, fetchedAt: Date.now() };
      return token;
    } catch (error) {
      // gh missing, or not logged in. The poller simply idles.
      graphqlLog.debug("gh auth token failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}
