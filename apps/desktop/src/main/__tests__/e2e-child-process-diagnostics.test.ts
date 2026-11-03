import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { childProcessCallSites, installE2eChildProcessDiagnostics } from "../e2e-child-process-diagnostics";

describe("E2E child process ownership diagnostics", () => {
  // This inherited-stdio fixture does not keep the pipe open on Windows,
  // matching the existing Playwright worker-shutdown self-test constraint.
  it.skipIf(process.platform === "win32")("retains a child after exit until its inherited stdio actually closes", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "child-ownership-"));
    const release = path.join(directory, "release");
    const lines: string[] = [];
    const recorder = installE2eChildProcessDiagnostics({
      enabled: true, launchId: "test-launch", writeLine: (line) => lines.push(line),
    });
    const child = spawn(process.execPath, ["-e", `
      const { spawn } = require("node:child_process");
      const child = spawn(process.execPath, ["-e",
        'const fs = require("node:fs"); setInterval(() => { if (fs.existsSync(process.argv[1])) process.exit(0); }, 20);',
        ${JSON.stringify(release)}], { stdio: ["ignore", process.stdout, process.stderr] });
      child.unref();
      process.exit(0);
    `, "PRIVATE_ARGUMENT"], {
      env: { ...process.env, PRIVATE_TOKEN: "PRIVATE_ENVIRONMENT" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.resume();
    child.stderr.resume();
    const closed = once(child, "close");
    try {
      await once(child, "exit");
      recorder.snapshot("shutdown-completed");
      const records = lines.map((line) => JSON.parse(line));
      const started = records.find((record) => record.event === "spawn" && record.pid === child.pid);
      expect(started).toBeDefined();
      expect(records.find((record) => record.event === "launch" && record.childId === started.childId)?.callSites.length).toBeGreaterThan(0);
      expect(records.some((record) => record.event === "exit" && record.pid === child.pid)).toBe(true);
      expect(records.some((record) => record.event === "close" && record.pid === child.pid)).toBe(false);
      expect(records.at(-1).children).toContainEqual({ childId: started.childId, pid: child.pid });
      expect(lines.join("")).not.toMatch(/PRIVATE_ARGUMENT|PRIVATE_ENVIRONMENT|PRIVATE_TOKEN/);
      writeFileSync(release, "release");
      await closed;
      recorder.snapshot("process-exit");
      expect(JSON.parse(lines.at(-1)!).children).toEqual([]);
      expect(lines.map((line) => JSON.parse(line)).some((record) => record.event === "close" && record.pid === child.pid)).toBe(true);
    } finally {
      writeFileSync(release, "release");
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await closed;
      recorder.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps only bounded app-relative call sites", () => {
    const sites = childProcessCallSites([
      { functionName: "private", scriptName: "/Users/private/secret.js", lineNumber: 3, columnNumber: 4 },
      ...Array.from({ length: 20 }, () => ({
        functionName: "probeVersion", scriptName: "D:\\private\\repo\\out\\main\\index.js", lineNumber: 50, columnNumber: 2,
      })),
    ]);
    expect(sites).toHaveLength(8);
    expect(sites[0]).toEqual({ functionName: "probeVersion", file: "out/main/index.js", line: 50, column: 2 });
    expect(JSON.stringify(sites)).not.toMatch(/private|secret/);
  });

  it("observes real launch lifecycles only when enabled", async () => {
    const lines: string[] = [];
    const observed: string[] = [];
    const disabled = installE2eChildProcessDiagnostics({ enabled: false, launchId: "test", writeLine: (line) => lines.push(line) });
    const enabled = installE2eChildProcessDiagnostics({ enabled: true, launchId: "test", writeLine: (line) => observed.push(line) });
    try {
      const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
      expect((await once(child, "close"))[0]).toBe(0);
      disabled.snapshot("process-exit");
      enabled.snapshot("process-exit");
      expect(lines).toEqual([]);
      expect(observed.map((line) => JSON.parse(line).event)).toEqual([
        "installed", "launch", "spawn", "exit", "close", "snapshot",
      ]);
      expect(JSON.parse(observed.at(-1)!).children).toEqual([]);
    } finally {
      disabled.dispose();
      enabled.dispose();
    }
  });

  it("does not throw into process creation when diagnostic writes fail", async () => {
    const failed = installE2eChildProcessDiagnostics({ enabled: true, launchId: "test", writeLine: () => { throw new Error("unwritable"); } });
    try {
      const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
      expect((await once(child, "close"))[0]).toBe(0);
      failed.snapshot("process-exit");
    } finally {
      failed.dispose();
    }
  });
});
