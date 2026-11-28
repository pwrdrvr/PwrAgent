import path from "node:path";
import { deriveFactoryEvidence } from "@pwragent/owner-core/factory-evidence";
import { buildPullRequestStatusKey, type PrSummary } from "@pwragent/shared/contracts/navigation";
import type { ThreadReview } from "@pwragent/shared/contracts/thread-reviews";
import {
  FACTORY_PROJECT_PAGE_LIMIT,
  type FactoryBranchSelection, type FactoryProjectProjection, type FactoryProjectPullRequest, type FactoryProjectReadRequest,
  type FactoryReceiptProjection, type FactoryReceiptStatus,
} from "@pwragent/shared/factory-projection";
import { isGitObjectId } from "@pwragent/shared/git-object-id";
import type { ForgeCiClient } from "../pr-status/forge-ci-client";
import type { GitHubRepoRef } from "../pr-status/git-remote";
import { readFactoryBranch } from "./factory-branch-evidence";

const HOST = "github.com";
const ORG = "pwrdrvr";
const CHECK_LIMIT = 64;
const REVIEW_LIMIT = 8;
const STATUS_MAX_AGE_MS = 60_000;

const ROW = "number title state isDraft headRepository { id }";
const PROJECT_QUERY = `query FactoryProject($owner: String!, $name: String!, $limit: Int!) {
  repository(owner: $owner, name: $name) {
    id nameWithOwner
    pullRequests(first: $limit, states: [OPEN], orderBy: {field: CREATED_AT, direction: DESC}) {
      nodes { ${ROW} }
      pageInfo { hasNextPage }
    }
  }
}`;

const SELECTION_QUERY = PROJECT_QUERY.replace(
  "$limit: Int!", "$limit: Int!, $number: Int!",
).replace("id nameWithOwner", `id nameWithOwner
    selected: pullRequest(number: $number) {
      ${ROW}
      headRefName baseRefName headRefOid baseRefOid mergeCommit { oid }
      commits(last: 1) { nodes { commit {
        oid statusCheckRollup {
          state contexts(first: ${CHECK_LIMIT}) {
            pageInfo { hasNextPage }
            nodes {
              ... on CheckRun { name status conclusion detailsUrl }
              ... on StatusContext { context state targetUrl }
            }
          }
        }
      } } }
      reviews: latestOpinionatedReviews(last: ${REVIEW_LIMIT}, writersOnly: true) {
        nodes { id state url author { login } commit { oid } }
      }
    }`);

type RecordValue = Record<string, unknown>;
type ProjectResolver = (key: string) => Promise<{ path: string; remotes: readonly GitHubRepoRef[] } | undefined>;
type CachedStatus = { pr: Pick<PrSummary, "headSha" | "baseSha" | "checkState">; fetchedAt: number };

interface FactoryEvidencePorts {
  resolveProject: ProjectResolver;
  github: ForgeCiClient["requestGithub"];
  cachedStatus: (key: string) => CachedStatus | undefined;
  readReview: (id: string) => ThreadReview | undefined;
  now?: () => number;
}

function record(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
}

function text(value: unknown, length: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= length && !/[\u0000-\u001f\u007f]/.test(value) ? value : undefined;
}

function oid(value: unknown): string | undefined {
  const normalized = typeof value === "string" ? value.toLowerCase() : "";
  return isGitObjectId(normalized) && !/^0+$/.test(normalized) ? normalized : undefined;
}

function positiveInt(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= max;
}

function requestError(): never {
  throw new Error("Select a registered first-party project and repository. For PR evidence, supply its repository ID and PR number.");
}

function assessment(value: unknown) {
  if (value === undefined) return undefined;
  const summary = record(value);
  const outcome = typeof summary.outcome === "string" ? summary.outcome.trim() : "";
  const change = typeof summary.change === "string" ? summary.change.trim() : "";
  if (!outcome || !change || outcome.length > 4096 || change.length > 4096) requestError();
  return { outcome, change };
}

function readBranchSelection(value: unknown): FactoryBranchSelection | undefined {
  if (value === undefined) return undefined;
  const branchSelection = record(value);
  const issueId = text(branchSelection.issueId, 36)?.toLowerCase();
  const branch = text(branchSelection.branch, 255);
  const baseRef = text(branchSelection.baseRef, 255);
  const ref = /^[a-z0-9_][\w./-]*$/i;
  if (!issueId || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(issueId)
    || !branch || !ref.test(branch) || branch.startsWith("refs/")
    || !baseRef || !ref.test(baseRef) || !/^refs\/(?:heads\/.+|remotes\/[^/]+\/.+)$/.test(baseRef)) requestError();
  const worktree = text(branchSelection.worktree, 4096);
  if (branchSelection.worktree !== undefined && (!worktree || !path.isAbsolute(worktree))) requestError();
  const rawIds = branchSelection.reviewIds ?? [];
  if (!Array.isArray(rawIds) || rawIds.length > REVIEW_LIMIT) requestError();
  const reviewIds = [...new Set(rawIds.map((id) => text(id, 256) ?? requestError()))].sort();
  return { issueId, branch, baseRef, worktree, reviewIds, assessment: assessment(branchSelection.assessment) };
}

function readRequest(value: unknown): FactoryProjectReadRequest {
  const input = record(value);
  const projectKey = text(input.projectKey, 4096);
  const repository = text(input.repository, 100);
  const limit = input.limit ?? FACTORY_PROJECT_PAGE_LIMIT;
  if (!projectKey?.startsWith("directory:") || !repository || !/^[a-z0-9_.-]+$/i.test(repository)
    || !positiveInt(limit, FACTORY_PROJECT_PAGE_LIMIT)) requestError();
  const candidate = readBranchSelection(input.candidate);
  if (input.selection === undefined) return { projectKey, repository, limit, candidate };
  const selection = record(input.selection);
  const repositoryId = text(selection.repositoryId, 256);
  const number = selection.number;
  if (!repositoryId || !positiveInt(number, 2_147_483_647)) requestError();
  const rawChecks = selection.requiredChecks ?? [];
  if (!Array.isArray(rawChecks) || rawChecks.length > CHECK_LIMIT) requestError();
  const requiredChecks = rawChecks.map((value) => text(value, 256) ?? requestError());
  const pair = record(selection.expected);
  const headOid = oid(pair.headOid);
  const baseOid = oid(pair.baseOid);
  if (selection.expected !== undefined && (!headOid || !baseOid || headOid.length !== baseOid.length)) requestError();
  const expected = headOid && baseOid ? { headOid, baseOid } : undefined;
  return { projectKey, repository, limit, candidate, selection: {
    repositoryId, number, expected, requiredChecks: [...new Set(requiredChecks)], assessment: assessment(selection.assessment),
  } };
}

function prRow(node: RecordValue, repository: FactoryProjectProjection["repository"]): FactoryProjectPullRequest {
  const { number, state } = node;
  if (!positiveInt(number, 2_147_483_647) || (state !== "OPEN" && state !== "CLOSED" && state !== "MERGED")) {
    throw new Error("GitHub returned an invalid pull request.");
  }
  return {
    number, title: typeof node.title === "string" ? node.title.slice(0, 300) : "",
    lifecycle: state === "OPEN" ? "open" : state === "CLOSED" ? "closed" : "merged",
    url: `https://${HOST}/${repository.owner}/${repository.name}/pull/${number}`,
    draft: node.isDraft === true,
    firstParty: record(node.headRepository).id === repository.id,
  };
}

function safeReference(value: unknown, fallback: string): string {
  if (!text(value, 1024)) return fallback;
  try {
    const url = new URL(String(value));
    if (url.origin === `https://${HOST}` && !url.username && !url.password) return url.origin + url.pathname;
  } catch { /* Keep the canonical GitHub link. */ }
  return fallback;
}

function checkStatus(node: RecordValue): FactoryReceiptStatus {
  const status = node.status ?? node.state;
  if (status === "QUEUED" || status === "IN_PROGRESS" || status === "PENDING" || status === "EXPECTED"
    || status === "REQUESTED" || status === "WAITING") return "pending";
  const conclusion = status === "COMPLETED" ? node.conclusion : node.state;
  if (conclusion === "SUCCESS") return "current";
  if (["FAILURE", "ERROR", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(String(conclusion))) return "failed";
  return "inconclusive";
}

function checkObservations(node: RecordValue, headOid: string, url: string) {
  const commits = record(node.commits).nodes;
  const commit = Array.isArray(commits) && commits.length === 1 ? record(record(commits[0]).commit) : {};
  const rollup = oid(commit.oid) === headOid ? record(commit.statusCheckRollup) : {};
  const contexts = record(rollup.contexts);
  const truncated = record(contexts.pageInfo).hasNextPage !== false;
  const nodes = Array.isArray(contexts.nodes) ? contexts.nodes : [];
  const fallback = `${url}/commits/${headOid}`;
  const checks: FactoryReceiptProjection[] = nodes.slice(0, CHECK_LIMIT).flatMap((raw) => {
    const check = record(raw);
    const name = text(check.name ?? check.context, 256);
    return name ? [{
      kind: "test", source: "github", name, status: checkStatus(check), headOid,
      reference: safeReference(check.detailsUrl ?? check.targetUrl, fallback),
    }] : [];
  });
  return {
    checks, checksTruncated: truncated || nodes.length > CHECK_LIMIT || checks.length !== nodes.length,
    checkRollup: text(rollup.state, 32),
  };
}

function reviewObservations(node: RecordValue, headOid: string, url: string): FactoryReceiptProjection[] {
  const nodes = record(node.reviews).nodes;
  if (!Array.isArray(nodes)) return [];
  return nodes.slice(0, REVIEW_LIMIT).flatMap((raw) => {
    const review = record(raw);
    const id = text(review.id, 256);
    const reviewed = oid(record(review.commit).oid);
    if (!id || !reviewed || (review.state !== "APPROVED" && review.state !== "CHANGES_REQUESTED")) return [];
    return [{
      kind: "review", source: "github", name: id, headOid: reviewed, reference: safeReference(review.url, url),
      actor: text(record(review.author).login, 100),
      status: reviewed !== headOid ? "stale_head"
        : review.state === "CHANGES_REQUESTED" ? "failed" : "inconclusive",
    }];
  });
}

function cacheReceipt(cached: CachedStatus | undefined, revision: { headOid: string; baseOid: string }, now: number, rollup?: string): FactoryReceiptProjection {
  const headOid = oid(cached?.pr.headSha);
  const baseOid = oid(cached?.pr.baseSha);
  const receipt = { kind: "other", source: "owner_pr_status", name: "Owner PR status", headOid, baseOid } as const;
  if (!cached) return { ...receipt, status: "absent" };
  if (headOid && headOid !== revision.headOid) return { ...receipt, status: "stale_head" };
  if (baseOid && baseOid !== revision.baseOid) return { ...receipt, status: "stale_base" };
  if (!headOid || !baseOid || !Number.isFinite(cached.fetchedAt) || cached.fetchedAt <= 0
    || cached.fetchedAt > now || now - cached.fetchedAt > STATUS_MAX_AGE_MS) return { ...receipt, status: "stale" };
  const state = cached.pr.checkState;
  const conflict = (state === "failing" && rollup === "SUCCESS") || (state === "passing" && rollup === "FAILURE");
  return { ...receipt, status: conflict ? "conflict" : "current" };
}

/** All rows, revision facts and provider receipts come from one bounded admitted read. */
export async function collectFactoryProject(value: unknown, ports: FactoryEvidencePorts): Promise<FactoryProjectProjection> {
  const { projectKey, repository: name, limit = FACTORY_PROJECT_PAGE_LIMIT, selection, candidate: requestedBranch } = readRequest(value);
  const project = await ports.resolveProject(projectKey);
  const remote = project?.remotes.find((entry) => entry.host === HOST && entry.owner.toLowerCase() === ORG && entry.repo.toLowerCase() === name.toLowerCase());
  if (!project || !remote) requestError();
  const now = ports.now ?? Date.now;
  const candidate = requestedBranch ? await readFactoryBranch(project.path, `${HOST}/${ORG}/${remote.repo}`, requestedBranch, ports.readReview, now) : undefined;
  if (candidate && !selection) return {
    projectKey, repository: { host: HOST, owner: ORG, name: remote.repo },
    authority: { source: "local_owner_git", observedAt: candidate.authority.observedAt },
    inventory: "unobserved", pullRequests: [], truncated: false, candidate,
  };

  const response = record(await ports.github({ ...remote, provider: "github" }, {
    path: "", graphql: true,
    body: {
      query: selection ? SELECTION_QUERY : PROJECT_QUERY,
      variables: { owner: ORG, name, limit, ...(selection ? { number: selection.number } : {}) },
    },
  }));
  const data = record(record(response.data).repository);
  const id = text(data.id, 256);
  const fullName = text(data.nameWithOwner, 101 + ORG.length);
  const canonicalName = fullName?.split("/")[1];
  if ((Array.isArray(response.errors) && response.errors.length > 0)
    || !id || !canonicalName || fullName?.toLowerCase() !== `${ORG}/${name.toLowerCase()}`
    || (selection && id !== selection.repositoryId)) {
    throw new Error("The selected project repository could not be confirmed by GitHub.");
  }

  const repository = { host: HOST, id, owner: ORG, name: canonicalName } as const;
  const observedAt = now();
  const page = record(data.pullRequests);
  if (!Array.isArray(page.nodes)) throw new Error("GitHub returned an invalid project PR list.");
  const result: FactoryProjectProjection = {
    projectKey, repository, authority: { source: "local_owner_github", observedAt },
    inventory: "observed",
    pullRequests: page.nodes.slice(0, limit).map((node) => prRow(record(node), repository)),
    truncated: record(page.pageInfo).hasNextPage !== false || page.nodes.length > limit, candidate,
  };
  if (!selection) return result;
  if (data.selected === null) return { ...result, selected: { kind: "absent" } };
  const node = record(data.selected);
  const pullRequest = prRow(node, repository);
  if (pullRequest.number !== selection.number) throw new Error("GitHub returned a different PR than requested.");
  const headOid = oid(node.headRefOid);
  const baseOid = oid(node.baseRefOid);
  const revision = pullRequest.firstParty && headOid && baseOid && headOid.length === baseOid.length ? { headOid, baseOid } : undefined;
  const checks = revision ? checkObservations(node, revision.headOid, pullRequest.url)
    : { checks: [], checksTruncated: false, checkRollup: undefined };
  const cache = revision ? cacheReceipt(ports.cachedStatus(buildPullRequestStatusKey({
    provider: HOST, org: ORG, repo: canonicalName, number: pullRequest.number,
  })), revision, observedAt, checks.checkRollup) : undefined;
  const evidence = deriveFactoryEvidence({
    repositoryId: id, pullRequest, revision, expected: selection.expected,
    ...checks, requiredChecks: selection.requiredChecks ?? [], cache,
    reviews: revision ? reviewObservations(node, revision.headOid, pullRequest.url) : [],
    mergeCommitOid: pullRequest.firstParty && pullRequest.lifecycle === "merged" ? oid(record(node.mergeCommit).oid) : undefined,
    assessment: selection.assessment,
  });
  if (!candidate) return { ...result, selected: { kind: "observed", evidence } };
  const baseBranch = candidate.baseRef.replace(/^refs\/(?:heads|remotes\/[^/]+)\//, "");
  if (!pullRequest.firstParty || node.headRefName !== candidate.branch || node.baseRefName !== baseBranch) {
    return { ...result, candidate: { ...candidate, publication: "mismatch" } };
  }
  const confirmed = revision !== undefined && candidate.headOid === revision.headOid;
  return {
    ...result, selected: { kind: "observed", evidence },
    candidate: confirmed ? { ...candidate, stage: "published", publication: "confirmed" }
      : { ...candidate, publication: "revision_changed" },
  };
}
