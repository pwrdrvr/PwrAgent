import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import type { ElectronApplication } from "@playwright/test";
import { vi } from "vitest";
import type { ElectronQuitModel } from "../helpers/electron-quit-model";

type SessionDouble = {
  closeAllConnections(): Promise<void>;
  cookies: { flushStore(): Promise<void> };
  clearData(options: { dataTypes: string[] }): Promise<void>;
};

export function createCloseHarness(sessions: SessionDouble[], options: {
  installed?: boolean;
  quitModel?: ElectronQuitModel;
  onPrepare?: () => void;
  onSignal?: () => void;
  onNativeQuit?: () => void;
} = {}) {
  const app = new EventEmitter() as EventEmitter & { quit(): void };
  const stderr = new EventEmitter();
  const child = {
    pid: 120,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    stderr,
    kill: vi.fn(() => { child.signalCode = "SIGKILL"; return true; }),
  };
  let finishNativeClose: () => void = () => undefined;
  const nativeClosed = new Promise<void>((resolve) => { finishNativeClose = resolve; });
  const completeNativeQuit = () => {
    options.onNativeQuit?.();
    child.exitCode = 0;
    finishNativeClose();
  };
  if (options.quitModel) {
    for (const stage of ["before-quit", "will-quit"]) {
      options.quitModel.on(stage, (event) => { app.emit(stage, event); });
    }
    options.quitModel.on("quit", completeNativeQuit);
  }
  let inspectorDetached = false;
  const quit = vi.fn(() => {
    if (options.quitModel) {
      options.quitModel.quit();
      return;
    }
    const before = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    app.emit("before-quit", before);
    if (before.defaultPrevented) return;
    const will = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    app.emit("will-quit", will);
    if (!will.defaultPrevented) {
      completeNativeQuit();
    }
  });
  app.quit = quit;
  const emit = vi.fn(() => { options.onSignal?.(); });
  const evaluate = vi.fn(async (callback: unknown, arg: unknown) => {
    if (inspectorDetached) throw new Error("Inspector detached");
    return await runInNewContext(`(${String(callback)})({ app, session, webContents }, arg)`, {
      app,
      arg,
      session: { defaultSession: sessions[0] },
      webContents: { getAllWebContents: () => sessions.map((session) => ({ session })) },
      process: {
        pid: 120,
        uptime: () => 10,
        emit,
        listenerCount: () => options.installed ? 1 : 0,
        stderr: { write: (line: string) => {
          const middle = Math.floor(line.length / 2);
          stderr.emit("data", Buffer.from(line.slice(0, middle)));
          stderr.emit("data", Buffer.from(line.slice(middle)));
        } },
      },
      Date,
      setImmediate,
    });
  });
  const close = vi.fn(async () => {
    options.onPrepare?.();
    quit();
    // This is Playwright's real ordering: inspector detachment follows the
    // app.quit RPC, even when will-quit has kept the native process alive.
    inspectorDetached = true;
    await nativeClosed;
  });
  const electronApp = { process: () => child, evaluate, close } as unknown as ElectronApplication;
  return { app, child, close, electronApp, emit, evaluate, quit, stderr };
}
