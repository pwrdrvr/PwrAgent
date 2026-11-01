import type {
  FederationCapability,
  FederationRemoteTarget,
  FederationThreadPrWatchesRequestV1,
  ThreadPrWatchesRequest,
  ThreadPrWatchesResponse,
} from "@pwragent/shared";
import {
  isAppServerBackendKind,
  isRemoteFederationTarget,
  THREAD_PR_WATCH_CONTROL_CAPABILITY,
} from "@pwragent/shared";

/** What a viewer hears when the owning instance cannot manage watches for it. */
export const THREAD_PR_WATCHES_UNSUPPORTED_MESSAGE =
  "Update PwrAgent on the owning instance to stop or start its PR watches from here.";

/** The federation runtime calls a viewer makes for a peer's watches. */
export type ThreadPrWatchesFederationRuntime = {
  remoteTargetSupportsCapability(
    target: FederationRemoteTarget,
    capability: FederationCapability,
  ): boolean;
  remoteBackend(target: FederationRemoteTarget): {
    manageThreadPrWatchesV1(
      request: FederationThreadPrWatchesRequestV1,
    ): Promise<ThreadPrWatchesResponse>;
  };
};

/**
 * The owner a request names, when it names a peer. `active` lists this
 * instance's own watches and never travels.
 */
export function readThreadPrWatchesRemoteTarget(
  request: ThreadPrWatchesRequest | undefined,
): FederationRemoteTarget | undefined {
  if (!request || request.action === "active") return undefined;
  const target = request.federationTarget;
  return target && isRemoteFederationTarget(target) ? target : undefined;
}

/**
 * Sends a peer thread's history, Stop or Watch CI to its owner. An owner
 * that does not advertise the capability, or does not grant turn control,
 * gets no request: its watches stay read-only here.
 */
export async function manageRemoteThreadPrWatches(
  request: Exclude<ThreadPrWatchesRequest, { action: "active" }>,
  target: FederationRemoteTarget,
  runtime: ThreadPrWatchesFederationRuntime,
): Promise<ThreadPrWatchesResponse> {
  if (
    !runtime.remoteTargetSupportsCapability(target, THREAD_PR_WATCH_CONTROL_CAPABILITY)
    || !runtime.remoteTargetSupportsCapability(target, "turn_control")
  ) {
    return {
      ok: false,
      error: { code: "federation_unsupported", message: THREAD_PR_WATCHES_UNSUPPORTED_MESSAGE },
    };
  }
  const owned = readFederationThreadPrWatchesRequest(request);
  if (!owned) {
    return {
      ok: false,
      error: { code: "invalid_arguments", message: "backend, threadId and the action's argument are required." },
    };
  }
  return await runtime.remoteBackend(target).manageThreadPrWatchesV1(owned);
}

/**
 * The owner's copy of a viewer's request. Only the named fields cross: no
 * federation target, and never `active`, which would list every thread's
 * watches. Undefined for anything else.
 */
export function readFederationThreadPrWatchesRequest(
  value: unknown,
): FederationThreadPrWatchesRequestV1 | undefined {
  if (!value || typeof value !== "object") return undefined;
  const request = value as Record<string, unknown>;
  const backend = request.backend;
  const threadId = request.threadId;
  if (
    typeof backend !== "string"
    || !isAppServerBackendKind(backend)
    || typeof threadId !== "string"
    || !threadId.trim()
  ) {
    return undefined;
  }
  if (request.action === "history") {
    const limit = request.limit;
    return {
      action: "history",
      backend,
      threadId,
      ...(typeof limit === "number" && Number.isFinite(limit) ? { limit } : {}),
    };
  }
  if (request.action === "cancel") {
    const watchId = request.watchId;
    return typeof watchId === "string" && watchId.trim()
      ? { action: "cancel", backend, threadId, watchId }
      : undefined;
  }
  if (request.action === "watch") {
    const prUrl = request.prUrl;
    return typeof prUrl === "string" && prUrl.trim()
      ? { action: "watch", backend, threadId, prUrl }
      : undefined;
  }
  return undefined;
}
