import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execFileSync = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFileSync }));

const platform = Object.getOwnPropertyDescriptor(process, "platform");
const TICKS = "639269852990946674";
const OTHER_PID = process.pid + 1;

function timedOut(stdout) {
  return Object.assign(new Error("spawnSync powershell.exe ETIMEDOUT"), { code: "ETIMEDOUT", signal: "SIGTERM", status: null, stdout });
}

// Each test gets a fresh module, so the remembered own identity starts empty.
async function onPlatform(name) {
  Object.defineProperty(process, "platform", { ...platform, value: name });
  vi.resetModules();
  return import("./tool-processes.mjs");
}

// Braces matter: a function returned from beforeEach runs as its teardown.
beforeEach(() => { execFileSync.mockReset(); });
afterEach(() => Object.defineProperty(process, "platform", platform));

describe("processStartedAt on Windows", () => {
  it("gives a cold PowerShell start far more than the POSIX 5 s budget", async () => {
    const { processStartedAt, WINDOWS_START_TIMEOUT_MS } = await onPlatform("win32");
    execFileSync.mockReturnValue(`${TICKS}\r\n`);
    expect(processStartedAt(OTHER_PID)).toBe(TICKS);
    expect(WINDOWS_START_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
    expect(execFileSync).toHaveBeenCalledWith("powershell.exe", expect.arrayContaining([
      `(Get-Process -Id ${OTHER_PID} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
    ]), expect.objectContaining({ timeout: WINDOWS_START_TIMEOUT_MS, windowsHide: true }));
  });

  it("accepts an answer PowerShell finished writing before the timeout killed it", async () => {
    const { processStartedAt } = await onPlatform("win32");
    execFileSync.mockImplementation(() => { throw timedOut(`${TICKS}\r\n`); });
    expect(processStartedAt(OTHER_PID)).toBe(TICKS);
  });

  it.each([
    ["nothing", ""],
    ["a partial line", TICKS.slice(0, 9)],
    ["an unterminated line", TICKS],
    ["something other than ticks", "Get-Process : Cannot find a process\r\n"],
  ])("still throws a timeout that left %s on stdout", async (_label, stdout) => {
    const { processStartedAt } = await onPlatform("win32");
    execFileSync.mockImplementation(() => { throw timedOut(stdout); });
    expect(() => processStartedAt(OTHER_PID)).toThrow("ETIMEDOUT");
  });

  it("asks PowerShell for its own identity once, and for any other PID every time", async () => {
    const { processStartedAt } = await onPlatform("win32");
    execFileSync.mockReturnValue(`${TICKS}\r\n`);
    expect(processStartedAt(process.pid)).toBe(TICKS);
    expect(processStartedAt(process.pid)).toBe(TICKS);
    expect(execFileSync).toHaveBeenCalledTimes(1);
    // A different process can take over another PID; never answer from memory.
    processStartedAt(OTHER_PID);
    processStartedAt(OTHER_PID);
    expect(execFileSync).toHaveBeenCalledTimes(3);
  });

  it("does not remember a failed lookup of its own identity", async () => {
    const { processStartedAt } = await onPlatform("win32");
    execFileSync.mockImplementationOnce(() => { throw timedOut(""); }).mockReturnValue(`${TICKS}\r\n`);
    expect(() => processStartedAt(process.pid)).toThrow("ETIMEDOUT");
    expect(processStartedAt(process.pid)).toBe(TICKS);
  });

  it("still reports a missing process as no identity", async () => {
    const { processStartedAt } = await onPlatform("win32");
    execFileSync.mockImplementation(() => { throw Object.assign(new Error("exit 1"), { status: 1, stdout: "" }); });
    expect(processStartedAt(OTHER_PID)).toBeNull();
  });
});

describe("processStartedAt on macOS", () => {
  it("keeps a 5 s ps lookup per call, with no timeout salvage", async () => {
    const { processStartedAt } = await onPlatform("darwin");
    execFileSync.mockReturnValue("Wed Oct  7 17:23:19 2026\n");
    expect(processStartedAt(process.pid)).toBe("Wed Oct  7 17:23:19 2026");
    expect(processStartedAt(process.pid)).toBe("Wed Oct  7 17:23:19 2026");
    expect(execFileSync).toHaveBeenCalledTimes(2);
    expect(execFileSync).toHaveBeenCalledWith("ps", ["-o", "lstart=", "-p", String(process.pid)],
      expect.objectContaining({ timeout: 5_000 }));
    execFileSync.mockImplementation(() => { throw timedOut("Wed Oct  7 17:23:19 2026\n"); });
    expect(() => processStartedAt(process.pid)).toThrow("ETIMEDOUT");
  });
});
