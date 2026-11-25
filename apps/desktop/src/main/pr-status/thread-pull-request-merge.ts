import {
  isAppServerBackendKind,
  type MergeThreadPullRequestRequest,
  type MergeThreadPullRequestResponse,
  type ReadThreadPullRequestMergeResponse,
  type ThreadPullRequestMergeTarget,
} from "@pwragent/shared/contracts/navigation";
import {
  isThreadTodoMergeMethod,
  type ThreadTodoMergeMethod,
} from "@pwragent/shared/contracts/thread-todos";
import { MAX_GITHUB_STACK_OPEN_BELOW } from "@pwragent/shared/stacks/stack-status";
import { parsePullRequestReferenceUrl } from "./forge-reference";

export type ThreadPullRequestMergeResult = { summary: string } & (
  | { mergedUrl: string; queued?: false; alreadyMerged?: true }
  | { queued: true; mergedUrl?: never }
);

/**
 * Everything a PR card's merge touches outside this module. The desktop
 * wires them to the overlay, the project's merge-method store, the Continue
 * After holds and the operator's `gh`: the same pieces a to-do merge card
 * runs through.
 */
export type ThreadPullRequestMergeDeps = {
  readThreadPullRequestUrls: (thread: ThreadPullRequestMergeTarget) => string[];
  readPreference: (thread: ThreadPullRequestMergeTarget) => Promise<{
    remembered?: ThreadTodoMergeMethod;
    remember?: (method: ThreadTodoMergeMethod) => void;
  }>;
  defaultMethod: () => ThreadTodoMergeMethod;
  /** The thread's project label when its Forge Automation never merges. */
  neverMergeProject?: (thread: ThreadPullRequestMergeTarget) => string | undefined;
  resolveCwd: (thread: ThreadPullRequestMergeTarget) => Promise<string | undefined>;
  /** Throws while a Continue After wait holds this thread's merge of `url`. */
  assertNotHeld: (thread: ThreadPullRequestMergeTarget, url: string) => void;
  merge: (params: {
    cwd?: string;
    pullRequest: string;
    method: ThreadTodoMergeMethod;
    assertCanMerge: (url: string) => void;
    /** The open lower layers of the PR's GitHub stack the operator chose to merge with it. */
    mergeOpenLayersBelow?: number[];
  }, thread: ThreadPullRequestMergeTarget) => Promise<ThreadPullRequestMergeResult>;
  /** A queued PR still needs a provider observation for its queue status. */
  refresh: (thread: ThreadPullRequestMergeTarget) => Promise<unknown>;
  onRefreshFailed?: (error: unknown) => void;
};

/**
 * The thread a request names, with only its backend and id: a renderer or a
 * peer names it, so its shape is checked here. Undefined when malformed.
 */
export function readThreadPullRequestMergeThread(
  request: unknown,
): { backend: ThreadPullRequestMergeTarget["backend"]; threadId: string } | undefined {
  const record = (request ?? {}) as { backend?: unknown; threadId?: unknown };
  if (typeof record.backend !== "string" || !isAppServerBackendKind(record.backend)
    || typeof record.threadId !== "string" || !record.threadId.trim()) {
    return undefined;
  }
  return { backend: record.backend, threadId: record.threadId };
}

function readTarget(request: unknown): ThreadPullRequestMergeTarget {
  const thread = readThreadPullRequestMergeThread(request);
  if (!thread) throw new Error("Choose a thread to merge from.");
  return thread;
}

/** One identity per PR, whatever case or trailing path the URL was stored with. */
function pullRequestIdentity(url: string): string | undefined {
  const reference = parsePullRequestReferenceUrl(url);
  if (!reference) return undefined;
  return [reference.kind, reference.provider, reference.org.toLowerCase(), reference.repo.toLowerCase(), reference.number].join("\u0000");
}

/** The renderer's list of lower stack layers to merge too: distinct PR numbers, or nothing. */
function readMergeOpenLayersBelow(value: unknown): number[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_GITHUB_STACK_OPEN_BELOW
    || !value.every((number) => typeof number === "number" && Number.isSafeInteger(number) && number > 0)
    || new Set(value).size !== value.length) {
    throw new Error("Choose the stack layers to merge again.");
  }
  return value.length ? [...value as number[]] : undefined;
}

export async function readThreadPullRequestMerge(
  deps: ThreadPullRequestMergeDeps,
  request: unknown,
): Promise<ReadThreadPullRequestMergeResponse> {
  const thread = readTarget(request);
  const preference = await deps.readPreference(thread);
  const neverMergeProject = deps.neverMergeProject?.(thread);
  return {
    ...(preference.remembered ? { remembered: preference.remembered } : {}),
    fallback: deps.defaultMethod(),
    ...(neverMergeProject ? { neverMergeProject } : {}),
  };
}

/**
 * Merge one of a thread's attached GitHub PRs from its PR card. Main checks
 * what the renderer cannot be trusted to: the PR is the thread's, it is on
 * GitHub (the operator's `gh` lands it), the method is one of the three, and
 * no Continue After wait holds the merge. A base branch that needs a merge
 * queue gets the PR queued instead, as a to-do merge card does.
 */
export async function mergeThreadPullRequest(
  deps: ThreadPullRequestMergeDeps,
  request: unknown,
): Promise<MergeThreadPullRequestResponse> {
  const thread = readTarget(request);
  const { url, method, rememberMethod, mergeOpenLayersBelow } = (request ?? {}) as Partial<MergeThreadPullRequestRequest>;
  if (!isThreadTodoMergeMethod(method)) throw new Error("Choose squash, rebase or merge.");
  const layersBelow = readMergeOpenLayersBelow(mergeOpenLayersBelow);
  const reference = typeof url === "string" ? parsePullRequestReferenceUrl(url) : undefined;
  const identity = typeof url === "string" ? pullRequestIdentity(url) : undefined;
  if (!reference || !identity) throw new Error("That is not a pull request URL.");
  if (reference.kind !== "github") {
    throw new Error("Merging from the PR card works for GitHub pull requests only.");
  }
  const attached = deps.readThreadPullRequestUrls(thread)
    .find((candidate) => pullRequestIdentity(candidate) === identity);
  if (!attached) throw new Error(`#${reference.number} is not attached to this thread.`);
  const neverMergeProject = deps.neverMergeProject?.(thread);
  if (neverMergeProject) {
    throw new Error(`${neverMergeProject} never merges its pull requests. Change it from the project menu: Forge Automation.`);
  }
  deps.assertNotHeld(thread, attached);
  // GitHub lands the chosen layers below with this one, so a wait that holds
  // any of them holds this merge too.
  for (const layer of layersBelow ?? []) {
    deps.assertNotHeld(thread, `https://${reference.provider}/${reference.org}/${reference.repo}/pull/${layer}`);
  }
  // Remembered before the merge runs, as a to-do card's pick is: it is the
  // operator's preference whether or not this merge succeeds.
  if (rememberMethod === true) {
    (await deps.readPreference(thread)).remember?.(method);
  }
  const merged = await deps.merge({
    cwd: await deps.resolveCwd(thread),
    pullRequest: attached,
    method,
    assertCanMerge: (target) => deps.assertNotHeld(thread, target),
    ...(layersBelow ? { mergeOpenLayersBelow: layersBelow } : {}),
  }, thread);
  if (merged.queued) void deps.refresh(thread).catch((error: unknown) => deps.onRefreshFailed?.(error));
  return {
    summary: merged.summary.includes("#") ? merged.summary : `${merged.summary} #${reference.number}`,
    ...(merged.queued ? { queued: true } : {}),
  };
}
