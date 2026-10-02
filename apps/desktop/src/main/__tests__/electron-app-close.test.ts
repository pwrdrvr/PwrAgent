import * as childProcess from "node:child_process";
import { runInNewContext } from "node:vm";
import type { ElectronApplication } from "@playwright/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureElectronMainProcess, closeElectronApplication } from "../../../e2e/fixtures/electron-app";

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, execFile: vi.fn(original.execFile) };
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.mocked(childProcess.execFile).mockReset();
});

describe("closeElectronApplication", () => {
  it.each([false, true])("retains Windows ownership after bootstrap quits, respecting PID reuse (%s)", async (reusedPid) => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.useFakeTimers();
    const startedAt = Date.now() - 10_000;
    const mainProcess = { pid: 120, startedAt };
    const child = { pid: 80, exitCode: 0, signalCode: null };
    let finishClose: () => void = () => undefined;
    const closePromise = new Promise<void>((resolve) => { finishClose = resolve; });
    const evaluate = vi.fn().mockResolvedValueOnce(mainProcess);
    const electronApp = {
      process: () => child,
      evaluate,
      close: () => closePromise,
    } as unknown as ElectronApplication;
    const killed: number[] = [];
    const execFile = vi.mocked(childProcess.execFile).mockImplementation((command, args, _options, callback) => {
      if (command === "powershell.exe") {
        const rows = [
          ...(reusedPid ? [`120\t90\t${startedAt + 5_000}`] : []),
          `140\t120\t${startedAt + 1_000}`,
        ];
        callback?.(null, rows.join("\n"), "");
      } else if (command === "taskkill") {
        killed.push(Number(args?.[1]));
        finishClose();
        callback?.(null, "", "");
      }
      return {} as childProcess.ChildProcess;
    });

    await captureElectronMainProcess(electronApp);
    // The wizard now quits. Its RPC can no longer reveal the main identity,
    // while its exited cmd.exe still has pipes held by an owned descendant.
    evaluate.mockRejectedValue(new Error("Target page, context or browser has been closed"));
    const closing = closeElectronApplication(electronApp);
    await vi.advanceTimersByTimeAsync(7_000);
    const result = await closing;

    expect(evaluate).toHaveBeenCalledTimes(2); // Capture, then the quit request.
    expect(execFile.mock.calls[0][0]).toBe("powershell.exe");
    expect(execFile.mock.calls[0][1]).toContainEqual(expect.stringContaining("ProcessId=120 OR ParentProcessId=120"));
    expect(killed).toEqual(reusedPid ? [] : [140]);
    expect(result).toMatchObject({
      quitRequestOutcome: "rejected",
      gracefulCloseOutcome: "timeout",
      forceExitOutcome: reusedPid ? "timed-out" : "exited",
    });
  });

  it.each([true, false])("uses the owned shutdown signal when installed (%s), without opening a quit dialog", async (installed) => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const quit = vi.fn();
    const emit = vi.fn();
    const listenerCount = vi.fn(() => installed ? 1 : 0);
    const child = { exitCode: null as number | null, signalCode: null };
    const close = vi.fn(async () => { child.exitCode = 0; });
    const electronApp = {
      process: () => child,
      evaluate: async (callback: unknown) => runInNewContext(`(${String(callback)})({ app })`, {
        app: { quit }, process: { emit, listenerCount },
      }),
      close,
    } as unknown as ElectronApplication;
    await expect(closeElectronApplication(electronApp)).resolves.toMatchObject({
      classification: "healthy", forceExitOutcome: "not-needed",
    });
    expect(emit.mock.calls).toEqual(installed ? [["SIGTERM", "SIGTERM"]] : []);
    expect(quit).toHaveBeenCalledTimes(installed ? 0 : 1);
    expect(close).toHaveBeenCalledOnce();
  });

  it("is a no-op when Playwright throws for an exited Electron handle", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const process = vi.fn(() => {
      throw new TypeError("Cannot read properties of undefined (reading '_object')");
    });
    const electronApp = { process } as unknown as ElectronApplication;

    await expect(closeElectronApplication(electronApp)).resolves.toMatchObject({
      classification: "healthy",
      forceExitOutcome: "not-needed",
    });
    expect(process).toHaveBeenCalledOnce();
  });

  it("is a no-op when Playwright returns no process for an exited Electron handle", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const process = vi.fn(() => undefined);
    const electronApp = { process } as unknown as ElectronApplication;

    await expect(closeElectronApplication(electronApp)).resolves.toMatchObject({
      classification: "healthy",
      forceExitOutcome: "not-needed",
    });
    expect(process).toHaveBeenCalledOnce();
  });
});
