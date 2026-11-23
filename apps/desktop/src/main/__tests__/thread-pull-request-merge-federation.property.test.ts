import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import type { FederationCapability, FederationRemoteTarget } from "@pwragent/shared/contracts/federation";
import { THREAD_PULL_REQUEST_MERGE_CAPABILITY } from "@pwragent/shared/contracts/navigation";
import {
  mergeRemoteThreadPullRequest,
  mergeThreadPullRequestForPeer,
  readFederationMergeThreadPullRequestRequest,
  readRemoteThreadPullRequestMerge,
  readThreadPullRequestMergeOwner,
  THREAD_PULL_REQUEST_MERGE_FORBIDDEN_MESSAGE,
  THREAD_PULL_REQUEST_MERGE_UNSUPPORTED_MESSAGE,
  type ThreadPullRequestMergeFederationRuntime,
} from "../pr-status/thread-pull-request-merge-federation";

/**
 * A peer thread's PR card merge crosses to its owner. The viewer sends it
 * only to an owner that advertises the merge and grants turn control, and
 * only the allowlisted fields cross. The owner answers a refusal as a
 * result carrying its own reason.
 */
const PEER: FederationRemoteTarget = { scope: "remote", instanceId: "peer-a" };
const REQUEST = {
  backend: "codex",
  threadId: "thread-1",
  url: "https://github.com/acme/orbit/pull/12",
  method: "squash",
  rememberMethod: true,
  federationTarget: PEER,
} as const;

function runtimeWith(granted: readonly FederationCapability[]) {
  const read = vi.fn(async () => ({ fallback: "squash" as const }));
  const merge = vi.fn(async () => ({ ok: true as const, summary: "Squashed #12" }));
  const runtime: ThreadPullRequestMergeFederationRuntime = {
    remoteTargetSupportsCapability: (_target, capability) => granted.includes(capability),
    remoteBackend: () => ({ readThreadPullRequestMergeV1: read, mergeThreadPullRequestV1: merge }),
  };
  return { runtime, read, merge };
}

const GRANTS: FederationCapability[] = [THREAD_PULL_REQUEST_MERGE_CAPABILITY, "turn_control", "thread_detail"];

describe("federated PR card merge", () => {
  it("reaches the owner exactly when it advertises the merge and grants turn control", async () => {
    await fc.assert(fc.asyncProperty(fc.subarray(GRANTS), async (granted) => {
      const { runtime, read, merge } = runtimeWith(granted);
      const supported = granted.includes(THREAD_PULL_REQUEST_MERGE_CAPABILITY);
      const allowed = supported && granted.includes("turn_control");
      const expected = !supported
        ? THREAD_PULL_REQUEST_MERGE_UNSUPPORTED_MESSAGE
        : THREAD_PULL_REQUEST_MERGE_FORBIDDEN_MESSAGE;
      const merged = mergeRemoteThreadPullRequest(REQUEST, PEER, runtime);
      const readMethod = readRemoteThreadPullRequestMerge(REQUEST, PEER, runtime);
      if (allowed) {
        await expect(merged).resolves.toEqual({ summary: "Squashed #12" });
        await expect(readMethod).resolves.toEqual({ fallback: "squash" });
      } else {
        await expect(merged).rejects.toThrow(expected);
        await expect(readMethod).rejects.toThrow(expected);
      }
      expect(merge).toHaveBeenCalledTimes(allowed ? 1 : 0);
      expect(read).toHaveBeenCalledTimes(allowed ? 1 : 0);
    }));
  });

  it("sends the owner only the allowlisted fields, never a target to forward", async () => {
    const { runtime, read, merge } = runtimeWith(GRANTS);
    await mergeRemoteThreadPullRequest({ ...REQUEST, extra: "x" }, PEER, runtime);
    await readRemoteThreadPullRequestMerge({ ...REQUEST, extra: "x" }, PEER, runtime);
    expect(merge).toHaveBeenCalledWith({
      backend: "codex", threadId: "thread-1", url: REQUEST.url, method: "squash", rememberMethod: true,
    });
    expect(read).toHaveBeenCalledWith({ backend: "codex", threadId: "thread-1" });
  });

  it("shows the owner's own reason when it refuses", async () => {
    const { runtime, merge } = runtimeWith(GRANTS);
    merge.mockResolvedValueOnce({ ok: false, message: "#12 is not attached to this thread." } as never);
    await expect(mergeRemoteThreadPullRequest(REQUEST, PEER, runtime))
      .rejects.toThrow("#12 is not attached to this thread.");
  });

  it("answers a peer's refusal as a result and never runs a malformed request", async () => {
    await fc.assert(fc.asyncProperty(
      fc.record({
        backend: fc.constantFrom("codex", "claude", "nope", 7),
        threadId: fc.constantFrom("thread-1", "", "  ", undefined),
        url: fc.constantFrom(REQUEST.url, "", undefined),
        method: fc.constantFrom("squash", "rebase", "merge", "fast-forward", undefined),
      }, { requiredKeys: [] }),
      fc.boolean(),
      async (request, refuses) => {
        const run = vi.fn(async () => {
          if (refuses) throw new Error("Merge waits for CI.");
          return { summary: "Merged #12" };
        });
        const result = await mergeThreadPullRequestForPeer(request, run);
        const wellFormed = readFederationMergeThreadPullRequestRequest(request) !== undefined;
        expect(run).toHaveBeenCalledTimes(wellFormed ? 1 : 0);
        if (!wellFormed) expect(result.ok).toBe(false);
        else expect(result).toEqual(refuses
          ? { ok: false, message: "Merge waits for CI." }
          : { ok: true, summary: "Merged #12" });
      },
    ));
  });

  it("names the owner from the request, else from the viewer window", () => {
    const windowTarget: FederationRemoteTarget = { scope: "remote", instanceId: "peer-b" };
    expect(readThreadPullRequestMergeOwner({ federationTarget: PEER }, windowTarget)).toEqual(PEER);
    expect(readThreadPullRequestMergeOwner({ federationTarget: { scope: "local" } }, windowTarget)).toEqual(windowTarget);
    expect(readThreadPullRequestMergeOwner({}, undefined)).toBeUndefined();
    expect(readThreadPullRequestMergeOwner({ federationTarget: { scope: "local" } }, undefined)).toBeUndefined();
  });
});
