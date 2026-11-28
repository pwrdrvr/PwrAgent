import { z } from "zod";
import { isGitObjectId } from "@pwragent/shared/git-object-id";
import type { ForgeCiClient } from "../pr-status/forge-ci-client";

const CHECK_LIMIT = 64;
const query = `query FactoryLanding($owner: String!, $name: String!, $number: Int!, $id: ID!) {
  viewer { id login }
  repository(owner: $owner, name: $name) {
    id nameWithOwner viewerPermission
    pullRequest(number: $number) {
      id number state isDraft headRefName headRefOid baseRefName
      headRepository { id } baseRepository { id }
      headRef { target { oid } } baseRef { target { oid } }
      labels(first: 32) { nodes { name } pageInfo { hasNextPage } }
      isMergeQueueEnabled isInMergeQueue autoMergeRequest { enabledAt }
      mergeQueueEntry { id state }
      timelineItems(last: 1, itemTypes: [ADDED_TO_MERGE_QUEUE_EVENT, REMOVED_FROM_MERGE_QUEUE_EVENT]) {
        nodes {
          __typename
          ... on AddedToMergeQueueEvent { id createdAt }
          ... on RemovedFromMergeQueueEvent { id createdAt reason }
        }
      }
      commits(last: 1) { nodes { commit { oid statusCheckRollup { state } } } }
      potentialMergeCommit {
        oid parents(first: 3) { nodes { oid } }
        statusCheckRollup { contexts(first: ${CHECK_LIMIT}) {
          pageInfo { hasNextPage }
          nodes {
            __typename
            ... on CheckRun { id name status conclusion isRequired(pullRequestId: $id) }
            ... on StatusContext { id context state isRequired(pullRequestId: $id) }
          }
        } }
      }
    }
  }
}`;

const id = z.string().min(1).max(256);
const oid = z.string().refine(isGitObjectId);
const ref = z.object({ target: z.object({ oid }) }).nullable();
const state = z.string().max(40);
const pageInfo = z.object({ hasNextPage: z.boolean() });
const check = z.discriminatedUnion("__typename", [
  z.object({ __typename: z.literal("CheckRun"), id, name: id, status: state, conclusion: state.nullable(), isRequired: z.boolean() }),
  z.object({ __typename: z.literal("StatusContext"), id, context: id, state, isRequired: z.boolean() }),
]);
const pr = z.object({
  id, number: z.int().positive(), state: z.enum(["OPEN", "CLOSED", "MERGED"]), isDraft: z.boolean(),
  headRefName: id, headRefOid: oid, baseRefName: id, headRef: ref, baseRef: ref,
  headRepository: z.object({ id }).nullable(), baseRepository: z.object({ id }).nullable(),
  labels: z.object({ nodes: z.array(z.object({ name: id })).max(32), pageInfo }),
  isMergeQueueEnabled: z.boolean(), isInMergeQueue: z.boolean(), autoMergeRequest: z.object({ enabledAt: id }).nullable(),
  mergeQueueEntry: z.object({
    id, state: z.enum(["QUEUED", "AWAITING_CHECKS", "MERGEABLE", "LOCKED", "UNMERGEABLE"]),
  }).nullable(),
  timelineItems: z.object({ nodes: z.array(z.object({
    id, createdAt: z.iso.datetime({ offset: true }), reason: state.nullish(),
    __typename: z.enum(["AddedToMergeQueueEvent", "RemovedFromMergeQueueEvent"]),
  })).max(1) }),
  commits: z.object({ nodes: z.array(z.object({
    commit: z.object({ oid, statusCheckRollup: z.object({ state }).nullable() }),
  })).max(1) }),
  potentialMergeCommit: z.object({
    oid, parents: z.object({ nodes: z.array(z.object({ oid })).max(3) }),
    statusCheckRollup: z.object({ contexts: z.object({ pageInfo, nodes: z.array(check).max(CHECK_LIMIT) }) }).nullable(),
  }).nullable(),
});
const response = z.object({ errors: z.array(z.unknown()).max(0).optional(), data: z.object({
  viewer: z.object({ id, login: id }),
  repository: z.object({
    id, nameWithOwner: id, viewerPermission: z.enum(["ADMIN", "MAINTAIN", "WRITE", "TRIAGE", "READ"]).nullable(),
    pullRequest: pr.nullable(),
  }).nullable(),
}) });

export type FactoryLandingIdentity = {
  repository: string; repositoryId: string; id: string; number: number;
  branch: string; base: string; headOid: string; baseOid: string;
};

export async function observeFactoryGithubLanding(
  github: ForgeCiClient["requestGithub"], identity: FactoryLandingIdentity, signal?: AbortSignal,
) {
  const [owner = "", repo = ""] = identity.repository.split("/");
  const result = await github({ provider: "github", host: "github.com", owner, repo }, {
    path: "", graphql: true,
    body: { query, variables: { owner, name: repo, number: identity.number, id: identity.id } },
  }, signal).catch(() => undefined);
  const parsed = response.safeParse(result);
  if (!parsed.success) return { status: "uncertain" as const, reason: "GitHub did not return a complete landing observation." };
  const { repository, viewer } = parsed.data.data;
  const pull = repository?.pullRequest;
  if (!pull || !repository) return { status: "missing" as const, reason: "GitHub did not return the published pull request." };
  if (repository.id !== identity.repositoryId || repository.nameWithOwner.toLowerCase() !== identity.repository
    || pull.id !== identity.id || pull.number !== identity.number
    || pull.headRepository?.id !== repository.id || pull.baseRepository?.id !== repository.id
    || pull.headRefName !== identity.branch || pull.baseRefName !== identity.base || pull.headRefOid !== identity.headOid) {
    return { status: "stale" as const, reason: "The published PR identity, head or target branch changed." };
  }
  return { status: "observed" as const, viewer, permission: repository.viewerPermission, pull };
}

type Pull = z.infer<typeof pr>;

export function factoryIntegrationChecks(pull: Pull, identity: FactoryLandingIdentity, requiredChecks: readonly string[]) {
  const head = pull.commits.nodes[0]?.commit;
  const headChecks = head?.oid === identity.headOid ? head?.statusCheckRollup?.state ?? "MISSING" : "MISSING";
  const candidate = pull.potentialMergeCommit;
  if (!candidate || candidate.oid === identity.headOid || candidate.oid === identity.baseOid
    || candidate.parents.nodes.length !== 2 || candidate.parents.nodes[0]?.oid !== identity.baseOid
    || candidate.parents.nodes[1]?.oid !== identity.headOid) {
    return { headChecks, checks: [], reason: "Wait for a GitHub test merge commit with this base and head. Head-only CI cannot clear integration." };
  }
  const contexts = candidate.statusCheckRollup?.contexts;
  if (contexts?.pageInfo.hasNextPage) {
    return { headChecks, candidateOid: candidate.oid, checks: [], reason: "GitHub returned an incomplete page of integration checks." };
  }
  const byName = new Map<string, z.infer<typeof check> | null>();
  const names = new Set(requiredChecks);
  for (const node of contexts?.nodes ?? []) {
    const name = node.__typename === "CheckRun" ? node.name : node.context;
    byName.set(name, byName.has(name) ? null : node);
    if (node.isRequired) names.add(name);
  }
  const checks = [...names].sort().map((name) => {
    const entry = byName.get(name);
    if (entry === undefined) return { name, status: "MISSING" };
    if (entry === null) return { name, status: "AMBIGUOUS" };
    if (!entry.isRequired) return { name, status: "NOT_REQUIRED_BY_GITHUB" };
    const status = entry.__typename === "StatusContext" ? entry.state
      : entry.status === "COMPLETED" ? entry.conclusion ?? "MISSING" : entry.status;
    return { name, id: entry.id, status };
  });
  const failing = checks.find(({ status }) => status !== "SUCCESS");
  return {
    headChecks, candidateOid: candidate.oid, checks,
    reason: failing ? `Integration check "${failing.name}" is ${failing.status}. Confirm the workflow runs on the test merge commit.`
      : headChecks !== "SUCCESS" ? `Head checks are ${headChecks}. Wait for GitHub's queue admission checks to pass.` : undefined,
  };
}
