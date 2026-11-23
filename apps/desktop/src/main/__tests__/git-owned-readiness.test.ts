import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import { runGitCommand } from "../app-server/git-executable";
import { startWindowsJobReadyPoll } from "../windows-job-wrapper";

vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(), spawn: vi.fn(),
}));
vi.mock("../git-runtime", () => ({
  gitRuntimeEnvironment: (env: NodeJS.ProcessEnv) => env,
  resolveRuntimeGitExecutable: async () => "fixture-git.exe",
}));
vi.mock("../bundled-git-lfs-advisory", () => ({ noteBundledGitCommand: vi.fn() }));
vi.mock("../windows-job-wrapper", () => ({
  wrapCommandInWindowsJob: () => ({ command: "fixture-job.exe", args: [], env: {}, cleanup: vi.fn() }),
  startWindowsJobReadyPoll: vi.fn(),
  formatWindowsJobStartupTimeout: () => "Windows Job startup timed out",
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
