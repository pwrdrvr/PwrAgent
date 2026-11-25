import type { ThreadTodoMergeMethod } from "@pwragent/shared/contracts/thread-todos";
import { ForgeReadError } from "./forge-tool-contract";

/**
 * GitHub's asynchronous merge, for the two merge paths: the agent's
 * `merge_pull_request` (GitHub API through the CI client) and a card's merge
 * (the operator's `gh`). A pull request in one of GitHub's own stacks merges
 * only this way: `gh pr merge` and the synchronous merge endpoint refuse it.
 * GitHub also queues the merge when the base branch requires a merge queue.
 */

/** GitHub's refusal of a direct merge of a stacked pull request. */
export const GITHUB_ASYNC_MERGE_REQUIRED = /part of a stack and must be merged using the asynchronous merge/i;

export type GithubAsyncMergeRequest = (
  method: "GET" | "PUT",
  route: string,
  body?: Record<string, string>,
) => Promise<unknown>;

export type GithubAsyncMergeOutcome =
  | { status: "merged"; sha?: string }
  /** In the merge queue: final for the request, but nothing has merged yet. */
  | { status: "enqueued" }
  /** GitHub accepted the merge and had not finished it by the deadline. */
  | { status: "pending"; uuid?: string; alreadyRequested?: boolean };

const DEFAULT_POLL_MS = 2_000;
const DEFAULT_DEADLINE_MS = 60_000;

type Reading = { status?: string; details?: { uuid?: string; message?: string; sha?: string } };

function reading(value: unknown): Reading {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Reading : {};
}

/**
 * Request the merge, then poll its request until GitHub settles it or the
 * deadline passes. A failed merge throws; one still running reports pending,
 * since GitHub may yet land it.
 */
export async function runGithubAsyncMerge(input: {
  request: GithubAsyncMergeRequest;
  number: number;
  method: ThreadTodoMergeMethod;
  /** The head the merge must take; a push before it runs cancels it. */
  sha?: string;
  /** True for the refusal GitHub sends when a merge of this pull request is already running. */
  isAlreadyRequested: (error: unknown) => boolean;
  /** Stops the wait, not the merge: an aborted wait reports pending. */
  signal?: AbortSignal;
  pollMs?: number;
  deadlineMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<GithubAsyncMergeOutcome> {
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? (async (ms: number) => await new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + (input.deadlineMs ?? DEFAULT_DEADLINE_MS);
  const route = `/pulls/${input.number}/merge-async`;
  let current: Reading;
  try {
    current = reading(await input.request("PUT", route, { merge_method: input.method, ...(input.sha ? { sha: input.sha } : {}) }));
  } catch (error) {
    if (input.isAlreadyRequested(error)) return { status: "pending", alreadyRequested: true };
    throw error;
  }
  const uuid = current.details?.uuid;
  for (;;) {
    if (current.status === "merged") return { status: "merged", ...(current.details?.sha ? { sha: current.details.sha } : {}) };
    if (current.status === "enqueued") return { status: "enqueued" };
    if (current.status === "failed") {
      throw new ForgeReadError("rejected", `GitHub could not merge #${input.number}: ${current.details?.message?.trim() || "the merge failed"}`);
    }
    if (!uuid || now() >= deadline || input.signal?.aborted) return { status: "pending", ...(uuid ? { uuid } : {}) };
    await sleep(input.pollMs ?? DEFAULT_POLL_MS);
    try {
      current = reading(await input.request("GET", `${route}/${encodeURIComponent(uuid)}`));
    } catch {
      // The merge was accepted: a failed read cannot say it did not land.
      return { status: "pending", uuid };
    }
  }
}
