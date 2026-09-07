import { describe, expect, it, vi } from "vitest";
import type { AppServerThreadSummary } from "@pwragent/shared";
import type { FederationBackendOperations } from "../federation/federation-backend-bridge";
import {
  resolveFederatedThreadTarget,
  type FederatedThreadTargetRuntime,
} from "../federation/federated-thread-target-service";

const thread: AppServerThreadSummary = {
  id: "019fd821-1450-7952-85ca-3bb8e5d150da",
  title: "Federated owner",
  titleSource: "explicit",
  source: "codex",
  linkedDirectories: [],
};

function runtimeWithBackend(
  backend: FederationBackendOperations,
): FederatedThreadTargetRuntime {
  return {
    connectedPeerTargets: () => [{
      target: { scope: "remote", instanceId: "pwr_remote" },
      label: "Remote Mac",
      capabilities: ["thread_navigation"],
    }],
    health: vi.fn(),
    remoteBackend: () => backend,
  } as unknown as FederatedThreadTargetRuntime;
}

describe("resolveFederatedThreadTarget", () => {
  it("uses one deadline for active and exact archive resolution", async () => {
    const resolveThread = vi.fn(async () => ({ thread: undefined }));
    const lookupArchivedThreads = vi.fn(async () => ({ threads: [thread] }));
    const runtime = runtimeWithBackend({ resolveThread, lookupArchivedThreads } as unknown as FederationBackendOperations);
    await expect(resolveFederatedThreadTarget({
      runtime,
      request: { backend: "codex", instanceId: "pwr_remote", threadId: thread.id },
    })).resolves.toMatchObject({ thread });
    const options = (resolveThread.mock.calls[0] as unknown[])[1];
    expect(options).toEqual({ deadlineAt: expect.any(Number) });
    expect(lookupArchivedThreads).toHaveBeenCalledWith({
      backend: "codex", threadIds: [thread.id],
    }, options);
  });

  it("bounds unknown-owner discovery concurrency without ignoring duplicate owners", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let active = 0;
    let maximum = 0;
    const resolveThread = vi.fn(async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await gate;
      active -= 1;
      return { thread };
    });
    const runtime = runtimeWithBackend({ resolveThread } as unknown as FederationBackendOperations);
    runtime.connectedPeerTargets = () => Array.from({ length: 12 }, (_, index) => ({
      target: { scope: "remote", instanceId: `peer-${index}` },
      label: `Peer ${index}`, capabilities: ["thread_navigation"],
    }));
    const resolving = resolveFederatedThreadTarget({
      runtime, request: { backend: "codex", threadId: thread.id },
    });
    const rejected = expect(resolving).rejects.toThrow("multiple federation instances");
    await vi.waitFor(() => expect(resolveThread).toHaveBeenCalledTimes(8));
    release();
    await rejected;
    expect(resolveThread).toHaveBeenCalledTimes(12);
    expect(maximum).toBe(8);
  });

  it("uses exact list scanning only when an older peer lacks resolveThread", async () => {
    const listThreads = vi.fn(async () => ({
      backend: "codex" as const,
      fetchedAt: 1_000,
      threads: [thread],
    }));
    const runtime = runtimeWithBackend({
      resolveThread: vi.fn(async () => {
        throw Object.assign(new Error("Unsupported federation method"), {
          code: "method_not_found",
        });
      }),
      listThreads,
    } as unknown as FederationBackendOperations);

    await expect(resolveFederatedThreadTarget({
      runtime,
      request: {
        backend: "codex",
        instanceId: "pwr_remote",
        threadId: thread.id,
      },
    })).resolves.toMatchObject({ thread: { id: thread.id } });
    expect(listThreads).toHaveBeenCalledExactlyOnceWith(
      { backend: "codex" }, { deadlineAt: expect.any(Number) },
    );
  });

  it.each([
    {
      label: "handler failure",
      error: Object.assign(new Error("Remote handler failed"), {
        code: "handler_failed",
      }),
    },
    {
      label: "timeout",
      error: new Error("Federation request timed out: backend.resolveThread"),
    },
  ])("does not amplify a $label into full thread-list scans", async ({ error }) => {
    const listThreads = vi.fn();
    const runtime = runtimeWithBackend({
      resolveThread: vi.fn(async () => {
        throw error;
      }),
      listThreads,
    } as unknown as FederationBackendOperations);

    await expect(resolveFederatedThreadTarget({
      runtime,
      request: {
        backend: "codex",
        instanceId: "pwr_remote",
        threadId: thread.id,
      },
    })).rejects.toThrow(error.message);
    expect(listThreads).not.toHaveBeenCalled();
  });
});
