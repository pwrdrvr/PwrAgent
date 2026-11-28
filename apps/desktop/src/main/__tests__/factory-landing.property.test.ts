import fc from "fast-check";
import { expect, it, vi } from "vitest";
import {
  GITHUB_ENQUEUE_MUTATION, runGithubQueueMerge, type GithubMergeQueueGate,
} from "../pr-status/github-merge-queue";

it("only writes an expected-head enqueue after all queue admission fences pass", async () => {
  const expected = "a".repeat(40);
  await fc.assert(fc.asyncProperty(
    fc.record({
      required: fc.boolean(), open: fc.boolean(), sameHead: fc.boolean(), hasExpected: fc.boolean(),
      checks: fc.constantFrom("PENDING", "EXPECTED", "FAILURE", "SUCCESS", undefined), queued: fc.boolean(),
    }),
    async ({ required, open, sameHead, hasExpected, checks, queued }) => {
      const gate: GithubMergeQueueGate = {
        required, open, headSha: sameHead ? expected : "b".repeat(40), checks, pullRequestId: "PR_fixture",
        ...(queued ? { status: { kind: "merge_queue", state: "group_checks_running" } } : {}),
      };
      const graphql = vi.fn(async (_query: string, _variables: { id: string; head: string | null }) => ({
        enqueuePullRequest: { mergeQueueEntry: { state: "AWAITING_CHECKS", enqueuedAt: "2026-01-01T00:00:00Z" } },
      }));
      const result = runGithubQueueMerge(gate, graphql, hasExpected ? expected : undefined, { enqueueOnly: true });
      const admitted = required && open && sameHead && hasExpected && checks === "SUCCESS" && !queued;
      if (admitted) {
        await expect(result).resolves.toMatchObject({ action: "enqueue", status: { state: "group_checks_running" } });
        expect(graphql).toHaveBeenCalledExactlyOnceWith(GITHUB_ENQUEUE_MUTATION, { id: "PR_fixture", head: expected });
      } else {
        await expect(result).rejects.toThrow("Protected queue admission");
        expect(graphql).not.toHaveBeenCalled();
      }
    },
  ));
});

it("never treats a pending check as permission to arm auto-merge", async () => {
  const head = "a".repeat(40);
  const graphql = vi.fn(async () => undefined);
  await expect(runGithubQueueMerge({ required: true, open: true, headSha: head, pullRequestId: "PR_fixture", checks: "PENDING" },
    graphql, head, { enqueueOnly: true })).rejects.toThrow("Protected queue admission");
  expect(graphql).not.toHaveBeenCalled();
});
