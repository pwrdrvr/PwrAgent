import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createPosixProcessTracker, DESCENDANT_ENV, ownerRunning, processStartedAt } from "./tool-processes.mjs";

// No tool starts until the lease owner has published this bridge's identity.
export function runPosixToolChild() {
  if (!process.connected) throw new Error("The POSIX tool gate requires its lease owner's IPC channel");
  const owner = JSON.parse(process.env.PWRAGENT_TOOL_RESOURCE_OWNER);
  const descendantToken = process.env[DESCENDANT_ENV];
  if (!descendantToken) throw new Error("Missing private tool descendant capability");
  const primary = { pid: process.pid, startedAt: processStartedAt(process.pid) };
  let tracker = createPosixProcessTracker(primary, [], { descendantToken });
  let finishing = false;
  const observeTimer = setInterval(() => {
    try { tracker.observe(); }
    catch (error) { void finish(127, error); }
  }, 100);
  const ownerWatch = setInterval(() => {
    try {
      const recorded = JSON.parse(readFileSync(`${owner.path}.owner.json`, "utf8"));
      if (recorded.pid !== owner.pid || recorded.token !== owner.token || !ownerRunning(recorded)) void finish(1);
    } catch (error) { void finish(1, error); }
  }, 100);
  const disconnected = () => { void finish(1); };
  process.once("disconnect", disconnected);
  process.once("message", ({ command, args }) => {
    if (finishing) return;
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", (error) => { void finish(127, error); });
    child.once("close", (code, signal) => {
      if (signal) console.error(`[resources] Tool exited with ${signal}.`);
      void finish(code ?? 1);
    });
  });

  async function finish(code, error) {
    if (finishing) return;
    finishing = true;
    clearInterval(observeTimer);
    clearInterval(ownerWatch);
    process.removeListener("disconnect", disconnected);
    if (error) console.error(error.message);
    try {
      // Retain local observations even if the launcher already exited. Merge
      // the owner's persisted groups so SIGKILL recovery uses the same ledger.
      tracker.observe();
      let recorded;
      try { recorded = JSON.parse(readFileSync(`${owner.path}.owner.json`, "utf8")); } catch { /* Local observations still own cleanup. */ }
      if (recorded?.pid === owner.pid && recorded?.token === owner.token && recorded?.groupPid === primary.pid
        && recorded?.groupStartedAt === primary.startedAt && recorded?.descendantToken === descendantToken) {
        tracker = createPosixProcessTracker(primary, [...tracker.recordedGroups(), ...(recorded.descendantGroups ?? [])], { descendantToken });
      }
      await tracker.drain();
      process.exitCode = code;
      if (process.connected) process.disconnect();
    } catch (cleanupError) {
      // Stay alive and retry rather than declaring this bridge drained while
      // a detached descendant may still own memory. Parent recovery can retry.
      console.error(cleanupError.message);
      finishing = false;
      setTimeout(() => { void finish(code); }, 100);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { runPosixToolChild(); }
  catch (error) { console.error(error.message); process.exitCode = 127; }
}
