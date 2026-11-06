import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ancestry, bindPipeNames, exactLauncherPipes, HANDLE_INVENTORY_OPTIONS, launcherParentMatches, normalizePipeName, parseHandleOutput, observeWindowsLauncher, packageManagerCommand } from "./windows-pipe-observation.mjs";
import { localSymbolDirectories, nativeDebuggerStatus, nativeProbeFailure, nativeStackArguments, parseNativeStacks, verifiedNativeStack } from "./windows-native-stack.mjs";

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function root() { const value = mkdtempSync(path.join(os.tmpdir(), "pwragent-native-pipes-")); roots.push(value); return value; }
const names = [1, 2, 3, 4].map((n) => "\\Device\\NamedPipe\\uv\\" + n + "-123");
const inventory = () => ({ verified: true, liveAfter: true, pipes: names.map((name) => ({ name })) });

describe("Windows natural pipe evidence", () => {
  it("binds a launcher through native parent creation when the JavaScript clock lags", () => {
    const event = { pid: 77, workerPid: 7, at: 1000 };
    const source = { pid: 77, created: "116444736010042220", verified: true, liveAfter: true };
    const child = { pid: 77, created: source.created, ppid: 7,
      parentCreated: "116444736009000000", name: "electron.exe" };
    const parent = { pid: 7, created: child.parentCreated };
    expect(BigInt(source.created) > (BigInt(event.at) + 1n) * 10000n + 116444736000000000n).toBe(true);
    expect(launcherParentMatches(event, source, child, parent)).toBe(true);
    for (const changed of [{ verified: false }, { liveAfter: false }, { pid: 78 }, { created: "116444736010042221" }]) {
      expect(launcherParentMatches(event, { ...source, ...changed }, child, parent)).toBe(false);
    }
    for (const changed of [{ ppid: 8 }, { parentCreated: "116444736009000001" }, { name: "node.exe" }]) {
      expect(launcherParentMatches(event, source, { ...child, ...changed }, parent)).toBe(false);
    }
    expect(launcherParentMatches(event, source, child, { ...parent, created: source.created + "0" })).toBe(false);
    expect(launcherParentMatches(event, source, { ...child, parentCreated: source.created + "0" },
      { ...parent, created: source.created + "0" })).toBe(false);
    expect(launcherParentMatches(event, source, child, undefined)).toBe(false);
  });

  it("samples with a non-suspending attach and local symbols, then rejects changed process identities", () => {
    const cache = path.resolve("private-symbol-cache");
    expect(nativeStackArguments(77, cache)).toEqual([
      "-pvr", "-noinh", "-noshell", "-sins", "-netsyms:no",
      "-y", cache, "-p", "77", "-c", "~* kn 40;q",
    ]);
    expect(() => nativeStackArguments(0, cache)).toThrow();
    for (const symbols of ["relative-cache", [], cache + ";srv*https://example.invalid", "\\\\server\\symbols", "//server/symbols"]) {
      expect(() => nativeStackArguments(77, symbols)).toThrow();
    }
    const before = { pid: 77, created: "134381166159731584", verified: true, liveAfter: true };
    const stack = { threads: [{ pid: "4d", frames: [] }] };
    expect(verifiedNativeStack(before, { ...before }, before.created, stack)).toBe(true);
    for (const changed of [
      { created: "134381166159731585" }, { pid: 78 }, { verified: false }, { liveAfter: false },
    ]) {
      expect(verifiedNativeStack(before, { ...before, ...changed }, before.created, stack)).toBe(false);
    }
    expect(verifiedNativeStack(before, before, "134381166159731585", stack)).toBe(false);
    expect(verifiedNativeStack(before, before, before.created, { threads: [{ pid: "4e" }] })).toBe(false);
    expect(verifiedNativeStack(before, before, before.created, { threads: [] })).toBe(false);
  });

  it("finds preloaded PDBs in the symbol-store layout without enabling a symbol server", () => {
    const cache = root();
    const identity = "A".repeat(32) + "1";
    const directory = path.join(cache, "electron.pdb", identity);
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, "electron.pdb"), "controlled PDB placeholder");
    mkdirSync(path.join(cache, "electron.pdb", "B".repeat(32) + "2")); // Incomplete preload.
    mkdirSync(path.join(cache, "unrelated", identity), { recursive: true });
    symlinkSync(path.join(cache, "electron.pdb"), path.join(cache, "linked.pdb"), "junction");
    const symbols = localSymbolDirectories(cache);
    expect(symbols).toEqual([cache, directory]);
    const args = nativeStackArguments(77, symbols);
    expect(args[args.indexOf("-y") + 1]).toBe(cache + ";" + directory);
    expect(args).not.toContain("-pd");
    expect(args.join(" ")).not.toContain("srv*");
  });

  it("retains known preflight failure reasons without exception text or debugger output", () => {
    const triageGuide = "docs/playwright-worker-shutdown-diagnostics.md#controlled-native-debugger-setup-failures";
    const noProgress = { bannerObserved: false, extensionInitializationStarted: false,
      extensionInitializationCompleted: false, commandPromptObserved: false, readinessMarkerObserved: false };
    const output = "cdb: The system does not support detach on exit\nWARNING: Network path disallowed\nC:\\private\\secret.pdb token";
    const error = new Error("Noninvasive debugger exited before readiness");
    error.nativeDebugger = { ...nativeDebuggerStatus(output), exitCode: 0, rawOutput: output };
    const failure = nativeProbeFailure(error);
    expect(failure).toEqual({ reason: "debugger-exited-before-readiness", triageGuide,
      debugger: { exitCode: 0, detachUnsupported: true, networkPathDisallowed: true,
        ...noProgress, outputBytes: Buffer.byteLength(output) } });
    expect(JSON.stringify(failure)).not.toMatch(/private|secret|token|rawOutput/);
    expect(nativeDebuggerStatus("native frames")).toEqual({ detachUnsupported: false, networkPathDisallowed: false,
      ...noProgress, outputBytes: 13 });
    expect(nativeProbeFailure(new Error(output))).toEqual({ reason: "controlled-probe-failed", triageGuide });
    expect(nativeProbeFailure({ nativeDebugger: { exitCode: output, detachUnsupported: output } })).toEqual({
      reason: "controlled-probe-failed", triageGuide, debugger: { exitCode: undefined, detachUnsupported: false, networkPathDisallowed: false,
        ...noProgress, outputBytes: undefined },
    });
  });

  it("retains native stack symbols without debugger paths, arguments or memory", () => {
    const parsed = parseNativeStacks([
      "CommandLine: C:\\private\\secret-command.exe secret-token",
      "*** ERROR: Symbol file could not be found. C:\\private\\secret.pdb",
      ".  0  Id: 1abc.2def Suspend: 0 Teb: 0000000011111111 Unfrozen",
      " # Child-SP          RetAddr           Call Site",
      "00 00000000`11111111 00000000`22222222 ntdll!NtWaitForSingleObject+0x14",
      "01 00000000`11111111 00000000`22222222 electron!base::Thread::Stop+0x73 [C:\\private\\secret.cc @ 15]",
      "02 00000000`11111111 00000000`22222222 electron+0x1234 secret-token",
      "03 00000000`11111111 00000000`22222222 C:\\private\\secret.cc",
      "04 00000000`11111111 00000000`22222222 00000000`33333333",
      "   1  Id: 1abc.3fed Suspend: 0 Teb: 0000000011111111 Unfrozen",
      "00 00000000`11111111 00000000`22222222 KERNELBASE!WaitForMultipleObjectsEx+0xf0",
      "rax=0000000011111111 rbx=secret-token",
    ].join("\n"));
    expect(parsed).toMatchObject({ frameCount: 4, omittedFrames: 2, symbolWarnings: 1, threads: [
      { index: 0, pid: "1abc", tid: "2def", frames: [
        { index: 0, symbol: "ntdll!NtWaitForSingleObject+0x14" },
        { index: 1, symbol: "electron!base::Thread::Stop+0x73" },
        { index: 2, symbol: "electron+0x1234" },
      ] },
      { index: 1, tid: "3fed", frames: [{ index: 0, symbol: "KERNELBASE!WaitForMultipleObjectsEx+0xf0" }] },
    ] });
    expect(JSON.stringify(parsed)).not.toMatch(/private|secret|11111111|22222222|33333333/);
    const bounded = parseNativeStacks(Array.from({ length: 130 }, (_, index) =>
      `   ${index} Id: 1abc.2def Suspend: 0\n` + "00 11111111 22222222 ntdll!Wait+0x1\n".repeat(45)).join("\n"));
    expect(bounded).toMatchObject({ omittedThreads: 2, frameCount: 128 * 40, omittedFrames: 128 * 5 });
    expect(parseNativeStacks("unknown debugger format secret-token").frameCount).toBe(0);
  });

  it("retains exact code offsets for later symbolization without exposing virtual addresses", () => {
    const parsed = parseNativeStacks([
      "start             end                 module name",
      "00000001`00000000 00000001`10000000 electron (export symbols)",
      "00000002`00000000 00000002`01000000 ntdll (export symbols)",
      ". 0 Id: 1abc.2def Suspend: 0 Teb: 00000000`12345678 Unfrozen",
      "00 00000000`12345678 00000001`00000180 ntdll!NtWait+0x14",
      "01 00000000`12345690 00000001`00000240 electron!AmbiguousExport+0x9999",
      "02 00000000`123456a0 00000000`deadbeef electron!AnotherExport+0x8888",
      // A missing row must not associate the preceding return with this row.
      "04 00000000`123456b0 00000001`00000300 ntdll!Wait+0x2",
      "1 Id: 1abc.3fed Suspend: 0",
      "00 00000000`123456c0 00000000`deadbeef ntdll!Wait+0x3",
      "01 00000000`123456d0 00000000`deadbeef 00000000`feedface",
    ].join("\n"), { moduleOffsets: true });
    expect(parsed.threads.map((thread) => thread.frames.map((frame) => frame.symbol))).toEqual([
      ["ntdll!NtWait+0x14", "electron+0x180", "electron+0x240", "ntdll!Wait+0x2"],
      ["ntdll!Wait+0x3"],
    ]);
    expect(JSON.stringify(parsed)).not.toMatch(/123456|deadbeef|feedface|00000001|AmbiguousExport|AnotherExport/);
    expect(parsed.omittedFrames).toBe(1);
  });

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
    expect(bindPipeNames(before, { ...before }, text.replaceAll("File  ", "")).pipes.map((pipe) => pipe.name)).toEqual(names);
    expect(bindPipeNames(before, { ...before }, "Access denied").nameQueryErrorCount).toBe(1);
    expect(bindPipeNames(before, { ...before }, "Access denied")).toMatchObject({ nameQueryStatus: "query-failed", error: expect.any(String) });
    expect(bindPipeNames(before, { ...before, created: "134379500000000001" }, text).error).toBeDefined();
    expect(bindPipeNames(before, { ...before, liveAfter: false }, text).error).toBeDefined();
  });

  it("distinguishes a recognized inventory without uv pipes from unknown output and rejected queries", () => {
    expect(HANDLE_INVENTORY_OPTIONS).toEqual(["-accepteula", "-nobanner", "-a"]);
    const identity = { pid: 77, created: "134379500000000000", verified: true, liveAfter: true };
    const nonPipe = "  58: File          C:\\contrived\\fixture.txt\r\n  2B0: Section       \\contrived\\section\r\n";
    const valid = bindPipeNames(identity, { ...identity }, nonPipe);
    expect(valid).toMatchObject({ nameQueryStatus: "inventory", parsedProcessCount: 1, recognizedHandleCount: 2, pipes: [], verified: true });
    expect(valid.error).toBeUndefined();
    const empty = bindPipeNames(identity, { ...identity }, "No matching handles found.\r\n", { error: { code: 1, killed: false } });
    expect(empty).toMatchObject({ nameQueryStatus: "empty", parsedProcessCount: 0, pipes: [], verified: true });
    expect(empty.error).toBeUndefined();
    for (const [text, status] of [
      ["", "unrecognized"],
      ["FutureHandle,Pid,Object,Name\ncontrived,77,10,synthetic", "unrecognized"],
      ["node.exe pid: 77", "unrecognized"],
      ["usage: handle [[-a] [-p <pid>]] [name]", "usage"],
      ["Error opening process 77: Access denied: C:\\contrived\\private.txt", "query-failed"],
      [nonPipe + "  20: File changed-format \\Device\\NamedPipe\\uv\\1-123", "unrecognized"],
      [nonPipe + "  20: File changed-format \\DEVICE\\NAMEDPIPE\\uv\\1-123", "unrecognized"],
      [nonPipe + "No matching handles found.", "unrecognized"],
    ]) {
      const rejected = bindPipeNames(identity, { ...identity }, text);
      expect(rejected).toMatchObject({ nameQueryStatus: status, error: expect.any(String) });
      expect(rejected.verified).toBeUndefined();
      expect(exactLauncherPipes(names, rejected).names).toBeUndefined();
      expect(JSON.stringify(rejected)).not.toContain("private.txt");
    }
    const text = names.map((name, i) => `  ${i + 16}: File  ${name}`).join("\n");
    for (const query of [{ error: { code: 2 } }, { error: { code: 1, killed: true } }, { stderrBytes: 1 }]) {
      expect(bindPipeNames(identity, { ...identity }, text, query)).toMatchObject({ nameQueryStatus: "query-failed", error: expect.any(String) });
      expect(bindPipeNames(identity, { ...identity }, "No matching handles found.", query).error).toBeDefined();
    }
    expect(bindPipeNames(identity, { ...identity }, text + "\nusage: handle").nameQueryStatus).toBe("usage");
    expect(bindPipeNames(identity, { ...identity }, "node.exe pid: 78\n  10: File  C:\\contrived\\fixture.txt").error).toMatch(/Unexpected PID/);
    expect(bindPipeNames(identity, { ...identity, created: "134379500000000001" }, "No matching handles found.").error).toMatch(/identity/);
  });

  it("parses global search records and rejects substring lookalikes at exact matching", () => {
    const text = names.map((name, i) => "cmd.exe pid: 99 type: File " + (i + 16).toString(16) + ": " + name).join("\n");
    const parsed = parseHandleOutput(text + "\nAccess denied\n");
    expect(parsed.processes).toHaveLength(1);
    expect(parsed.processes[0]).toMatchObject({ pid: 99 });
    expect(parsed.processes[0].pipes.map((pipe) => pipe.name)).toEqual(names);
    expect(parseHandleOutput(text.replaceAll("type: File ", "")).processes[0].pipes.map((pipe) => pipe.name)).toEqual(names);
    expect(parsed.errorCount).toBe(1);
    expect(parsed.status).toBe("query-failed");
    expect(parsed.errors).toEqual(["access-denied"]);
    expect(parseHandleOutput(text).status).toBe("inventory");
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
      windowsHide: true, timeout: 35000,
    });
    const proof = JSON.parse(result.stdout);
    expect(proof).toEqual(expect.objectContaining({
      creationIdentityVerified: true, nativeExitTimeVerified: true,
    }));
    // The owned live process is the oracle: readiness must lead to frames,
    // a moving heartbeat during attach, and survival of cancellation and q.
    if (process.env.PWRAGENT_WINDOWS_CDB_EXE) {
      expect(proof).toMatchObject({ noninvasiveDebuggerVerified: true, debuggerQuitVerified: true });
    }
  }, 40000);
});
