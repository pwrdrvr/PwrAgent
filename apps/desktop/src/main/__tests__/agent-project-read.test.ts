import { describe, expect, it, vi } from "vitest";
import type { FederationBackendOperations } from "../federation/federation-backend-bridge";
import { markAgentProjectRead } from "../app-server/agent-project-read";

describe("agent project mark-read routing", () => {
  function setup() {
    const localMark = vi.fn(async () => ({ directoryKey: "directory:/repo", changedCount: 140 }));
    const remoteMark = vi.fn(async () => ({ directoryKey: "directory:/repo", changedCount: 42 }));
    const localBackend = vi.fn(() => ({ markNavigationDirectorySeen: localMark }) as unknown as FederationBackendOperations);
    const remoteBackend = vi.fn(() => ({ markNavigationDirectorySeen: remoteMark }) as unknown as FederationBackendOperations);
    return { runtime: { localFederationInstanceId: () => "local", localBackend, remoteBackend }, localMark, remoteMark };
  }

  it.each([undefined, "local"])("calls the local owner once with instanceId=%s", async (instanceId) => {
    const { runtime, localMark, remoteMark } = setup();
    expect(await markAgentProjectRead(runtime, { projectKey: "directory:/repo", instanceId })).toEqual({
      projectKey: "directory:/repo", instanceId: "local", isLocal: true, changedCount: 140,
    });
    expect(localMark).toHaveBeenCalledExactlyOnceWith({ directoryKey: "directory:/repo" });
    expect(remoteMark).not.toHaveBeenCalled();
  });

  it("routes an explicit peer through the existing capability-gated backend", async () => {
    const { runtime, localMark, remoteMark } = setup();
    expect(await markAgentProjectRead(runtime, { projectKey: "directory:/repo", instanceId: "peer" })).toEqual({
      projectKey: "directory:/repo", instanceId: "peer", isLocal: false, changedCount: 42,
    });
    expect(runtime.remoteBackend).toHaveBeenCalledExactlyOnceWith({ scope: "remote", instanceId: "peer" });
    expect(remoteMark).toHaveBeenCalledExactlyOnceWith({ directoryKey: "directory:/repo" });
    expect(localMark).not.toHaveBeenCalled();
  });

  it("reports a peer failure without retrying or falling back to the local project", async () => {
    const { runtime, localMark, remoteMark } = setup();
    remoteMark.mockRejectedValue(new Error("Peer denied thread_navigation"));
    await expect(markAgentProjectRead(runtime, { projectKey: "directory:/repo", instanceId: "peer" })).rejects.toThrow("Peer denied");
    expect(remoteMark).toHaveBeenCalledTimes(1);
    expect(localMark).not.toHaveBeenCalled();
  });

  it("reports an owner that cannot perform the batch action", async () => {
    const { runtime } = setup();
    runtime.remoteBackend.mockReturnValue({} as FederationBackendOperations);
    await expect(markAgentProjectRead(runtime, { projectKey: "directory:/repo", instanceId: "old-peer" })).rejects.toThrow("Upgrade the owning instance");
  });
});
