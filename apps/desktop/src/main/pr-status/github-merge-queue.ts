import type { PrMergeQueueStatus } from "@pwragent/shared";
import { isMergeQueueActive } from "@pwragent/shared";
import { ForgeReadError } from "./forge-tool-contract";
import { num, payloadItems, payloadObject, str, type Payload } from "./forge-pr-tool-shared";
import { githubMergeQueueStatus } from "./pr-merge-queue";

/**
 * GitHub's merge queue, for the two merge paths: the agent's
 * `merge_pull_request` (GitHub API through the CI client) and a to-do card's
 * merge (the operator's `gh`). Both read the same gate and take the same
 * action, so neither can merge directly past a queue.
 */

const object = (value: unknown) => payloadObject(value, "GitHub");
const items = (value: unknown) => payloadItems(value, "GitHub");

/** What a merge needs to know about the base branch's merge queue. */
export type GithubMergeQueueGate = {
  required: boolean;
  pullRequestId: string;
  baseRef?: string;
  headSha?: string;
  open: boolean;
  /** The PR's queue reading, unless it is simply not in the queue. */
  status?: PrMergeQueueStatus;
  /** The head's combined check state: SUCCESS, PENDING, EXPECTED, FAILURE, ERROR. */
  checks?: string;
};

export const GITHUB_MERGE_QUEUE_GATE_QUERY = `query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){
  id state headRefOid baseRefName isMergeQueueEnabled
  mergeQueueEntry { state position enqueuedAt }
  queueEvents: timelineItems(last:1, itemTypes:[ADDED_TO_MERGE_QUEUE_EVENT, REMOVED_FROM_MERGE_QUEUE_EVENT]){nodes{
    __typename
    ... on AddedToMergeQueueEvent { createdAt }
    ... on RemovedFromMergeQueueEvent { createdAt reason }
  }}
  commits(last:1){nodes{commit{statusCheckRollup{state}}}}
}}}`;

export const GITHUB_ENQUEUE_MUTATION =
  "mutation($id:ID!,$head:GitObjectID){enqueuePullRequest(input:{pullRequestId:$id,expectedHeadOid:$head}){mergeQueueEntry{state position enqueuedAt}}}";

export const GITHUB_ENABLE_AUTO_MERGE_MUTATION =
  "mutation($id:ID!,$head:GitObjectID){enablePullRequestAutoMerge(input:{pullRequestId:$id,expectedHeadOid:$head}){pullRequest{autoMergeRequest{enabledAt}}}}";

function entryObservation(entry: Payload) {
  return {
    state: str(entry.state, 40) ?? null,
    position: num(entry.position) ?? null,
    enqueuedAt: str(entry.enqueuedAt, 40) ?? null,
  };
}

/**
 * Whether a GraphQL refusal is the server not knowing the merge queue schema.
 * GitHub Enterprise Server before 3.8 rejects the whole document over
 * `isMergeQueueEnabled`, `mergeQueueEntry` or the queue timeline items. Such a
 * server has no merge queue, so the gate reads as not required. PwrGit
 * (pwrdrvr/PwrGit#586) found the same. Only an Enterprise Server host can
 * lack it.
 */
export function isMergeQueueSchemaUnsupported(host: string, message: string): boolean {
  // github.com always has the schema: a refusal there is never "no queue",
  // so it can never turn into a direct merge past one.
  if (host.toLowerCase() === "github.com") return false;
  return /isMergeQueueEnabled|mergeQueueEntry|MergeQueue|MERGE_QUEUE/.test(message)
    && /doesn't exist|does not exist|undefined|invalid value|not a valid|Expected/i.test(message);
}

/** The gate for a server with no merge queue at all. */
export function githubGateWithoutQueue(): GithubMergeQueueGate {
  return { required: false, pullRequestId: "", open: true };
}

/** Read the gate query's `data`. */
export function parseGithubMergeQueueGate(data: unknown): GithubMergeQueueGate {
  const pr = object(object(object(data).repository).pullRequest);
  const id = str(pr.id, 200);
  if (!id) throw new ForgeReadError("invalid_response", "GitHub did not return the pull request's node id.");
  const state = str(pr.state, 20);
  const lifecycle = state === "MERGED" ? "merged" : state === "CLOSED" ? "closed" : "open";
  const entry = pr.mergeQueueEntry && typeof pr.mergeQueueEntry === "object" ? pr.mergeQueueEntry as Payload : null;
  const events = pr.queueEvents && typeof pr.queueEvents === "object" ? (pr.queueEvents as Payload).nodes : undefined;
  const event = Array.isArray(events) ? items(events.filter((node) => node !== null)).at(-1) : undefined;
  const eventType = event?.__typename === "AddedToMergeQueueEvent" ? "added"
    : event?.__typename === "RemovedFromMergeQueueEvent" ? "removed" : undefined;
  const status = githubMergeQueueStatus({
    lifecycle,
    enabled: pr.isMergeQueueEnabled === true,
    entry: entry ? entryObservation(entry) : null,
    lastEvent: event && eventType
      ? { type: eventType, createdAt: str(event.createdAt, 40) ?? null, reason: str(event.reason, 200) ?? null }
      : null,
  });
  const commits = pr.commits && typeof pr.commits === "object" ? (pr.commits as Payload).nodes : undefined;
  const commit = Array.isArray(commits) ? commits[0] as Payload | undefined : undefined;
  const rollup = commit?.commit && typeof commit.commit === "object"
    ? (commit.commit as Payload).statusCheckRollup
    : undefined;
  const checks = rollup && typeof rollup === "object" ? str((rollup as Payload).state, 20) : undefined;
  const baseRef = str(pr.baseRefName, 255);
  const headSha = str(pr.headRefOid, 64);
  return {
    required: pr.isMergeQueueEnabled === true,
    pullRequestId: id,
    open: lifecycle === "open",
    ...(baseRef ? { baseRef } : {}),
    ...(headSha ? { headSha } : {}),
    ...(status && status.state !== "not_queued" ? { status } : {}),
    ...(checks ? { checks } : {}),
  };
}

/**
 * What a merge does on a branch that requires the queue. A PR already in it
 * is left alone. GitHub queues only a PR whose required checks passed, so
 * while they run, auto-merge waits for them and then enqueues, the choice
 * `gh pr merge` makes too. Anything else is enqueued, and GitHub says why
 * when it refuses.
 */
export type GithubQueueAction = "already_queued" | "auto_merge" | "enqueue";

export function githubQueueAction(gate: GithubMergeQueueGate): GithubQueueAction {
  if (isMergeQueueActive(gate.status)) return "already_queued";
  if (gate.checks === "PENDING" || gate.checks === "EXPECTED") return "auto_merge";
  return "enqueue";
}

/** The queue reading an `enqueuePullRequest` answer gives. */
export function parseGithubEnqueueResult(data: unknown): PrMergeQueueStatus | undefined {
  const entry = object(object(object(data).enqueuePullRequest).mergeQueueEntry);
  return githubMergeQueueStatus({ lifecycle: "open", enabled: true, entry: entryObservation(entry) });
}

/** Whether an `enablePullRequestAutoMerge` answer shows auto-merge on. */
export function parseGithubAutoMergeResult(data: unknown): boolean {
  return Boolean(object(object(object(data).enablePullRequestAutoMerge).pullRequest).autoMergeRequest);
}

export type GithubQueueMergeResult =
  | { action: "already_queued"; status?: PrMergeQueueStatus }
  | { action: "auto_merge" }
  | { action: "enqueue"; status?: PrMergeQueueStatus };

/**
 * Take the queue action a gate calls for, through whichever GraphQL
 * transport the caller has (the CI client, or the operator's `gh`). Both
 * merge paths run this one decision, so neither can drift into a direct
 * merge. An auto-merge GitHub did not confirm is an error, never a success.
 */
export async function runGithubQueueMerge(
  gate: GithubMergeQueueGate,
  graphql: (query: string, variables: { id: string; head: string | null }) => Promise<unknown>,
  head?: string,
): Promise<GithubQueueMergeResult> {
  const action = githubQueueAction(gate);
  if (action === "already_queued") return { action, ...(gate.status ? { status: gate.status } : {}) };
  const variables = { id: gate.pullRequestId, head: head ?? null };
  if (action === "auto_merge") {
    if (!parseGithubAutoMergeResult(await graphql(GITHUB_ENABLE_AUTO_MERGE_MUTATION, variables))) {
      throw new ForgeReadError("rejected", "GitHub did not turn on auto-merge for the pull request.");
    }
    return { action };
  }
  const status = parseGithubEnqueueResult(await graphql(GITHUB_ENQUEUE_MUTATION, variables));
  return { action, ...(status ? { status } : {}) };
}
