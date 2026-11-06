import { spawn } from "node:child_process";
import { once } from "node:events";
import { expect, test } from "vitest";
import { cleanupProbeProcessGroup } from "./probe-electron-native-quit.mjs";

test.skipIf(process.platform === "win32")("closes inherited pipes after the POSIX group leader exits", async () => {
  const descendant = 'process.stdout.write("descendant-ready\\n"); setInterval(() => {}, 1000);';
  const launcher = `
    const { spawn } = require("node:child_process");
    spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], {
      stdio: ["ignore", "inherit", "inherit"],
    }).unref();
  `;
  const child = spawn(process.execPath, ["-e", launcher], {
    detached: true, stdio: ["ignore", "pipe", "pipe"],
  });
  const signal = AbortSignal.timeout(3_000);
  const ready = once(child.stdout, "data", { signal });
  const exited = once(child, "exit", { signal });
  let didClose = false;
  const closed = once(child, "close", { signal }).then(() => { didClose = true; });
  for (const promise of [ready, exited, closed]) promise.catch(() => undefined);
  child.stderr.resume();
  try {
    const [data] = await ready;
    expect(data.toString()).toBe("descendant-ready\n");
    expect((await exited)[0]).toBe(0);
    expect(child.exitCode).toBe(0);
    expect(didClose).toBe(false);
    await cleanupProbeProcessGroup(child, closed);
    expect(didClose).toBe(true);
  } finally {
    // Also clean up if an assertion fails before the production cleanup runs.
    if (child.pid) {
      try { process.kill(-child.pid, "SIGKILL"); } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
    await closed;
  }
});
