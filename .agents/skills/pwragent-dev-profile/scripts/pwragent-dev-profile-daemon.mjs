#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const INSTANCE_ROOT_ENV = "PWRAGENT_INSTANCE_ROOT";

function parseArgs(argv) {
  const options = { daemonize: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--daemonize") {
      options.daemonize = true;
      continue;
    }
    if (!arg.startsWith("--")) throw new Error(`unknown argument: ${arg}`);
    const key = arg.slice(2).replace(/-([a-z])/g, (_match, value) => value.toUpperCase());
    const value = argv[index + 1];
    if (!value) throw new Error(`${arg} requires a value`);
    options[key] = value;
    index += 1;
  }
  for (const key of ["root", "profile", "rootHash", "stateDb", "log", "pidFile", "startedAfter"]) {
    if (!options[key]) throw new Error(`missing --${key.replace(/[A-Z]/g, (value) => `-${value.toLowerCase()}`)}`);
  }
  return options;
}

function appendLog(logPath, message) {
  fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`);
}

function daemonize(options) {
  const args = process.argv.slice(1).filter((arg) => arg !== "--daemonize");
  const out = fs.openSync(options.log, "a");
  const child = spawn(process.execPath, args, {
    cwd: options.root,
    detached: true,
    env: process.env,
    stdio: ["ignore", out, out],
  });
  child.unref();
  fs.writeFileSync(options.pidFile, `${child.pid}\n`);
  process.stdout.write(`${child.pid}\n`);
}

function sqliteValue(value) {
  return String(value).replaceAll("'", "''");
}

function readStartedInstance(options, trackedInstanceId) {
  if (!fs.existsSync(options.stateDb)) return null;
  const candidatePids = trackedInstanceId ? [] : electronDescendantPids(Number(options.childPid));
  if (!trackedInstanceId && candidatePids.length === 0) return null;
  const selector = trackedInstanceId
    ? `instance_id = '${sqliteValue(trackedInstanceId)}'`
    : `profile_name = '${sqliteValue(options.profile)}' AND cwd_hash = '${sqliteValue(options.rootHash)}' AND heartbeat_at >= ${Number(options.startedAfter)} AND process_id IN (${candidatePids.join(",")}) AND exited_at IS NULL`;
  const sql = `SELECT instance_id, process_id, coalesce(exited_at, '') FROM app_runtime_instances WHERE ${selector} ORDER BY heartbeat_at DESC LIMIT 1;`;
  const result = spawnSync("sqlite3", ["-readonly", "-separator", "\t", options.stateDb, sql], {
    encoding: "utf8",
  });
  if (result.status !== 0) return null;
  const line = result.stdout.trim();
  if (!line) return null;
  const [instanceId, processId, exitedAt] = line.split("\t");
  return { instanceId, processId: Number(processId), exitedAt };
}

function electronDescendantPids(rootPid) {
  return descendantPids(rootPid).filter((pid) => {
    const result = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
    });
    return result.status === 0
      && result.stdout.includes("Electron.app/Contents/MacOS/Electron");
  });
}

function descendantPids(rootPid) {
  if (!rootPid) return [];
  const result = spawnSync("pgrep", ["-P", String(rootPid)], { encoding: "utf8" });
  if (result.status !== 0) return [];
  return result.stdout
    .split(/\s+/)
    .filter(Boolean)
    .map((value) => Number(value))
    .flatMap((pid) => [pid, ...descendantPids(pid)]);
}

function pidIsLive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function terminateProcessGroup(pid, signal) {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
}

async function run(options) {
  appendLog(options.log, `daemon start root=${options.root} profile=${options.profile} rootHash=${options.rootHash}`);
  fs.writeFileSync(options.pidFile, `${process.pid}\n`);

  const out = fs.openSync(options.log, "a");
  const child = spawn("/bin/zsh", ["-lc", "exec pnpm dev"], {
    cwd: options.root,
    detached: true,
    env: {
      ...process.env,
      PWRAGENT_PROFILE: options.profile,
      [INSTANCE_ROOT_ENV]: options.root,
    },
    stdio: ["ignore", out, out],
  });
  options.childPid = child.pid;

  let stopping = false;
  const stop = (reason) => {
    if (stopping) return;
    stopping = true;
    appendLog(options.log, `daemon stopping reason=${reason} childPid=${child.pid}`);
    terminateProcessGroup(child.pid, "SIGTERM");
    setTimeout(() => {
      terminateProcessGroup(child.pid, "SIGKILL");
      process.exit(0);
    }, 5_000).unref();
  };

  process.on("SIGTERM", () => stop("sigterm"));
  process.on("SIGINT", () => stop("sigint"));
  process.on("SIGHUP", () => stop("sighup"));
  child.on("exit", (code, signal) => {
    appendLog(options.log, `pnpm dev exited code=${code ?? ""} signal=${signal ?? ""}`);
    process.exit(code ?? 0);
  });

  let trackedInstanceId = null;
  let trackedProcessId = null;
  const monitor = setInterval(() => {
    const instance = readStartedInstance(options, trackedInstanceId);
    if (!instance) return;
    if (!trackedInstanceId) {
      trackedInstanceId = instance.instanceId;
      trackedProcessId = instance.processId;
      appendLog(options.log, `tracking app instance id=${trackedInstanceId} pid=${trackedProcessId}`);
      return;
    }
    if (instance.exitedAt) {
      stop(`app-exited instance=${trackedInstanceId}`);
      return;
    }
    if (trackedProcessId && !pidIsLive(trackedProcessId)) {
      stop(`app-pid-exited instance=${trackedInstanceId} pid=${trackedProcessId}`);
    }
  }, 500);
  monitor.unref();
}

try {
  const options = parseArgs(process.argv.slice(2));
  fs.mkdirSync(path.dirname(options.log), { recursive: true });
  fs.mkdirSync(path.dirname(options.pidFile), { recursive: true });
  if (options.daemonize) {
    daemonize(options);
  } else {
    await run(options);
  }
} catch (error) {
  console.error(`pwragent-dev-profile-daemon: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
