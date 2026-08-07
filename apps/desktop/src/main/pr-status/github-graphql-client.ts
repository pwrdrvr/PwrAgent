import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { graphql } from "@octokit/graphql";
import type { PrSummary } from "@pwragent/shared";
import { buildPwrAgentChildProcessEnv } from "../child-process-env";
import { getMainLogger } from "../log";
import {
  deriveChipStateFromRollup,
  deriveLifecycleState,
  deriveMergeState,
  deriveReviewState,
  findFailedCheckUrl,
  hasChecksStillRunning,
  normalizeCommitShas,
  parsePullRequestProvider,
} from "./pr-derivations";

const execFileAsync = promisify(execFile);
const graphqlLog = getMainLogger("pwragent:pr-graphql");

/**
 * In-process batched GitHub client for PR discovery and status refresh.
 *
 * Aliased top-level `repository(...)` selections put N PRs from
 * arbitrary repos into ONE request. GitHub bills GraphQL on a node/point model
 * against 5,000 points/hr. The query keeps its connections bounded to one head
 * commit and pages status contexts in batches of 100, stopping as soon as it
 * finds a running check. That lets it preserve failure-while-running state
 * without returning check output. All PR data requests use this client; the
 * `gh` subprocess is limited to exporting its auth token and reporting
 * installation/login status in Settings.
 *
 * Auth is still `gh`'s: we read the token from `gh` rather than asking the
 * operator for a PAT, so there is no new credential to store. Newer CLIs have
 * `gh auth token`; older CLIs only have `gh auth status --show-token`.
 */

/** How many aliased PR lookups go into one GraphQL request. */
const DEFAULT_BATCH_SIZE = 40;
/** GitHub's maximum page size for status check contexts. */
const STATUS_CONTEXT_PAGE_SIZE = 100;
/** Retries per request before giving up on a batch. */
const MAX_RETRIES = 4;
/** Upper bound on any single backoff wait. */
const MAX_BACKOFF_MS = 60_000;
/** How long a minted `gh auth token` stays fresh in memory. */
const TOKEN_TTL_MS = 5 * 60_000;

type GhAuthTokenRunner = (
  command: string,
  args: string[],
) => Promise<{ stdout: string; stderr?: string }>;

const GITHUB_TOKEN_PATTERN = /(?:gh[oprsu]_\w+|github_pat_\w+)/;

function findGithubToken(output: { stdout: string; stderr?: string }): string | null {
  return `${output.stdout}\n${output.stderr ?? ""}`.match(GITHUB_TOKEN_PATTERN)?.[0] ?? null;
}

/** Export the credential for the same host this client queries. */
export async function readGithubDotComAuthToken(
  command: string,
  run: GhAuthTokenRunner = async (executable, args) =>
    await execFileAsync(executable, args, {
      env: buildPwrAgentChildProcessEnv(process.env),
      timeout: 10_000,
      encoding: "utf8",
    }),
): Promise<string | null> {
  try {
    const output = await run(command, [
      "auth",
      "token",
      "--hostname",
      "github.com",
    ]);
    const token = findGithubToken(output);
    if (token) {
      return token;
    }
  } catch {
    // Older gh versions do not have `auth token`; try their status output.
  }

  const output = await run(command, [
    "auth",
    "status",
    "--hostname",
    "github.com",
    "--show-token",
  ]);
  return findGithubToken(output);
}

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

/**
 * The PullRequest fields the poller reads. `contexts` carries only enough
 * state to distinguish a completed failure from a failure while sibling
 * checks still run. Failed destinations are retained for the auto-fix card;
 * names and output remain deliberately excluded.
 * Later pages are fetched only when this page cannot already prove a check is
 * running.
 */
const PR_STATUS_FRAGMENT = `
fragment PrStatus on PullRequest {
  number
  title
  url
  state
  isDraft
  mergeable
  baseRefName
  headRefName
  headRepository { name }
  headRepositoryOwner { login }
  commits(last: 1) {
    nodes {
      commit {
        id
        oid
        statusCheckRollup {
          state
          contexts(first: ${STATUS_CONTEXT_PAGE_SIZE}) {
            pageInfo { hasNextPage endCursor }
            nodes {
              __typename
              ... on CheckRun { conclusion detailsUrl status }
              ... on StatusContext { state targetUrl }
            }
          }
        }
      }
    }
  }
}`;

type GraphqlCheckContext = {
  __typename?: string;
  conclusion?: string | null;
  detailsUrl?: string | null;
  status?: string | null;
  state?: string | null;
  targetUrl?: string | null;
};

type PrCheckResolution = {
  checksStillRunning: boolean;
  failedCheckUrl?: string;
};

type GraphqlStatusContextPage = {
  nodes?: (GraphqlCheckContext | null)[] | null;
  pageInfo?: {
    hasNextPage?: boolean | null;
    endCursor?: string | null;
  } | null;
};

type GraphqlCommit = {
  id?: string | null;
  oid?: string | null;
  statusCheckRollup?: {
    state?: string | null;
    contexts?: GraphqlStatusContextPage | null;
  } | null;
};

export type GraphqlPrNode = {
  number: number;
  title?: string | null;
  url: string;
  state: string;
  isDraft: boolean;
  mergeable?: string | null;
  baseRefName?: string | null;
  headRefName?: string | null;
  headRepository?: { name?: string | null } | null;
  headRepositoryOwner?: { login?: string | null } | null;
  commits?: {
    nodes?: (
      | {
        commit?: GraphqlCommit | null;
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

type StatusContextPageRef = {
  commitId: string;
  cursor: string;
};

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

/**
 * Fetch one later page of status contexts for every supplied head commit.
 *
 * The initial PR query has already established these are `Commit` nodes, so
 * this can use the global node ID instead of repeating repository/PR lookups.
 * As with the primary batch, only generated aliases and variable names enter
 * the document text; commit IDs and cursors remain variables.
 */
export function buildBatchedStatusContextQuery(refs: StatusContextPageRef[]): {
  query: string;
  variables: Record<string, string | number>;
} {
  const variableDecls: string[] = [];
  const selections: string[] = [];
  const variables: Record<string, string | number> = {};

  refs.forEach((ref, index) => {
    const id = `id${index}`;
    const cursor = `c${index}`;
    variableDecls.push(`$${id}: ID!`, `$${cursor}: String!`);
    selections.push(`
  r${index}: node(id: $${id}) {
    ... on Commit {
      statusCheckRollup {
        contexts(first: ${STATUS_CONTEXT_PAGE_SIZE}, after: $${cursor}) {
          pageInfo { hasNextPage endCursor }
          nodes {
            __typename
            ... on CheckRun { conclusion detailsUrl status }
            ... on StatusContext { state targetUrl }
          }
        }
      }
    }
  }`);
    variables[id] = ref.commitId;
    variables[cursor] = ref.cursor;
  });

  return {
    query: `query PollStatusContextPages(${variableDecls.join(", ")}) {${selections.join("\n")}
}`,
    variables,
  };
}

/**
 * A branch to look up PRs for: "does this branch have a PR?"
 */
export type BranchRef = {
  owner: string;
  repo: string;
  branch: string;
};

/** Stable key for correlating a branch lookup back to its result. */
export function branchRefKey(ref: BranchRef): string {
  return `${ref.owner.toLowerCase()}/${ref.repo.toLowerCase()}#${ref.branch}`;
}

/**
 * How many PRs to return per branch. Five preserves the established behavior:
 * a branch that has both a merged PR and a newer open one still surfaces both.
 */
const PRS_PER_BRANCH = 5;

/**
 * Build one aliased document that looks up PRs by head branch across
 * arbitrary repos.
 *
 * PwrGit batches ~50 branches inside a single `repository(...)`; aliasing the
 * repository level too (as the by-number query does) lets branches from
 * different repos share one request as well. Same injection-safe variable
 * discipline: nothing is interpolated.
 */
export function buildBranchPrQuery(refs: BranchRef[]): {
  query: string;
  variables: Record<string, string | number>;
} {
  const variableDecls: string[] = [];
  const selections: string[] = [];
  const variables: Record<string, string | number> = {};

  refs.forEach((ref, index) => {
    const owner = `o${index}`;
    const name = `n${index}`;
    const branch = `b${index}`;
    variableDecls.push(
      `$${owner}: String!`,
      `$${name}: String!`,
      `$${branch}: String!`,
    );
    selections.push(
      `  r${index}: repository(owner: $${owner}, name: $${name}) {`
      + ` pullRequests(headRefName: $${branch}, first: ${PRS_PER_BRANCH},`
      + ` orderBy: { field: CREATED_AT, direction: DESC },`
      + ` states: [OPEN, MERGED, CLOSED]) { nodes { ...PrStatus } } }`,
    );
    variables[owner] = ref.owner;
    variables[name] = ref.repo;
    variables[branch] = ref.branch;
  });

  const query = `query DiscoverPullRequestsByBranch(${variableDecls.join(", ")}) {
${selections.join("\n")}
}
${PR_STATUS_FRAGMENT}`;

  return { query, variables };
}

/** Map one GraphQL PullRequest node onto our shared PrSummary. */
export function mapGraphqlPrNode(
  node: GraphqlPrNode,
  checkResolution?: PrCheckResolution,
): PrSummary {
  const headCommit = getHeadCommit(node);
  const checkContexts = headCommit?.statusCheckRollup?.contexts?.nodes ?? [];
  const checkState = deriveChipStateFromRollup(
    headCommit?.statusCheckRollup?.state,
  );
  const checksStillRunning =
    checkResolution?.checksStillRunning
    ?? hasChecksStillRunning(
      checkContexts.filter(
        (context): context is GraphqlCheckContext => context !== null,
      ),
    );
  const failedCheckUrl =
    checkResolution?.failedCheckUrl
    ?? findFailedCheckUrl(
      checkContexts.filter(
        (context): context is GraphqlCheckContext => context !== null,
      ),
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
  const headSha = commitShas[0];

  return {
    provider: parsePullRequestProvider(node.url),
    number: node.number,
    // Head repo, NOT the base repo we queried — matches what the `gh` path
    // writes, so both transports produce the same `buildPullRequestStatusKey`.
    org: node.headRepositoryOwner?.login ?? "",
    repo: node.headRepository?.name ?? "",
    ...(node.title?.trim() ? { title: node.title.trim() } : {}),
    ...(node.baseRefName?.trim() ? { baseRefName: node.baseRefName.trim() } : {}),
    ...(node.headRefName?.trim() ? { headRefName: node.headRefName.trim() } : {}),
    state: checkState,
    checkState,
    ...(checksStillRunning ? { checksStillRunning: true } : {}),
    ...(failedCheckUrl ? { failedCheckUrl } : {}),
    lifecycleState: deriveLifecycleState(shaped),
    reviewState: deriveReviewState(shaped),
    mergeState: deriveMergeState(shaped),
    ...(headSha ? { headSha } : {}),
    ...(commitShas.length > 0 ? { commitShas } : {}),
    url: node.url,
  };
}

function getHeadCommit(node: GraphqlPrNode): GraphqlCommit | undefined {
  return node.commits?.nodes?.[0]?.commit ?? undefined;
}

function readCheckContexts(
  page: GraphqlStatusContextPage | null | undefined,
): GraphqlCheckContext[] | undefined {
  const nodes = page?.nodes;
  return nodes?.filter(
    (context): context is GraphqlCheckContext => context !== null,
  );
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

function githubSamlEnforcementAliasIndexes(
  error: unknown,
  refCount: number,
  partial?: Record<string, unknown>,
): number[] {
  const entries = (
    error as { errors?: Array<{ message?: unknown; path?: unknown[] }> } | null
  )?.errors ?? [];
  const matching = entries.filter(
    (entry) =>
      typeof entry.message === "string"
      && isGithubOrganizationSamlEnforcementMessage(entry.message),
  );
  const indexes = new Set<number>();
  for (const entry of matching) {
    const alias = entry.path?.[0];
    const match = typeof alias === "string" ? alias.match(/^r(\d+)$/) : null;
    if (match) {
      const index = Number.parseInt(match[1]!, 10);
      if (index >= 0 && index < refCount) {
        indexes.add(index);
      }
    }
  }
  if (indexes.size > 0) {
    return [...indexes];
  }
  const message = error instanceof Error ? error.message : String(error);
  if (
    matching.length === 0
    && !isGithubOrganizationSamlEnforcementMessage(message)
  ) {
    return [];
  }
  return Array.from({ length: refCount }, (_, index) => index).filter(
    (index) => !partial || !partial[`r${index}`],
  );
}

export function isGithubOrganizationSamlEnforcementMessage(
  message: string,
): boolean {
  return /resource protected by organization saml enforcement/i.test(message);
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
  onRepositoryAccess?: (event: GithubRepositoryAccessEvent) => void;
  onAuthenticationFailure?: (event: GithubAuthenticationFailureEvent) => void;
};

export type GithubRepositoryAccessEvent = {
  branch?: string;
  owner: string;
  repo: string;
  status: "available" | "saml-enforced";
};

export type GithubAuthenticationFailureEvent = {
  detail?: string;
  reason: "token-command-failed" | "token-unavailable";
};

export class GithubGraphqlPrClient {
  private readonly requestOverride: GithubGraphqlPrClientOptions["request"];
  private readonly getTokenOverride: GithubGraphqlPrClientOptions["getToken"];
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly batchSize: number;
  private readonly onRepositoryAccess:
    | NonNullable<GithubGraphqlPrClientOptions["onRepositoryAccess"]>
    | undefined;
  private readonly onAuthenticationFailure:
    | NonNullable<GithubGraphqlPrClientOptions["onAuthenticationFailure"]>
    | undefined;
  private tokenCache: { token: string; fetchedAt: number } | undefined;

  constructor(options: GithubGraphqlPrClientOptions = {}) {
    this.requestOverride = options.request;
    this.getTokenOverride = options.getToken;
    this.sleep =
      options.sleep
      ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE);
    this.onRepositoryAccess = options.onRepositoryAccess;
    this.onAuthenticationFailure = options.onAuthenticationFailure;
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

  /**
   * Look up PRs by head branch, batched across repos.
   *
   * Returns a map keyed by `branchRefKey`. A key is present ONLY when GitHub
   * actually answered for that branch — an empty array then means an
   * authoritative "this branch has no PRs". A missing key means we don't know
   * (batch failed, repo inaccessible), and the caller must retain prior state
   * rather than record a false negative. That distinction is the whole contract
   * here: conflating the two would let one failed request blank out every chip.
   */
  async fetchPullRequestsForBranches(
    refs: BranchRef[],
  ): Promise<Map<string, PrSummary[]>> {
    const results = new Map<string, PrSummary[]>();
    if (refs.length === 0) {
      return results;
    }
    const token = await this.resolveToken();
    if (!token) {
      graphqlLog.debug("skipping branch PR lookup: no GitHub token from gh");
      return results;
    }

    for (const batch of chunk(refs, this.batchSize)) {
      const data = await this.runBatchQuery(
        buildBranchPrQuery(batch),
        token,
        batch.length,
        batch,
      );
      if (!data) {
        continue;
      }
      const answers = batch.map((ref, index) => {
        const repository = data[`r${index}`] as
          | { pullRequests?: { nodes?: (GraphqlPrNode | null)[] | null } | null }
          | null
          | undefined;
        return {
          ref,
          repository,
          nodes: (repository?.pullRequests?.nodes ?? []).filter(
            (node): node is GraphqlPrNode => Boolean(node),
          ),
        };
      });
      answers.forEach(({ ref, repository }) => {
        if (repository) {
          this.notifyRepositoryAccess(ref, "available");
        }
      });
      const checkResolutions = await this.resolveCheckContexts(
        answers.flatMap((answer) => answer.nodes),
        token,
      );
      answers.forEach(({ ref, repository, nodes }) => {
        if (!repository || nodes.some((node) => !checkResolutions.has(node))) {
          // An unresolved alias or context page is not an authoritative answer;
          // leave the key absent so callers retain prior state.
          return;
        }
        results.set(
          branchRefKey(ref),
          nodes.map((node) => mapGraphqlPrNode(node, checkResolutions.get(node)!)),
        );
      });
    }
    return results;
  }

  /**
   * Resolve each PR's running state and first failed destination without
   * treating the first context page as terminal. A failed follow-up page leaves
   * that PR unresolved so callers retain the last known status.
   */
  private async resolveCheckContexts(
    nodes: GraphqlPrNode[],
    token: string,
  ): Promise<Map<GraphqlPrNode, PrCheckResolution>> {
    const resolved = new Map<GraphqlPrNode, PrCheckResolution>();
    const pendingNodes = new Map<GraphqlPrNode, string>();
    const pendingByCommitId = new Map<string, StatusContextPageRef>();
    const failedCheckUrlByCommitId = new Map<string, string>();
    const seenCursorsByCommitId = new Map<string, Set<string>>();

    const queueNextPage = (commitId: string, cursor: string): boolean => {
      if (pendingByCommitId.has(commitId)) {
        return true;
      }
      const seen = seenCursorsByCommitId.get(commitId) ?? new Set<string>();
      if (seen.has(cursor)) {
        return false;
      }
      seen.add(cursor);
      seenCursorsByCommitId.set(commitId, seen);
      pendingByCommitId.set(commitId, { commitId, cursor });
      return true;
    };

    for (const node of nodes) {
      const headCommit = getHeadCommit(node);
      const rollup = headCommit?.statusCheckRollup;
      if (!rollup) {
        resolved.set(node, { checksStillRunning: false });
        continue;
      }
      const contexts = readCheckContexts(rollup.contexts);
      if (!contexts) {
        continue;
      }
      const failedCheckUrl = findFailedCheckUrl(contexts);
      const commitId = headCommit?.id?.trim();
      if (commitId && failedCheckUrl) {
        failedCheckUrlByCommitId.set(commitId, failedCheckUrl);
      }
      if (hasChecksStillRunning(contexts)) {
        resolved.set(node, {
          checksStillRunning: true,
          ...(failedCheckUrl ? { failedCheckUrl } : {}),
        });
        continue;
      }
      const pageInfo = rollup.contexts?.pageInfo;
      if (pageInfo?.hasNextPage === false) {
        resolved.set(node, {
          checksStillRunning: false,
          ...(failedCheckUrl ? { failedCheckUrl } : {}),
        });
        continue;
      }
      const cursor = pageInfo?.endCursor?.trim();
      if (
        pageInfo?.hasNextPage === true
        && commitId
        && cursor
        && queueNextPage(commitId, cursor)
      ) {
        pendingNodes.set(node, commitId);
      }
    }

    const completedByCommitId = new Map<string, PrCheckResolution>();
    while (pendingByCommitId.size > 0) {
      const pending = [...pendingByCommitId.values()];
      pendingByCommitId.clear();
      for (const batch of chunk(pending, this.batchSize)) {
        const data = await this.runBatchQuery(
          buildBatchedStatusContextQuery(batch),
          token,
          batch.length,
        );
        if (!data) {
          continue;
        }
        batch.forEach((ref, index) => {
          const page = (data[`r${index}`] as GraphqlCommit | null | undefined)
            ?.statusCheckRollup?.contexts;
          const contexts = readCheckContexts(page);
          if (!contexts) {
            return;
          }
          const failedCheckUrl =
            failedCheckUrlByCommitId.get(ref.commitId)
            ?? findFailedCheckUrl(contexts);
          if (failedCheckUrl) {
            failedCheckUrlByCommitId.set(ref.commitId, failedCheckUrl);
          }
          if (hasChecksStillRunning(contexts)) {
            completedByCommitId.set(ref.commitId, {
              checksStillRunning: true,
              ...(failedCheckUrl ? { failedCheckUrl } : {}),
            });
            return;
          }
          const pageInfo = page?.pageInfo;
          if (pageInfo?.hasNextPage === false) {
            completedByCommitId.set(ref.commitId, {
              checksStillRunning: false,
              ...(failedCheckUrl ? { failedCheckUrl } : {}),
            });
            return;
          }
          const cursor = pageInfo?.endCursor?.trim();
          if (pageInfo?.hasNextPage === true && cursor) {
            queueNextPage(ref.commitId, cursor);
          }
        });
      }
    }

    for (const [node, commitId] of pendingNodes) {
      if (completedByCommitId.has(commitId)) {
        resolved.set(node, completedByCommitId.get(commitId)!);
      }
    }

    if (resolved.size < nodes.length) {
      graphqlLog.debug("PR status context pagination incomplete; retaining prior state", {
        prCount: nodes.length,
        unresolved: nodes.length - resolved.size,
      });
    }
    return resolved;
  }

  /**
   * Run one aliased document with retry/backoff, salvaging partial data.
   * Returns `undefined` when the batch produced nothing usable.
   */
  private async runBatchQuery(
    built: { query: string; variables: Record<string, string | number> },
    token: string,
    refCount: number,
    repositoryRefs?: Array<Pick<BranchRef, "owner" | "repo" | "branch">>,
  ): Promise<Record<string, unknown> | undefined> {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
      try {
        return (await this.runRequest(built.query, built.variables, token)) as Record<
          string,
          unknown
        >;
      } catch (error) {
        const partial = (error as { data?: Record<string, unknown> } | null)?.data;
        this.notifySamlEnforcement(error, repositoryRefs, partial);
        if (partial) {
          graphqlLog.debug("PR batch returned partial data", {
            refCount,
            error: error instanceof Error ? error.message : String(error),
          });
          return partial;
        }

        const delay = retryDelayMs(error, attempt);
        if (delay === null || attempt === MAX_RETRIES) {
          graphqlLog.warn("PR batch failed", {
            refCount,
            attempt,
            retryable: delay !== null,
            error: error instanceof Error ? error.message : String(error),
          });
          return undefined;
        }
        await this.sleep(delay);
      }
    }
    return undefined;
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
        this.notifySamlEnforcement(error, refs, partial);
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

    const nodes = refs
      .map((_, index) => data![`r${index}`]?.pullRequest)
      .filter((node): node is GraphqlPrNode => Boolean(node));
    refs.forEach((ref, index) => {
      if (data[`r${index}`]) {
        this.notifyRepositoryAccess(ref, "available");
      }
    });
    const checkResolutions = await this.resolveCheckContexts(nodes, token);
    const prs: PrSummary[] = [];
    let dropped = 0;
    let incompleteContexts = 0;
    refs.forEach((ref, index) => {
      const node = data[`r${index}`]?.pullRequest;
      if (!node) {
        dropped += 1;
        return;
      }
      if (!checkResolutions.has(node)) {
        incompleteContexts += 1;
        return;
      }
      prs.push(mapGraphqlPrNode(node, checkResolutions.get(node)!));
    });

    if (dropped > 0 || incompleteContexts > 0) {
      // Never silently clear a status: an unresolved alias or incomplete
      // context pagination is a coverage gap, so callers keep cached state.
      graphqlLog.debug("PR poll batch skipped incomplete status results", {
        refCount: refs.length,
        dropped,
        incompleteContexts,
      });
    }
    return prs;
  }

  private notifySamlEnforcement(
    error: unknown,
    refs:
      | Array<Pick<BranchRef, "owner" | "repo"> & { branch?: string }>
      | undefined,
    partial?: Record<string, unknown>,
  ): void {
    if (!refs || refs.length === 0) {
      return;
    }
    for (const index of githubSamlEnforcementAliasIndexes(
      error,
      refs.length,
      partial,
    )) {
      const ref = refs[index];
      if (ref) {
        this.notifyRepositoryAccess(ref, "saml-enforced");
      }
    }
  }

  private notifyRepositoryAccess(
    ref: Pick<BranchRef, "owner" | "repo"> & { branch?: string },
    status: GithubRepositoryAccessEvent["status"],
  ): void {
    try {
      this.onRepositoryAccess?.({
        branch: ref.branch,
        owner: ref.owner,
        repo: ref.repo,
        status,
      });
    } catch (error) {
      graphqlLog.warn("failed to surface GitHub repository access", {
        owner: ref.owner,
        repo: ref.repo,
        error: error instanceof Error ? error.message : String(error),
      });
    }
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
        env: buildPwrAgentChildProcessEnv(process.env),
      });
      const command = discovery.selectedCommand;
      if (!command) {
        this.onAuthenticationFailure?.({ reason: "token-unavailable" });
        return null;
      }
      const token = await readGithubDotComAuthToken(command);
      if (!token) {
        this.onAuthenticationFailure?.({ reason: "token-unavailable" });
        return null;
      }
      this.tokenCache = { token, fetchedAt: Date.now() };
      return token;
    } catch (error) {
      // gh missing, or not logged in. The poller simply idles.
      this.onAuthenticationFailure?.({
        detail: error instanceof Error ? error.message : String(error),
        reason: "token-command-failed",
      });
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
