import fc from "fast-check";
import { expect, it, vi } from "vitest";
import { observeFactoryGithubPublication, readFactoryCreatedPr } from "../factory/factory-publication-github";
import type { ForgeCiClient } from "../pr-status/forge-ci-client";

const repository = "pwrdrvr/synthetic";
const repositoryId = "R_factory";
const branch = "work/example";
const base = "main";
const headOid = "a".repeat(40);
const baseOid = "b".repeat(40);
const ref = (oid: string) => ({ target: { oid } });
const pullRequest = {
  id: "PR_fixture", number: 42, state: "OPEN", isDraft: false, headRefName: branch, headRefOid: headOid,
  baseRefName: base, headRepository: { id: repositoryId }, baseRepository: { id: repositoryId }, baseRef: ref(baseOid),
  labels: { nodes: [{ name: "hold" }], pageInfo: { hasNextPage: false } },
};

const events = [
  { event: "current", expected: "current" },
  { event: "baseMoved", expected: "stale" },
  { event: "headMoved", expected: "stale" },
  { event: "deleted", expected: "missing" },
  { event: "retargeted", expected: "conflict" },
  { event: "replaced", expected: "conflict" },
  { event: "closed", expected: "conflict" },
  { event: "fork", expected: "conflict" },
  { event: "unavailable", expected: "uncertain" },
] as const;

it("a tracked pull request satisfies a receipt only while the provider confirms its identity and both live tips", async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.constantFrom(...events), { minLength: 4, maxLength: 16 }), async (sequence) => {
    for (const { event, expected } of sequence) {
      const github = vi.fn<ForgeCiClient["requestGithub"]>(async () => {
        if (event === "unavailable") return { errors: [{ message: "Partial response" }] };
        const selected = event === "deleted" ? null : {
          ...pullRequest,
          id: event === "replaced" ? "PR_other" : pullRequest.id,
          state: event === "closed" ? "CLOSED" : "OPEN",
          baseRefName: event === "retargeted" ? "release" : base,
          headRepository: event === "fork" ? { id: "R_fork" } : { id: repositoryId },
        };
        return { data: { repository: {
          id: repositoryId, nameWithOwner: repository,
          head: ref(event === "headMoved" ? "d".repeat(40) : headOid),
          base: ref(event === "baseMoved" ? "c".repeat(40) : baseOid), selected,
        } } };
      });
      expect(await observeFactoryGithubPublication(github, {
        repository, repositoryId, branch, base, headOid, baseOid, prNumber: 42, prId: "PR_fixture", notReadyLabel: "hold",
      })).toMatchObject({ status: expected });
      expect(github).toHaveBeenCalledTimes(1);
    }
  }), { numRuns: 32 });
});

it("bounds discovery to one provider request and two returned PRs as repository inventory grows", async () => {
  for (const size of [16, 64, 256]) {
    const inventory = Array.from({ length: size }, (_, index) => ({ ...pullRequest, number: index + 100, headRefName: `unrelated/${index}` }));
    const github = vi.fn<ForgeCiClient["requestGithub"]>(async (_repo, request) => {
      const { query, variables } = request.body as { query: string; variables: { branch: string } };
      expect(query).toContain("pullRequests(first: 2, headRefName: $branch)");
      const matches = [...inventory, pullRequest].filter(({ headRefName }) => headRefName === variables.branch);
      return { data: { repository: {
        id: repositoryId, nameWithOwner: repository, head: ref(headOid), base: ref(baseOid),
        matches: { nodes: matches.slice(0, 2), pageInfo: { hasNextPage: matches.length > 2 } },
      } } };
    });
    expect(await observeFactoryGithubPublication(github, { repository, branch, base, headOid, baseOid })).toMatchObject({
      status: "current", pr: { number: 42 },
    });
    expect(github).toHaveBeenCalledTimes(1);
  }
});

it.each([
  { label: "HOLD", readiness: "not_ready_label" },
  { label: undefined, readiness: "ready" },
])("reports draft and label readiness using the selected label policy ($readiness)", async ({ label, readiness }) => {
  const github: ForgeCiClient["requestGithub"] = async () => ({ data: { repository: {
    id: repositoryId, nameWithOwner: repository, head: ref(headOid), base: ref(baseOid), selected: pullRequest,
  } } });
  expect(await observeFactoryGithubPublication(github, { repository, branch, base, headOid, baseOid,
    prNumber: 42, notReadyLabel: label })).toMatchObject({ status: "current", pr: { readiness } });
});

it("a created PR satisfies the confirmation only if its whole returned snapshot matches", () => {
  const head = { ref: branch, sha: headOid, repo: { node_id: repositoryId } };
  const target = { ref: base, sha: baseOid, repo: { node_id: repositoryId } };
  const original = { node_id: pullRequest.id, number: pullRequest.number, head, base: target, state: "open", draft: true };
  const changes = [
    { head: { ...head, sha: baseOid } }, { base: { ...target, sha: headOid } },
    { head: { ...head, ref: "elsewhere" } }, { base: { ...target, ref: "elsewhere" } },
    { head: { ...head, repo: { node_id: "fork" } } }, { base: { ...target, repo: { node_id: "other" } } },
    { state: "closed" }, { draft: false },
  ];
  fc.assert(fc.property(fc.subarray(changes), (edits) => {
    const payload = Object.assign({}, original, ...edits);
    expect(readFactoryCreatedPr(payload, { repositoryId, branch, base, headOid, baseOid, draft: true })).toEqual({
      id: pullRequest.id, number: pullRequest.number, matches: edits.length === 0,
    });
  }));
});
