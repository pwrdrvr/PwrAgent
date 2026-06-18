import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { ELECTRON_DEV_ENV_KEYS, runLongLived, sanitizeDevEnv } from "./dev.mjs";

function createFakeProcess() {
  const listeners = new Map();
  return {
    on(signal, handler) {
      listeners.set(signal, [...(listeners.get(signal) ?? []), handler]);
    },
    off(signal, handler) {
      listeners.set(
        signal,
        (listeners.get(signal) ?? []).filter((candidate) => candidate !== handler)
      );
    },
    emit(signal) {
      for (const handler of listeners.get(signal) ?? []) {
        handler();
      }
    },
    listenerCount(signal) {
      return listeners.get(signal)?.length ?? 0;
    }
  };
}

function createFakeChild(pid = 12345) {
  const child = new EventEmitter();
  child.pid = pid;
  child.killCalls = [];
  child.kill = (signal) => {
    child.killCalls.push(signal);
    return true;
  };
  return child;
}

describe("dev launch wrapper", () => {
  it("scrubs inherited Electron and module-resolution variables", () => {
    const inherited = {
      ELECTRON_EXEC_PATH: "/other/repo/Electron",
      ELECTRON_RENDERER_URL: "http://localhost:5173",
      NODE_PATH: "/other/repo/node_modules",
      PATH: "/usr/bin",
      PWRAGENT_HOME: "/tmp/pwragent"
    };

    const { env, removed } = sanitizeDevEnv(inherited);

    for (const key of ELECTRON_DEV_ENV_KEYS) {
      expect(env).not.toHaveProperty(key);
    }
    expect(removed).toEqual(["ELECTRON_EXEC_PATH", "ELECTRON_RENDERER_URL", "NODE_PATH"]);
    expect(env.PATH).toBe("/usr/bin");
    expect(env.PWRAGENT_HOME).toBe("/tmp/pwragent");
  });

  it("runs the long-lived dev child in a POSIX process group and forwards Ctrl+C", async () => {
    const fakeProcess = createFakeProcess();
    const child = createFakeChild(4242);
    const killCalls = [];
    let spawnOptions;
    const promise = runLongLived("node", ["electron-vite", "dev"], { PATH: "/usr/bin" }, {
      killProcess: (pid, signal) => {
        killCalls.push([pid, signal]);
        return true;
      },
      platform: "darwin",
      process: fakeProcess,
      spawn: (_command, _args, options) => {
        spawnOptions = options;
        return child;
      }
    });

    expect(spawnOptions.detached).toBe(true);
    expect(fakeProcess.listenerCount("SIGHUP")).toBe(1);
    expect(fakeProcess.listenerCount("SIGINT")).toBe(1);
    expect(fakeProcess.listenerCount("SIGTERM")).toBe(1);

    fakeProcess.emit("SIGINT");
    child.emit("close", null, null);

    await expect(promise).resolves.toBe(0);
    expect(killCalls).toEqual([[-4242, "SIGINT"]]);
    expect(child.killCalls).toEqual([]);
    expect(fakeProcess.listenerCount("SIGHUP")).toBe(0);
    expect(fakeProcess.listenerCount("SIGINT")).toBe(0);
    expect(fakeProcess.listenerCount("SIGTERM")).toBe(0);
  });

  it("forwards terminal hangup to the detached POSIX process group", async () => {
    const fakeProcess = createFakeProcess();
    const child = createFakeChild(4343);
    const killCalls = [];
    const promise = runLongLived("node", ["electron-vite", "dev"], {}, {
      killProcess: (pid, signal) => {
        killCalls.push([pid, signal]);
        return true;
      },
      platform: "darwin",
      process: fakeProcess,
      spawn: () => child
    });

    fakeProcess.emit("SIGHUP");
    child.emit("close", null, null);

    await expect(promise).resolves.toBe(0);
    expect(killCalls).toEqual([[-4343, "SIGHUP"]]);
    expect(child.killCalls).toEqual([]);
    expect(fakeProcess.listenerCount("SIGHUP")).toBe(0);
    expect(fakeProcess.listenerCount("SIGINT")).toBe(0);
    expect(fakeProcess.listenerCount("SIGTERM")).toBe(0);
  });

  it("falls back to child.kill on Windows", async () => {
    const fakeProcess = createFakeProcess();
    const child = createFakeChild(5151);
    const promise = runLongLived("node", ["electron-vite", "dev"], {}, {
      platform: "win32",
      process: fakeProcess,
      spawn: () => child
    });

    fakeProcess.emit("SIGTERM");
    child.emit("close", null, null);

    await expect(promise).resolves.toBe(0);
    expect(child.killCalls).toEqual(["SIGTERM"]);
  });

  it("preserves nonzero status when the child exits by signal independently", async () => {
    const fakeProcess = createFakeProcess();
    const child = createFakeChild(6161);
    const promise = runLongLived("node", ["electron-vite", "dev"], {}, {
      platform: "darwin",
      process: fakeProcess,
      spawn: () => child
    });

    child.emit("close", null, "SIGTERM");

    await expect(promise).resolves.toBe(143);
  });

  it("preserves nonzero status when the child exits by hangup independently", async () => {
    const fakeProcess = createFakeProcess();
    const child = createFakeChild(6162);
    const promise = runLongLived("node", ["electron-vite", "dev"], {}, {
      platform: "darwin",
      process: fakeProcess,
      spawn: () => child
    });

    child.emit("close", null, "SIGHUP");

    await expect(promise).resolves.toBe(129);
  });

  it("forces the long-lived dev child down on a repeated terminal signal", async () => {
    const fakeProcess = createFakeProcess();
    const child = createFakeChild(6262);
    const killCalls = [];
    const promise = runLongLived("node", ["electron-vite", "dev"], {}, {
      killProcess: (pid, signal) => {
        killCalls.push([pid, signal]);
        return true;
      },
      platform: "darwin",
      process: fakeProcess,
      spawn: () => child
    });

    fakeProcess.emit("SIGINT");
    fakeProcess.emit("SIGINT");
    child.emit("close", null, "SIGKILL");

    await expect(promise).resolves.toBe(137);
    expect(killCalls).toEqual([
      [-6262, "SIGINT"],
      [-6262, "SIGKILL"]
    ]);
  });
});
