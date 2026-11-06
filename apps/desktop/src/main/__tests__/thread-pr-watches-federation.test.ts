import { describe, expect, it, vi } from "vitest";
import type { FederationCapability, FederationRemoteTarget } from "@pwragent/shared";
import {
  manageRemoteThreadPrWatches,
  readFederationThreadPrWatchesRequest,
  readThreadPrWatchesRemoteTarget,
  THREAD_PR_WATCHES_UNSUPPORTED_MESSAGE,
} from "../pr-status/thread-pr-watches-federation";

const owner: FederationRemoteTarget = { scope: "remote", instanceId: "peer_owner" };

function runtimeWith(capabilities: FederationCapability[]) {
  const manageThreadPrWatchesV1 = vi.fn(async () => ({ ok: true as const, cancelled: true }));
  const remoteBackend = vi.fn(() => ({ manageThreadPrWatchesV1 }));
  return {
    manageThreadPrWatchesV1,
    remoteBackend,
    runtime: {
      remoteTargetSupportsCapability: (_target: FederationRemoteTarget, capability: FederationCapability) =>
        capabilities.includes(capability),
      remoteBackend,
    },
  };
}

describe("readThreadPrWatchesRemoteTarget", () => {
  it("names a peer owner, never for the local list or a local target", () => {
    expect(readThreadPrWatchesRemoteTarget({
      action: "cancel", backend: "codex", threadId: "t", watchId: "w", federationTarget: owner,
    })).toEqual(owner);
    expect(readThreadPrWatchesRemoteTarget({ action: "active" })).toBeUndefined();
    expect(readThreadPrWatchesRemoteTarget({
      action: "history", backend: "codex", threadId: "t", federationTarget: { scope: "local" },
    })).toBeUndefined();
    expect(readThreadPrWatchesRemoteTarget(undefined)).toBeUndefined();
  });
});

describe("manageRemoteThreadPrWatches", () => {
  it("sends Stop to an owner that accepts it, without the target", async () => {
    const { runtime, remoteBackend, manageThreadPrWatchesV1 } = runtimeWith([
      "turn_control", "thread_pr_watch_control_v1",
    ]);
    await expect(manageRemoteThreadPrWatches({
      action: "cancel", backend: "codex", threadId: "t", watchId: "w", federationTarget: owner,
    }, owner, runtime)).resolves.toEqual({ ok: true, cancelled: true });
    expect(remoteBackend).toHaveBeenCalledExactlyOnceWith(owner);
    expect(manageThreadPrWatchesV1).toHaveBeenCalledExactlyOnceWith({
      action: "cancel", backend: "codex", threadId: "t", watchId: "w",
    });
  });

  it.each([
    { name: "an older owner", capabilities: ["turn_control"] },
    { name: "an owner that grants no turn control", capabilities: ["thread_pr_watch_control_v1"] },
  ] as const)("keeps $name read-only without a request", async ({ capabilities }) => {
    const { runtime, manageThreadPrWatchesV1 } = runtimeWith([...capabilities]);
    await expect(manageRemoteThreadPrWatches({
      action: "watch", backend: "codex", threadId: "t", prUrl: "https://github.com/a/b/pull/1",
    }, owner, runtime)).resolves.toEqual({
      ok: false,
      error: { code: "federation_unsupported", message: THREAD_PR_WATCHES_UNSUPPORTED_MESSAGE },
    });
    expect(manageThreadPrWatchesV1).not.toHaveBeenCalled();
  });

  it("refuses an incomplete request before it travels", async () => {
    const { runtime, manageThreadPrWatchesV1 } = runtimeWith(["turn_control", "thread_pr_watch_control_v1"]);
    await expect(manageRemoteThreadPrWatches({
      action: "cancel", backend: "codex", threadId: "t", watchId: " ",
    }, owner, runtime)).resolves.toMatchObject({ ok: false, error: { code: "invalid_arguments" } });
    expect(manageThreadPrWatchesV1).not.toHaveBeenCalled();
  });
});

describe("readFederationThreadPrWatchesRequest", () => {
  it("keeps only the named fields of a viewer's request", () => {
    expect(readFederationThreadPrWatchesRequest({
      action: "history", backend: "codex", threadId: "t", limit: 5, federationTarget: owner, extra: "dropped",
    })).toEqual({ action: "history", backend: "codex", threadId: "t", limit: 5 });
    expect(readFederationThreadPrWatchesRequest({
      action: "watch", backend: "claude", threadId: "t", prUrl: "https://github.com/a/b/pull/1",
    })).toEqual({ action: "watch", backend: "claude", threadId: "t", prUrl: "https://github.com/a/b/pull/1" });
  });

  it("never lets a viewer list every watch or name a malformed thread", () => {
    expect(readFederationThreadPrWatchesRequest({ action: "active" })).toBeUndefined();
    expect(readFederationThreadPrWatchesRequest({ action: "active", backend: "codex", threadId: "t" }))
      .toBeUndefined();
    expect(readFederationThreadPrWatchesRequest({ action: "cancel", backend: "bogus", threadId: "t", watchId: "w" }))
      .toBeUndefined();
    expect(readFederationThreadPrWatchesRequest({ action: "cancel", backend: "codex", threadId: "", watchId: "w" }))
      .toBeUndefined();
    expect(readFederationThreadPrWatchesRequest({ action: "watch", backend: "codex", threadId: "t", prUrl: 7 }))
      .toBeUndefined();
    expect(readFederationThreadPrWatchesRequest(null)).toBeUndefined();
  });
});
