import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import {
  collectProcessTreeIds,
  isProcessIdAlive,
  terminateOwnedProcessTree,
  waitForProcessTreeGone,
} from "../process-tree";

const posixOnly = process.platform === "win32" ? it.skip : it;
const windowsOnly = process.platform === "win32" ? it : it.skip;

describe("collectProcessTreeIds", () => {
  windowsOnly("observes a real child without adopting its owner's other processes", async () => {
    const leaf = "process.stdin.resume(); process.stdin.once('end', () => process.exit(0));";
    const script = [
      "const { spawn } = require('node:child_process');",
      `const child = spawn(process.execPath, ['-e', ${JSON.stringify(leaf)}], { stdio: ['pipe', 'ignore', 'ignore'] });`,
      "process.stdout.write(String(child.pid) + '\\n');",
      "process.stdin.resume();",
      "process.stdin.once('end', () => child.stdin.end());",
      "child.once('close', () => process.exit(0));",
    ].join(" ");
    const child = spawn(process.execPath, ["-e", script], { stdio: ["pipe", "pipe", "ignore"] });
    const closed = once(child, "close");
    try {
      const [line] = await once(child.stdout!, "data");
      const leafPid = Number(String(line).trim());
      expect(leafPid).toBeGreaterThan(0);
      const snapshot = collectProcessTreeIds(child.pid!);
      expect(snapshot).toContain(child.pid);
      expect(snapshot).toContain(leafPid);
      expect(snapshot).not.toContain(process.pid);
    } finally {
      // The root closes its child's stdin and awaits that child's close.
      child.stdin!.end();
      await closed;
    }
  }, 30_000);
});

describe("terminateOwnedProcessTree", () => {
  posixOnly("kills a resistant descendant after its group leader exits", async () => {
    const script = [
      'const { spawn } = require("node:child_process");',
      "const descendant = spawn(process.execPath, [\"-e\", \"process.on('SIGTERM', () => undefined); setInterval(() => undefined, 1000)\"], { stdio: \"ignore\" });",
      'process.stdout.write(String(descendant.pid) + "\\n");',
      "setInterval(() => undefined, 1000);",
    ].join(" ");
    const child = spawn(process.execPath, ["-e", script], {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    try {
      const [line] = await once(child.stdout!, "data");
      const descendantPid = Number(String(line).trim());

      await terminateOwnedProcessTree(child, {
        gracefulTimeoutMs: 25,
        forceTimeoutMs: 1_000,
      });

      expect(() => process.kill(child.pid!, 0)).toThrow();
      expect(() => process.kill(descendantPid, 0)).toThrow();
    } finally {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        // The expected path already terminated the entire process group.
      }
    }
  });
});

describe("waitForProcessTreeGone", () => {
  it("treats a missing pid as already gone", async () => {
    await expect(
      waitForProcessTreeGone({ rootPid: 0, timeoutMs: 50 }),
    ).resolves.toBe(true);
  });

  it("waits until a killed process and its snapshot pids are gone", async () => {
    const child = spawn(
      process.execPath,
      ["-e", "setInterval(() => undefined, 1000)"],
      { stdio: "ignore" },
    );
    const pid = child.pid;
    expect(pid).toEqual(expect.any(Number));
    const knownPids = collectProcessTreeIds(pid!);
    expect(knownPids).toContain(pid);
    expect(isProcessIdAlive(pid!)).toBe(true);

    child.kill("SIGKILL");
    await expect(
      waitForProcessTreeGone({
        knownPids,
        rootPid: pid,
        timeoutMs: 2_000,
      }),
    ).resolves.toBe(true);
    expect(isProcessIdAlive(pid!)).toBe(false);
  });
});
