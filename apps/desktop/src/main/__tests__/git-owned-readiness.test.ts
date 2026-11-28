import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import { runGitCommand } from "../app-server/git-executable";
import { collectProcessTreeIds } from "../process-tree";
import { startWindowsJobReadyPoll, windowsJobCleanupVerified, wrapCommandInWindowsJob } from "../windows-job-wrapper";

vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(), spawn: vi.fn(),
}));
vi.mock("../git-runtime", () => ({
  gitCommandEnvironment: (env: NodeJS.ProcessEnv) => env,
  resolveRuntimeGitExecutable: async () => "fixture-git.exe",
}));
vi.mock("../bundled-git-lfs-advisory", () => ({ noteBundledGitCommand: vi.fn() }));
vi.mock("../process-tree", () => ({
  collectProcessTreeIds: vi.fn(() => []), isProcessIdAlive: vi.fn(() => false), terminateOwnedProcessTree: vi.fn(),
}));
vi.mock("../windows-job-wrapper", () => ({
  wrapCommandInWindowsJob: vi.fn(() => ({
    command: "fixture-job.exe", args: [], env: {}, cleanup: vi.fn(), requestStop: vi.fn(),
    readyFilePath: "fixture-ready", startupStartedAt: 0, startupStatusFilePath: "fixture-status",
  })),
  startWindowsJobReadyPoll: vi.fn(),
  formatWindowsJobStartupTimeout: () => "Windows Job startup timed out",
  windowsJobCleanupVerified: vi.fn(() => true),
}));

it.each([false, true])("starts the owned Git execution timeout at readiness (expires: %s)", async (expires) => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...originalPlatform, value: "win32" });
  vi.useFakeTimers();
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
  });
  vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcess);
  const cancel = vi.fn();
  vi.mocked(startWindowsJobReadyPoll).mockReturnValue({ cancel });
  try {
    const result = runGitCommand("/fixture/checkout", ["rev-parse", "HEAD"], { timeout: 3_000, ownProcessTree: true })
      .then((value) => ({ value }), (error: unknown) => ({ error }));
    await vi.advanceTimersByTimeAsync(4_000);
    const readiness = vi.mocked(startWindowsJobReadyPoll).mock.calls[0]?.[0];
    readiness?.onReady({ phases: [] });
    await vi.advanceTimersByTimeAsync(expires ? 3_000 : 2_999);
    child.stdout.write("fixture-head");
    child.emit("close", 0, null);
    if (expires) {
      expect(await result).toMatchObject({ error: { killed: true, code: null } });
    } else {
      expect(await result).toEqual({ value: { stdout: "fixture-head", stderr: "" } });
    }
    expect(readiness).toBeDefined();
    expect(cancel).toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
    Object.defineProperty(process, "platform", originalPlatform);
    vi.clearAllMocks();
  }
});

it("cancels owned Windows Git through Job drain without taking a process snapshot", async () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...originalPlatform, value: "win32" });
  vi.useFakeTimers();
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
    pid: 123, signalCode: null, exitCode: null, kill: vi.fn(),
  });
  vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcess);
  vi.mocked(startWindowsJobReadyPoll).mockReturnValue({ cancel: vi.fn() });
  const controller = new AbortController();
  let settled = false;
  try {
    const result = runGitCommand("/fixture/checkout", ["rev-parse", "HEAD"], { ownProcessTree: true, signal: controller.signal })
      .catch((error: unknown) => error).finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(5);
    controller.abort();
    await vi.advanceTimersByTimeAsync(5);
    const launch = vi.mocked(wrapCommandInWindowsJob).mock.results[0]?.value as ReturnType<typeof wrapCommandInWindowsJob>;
    expect(wrapCommandInWindowsJob).toHaveBeenCalledWith(expect.objectContaining({ keepDrainEvidenceOnStop: true }));
    expect(launch.requestStop).toHaveBeenCalledOnce();
    expect(collectProcessTreeIds).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
    expect(settled).toBe(false);
    child.emit("close", 1, null);
    expect(await result).toMatchObject({ name: "AbortError", code: "ABORT_ERR" });
    expect(windowsJobCleanupVerified).toHaveBeenCalledWith(launch);
    await vi.advanceTimersByTimeAsync(3_001);
    expect(child.kill).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
    Object.defineProperty(process, "platform", originalPlatform);
    vi.clearAllMocks();
  }
});
