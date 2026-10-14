import { appendFileSync, createReadStream, lstatSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import { deadlineCall, sanitizedProtocolRecord } from "./headless-contract.mjs";

export function createOwnedCaptureRoot(profileDir) {
  const directory = path.join(profileDir, "protocol");
  // Exclusive creation: never acquire ownership of existing captures.
  mkdirSync(directory, { mode: 0o700 });
  const info = lstatSync(directory);
  return { directory, dev: info.dev, ino: info.ino };
}

export async function exportOwnedProtocol(owned, destination, redact) {
  if (!owned) return;
  const info = lstatSync(owned.directory);
  if (!info.isDirectory() || info.dev !== owned.dev || info.ino !== owned.ino) throw new Error("Capture directory ownership changed");
  writeFileSync(destination, "", { mode: 0o600 });
  async function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
        for await (const line of lines) {
          if (line.trim()) appendFileSync(destination, JSON.stringify(sanitizedProtocolRecord(JSON.parse(line), redact)) + "\n");
        }
      }
    }
  }
  await walk(owned.directory);
}

export async function closeHeadlessApp(app, { graceMs = 15_000, forceMs = 5_000 } = {}) {
  try {
    await deadlineCall("closeElectron", app.close(), graceMs);
    return { cleanup: "graceful", artifactsSafe: true };
  } catch (error) {
    const child = app.process();
    let forceError;
    try {
      if (process.platform === "win32" || !child.pid || child.pid <= 1 || child.pid === process.pid) throw new Error("No owned POSIX Electron process group");
      if (child.exitCode === null && child.signalCode === null) {
        // Playwright launches Electron detached on POSIX. Do not call
        // child.kill(): that kills just the leader and disables its tree cleanup.
        try { process.kill(-child.pid, "SIGKILL"); }
        catch (killError) { if (killError.code !== "ESRCH") throw killError; }
        let onExit;
        try {
          await deadlineCall("waitElectronExit", new Promise((resolve) => {
            onExit = resolve;
            child.once("exit", onExit);
            if (child.exitCode !== null || child.signalCode !== null) resolve();
          }), forceMs);
        } finally { child.off("exit", onExit); }
      }
    } catch (failure) { forceError = failure.message; }
    // A task can start a new session/process group. Only container teardown
    // guarantees those descendants stopped. Never collect live task artifacts
    // on this path, even when killing Electron's group succeeded.
    return {
      cleanup: "forced",
      artifactsSafe: false,
      containerStopRequired: true,
      cleanupError: error.message,
      ...(forceError ? { forceError } : {}),
    };
  }
}
