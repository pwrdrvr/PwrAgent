#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const desktopRoot = resolve(__dirname, "..");
const grokAppServerBuildScript = resolve(
  desktopRoot,
  "..",
  "grok-app-server",
  "build.mjs"
);

export const ELECTRON_DEV_ENV_KEYS = [
  "ELECTRON_EXEC_PATH",
  "ELECTRON_RENDERER_URL",
  "ELECTRON_RUN_AS_NODE",
  "NODE_PATH",
  "PNPM_SCRIPT_SRC_DIR"
];

const TERMINAL_SHUTDOWN_SIGNALS = ["SIGHUP", "SIGINT", "SIGTERM"];
export const DEV_SETUP_SCRIPTS = [
  "./scripts/ensure-electron-runtime.mjs",
  "./scripts/rebuild-native-for-electron.mjs",
  grokAppServerBuildScript
];

export function sanitizeDevEnv(input = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) env[key] = value;
  }

  const removed = [];
  for (const key of ELECTRON_DEV_ENV_KEYS) {
    if (Object.prototype.hasOwnProperty.call(env, key)) {
      delete env[key];
      removed.push(key);
    }
  }

  return { env, removed };
}

function run(command, args, env) {
  const result = spawnSync(command, args, {
    cwd: desktopRoot,
    env,
    stdio: "inherit"
  });
  if (result.error !== undefined) {
    console.error(`[dev] failed to run ${command}: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

export function runDevSetup(node, env, runCommand = run) {
  for (const script of DEV_SETUP_SCRIPTS) {
    const status = runCommand(node, [script], env);
    if (status !== 0) return status;
  }
  return 0;
}

function exitCodeForSignal(signal) {
  if (signal === "SIGHUP") return 129;
  return signal === "SIGINT" ? 130 : 143;
}

function signalChild(child, signal, platform = process.platform, killProcess = process.kill) {
  if (child.pid === undefined) {
    child.kill(signal);
    return;
  }

  if (platform !== "win32") {
    try {
      killProcess(-child.pid, signal);
      return;
    } catch (error) {
      if (error?.code !== "ESRCH") {
        throw error;
      }
    }
  }

  child.kill(signal);
}

export function runLongLived(command, args, env, options = {}) {
  const platform = options.platform ?? process.platform;
  const spawnImpl = options.spawn ?? spawn;
  const processTarget = options.process ?? process;
  const killProcess = options.killProcess ?? process.kill;
  const child = spawnImpl(command, args, {
    cwd: desktopRoot,
    detached: platform !== "win32",
    env,
    stdio: "inherit"
  });

  if (child.pid === undefined) {
    return Promise.resolve(1);
  }

  return new Promise((resolve) => {
    let shutdownSignal = null;
    let forced = false;
    const signalHandlers = new Map();

    const cleanup = () => {
      for (const [signal, handler] of signalHandlers) {
        processTarget.off(signal, handler);
      }
    };

    for (const signal of TERMINAL_SHUTDOWN_SIGNALS) {
      const handler = () => {
        if (forced) return;
        if (shutdownSignal !== null) {
          forced = true;
          signalChild(child, "SIGKILL", platform, killProcess);
          return;
        }

        shutdownSignal = signal;
        signalChild(child, signal, platform, killProcess);
      };
      signalHandlers.set(signal, handler);
      processTarget.on(signal, handler);
    }

    child.on("error", (error) => {
      cleanup();
      console.error(`[dev] failed to run ${command}: ${error.message}`);
      resolve(1);
    });

    child.on("close", (status, signal) => {
      cleanup();
      if (typeof status === "number") {
        resolve(status);
        return;
      }
      if (forced) {
        resolve(signal === "SIGKILL" ? 137 : exitCodeForSignal(shutdownSignal));
        return;
      }
      if (shutdownSignal !== null) {
        resolve(0);
        return;
      }
      if (signal === "SIGHUP" || signal === "SIGINT" || signal === "SIGTERM") {
        resolve(exitCodeForSignal(signal));
        return;
      }
      resolve(1);
    });
  });
}

export async function main(argv = process.argv.slice(2), inputEnv = process.env) {
  const { env, removed } = sanitizeDevEnv(inputEnv);
  if (removed.length > 0) {
    console.warn(`[dev] scrubbed inherited launch env: ${removed.join(", ")}`);
  }

  const node = process.execPath;
  const setupStatus = runDevSetup(node, env);
  if (setupStatus !== 0) return setupStatus;

  // Run electron-vite's JS entry directly so the long-running child can be
  // supervised without relying on a platform-specific node_modules/.bin shim.
  const electronViteJs = resolve(
    desktopRoot,
    "node_modules/electron-vite/bin/electron-vite.js"
  );
  if (!existsSync(electronViteJs)) {
    console.error("[dev] electron-vite is missing; run `pnpm install`.");
    return 1;
  }

  return runLongLived(node, [electronViteJs, "dev", ...argv], env);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  process.exitCode = await main();
}
