import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { windowsJobLauncherPath } from "../src/main/windows-job-launcher-path";
import {
  DEV_SETUP_SCRIPTS,
  ELECTRON_DEV_ENV_KEYS,
  runDevSetup,
  runLongLived,
  sanitizeDevEnv
} from "./dev.mjs";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, existsSync: vi.fn(actual.existsSync) };
});
vi.mock("../src/main/runtime-resources", () => ({
  isDevelopmentRuntime: () => true, runtimeResourcesPath: () => undefined,
}));

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
  it("prepares the Electron runtime before launching development", () => {
    const calls = [];
    const env = { PATH: "/usr/bin" };

    const status = runDevSetup("node", env, (command, args, childEnv) => {
      calls.push([command, args, childEnv]);
      return 0;
    }, "darwin");

    expect(status).toBe(0);
    expect(calls).toEqual(
      DEV_SETUP_SCRIPTS.map((script) => [
        "node",
        Array.isArray(script) ? script : [script],
        env,
      ])
    );
  });

  it.each([
    "src/main/windows-job-launcher-path.ts",
    "out/main/index.js",
    "out/main/chunks/codex-environment-config.js",
  ])("finds the Windows dev launcher from %s after Vite clears the main output", (module) => {
    const desktop = fileURLToPath(new URL("../", import.meta.url));
    const launcher = "pwragent-windows-job.exe";
    const files = new Set();
    const status = runDevSetup("node", {}, (_node, [script, directory]) => {
      if (script === "./scripts/build-windows-job-launcher.mjs") {
        files.add(path.resolve(desktop, directory, launcher));
      }
      return 0;
    }, "win32");
    expect(status).toBe(0);
    files.delete(path.join(desktop, "out/main", launcher));
    vi.mocked(existsSync).mockImplementation((file) => files.has(file));
    try {
      const moduleUrl = pathToFileURL(path.join(desktop, module)).href;
      expect(windowsJobLauncherPath(moduleUrl)).toBe(path.join(desktop, ".local/windows-job-launcher", launcher));
    } finally {
      vi.mocked(existsSync).mockRestore();
    }
  });

  it("uses the Windows launcher rebuilt with the app when a previous dev launcher is present", () => {
    const desktop = fileURLToPath(new URL("../", import.meta.url));
    const builtLauncher = path.join(desktop, "out/main/pwragent-windows-job.exe");
    const previousDevLauncher = path.join(desktop, ".local/windows-job-launcher/pwragent-windows-job.exe");
    const files = new Set([builtLauncher, previousDevLauncher]);
    vi.mocked(existsSync).mockImplementation((file) => files.has(file));
    try {
      const moduleUrl = pathToFileURL(path.join(desktop, "out/main/chunks/profile.js")).href;
      expect(windowsJobLauncherPath(moduleUrl)).toBe(builtLauncher);
    } finally {
      vi.mocked(existsSync).mockRestore();
    }
  });

  it("checks sandbox permissions after preparing the runtime", () => {
    expect(DEV_SETUP_SCRIPTS).toEqual([
      ["./scripts/build-mcp-ipc-relay.mjs", "--optional"],
      ["./scripts/build-mcp-stdio-relay.mjs", "--optional"],
      ["./scripts/stage-ripgrep-bundle.mjs", "--platform", "current"],
      "./scripts/ensure-electron-runtime.mjs",
      ["../../scripts/linux-sandbox.mjs", "--warn"],
    ]);
  });

  it("stops the dev setup when the child build fails", () => {
    const statuses = [0, 1];
    const calls = [];

    const status = runDevSetup("node", {}, (_command, args) => {
      calls.push(args);
      return statuses.shift();
    }, "darwin");

    expect(status).toBe(1);
    expect(calls).toEqual(
      DEV_SETUP_SCRIPTS.slice(0, 2).map((script) =>
        Array.isArray(script) ? script : [script]
      ),
    );
  });

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

  it.each([
    ["signal", 6161, "SIGTERM", 143],
    ["hangup", 6162, "SIGHUP", 129],
  ])("preserves nonzero status when the child exits by %s independently", async (
    _name,
    pid,
    signal,
    exitStatus,
  ) => {
    const fakeProcess = createFakeProcess();
    const child = createFakeChild(pid);
    const promise = runLongLived("node", ["electron-vite", "dev"], {}, {
      platform: "darwin",
      process: fakeProcess,
      spawn: () => child
    });

    child.emit("close", null, signal);

    await expect(promise).resolves.toBe(exitStatus);
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
