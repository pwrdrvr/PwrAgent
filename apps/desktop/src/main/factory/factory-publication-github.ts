import { z } from "zod";
import { isGitObjectId } from "@pwragent/shared/git-object-id";
import type { ForgeCiClient } from "../pr-status/forge-ci-client";
import type { ForgeRepository } from "../pr-status/forge-tool-contract";

const PR_FIELDS = `id number state isDraft headRefName headRefOid baseRefName
  headRepository { id } baseRepository { id } baseRef { target { oid } }
  labels(first: 32) { nodes { name } pageInfo { hasNextPage } }`;
const query = (tracked: boolean) => `query FactoryPublication(
  $owner: String!, $name: String!, $head: String!, $base: String!, ${tracked ? "$number: Int!" : "$branch: String!"}
) {
  repository(owner: $owner, name: $name) {
    id nameWithOwner
    head: ref(qualifiedName: $head) { target { oid } }
    base: ref(qualifiedName: $base) { target { oid } }
    ${tracked ? `selected: pullRequest(number: $number) { ${PR_FIELDS} }`
      : `matches: pullRequests(first: 2, headRefName: $branch) {
        nodes { ${PR_FIELDS} } pageInfo { hasNextPage }
      }`}
  }
}`;

const oid = z.string().refine(isGitObjectId);
const id = z.string().min(1).max(256);
const repoId = z.object({ id });
const ref = z.object({ target: z.object({ oid }) }).nullable();
const pageInfo = z.object({ hasNextPage: z.boolean() });
const pr = z.object({
  id, number: z.int().positive(), state: z.enum(["OPEN", "CLOSED", "MERGED"]), isDraft: z.boolean(),
  headRefName: z.string(), headRefOid: oid, baseRefName: z.string(),
  headRepository: repoId.nullable(), baseRepository: repoId.nullable(), baseRef: ref,
  labels: z.object({ nodes: z.array(z.object({ name: z.string() })).max(32), pageInfo }).nullable(),
});
const repository = z.object({
  id, nameWithOwner: z.string(), head: ref, base: ref,
  selected: pr.nullable().optional(),
  matches: z.object({ nodes: z.array(pr).max(2), pageInfo }).optional(),
});
const response = z.object({ errors: z.array(z.unknown()).max(0).optional(), data: z.object({ repository }) });

export type FactoryPublishedPr = {
  id: string;
  number: number;
  url: string;
  readiness: "draft" | "not_ready_label" | "ready" | "unknown";
};

type PrIdentity = Pick<FactoryPublishedPr, "id" | "number">;
type Observation =
  | { status: "current"; repositoryId: string; pr?: FactoryPublishedPr }
  | { status: "missing" | "stale" | "conflict" | "uncertain"; reason: string; prIdentity?: PrIdentity };

export function factoryGithubRepository(repository: string): ForgeRepository {
  const [owner = "", repo = ""] = repository.split("/");
  return { provider: "github", host: "github.com", owner, repo };
}

const createdIdentity = z.object({ node_id: id, number: z.int().min(1).max(2_147_483_647) });
const createdRef = z.object({ ref: z.string(), sha: oid, repo: z.object({ node_id: id }) });
const createdPr = createdIdentity.extend({ state: z.literal("open"), draft: z.boolean(), head: createdRef, base: createdRef });

/** Keep the returned identity even when the creation snapshot differs from the approval. */
export function readFactoryCreatedPr(payload: unknown, expected: {
  repositoryId: string; branch: string; base: string; headOid: string; baseOid: string; draft: boolean;
}) {
  const identity = createdIdentity.safeParse(payload);
  if (!identity.success) return undefined;
  const parsed = createdPr.safeParse(payload);
  const pr = parsed.data;
  return {
    id: identity.data.node_id, number: identity.data.number,
    matches: !!pr && pr.head.repo.node_id === expected.repositoryId && pr.base.repo.node_id === expected.repositoryId
      && pr.head.ref === expected.branch && pr.base.ref === expected.base
      && pr.head.sha === expected.headOid && pr.base.sha === expected.baseOid && pr.draft === expected.draft,
  };
}

/** One bounded provider read of the repository, live ref tips, and tracked PR or exact branch matches. */
export async function observeFactoryGithubPublication(
  github: ForgeCiClient["requestGithub"],
  args: {
    repository: string; branch: string; base: string; headOid: string; baseOid: string;
    repositoryId?: string; prNumber?: number; prId?: string; notReadyLabel?: string;
  },
): Promise<Observation> {
  const target = factoryGithubRepository(args.repository);
  const tracked = args.prNumber !== undefined;
  const payload = await github(target, {
    path: "", graphql: true,
    body: { query: query(tracked), variables: {
      owner: target.owner, name: target.repo, head: `refs/heads/${args.branch}`, base: `refs/heads/${args.base}`,
      ...(tracked ? { number: args.prNumber } : { branch: args.branch }),
    } },
  }).catch(() => undefined);
  const parsed = response.safeParse(payload);
  if (!parsed.success) return { status: "uncertain", reason: "GitHub did not provide a complete publication observation." };
  const repo = parsed.data.data.repository;
  if (repo.nameWithOwner.toLowerCase() !== args.repository || (args.repositoryId && repo.id !== args.repositoryId)) {
    return { status: "conflict", reason: "GitHub repository identity changed or does not match the tracked pull request." };
  }
  const selected = tracked ? repo.selected : repo.matches?.nodes[0];
  const ambiguous = repo.matches && (repo.matches.pageInfo.hasNextPage || repo.matches.nodes.length > 1);
  const matchesIdentity = selected && (!tracked || selected.number === args.prNumber) && (!args.prId || selected.id === args.prId)
    && selected.headRepository?.id === repo.id && selected.baseRepository?.id === repo.id
    && selected.headRefName === args.branch && selected.baseRefName === args.base;
  const prIdentity = !ambiguous && matchesIdentity && selected ? { id: selected.id, number: selected.number } : undefined;
  if (!repo.head || !repo.base) return { status: "missing", reason: "The pushed branch or target branch is missing on GitHub.", prIdentity };
  if (repo.head.target.oid !== args.headOid || repo.base.target.oid !== args.baseOid) {
    return { status: "stale", reason: "The pushed head or target tip differs from the reviewed revision.", prIdentity };
  }
  if (tracked && repo.selected === null) return { status: "missing", reason: "The tracked pull request was not found on GitHub." };
  if ((tracked && !repo.selected) || (!tracked && !repo.matches)) {
    return { status: "uncertain", reason: "GitHub did not confirm the pull request selection." };
  }
  if (ambiguous) {
    return { status: "conflict", reason: "Multiple pull requests match the branch. Select the tracked pull request explicitly." };
  }
  if (!selected) return { status: "current", repositoryId: repo.id };
  if (!matchesIdentity || selected.state !== "OPEN") {
    return { status: "conflict", reason: "The pull request is closed, retargeted, outside this repository, or a different pull request.", prIdentity };
  }
  if (selected.headRefOid !== args.headOid || selected.baseRef?.target.oid !== args.baseOid) {
    return { status: "stale", reason: "The pull request differs from the reviewed head or target tip.", prIdentity };
  }
  const holdLabel = args.notReadyLabel?.toLowerCase();
  const readiness = selected.isDraft ? "draft"
    : !holdLabel ? "ready"
    : selected.labels?.nodes.some(({ name: label }) => label.toLowerCase() === holdLabel) ? "not_ready_label"
    : !selected.labels || selected.labels.pageInfo.hasNextPage ? "unknown" : "ready";
  return {
    status: "current", repositoryId: repo.id, pr: {
      id: selected.id, number: selected.number, url: `https://github.com/${args.repository}/pull/${selected.number}`, readiness,
    },
  };
}
