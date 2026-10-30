import { describe, expect, it, vi } from "vitest";
import type { LaunchpadCreationStatus, MaterializeDirectoryLaunchpadResponse, CodexEnvironmentSetupProgressEvent } from "@pwragent/shared";
import { materializeObservableLaunchpad, LaunchpadStartupCancelledError } from "../launchpad-creation-client";
import { applyLaunchpadEnvironmentSetupProgress } from "../launchpad-setup-progress";

const request = { operationId: "op-1", directoryKey: "repo", submittedAt: 100, federationTarget: { scope: "remote" as const, instanceId: "owner" } };
const result: MaterializeDirectoryLaunchpadResponse = { backend: "codex", threadId: "created", executionMode: "default", workMode: "local" };
const status: LaunchpadCreationStatus = { operationId: "op-1", directoryKey: "repo", submittedAt: 100, startedAt: 200, updatedAt: 200, phase: "setup", cancellable: true };
const progress: CodexEnvironmentSetupProgressEvent = { operationId: "op-1", directoryKey: "repo", environmentId: "env", environmentName: "Env", command: "install", phase: "stdout", at: 5_000, startedAt: 200, sequence: 2, chunk: "tail", output: "full output" };

describe("remote startup observation", () => {
  it("recovers output and the completed response after dropped progress and a disconnected RPC", async () => {
    const api = {
      materializeDirectoryLaunchpad: vi.fn(async () => { throw new Error("disconnected"); }),
      manageLaunchpadCreation: vi.fn()
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(new Error("offline"))
        .mockResolvedValueOnce({ operation: { ...status, setupProgress: progress } })
        .mockResolvedValueOnce({ operation: { ...status, phase: "completed", result } }),
    };
    const onStatus = vi.fn();
    await expect(materializeObservableLaunchpad({ api, request, onStatus, wait: async () => {} })).resolves.toEqual(result);
    expect(api.materializeDirectoryLaunchpad).toHaveBeenCalledOnce();
    expect(onStatus.mock.calls[0][0].setupProgress.output).toBe("full output");
    expect(api.manageLaunchpadCreation).toHaveBeenLastCalledWith({ operationId: "op-1", action: "read", federationTarget: request.federationTarget });
  });

  it("settles on owner cancellation even if the unlimited materialize response is lost", async () => {
    const api = {
      materializeDirectoryLaunchpad: vi.fn(() => new Promise<MaterializeDirectoryLaunchpadResponse>(() => {})),
      manageLaunchpadCreation: vi.fn().mockResolvedValueOnce({}).mockResolvedValue({ operation: { ...status, phase: "cancelled", error: "cancelled" } }),
    };
    await expect(materializeObservableLaunchpad({ api, request, onStatus: () => {} })).rejects.toBeInstanceOf(LaunchpadStartupCancelledError);
  });

  it("never starts an operation on an owner that cannot confirm cancellation support", async () => {
    const api = { materializeDirectoryLaunchpad: vi.fn(), manageLaunchpadCreation: vi.fn().mockRejectedValue(new Error("method_not_found")) };
    await expect(materializeObservableLaunchpad({ api, request, onStatus: () => {} })).rejects.toThrow("draft has been retained");
    expect(api.materializeDirectoryLaunchpad).not.toHaveBeenCalled();
  });

  it("uses owner timestamps and snapshot output, ignoring duplicated or reordered notifications", () => {
    const snapshot = applyLaunchpadEnvironmentSetupProgress(undefined, progress);
    expect(snapshot).toMatchObject({ startedAt: 200, output: "full output" });
    const missedEarlierChunks = applyLaunchpadEnvironmentSetupProgress(undefined, { ...progress, output: undefined });
    expect(applyLaunchpadEnvironmentSetupProgress(missedEarlierChunks, progress).output).toBe("full output");
    expect(applyLaunchpadEnvironmentSetupProgress(snapshot, progress)).toBe(snapshot);
    expect(applyLaunchpadEnvironmentSetupProgress(snapshot, { ...progress, sequence: 1, phase: "started" })).toBe(snapshot);
    const complete = applyLaunchpadEnvironmentSetupProgress(undefined, { ...progress, startedAt: undefined, phase: "completed", durationMs: 4_000 });
    expect(complete.startedAt).toBe(1_000);
  });
});
