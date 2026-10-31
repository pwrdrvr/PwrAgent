import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ancestry, bindPipeNames, exactLauncherPipes, normalizePipeName, parseHandleOutput, observeWindowsLauncher, packageManagerCommand } from "./windows-pipe-observation.mjs";

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function root() { const value = mkdtempSync(path.join(os.tmpdir(), "pwragent-native-pipes-")); roots.push(value); return value; }
const names = [1, 2, 3, 4].map((n) => "\\Device\\NamedPipe\\uv\\" + n + "-123");
const inventory = () => ({ verified: true, liveAfter: true, pipes: names.map((name) => ({ name })) });

describe("Windows natural pipe evidence", () => {
  it("launches pnpm native executables directly and JavaScript entries through Node", () => {
    const args = ["--filter", "@pwragent/desktop", "test:e2e", "--shard=4/4"];
    const native = path.resolve("pnpm-native.exe");
    const script = path.resolve("pnpm.cjs");
    expect(packageManagerCommand(native, args)).toEqual({ file: native, args });
    expect(packageManagerCommand(script, args)).toEqual({ file: process.execPath, args: [script, ...args] });
    expect(() => packageManagerCommand(path.resolve("pnpm.cmd"), args)).toThrow();
    expect(() => packageManagerCommand(undefined, args)).toThrow();
  });

  it("normalizes only the namespace prefix and requires complete exact names", () => {
    expect(normalizePipeName("\\\\?\\pipe\\uv\\1-123")).toBe(names[0]);
    expect(normalizePipeName("\\Device\\NamedPipe\\uv\\1-123")).toBe(names[0]);
    const candidates = names.map((name) => name.replace("\\Device\\NamedPipe\\", "\\\\?\\pipe\\"));
    expect(exactLauncherPipes([...candidates, "\\\\?\\pipe\\uv\\other-app-123"], inventory()).names).toEqual(names);
    expect(exactLauncherPipes(candidates.map((name) => name + "-extra"), inventory()).error).toBeDefined();
    expect(exactLauncherPipes(candidates, { ...inventory(), liveAfter: false }).error).toBeDefined();
    expect(exactLauncherPipes(candidates, { ...inventory(), verified: false }).error).toBeDefined();
  });

  it("does not map a worker's candidate pool without an exact four-name main inventory", () => {
    const result = inventory();
    result.pipes.push({ name: "\\Device\\NamedPipe\\uv\\other-123" });
    expect(exactLauncherPipes([...names, result.pipes[4].name], result).error).toBeDefined();
    expect(exactLauncherPipes(names.slice(0, 3), inventory()).error).toBeDefined();
  });

  it("uses native exit intervals to resolve a dead parent across PID reuse", () => {
    const base = 134379500000000000n;
    const old = { pid: 20, ppid: 0, created: String(base), goneAt: 400, nativeExit: String(base + 8n) };
    const replacement = { pid: 20, ppid: 0, created: String(base + 10n) };
    const child = { pid: 30, ppid: 20, created: String(base + 7n) };
    const rows = new Map([old, replacement, child].map((row) => [row.pid + ":" + row.created, row]));
    expect(ancestry(rows, 30, child.created).chain).toEqual([child, old]);
    old.nativeExit = String(base + 6n); // 100ns precision must survive Number's rounding.
    expect(ancestry(rows, 30, child.created).status).toBe("missing-parent");
    old.nativeExit = "0";
    expect(ancestry(rows, 30, child.created).status).toBe("missing-parent");
  });

  it("exposes missing and ambiguous ancestry instead of adopting a PID-only parent", () => {
    const child = { pid: 30, ppid: 20, created: "100" };
    const rows = new Map([["30:100", child]]);
    expect(ancestry(rows, 30, "100").status).toBe("missing-parent");
    rows.set("20:1", { pid: 20, ppid: 0, created: "1", goneAt: 200, nativeExit: "101" });
    rows.set("20:2", { pid: 20, ppid: 0, created: "2", goneAt: 200, nativeExit: "101" });
    expect(ancestry(rows, 30, "100").status).toBe("ambiguous-parent");
    child.parentCreated = "1";
    expect(ancestry(rows, 30, "100").chain[1].created).toBe("1");
  });

  it("binds scoped Handle output only across the same native creation identity", () => {
    const before = { pid: 77, created: "134379500000000000", verified: true, liveAfter: true };
    const text = names.map((name, i) => "  " + (i + 16).toString(16) + ": File  " + name).join("\n");
    expect(bindPipeNames(before, { ...before }, text).pipes.map((pipe) => pipe.name)).toEqual(names);
    expect(bindPipeNames(before, { ...before, created: "134379500000000001" }, text).error).toBeDefined();
    expect(bindPipeNames(before, { ...before, liveAfter: false }, text).error).toBeDefined();
  });

  it("parses global search records and rejects substring lookalikes at exact matching", () => {
    const text = names.map((name, i) => "cmd.exe pid: 99 type: File " + (i + 16).toString(16) + ": " + name).join("\n");
    const parsed = parseHandleOutput(text + "\nAccess denied\n");
    expect(parsed.processes).toHaveLength(1);
    expect(parsed.processes[0]).toMatchObject({ pid: 99 });
    expect(parsed.processes[0].pipes.map((pipe) => pipe.name)).toEqual(names);
    expect(parsed.errorCount).toBe(1);
    expect(parseHandleOutput("node.exe pid: 98\n  10: File " + names[0]).processes[0].pid).toBe(98);
  });
  function fake() {
    const child = new EventEmitter();
    Object.assign(child, { spawnfile: "electron.exe", pid: 77,
      stdio: [null, ...names.map(() => ({ destroyed: false, readableEnded: false, writableFinished: false }))] });
    return child;
  }
  it("snapshots the natural exit trigger before logging and does not report on exit", () => {
    const directory = root();
    const child = fake();
    const report = vi.fn(() => ({ libuv: [{ type: "pipe", remoteEndpoint: "\\\\?\\pipe\\uv\\1-" + process.pid }] }));
    const logEvidence = vi.fn(() => { for (const stream of child.stdio.filter(Boolean)) stream.destroyed = true; });
    const launchId = observeWindowsLauncher(child, { directory, report, logEvidence, now: () => 1234 });
    child.emit("exit", 0, null);
    const trigger = JSON.parse(readFileSync(path.join(directory, launchId + "-trigger.json"), "utf8"));
    expect(trigger.at).toBe(1234);
    expect(trigger.stdio).toHaveLength(4);
    expect(trigger.stdio.every((stream) => !stream.destroyed)).toBe(true);
    expect(report).toHaveBeenCalledTimes(1);
    expect(logEvidence).toHaveBeenCalledWith("windows-natural-exit-open-pipes", expect.objectContaining({ launchId, pid: 77 }));
  });

  it("does no exit query/report for healthy or nonzero exits and survives request-write failure", () => {
    const directory = root();
    const report = vi.fn(() => ({ libuv: [] }));
    const healthy = fake();
    observeWindowsLauncher(healthy, { directory, report });
    for (const stream of healthy.stdio.filter(Boolean)) stream.destroyed = true;
    healthy.emit("exit", 0, null);
    const nonzero = fake();
    observeWindowsLauncher(nonzero, { directory, report });
    nonzero.emit("exit", 1, null);
    expect(readdirSync(directory).filter((name) => name.includes("trigger"))).toEqual([]);
    expect(report).toHaveBeenCalledTimes(2);
    const failed = fake();
    const logEvidence = vi.fn();
    observeWindowsLauncher(failed, { directory, report, logEvidence });
    rmSync(directory, { recursive: true });
    writeFileSync(directory, "occupied");
    expect(() => failed.emit("exit", 0, null)).not.toThrow();
    expect(logEvidence).toHaveBeenCalledWith("windows-pipe-request-error", expect.objectContaining({ kind: "trigger" }));
  });

  it.skipIf(process.platform !== "win32" || process.arch !== "x64")("records native process creation and exit times on Windows", async () => {
    const result = await promisify(execFile)(process.execPath, [path.join(import.meta.dirname, "windows-pipe-diagnostics-probe.mjs")], {
      windowsHide: true, timeout: 25000,
    });
    expect(JSON.parse(result.stdout)).toEqual(expect.objectContaining({ creationIdentityVerified: true, nativeExitTimeVerified: true }));
  });
});
