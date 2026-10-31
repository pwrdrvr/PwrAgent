import * as childProcess from "node:child_process";
import { performance } from "node:perf_hooks";
import type { ElectronApplication } from "@playwright/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCloseHarness } from "./fixtures/electron-close-harness";
import { captureElectronMainProcess, closeElectronApplication, closeElectronWithSessionDrain } from "../../../e2e/fixtures/electron-app";

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

  it.each([
    { platform: "win32", installed: true },
    { platform: "win32", installed: false },
    { platform: "linux", installed: true },
    { platform: "linux", installed: false },
  ] as const)("lets Playwright prepare close before the owned shutdown signal ($platform, $installed)", async ({ platform, installed }) => {
    vi.spyOn(process, "platform", "get").mockReturnValue(platform);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const order: string[] = [];
    let rendererClosed = false;
    const ownedSession = {
      closeAllConnections: vi.fn(async () => { order.push("close-session-connections"); }),
      cookies: { flushStore: vi.fn(async () => { order.push("flush-session-cookies"); }) },
      clearData: vi.fn(async () => { order.push("complete-session-cache-writes"); }),
    };
    const harness = createCloseHarness([ownedSession], {
      installed,
      onPrepare: () => {
        expect(rendererClosed).toBe(false);
        order.push("prepare-playwright-close");
      },
      onSignal: () => { order.push("owned-shutdown"); rendererClosed = true; },
      onNativeQuit: () => { order.push("native-quit"); },
    });
    harness.app.on("before-quit", () => {
      order.push("production-before-quit");
      expect(harness.emit).toHaveBeenCalledTimes(installed ? 1 : 0);
      rendererClosed = true;
    });
    await expect(closeElectronApplication(harness.electronApp)).resolves.toMatchObject({
      classification: "healthy", forceExitOutcome: "not-needed",
    });
    expect(harness.emit.mock.calls).toEqual(installed ? [["SIGTERM", "SIGTERM"]] : []);
    expect(harness.close).toHaveBeenCalledOnce();
    expect(harness.child.kill).not.toHaveBeenCalled();
    expect(ownedSession.closeAllConnections).toHaveBeenCalledTimes(platform === "win32" ? 1 : 0);
    expect(ownedSession.cookies.flushStore).toHaveBeenCalledTimes(platform === "win32" ? 1 : 0);
    expect(ownedSession.clearData.mock.calls).toEqual(platform === "win32" ? [[{ dataTypes: ["cache"] }]] : []);
    expect(order.indexOf("prepare-playwright-close")).toBeLessThan(order.indexOf("production-before-quit"));
    if (installed) {
      expect(order.indexOf("prepare-playwright-close")).toBeLessThan(order.indexOf("owned-shutdown"));
      expect(order.indexOf("owned-shutdown")).toBeLessThan(order.indexOf("production-before-quit"));
    }
    if (platform === "win32") {
      expect(order.indexOf("complete-session-cache-writes")).toBeLessThan(order.indexOf("native-quit"));
    }
    expect(harness.app.listenerCount("before-quit")).toBe(1);
    expect(harness.app.listenerCount("will-quit")).toBe(0);
  });

  it("charges a stalled cache completion to the existing Windows graceful-close deadline", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.useFakeTimers();
    const ownedSession = {
      closeAllConnections: async () => undefined,
      cookies: { flushStore: async () => undefined },
      clearData: vi.fn(() => new Promise<void>(() => undefined)),
    };
    const harness = createCloseHarness([ownedSession]);
    const execFile = vi.mocked(childProcess.execFile).mockImplementation((command, _args, _options, callback) => {
      if (command === "taskkill") harness.child.exitCode = 1;
      callback?.(null, "", "");
      return {} as childProcess.ChildProcess;
    });
    const closing = closeElectronApplication(harness.electronApp);
    await vi.advanceTimersByTimeAsync(5_999);
    expect(ownedSession.clearData).toHaveBeenCalledOnce();
    expect(harness.close).toHaveBeenCalledOnce();
    expect(harness.child.exitCode).toBeNull();
    expect(execFile).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(execFile.mock.calls[0].slice(0, 2)).toEqual(["taskkill", ["/pid", "120", "/T", "/F"]]);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(closing).resolves.toMatchObject({
      classification: "force-killed", gracefulCloseOutcome: "timeout", forceExitOutcome: "timed-out",
    });
  });

  it("overlaps application disposal and persistence without extending the six-second deadline", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.useFakeTimers();
    const startedAt = Date.now();
    vi.spyOn(performance, "now").mockImplementation(() => Date.now() - startedAt);
    const harness = createCloseHarness([{
      closeAllConnections: async () => undefined,
      cookies: { flushStore: async () => undefined },
      clearData: () => new Promise<void>((resolve) => { setTimeout(resolve, 4_500); }),
    }]);
    harness.app.prependOnceListener("before-quit", (event: { preventDefault(): void }) => {
      event.preventDefault();
      setTimeout(() => { harness.app.quit(); }, 2_000);
    });
    const closing = closeElectronApplication(harness.electronApp);
    await vi.advanceTimersByTimeAsync(4_499);
    expect(harness.child.exitCode).toBeNull();
    expect(childProcess.execFile).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.child.exitCode).toBe(0);
    await expect(closing).resolves.toMatchObject({
      gracefulCloseOutcome: "closed", forceExitOutcome: "not-needed", elapsedMs: 4_500,
    });
    expect(childProcess.execFile).not.toHaveBeenCalled();
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

describe("closeElectronWithSessionDrain", () => {
  it("keeps every distinct session alive until completion after inspector detachment", async () => {
    const completions: Array<() => void> = [];
    const makeSession = () => ({
      closeAllConnections: vi.fn(async () => undefined),
      cookies: { flushStore: vi.fn(async () => undefined) },
      clearData: vi.fn(() => new Promise<void>((resolve) => { completions.push(resolve); })),
    });
    const defaultSession = makeSession();
    const partitionSession = makeSession();
    const harness = createCloseHarness([defaultSession, partitionSession, partitionSession]);
    const closing = closeElectronWithSessionDrain(harness.electronApp);
    await vi.waitFor(() => expect(completions).toHaveLength(2));
    expect(harness.close).toHaveBeenCalledOnce();
    expect(harness.child.exitCode).toBeNull();
    await expect(harness.electronApp.evaluate(() => undefined)).rejects.toThrow("Inspector detached");
    completions[0]();
    await Promise.resolve();
    expect(harness.child.exitCode).toBeNull();
    completions[1]();
    await closing;
    expect(harness.child.exitCode).toBe(0);
    expect(harness.app.listenerCount("will-quit")).toBe(0);
    expect(harness.stderr.listenerCount("data")).toBe(0);
    for (const ownedSession of [defaultSession, partitionSession]) {
      expect(ownedSession.closeAllConnections).toHaveBeenCalledOnce();
      expect(ownedSession.cookies.flushStore).toHaveBeenCalledOnce();
      expect(ownedSession.clearData).toHaveBeenCalledExactlyOnceWith({ dataTypes: ["cache"] });
    }
  });

  it("propagates a split-pipe cache failure after inspector detachment and leaves native quit held", async () => {
    const failure = new Error("Network Persistent State write failed");
    const harness = createCloseHarness([{
      closeAllConnections: async () => undefined,
      cookies: { flushStore: async () => undefined },
      clearData: async () => { throw failure; },
    }]);
    await expect(closeElectronWithSessionDrain(harness.electronApp)).rejects.toThrow("Network Persistent State write failed");
    expect(harness.close).toHaveBeenCalledOnce();
    expect(harness.child.exitCode).toBeNull();
    expect(harness.app.listenerCount("will-quit")).toBe(1);
    expect(harness.stderr.listenerCount("data")).toBe(0);
  });
});
