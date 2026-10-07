#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createPosixProcessTracker, DESCENDANT_ENV, ownerRunning, processStartedAt } from "./tool-processes.mjs";
export { processStartedAt } from "./tool-processes.mjs";
import { pathToFileURL } from "node:url";
import lockfile from "proper-lockfile";
import crossSpawn from "cross-spawn";
import { prepareWindowsToolJob } from "./windows-tool-job.mjs";
import { getToolResourcePolicy, resourceCommand, resourceEnvironment, toolHeapMiB } from "./tool-resource-policy.mjs";

export const OWNER_ENV = "PWRAGENT_TOOL_RESOURCE_OWNER";
const userKey = createHash("sha256").update(homedir()).digest("hex").slice(0, 16);
// Shared with PwrGit. TMPDIR varies between terminals and worktrees, so the
// user's home, rather than their current temp directory, anchors the lane.
export const MACHINE_TOOL_LOCK = path.join(homedir(), ".cache", `pwragent-tools-${userKey}`, "heavy-tool");

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

function parentPid(pid) {
  if (process.platform === "linux") {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
  }
  if (process.platform === "win32") {
    return Number(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').ParentProcessId`], { encoding: "utf8", timeout: 5_000, windowsHide: true }).trim());
  }
  return Number(execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8", timeout: 5_000 }).trim());
}

export function isAncestorPid(ownerPid, pid = process.pid, getParent = parentPid) {
  const visited = new Set();
  try {
    while (Number.isInteger(pid) && pid > 0 && !visited.has(pid)) {
      if (pid === ownerPid) return true;
      visited.add(pid);
      pid = getParent(pid);
    }
  } catch { /* An exited/unreadable ancestor cannot grant a lease. */ }
  return false;
}

async function readOwner(lockPath) {
  try { return JSON.parse(await readFile(`${lockPath}.owner.json`, "utf8")); } catch { return null; }
}

async function writeOwner(lockPath, owner) {
  const temporary = `${lockPath}.owner-${owner.token}.tmp`;
  await writeFile(temporary, JSON.stringify(owner), { mode: 0o600 });
  await rename(temporary, `${lockPath}.owner.json`);
}

async function inheritedLock(env, lockPath) {
  try {
    const owner = JSON.parse(env[OWNER_ENV] ?? "null");
    if (!owner || owner.path !== lockPath || typeof owner.token !== "string" || !alive(owner.pid) || !isAncestorPid(owner.pid)) return false;
    const recorded = await readOwner(lockPath);
    return recorded?.pid === owner.pid && recorded?.token === owner.token && recorded?.path === lockPath
      && ownerRunning(recorded) && await lockfile.check(lockPath, { realpath: false, stale: 30_000 });
  } catch { return false; }
}

function signalGroup(pid, signal) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("Invalid tool process group identity");
  try { process.kill(-pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; }
}

function groupRunning(pid) {
  // kill(-pgid, 0) includes unreaped zombies on Linux. They consume no memory
  // and cannot execute; ps lets us wait for all *running* descendants instead.
  const rows = execFileSync("ps", ["-eo", "pgid=,stat="], { encoding: "utf8", timeout: 5_000 }).trim().split("\n");
  return rows.some((row) => {
    const [group, state] = row.trim().split(/\s+/);
    return Number(group) === pid && !state.startsWith("Z");
  });
}

async function finishGroup(pid, expectedStartedAt) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("Invalid tool process group identity");
  // A PGID cannot be reused while any original member remains. If its leader
  // exists with a different start identity, the old group is already gone.
  const currentStartedAt = processStartedAt(pid);
  if (expectedStartedAt && currentStartedAt && currentStartedAt !== expectedStartedAt) return;
  signalGroup(pid, "SIGKILL");
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!groupRunning(pid)) return;
    await delay(50);
  }
  throw new Error(`Tool process group ${pid} is still running; refusing to release its lease.`);
}

// A lease covers the entire enclosing script. Nested scripts share its process
// group and verified token; separate commands queue even across repositories.
export async function runResourceCommand(command, args, {
  env = process.env,
  policy = getToolResourcePolicy({ env }),
  lockPath = MACHINE_TOOL_LOCK,
  cwd = process.cwd(),
  stdio = "inherit",
  log = (message) => process.stderr.write(`${message}\n`),
} = {}) {
  const heapMiB = toolHeapMiB(command, args, cwd);
  const childEnv = resourceEnvironment(command, args, env, policy, cwd);
  const abort = new AbortController();
  let child;
  let stoppedBy;
  let release;
  let owner;
  let compromised;
  let ownsGroup = false;
  let ownedGroupStartedAt;
  let killTimer;
  let windowsJob;
  let tracker;
  let observeTimer;
  let recordedGroups = "[]";
  const observeDescendants = () => {
    tracker.observe();
    const groups = tracker.recordedGroups();
    const serialized = JSON.stringify(groups);
    if (serialized === recordedGroups) return;
    owner.descendantGroups = groups;
    // One writer, synchronous atomic replacement: cancellation must publish
    // discoveries before killing their parents, without racing an interval.
    const temporary = `${lockPath}.owner-${owner.token}.tmp`;
    writeFileSync(temporary, JSON.stringify(owner), { mode: 0o600 });
    renameSync(temporary, `${lockPath}.owner.json`);
    recordedGroups = serialized;
  };
  const stopChild = (signal) => {
    if (!child?.pid) return;
    if (windowsJob) { windowsJob.cancel(); return; }
    if (tracker) { observeDescendants(); tracker.signal(signal); }
    else if (ownsGroup) signalGroup(child.pid, signal);
    else child.kill(signal);
  };
  const stop = (signal) => {
    stoppedBy ??= signal;
    abort.abort();
    try { stopChild(signal); } catch (error) { compromised ??= error; }
    if (child && !windowsJob && !killTimer) killTimer = setTimeout(() => { try { stopChild("SIGKILL"); } catch (error) { compromised ??= error; } }, 5_000);
  };
  const onInt = () => stop("SIGINT");
  const onTerm = () => stop("SIGTERM");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  try {
    if (policy.constrained && !await inheritedLock(env, lockPath)) {
      await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
      let announced = false;
      while (!abort.signal.aborted) {
        try {
          release = await lockfile.lock(lockPath, {
            realpath: false, stale: 30_000, update: 5_000, retries: 0,
            onCompromised(error) { compromised = error; stop("SIGTERM"); },
          });
          const previous = await readOwner(lockPath);
          if (previous && ownerRunning(previous)) throw new Error("Stale tool lease still has a live owner; refusing concurrent execution.");
          if (previous?.groupPid && process.platform !== "win32") {
            if (!previous.groupStartedAt) {
              if (groupRunning(previous.groupPid)) throw new Error("Stale process group has no start identity; refusing unsafe recovery.");
            } else await createPosixProcessTracker(
              { pid: previous.groupPid, startedAt: previous.groupStartedAt }, previous.descendantGroups, { descendantToken: previous.descendantToken },
            ).drain();
          }
          const ownerStartedAt = processStartedAt(process.pid);
          if (!ownerStartedAt) throw new Error("Unable to identify the tool lease owner");
          owner = { pid: process.pid, path: lockPath, token: randomUUID(), ownerStartedAt, ...(process.platform === "win32" ? {} : { descendantToken: randomUUID() }) };
          await writeOwner(lockPath, owner);
          childEnv[OWNER_ENV] = JSON.stringify({ pid: owner.pid, path: owner.path, token: owner.token });
          break;
        } catch (error) {
          if (error.code !== "ELOCKED") throw error;
          if (!announced) { log("[resources] Waiting for another project's/worktree's tool command to finish."); announced = true; }
          await delay(250, undefined, { signal: abort.signal });
        }
      }
    }
    if (abort.signal.aborted) return { code: null, signal: stoppedBy };
    const childArgs = resourceCommand(command, args, policy);
    if (policy.constrained) log(`[resources] ${(policy.effectiveMemory / 1024 ** 3).toFixed(1)} GiB total machine/container capacity; ${heapMiB} MiB Node old space, serial tools.`);
    ownsGroup = !!release && process.platform !== "win32";
    if (policy.constrained && process.platform === "win32") {
      windowsJob = prepareWindowsToolJob(command, childArgs, { env: childEnv, cwd });
    }
    const completion = new Promise((resolve, reject) => {
      const launchCommand = windowsJob?.command ?? (ownsGroup ? process.execPath : command);
      const launchArgs = windowsJob?.args ?? (ownsGroup ? [path.join(import.meta.dirname, "posix-tool-child.mjs")] : childArgs);
      const spawnTool = process.platform === "win32" && !windowsJob ? crossSpawn : spawn;
      child = spawnTool(launchCommand, launchArgs, {
        cwd, env: ownsGroup ? { ...childEnv, [DESCENDANT_ENV]: owner.descendantToken } : (windowsJob?.env ?? childEnv),
        stdio: ownsGroup ? (Array.isArray(stdio) ? [...stdio.slice(0, 3), "ipc"] : [stdio, stdio, stdio, "ipc"]) : stdio,
        shell: false,
        windowsHide: !!windowsJob,
        detached: ownsGroup,
      });
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal: stoppedBy ?? signal }));
    });
    // Observe spawn errors immediately even while publishing ownership.
    completion.catch(() => {});
    if (owner && ownsGroup && child.pid) {
      ownedGroupStartedAt = processStartedAt(child.pid);
      if (!ownedGroupStartedAt) throw new Error("Tool bridge exited before publishing process ownership.");
      owner = { ...owner, groupPid: child.pid, groupStartedAt: ownedGroupStartedAt, descendantGroups: [] };
      await writeOwner(lockPath, owner);
      tracker = createPosixProcessTracker({ pid: child.pid, startedAt: ownedGroupStartedAt }, [], { descendantToken: owner.descendantToken });
      observeTimer = setInterval(() => {
        try { observeDescendants(); }
        catch (error) { compromised ??= error; stop("SIGTERM"); }
      }, 100);
      if (abort.signal.aborted) stopChild(stoppedBy);
      else await new Promise((resolve, reject) => child.send({ command, args: childArgs }, (error) => error ? reject(error) : resolve()));
    }
    const result = await completion;
    if (compromised) throw compromised;
    return result;
  } catch (error) {
    if (abort.signal.aborted && !compromised) return { code: null, signal: stoppedBy };
    throw error;
  } finally {
    if (killTimer) clearTimeout(killTimer);
    if (observeTimer) clearInterval(observeTimer);
    try {
      if (tracker) { observeDescendants(); await tracker.drain(); }
      else if (ownsGroup && child?.pid) await finishGroup(child.pid, ownedGroupStartedAt);
      if (release && !compromised) {
        if (owner) await rm(`${lockPath}.owner.json`, { force: true });
        await release();
      }
    } finally {
      windowsJob?.cleanup();
      process.removeListener("SIGINT", onInt);
      process.removeListener("SIGTERM", onTerm);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [command, ...args] = process.argv.slice(2);
  if (command === "--policy") console.log(JSON.stringify(getToolResourcePolicy(), null, 2));
  else if (!command) {
    console.error("Usage: node scripts/resource-run.mjs <command> [args...] | --policy");
    process.exitCode = 2;
  } else {
    try {
      const result = await runResourceCommand(command, args);
      if (result.signal) {
        // Keep the loop alive until the OS delivers the forwarded signal.
        setTimeout(() => process.exit(1), 1_000);
        process.kill(process.pid, result.signal);
      }
      else process.exitCode = result.code ?? 1;
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
