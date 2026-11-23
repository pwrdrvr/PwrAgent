import type { FederationCapability, FederationRemoteTarget } from "@pwragent/shared/contracts/federation";
import type {
  FederationMergeThreadPullRequestRequestV1,
  FederationMergeThreadPullRequestResultV1,
  FederationReadThreadPullRequestMergeRequestV1,
  MergeThreadPullRequestRequest,
  MergeThreadPullRequestResponse,
  ReadThreadPullRequestMergeResponse,
  ThreadPullRequestMergeTarget,
} from "@pwragent/shared/contracts/navigation";
import { isRemoteFederationTarget } from "@pwragent/shared/contracts/federation";
import { THREAD_PULL_REQUEST_MERGE_CAPABILITY } from "@pwragent/shared/contracts/navigation";
import { isThreadTodoMergeMethod } from "@pwragent/shared/contracts/thread-todos";
import { readThreadPullRequestMergeThread } from "./thread-pull-request-merge";

/** What a viewer hears when the owning instance cannot merge for it. */
export const THREAD_PULL_REQUEST_MERGE_UNSUPPORTED_MESSAGE =
  "Update PwrAgent on the owning instance to merge its pull requests from here.";

/** What a viewer hears when the owner does not grant it turn control. */
export const THREAD_PULL_REQUEST_MERGE_FORBIDDEN_MESSAGE =
  "The owning instance does not let this one merge its pull requests.";

/** The federation runtime calls a viewer makes for a peer's merge. */
export type ThreadPullRequestMergeFederationRuntime = {
  remoteTargetSupportsCapability(
    target: FederationRemoteTarget,
    capability: FederationCapability,
  ): boolean;
  remoteBackend(target: FederationRemoteTarget): {
    readThreadPullRequestMergeV1(
      request: FederationReadThreadPullRequestMergeRequestV1,
    ): Promise<ReadThreadPullRequestMergeResponse>;
    mergeThreadPullRequestV1(
      request: FederationMergeThreadPullRequestRequestV1,
    ): Promise<FederationMergeThreadPullRequestResultV1>;
  };
};

/**
 * The instance that owns the thread a request names: the request's own
 * remote target, else the peer the sending window fronts. Undefined means
 * this instance.
 */
export function readThreadPullRequestMergeOwner(
  request: Pick<ThreadPullRequestMergeTarget, "federationTarget"> | undefined,
  windowTarget: FederationRemoteTarget | undefined,
): FederationRemoteTarget | undefined {
  const target = request?.federationTarget;
  if (target && isRemoteFederationTarget(target)) return target;
  return windowTarget;
}

function assertOwnerMerges(
  target: FederationRemoteTarget,
  runtime: ThreadPullRequestMergeFederationRuntime,
): void {
  if (!runtime.remoteTargetSupportsCapability(target, THREAD_PULL_REQUEST_MERGE_CAPABILITY)) {
    throw new Error(THREAD_PULL_REQUEST_MERGE_UNSUPPORTED_MESSAGE);
  }
  if (!runtime.remoteTargetSupportsCapability(target, "turn_control")) {
    throw new Error(THREAD_PULL_REQUEST_MERGE_FORBIDDEN_MESSAGE);
  }
}

/** Reads the method a peer thread's PR card starts on, from its owner. */
export async function readRemoteThreadPullRequestMerge(
  request: unknown,
  target: FederationRemoteTarget,
  runtime: ThreadPullRequestMergeFederationRuntime,
): Promise<ReadThreadPullRequestMergeResponse> {
  assertOwnerMerges(target, runtime);
  // Only the thread crosses: never a target, which would send it on again.
  const owned = readThreadPullRequestMergeThread(request);
  if (!owned) throw new Error("backend and threadId are required.");
  return await runtime.remoteBackend(target).readThreadPullRequestMergeV1(owned);
}

/**
 * Sends a peer thread's merge to its owner, which validates it exactly as
 * its own window's merge. The owner's refusal surfaces as its message.
 */
export async function mergeRemoteThreadPullRequest(
  request: unknown,
  target: FederationRemoteTarget,
  runtime: ThreadPullRequestMergeFederationRuntime,
): Promise<MergeThreadPullRequestResponse> {
  assertOwnerMerges(target, runtime);
  const owned = readFederationMergeThreadPullRequestRequest(request);
  if (!owned) throw new Error("backend, threadId, url and a merge method are required.");
  const result = await runtime.remoteBackend(target).mergeThreadPullRequestV1(owned);
  if (!result.ok) throw new Error(result.message);
  return { summary: result.summary, ...(result.queued ? { queued: true } : {}) };
}

/**
 * Runs a viewer's merge on the owner and answers with a result, so the
 * viewer shows the owner's reason for a refusal rather than a generic one.
 */
export async function mergeThreadPullRequestForPeer(
  request: unknown,
  merge: (request: MergeThreadPullRequestRequest) => Promise<MergeThreadPullRequestResponse>,
): Promise<FederationMergeThreadPullRequestResultV1> {
  const owned = readFederationMergeThreadPullRequestRequest(request);
  if (!owned) return { ok: false, message: "backend, threadId, url and a merge method are required." };
  try {
    return { ok: true, ...await merge(owned) };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The owner's copy of a viewer's merge. Only the named fields cross: never a
 * federation target, which would send the request on again.
 */
export function readFederationMergeThreadPullRequestRequest(
  value: unknown,
): FederationMergeThreadPullRequestRequestV1 | undefined {
  const thread = readThreadPullRequestMergeThread(value);
  if (!thread) return undefined;
  const request = value as Record<string, unknown>;
  const url = request.url;
  const method = request.method;
  if (typeof url !== "string" || !url.trim() || !isThreadTodoMergeMethod(method)) return undefined;
  return {
    ...thread,
    url,
    method,
    ...(request.rememberMethod === true ? { rememberMethod: true } : {}),
  };
}
