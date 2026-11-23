import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyLocalCodexEnvironmentSelection,
  CODEX_ENVIRONMENT_SETUP_TIMEOUT_MS_ENV,
  listRunningDetachedCommands,
  startLocalCodexEnvironmentAction,
  stopAllCodexEnvironmentDetachedCommands,
  stopCodexEnvironmentDetachedCommand,
  waitForCodexEnvironmentDetachedCommandGone,
} from "../app-server/codex-environment-runtime";
import { ShellAutomationGateRunner, type AutomationGateRunner } from "../automations/automation-gate-runner";
import {
  windowsJobCleanupVerified,
  wrapCommandInWindowsJob,
} from "../windows-job-wrapper";

vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawn: vi.fn(),
}));
vi.mock("../log", () => ({ getMainLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));

vi.mock("../windows-job-wrapper", () => ({
  wrapCommandInWindowsJob: vi.fn((options) => ({
    ...options,
    cleanup: vi.fn(),
    requestStop: options.keepDrainEvidenceOnStop ? vi.fn() : undefined,
  })),
  startWindowsJobReadyPoll: ({ onReady }: { onReady: (telemetry: { phases: [] }) => void }) => {
    queueMicrotask(() => onReady({ phases: [] }));
    return { cancel: vi.fn() };
  },
  windowsJobCleanupVerified: vi.fn(),
}));

// The child emits the Node lifecycle events. The kernel oracle below owns
// group membership separately so a shell close cannot stand in for drain.
function fakeChild(pid: number) {
  return Object.assign(new EventEmitter(), { pid, unref: vi.fn(), kill: vi.fn() });
}

function mockSpawn(pid: number) {
  const child = fakeChild(pid);
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  return child;
}

function startAction(runId: string, onDetachedExit: () => void) {
  return startLocalCodexEnvironmentAction({
    actionId: "run",
    runId,
    owner: { backend: "codex", threadId: "thread" },
    onDetachedExit,
    runtime: {
      environmentId: "env",
      environmentName: "Env",
      executionTarget: "local",
      cwd: process.cwd(),
      actions: [{ id: "run", name: "Run", command: "start-service" }],
    },
  });
}

describe("local command process ownership", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv("SHELL", "/bin/sh");
    vi.stubEnv(CODEX_ENVIRONMENT_SETUP_TIMEOUT_MS_ENV, undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  function setPlatform(platform: NodeJS.Platform) {
    vi.stubGlobal("process", Object.create(process, { platform: { value: platform } }));
  }

  function fakeGroup(pid: number) {
    let alive = true;
    const signals: Array<string | number | undefined> = [];
    vi.spyOn(process, "kill").mockImplementation((target, signal) => {
      if (target !== -pid || !alive) throw Object.assign(new Error("No such process"), { code: "ESRCH" });
      if (signal !== 0) signals.push(signal);
      return true;
    });
    return { signals, drain: () => { alive = false; } };
  }

  it.each(["natural exit", "Stop", "Terminate", "Quit"] as const)(
    "keeps a POSIX action owned after shell close until kernel drain via %s",
    async (end) => {
      setPlatform("darwin");
      const runId = `action-${end}`;
      const child = mockSpawn(100);
      const group = fakeGroup(child.pid);
      const onExit = vi.fn();
      const started = startAction(runId, onExit);
      child.emit("spawn");
      await started;
      child.emit("close", 0, null);

      try {
        expect(listRunningDetachedCommands().some((run) => run.runId === runId)).toBe(true);
        expect(onExit).not.toHaveBeenCalled();
        if (end === "Quit") {
          expect(stopAllCodexEnvironmentDetachedCommands()).toBe(1);
        } else if (end !== "natural exit") {
          expect(stopCodexEnvironmentDetachedCommand(runId, end === "Stop" ? "stop" : "terminate").found).toBe(true);
        }
        expect(group.signals).toEqual(end === "natural exit" ? [] : [end === "Stop" ? "SIGTERM" : "SIGKILL"]);
      } finally {
        group.drain();
        await vi.advanceTimersByTimeAsync(100);
      }
      expect(listRunningDetachedCommands().some((run) => run.runId === runId)).toBe(false);
      expect(onExit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ exitCode: 0 }));
    },
  );

  it.each(["bash", "powershell"] as const)("owns untimed Windows %s setup through a Job", async (shell) => {
    setPlatform("win32");
    const child = mockSpawn(101);
    const result = applyLocalCodexEnvironmentSelection({
      cwd: process.cwd(),
      selection: {
        executionTarget: "local",
        runSetup: true,
        environment: { id: "env", name: "Env", sourcePath: "environment.toml", setupScript: "setup", shell: shell === "powershell" ? shell : undefined, actions: [] },
      },
    });
    child.emit("close", 0, null);
    await expect(result).resolves.toMatchObject({ setupStatus: "completed" });
    expect(wrapCommandInWindowsJob).toHaveBeenLastCalledWith(expect.objectContaining({
      terminateDescendantsOnExit: shell === "powershell",
    }));
  });

  it.each([true, false])("requires Windows Job drain evidence for rollback (verified=%s)", async (verified) => {
    setPlatform("win32");
    const child = mockSpawn(102);
    const runId = `windows-action-${verified}`;
    const started = startAction(runId, vi.fn());
    child.emit("spawn");
    await started;
    const job = vi.mocked(wrapCommandInWindowsJob).mock.results.at(-1)?.value;
    const stopped = stopCodexEnvironmentDetachedCommand(runId, "terminate");
    const gone = vi.fn();
    const waiting = waitForCodexEnvironmentDetachedCommandGone({ runId });
    void waiting.then(gone, () => {});
    await vi.advanceTimersByTimeAsync(100);
    try {
      expect(stopped).toEqual({ found: true, alreadyClosed: false });
      expect(job?.requestStop).toHaveBeenCalledOnce();
      expect(child.kill).not.toHaveBeenCalled();
      expect(gone).not.toHaveBeenCalled();
    } finally {
      vi.mocked(windowsJobCleanupVerified).mockReturnValue(verified);
      child.emit("close", 1, null);
      await vi.advanceTimersByTimeAsync(100);
    }
    if (verified) {
      await expect(waiting).resolves.toBeUndefined();
      expect(gone).toHaveBeenCalledOnce();
    } else {
      await expect(waiting).rejects.toThrow("Windows Job drain was not confirmed");
      expect(gone).not.toHaveBeenCalled();
    }
    expect(windowsJobCleanupVerified).toHaveBeenCalledWith(job);
  });

  it.each(["drain", "deadline", "shutdown"] as const)(
    "keeps ownership of a gate group after its shell publishes a result until %s",
    async (end) => {
      setPlatform("darwin");
      const child = mockSpawn(103);
      const group = fakeGroup(child.pid);
      const runner: AutomationGateRunner = new ShellAutomationGateRunner();
      const result = runner.runGate({ command: "start-worker", timeoutMs: 500 });
      child.emit("close", 10, null);
      await expect(result).resolves.toMatchObject({ status: "skip", exitCode: 10 });
      if (end === "shutdown") runner.stopAll?.();
      if (end === "drain") group.drain();
      await vi.advanceTimersByTimeAsync(500);
      expect(group.signals).toEqual(end === "drain" ? [] : ["SIGKILL"]);
    },
  );

  it.each(["darwin", "win32"] as const)("stops an in-flight %s gate on owner shutdown", async (platform) => {
    setPlatform(platform);
    const child = mockSpawn(104);
    const group = fakeGroup(child.pid);
    const runner: AutomationGateRunner = new ShellAutomationGateRunner();
    const result = runner.runGate({ command: "run-worker" });
    runner.stopAll?.();
    if (platform === "win32") {
      expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    } else {
      expect(group.signals).toEqual(["SIGKILL"]);
    }
    group.drain();
    child.emit("close", null, "SIGKILL");
    await expect(result).resolves.toMatchObject({ status: "failed", errorMessage: expect.stringContaining("shutdown") });
  });
});
