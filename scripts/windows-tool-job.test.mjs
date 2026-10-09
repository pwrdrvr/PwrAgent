import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { prepareWindowsToolJob } from "./windows-tool-job.mjs";

describe("Windows atomic tool ownership", () => {
  it("keeps arguments out of executable PowerShell source and uses a cancellation marker", async () => {
    const job = prepareWindowsToolJob("node", ["-e", 'console.log("quoted $value")', "C:\\path with spaces\\"], {
      env: { ...process.env, SystemRoot: "C:\\Windows" }, cwd: process.cwd(),
    });
    try {
      expect(job.command).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
      expect(job.args.join(" ")).not.toContain("quoted");
      const bridgeArgs = JSON.parse(Buffer.from(job.env.PWR_TOOLS_JOB_ARGUMENTS, "base64").toString());
      expect(JSON.parse(Buffer.from(bridgeArgs[1], "base64").toString())).toEqual({ command: "node", args: ["-e", 'console.log("quoted $value")', "C:\\path with spaces\\"] });
      job.cancel();
      expect(await readFile(job.env.PWR_TOOLS_JOB_CANCEL, "utf8")).toBe("cancel");
    } finally { job.cleanup(); }
  });

  it("requires a known system PowerShell executable", () => {
    expect(() => prepareWindowsToolJob("node", [], { env: {}, cwd: process.cwd() })).toThrow("SystemRoot");
  });

  it("assigns the native process while suspended, waits for an empty Job, and never uses taskkill", async () => {
    const source = await readFile(new URL("./windows-tool-job.ps1", import.meta.url), "utf8");
    const launch = source.slice(source.indexOf("public static int Run"));
    expect(launch.indexOf("CREATE_SUSPENDED | CREATE_NO_WINDOW")).toBeLessThan(launch.indexOf("AssignProcessToJobObject(job"));
    expect(launch.indexOf("AssignProcessToJobObject(job")).toBeLessThan(launch.indexOf("ResumeThread(processInformation"));
    expect(launch).toContain("while (ReadActiveProcessCount(job) > 0)");
    expect(launch).toContain("TerminateJobObject(job, 130)");
    expect(launch).toContain("OpenProcess(0x00100000, false, ownerPid)");
    expect(source).not.toContain("taskkill");
  }, 30_000);

  it.skipIf(process.platform !== "win32")("passes native Node arguments, stdio, and nonzero exits through the Job", async () => {
    const job = prepareWindowsToolJob(process.execPath, ["-e", "console.log(JSON.stringify(process.argv.slice(1)));process.exitCode=7", "--", "spaces & \"quotes\"", "C:\\ending\\"], {
      env: process.env, cwd: process.cwd(),
    });
    try {
      const child = spawn(job.command, job.args, { env: job.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      let stdout = "";
      child.stdout.on("data", (data) => { stdout += data; });
      const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
      expect(code).toBe(7);
      expect(JSON.parse(stdout)).toEqual(["spaces & \"quotes\"", "C:\\ending\\"]);
    } finally { job.cleanup(); }
  }, 30_000);

  it.skipIf(process.platform !== "win32")("drains persistent descendants on cancellation before the helper returns", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "pwragent-job-test-"));
    const marker = path.join(directory, "pid");
    const code = `const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('fs').writeFileSync(${JSON.stringify(marker)},String(c.pid));setInterval(()=>{},1000)`;
    const job = prepareWindowsToolJob(process.execPath, ["-e", code], { env: process.env, cwd: directory });
    const child = spawn(job.command, job.args, { env: job.env, stdio: "ignore", windowsHide: true });
    const done = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    try {
      let pid;
      for (let i = 0; i < 250; i++) {
        try { pid = Number(await readFile(marker, "utf8")); break; } catch { await delay(50); }
      }
      expect(pid).toBeGreaterThan(0);
      job.cancel();
      expect(await done).toBe(130);
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      job.cancel();
      await done;
      job.cleanup();
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it.skipIf(process.platform !== "win32")("terminates every descendant when the Node lease owner dies", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "pwragent-job-owner-"));
    const marker = path.join(directory, "pid");
    const stateFile = path.join(directory, "job-state");
    const driver = path.join(directory, "owner.mjs");
    const task = `const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('fs').writeFileSync(${JSON.stringify(marker)},String(c.pid));setInterval(()=>{},1000)`;
    await writeFile(driver, `import {spawn} from 'node:child_process';import fs from 'node:fs';import {prepareWindowsToolJob} from ${JSON.stringify(new URL("./windows-tool-job.mjs", import.meta.url).href)};const job=prepareWindowsToolJob(process.execPath,['-e',${JSON.stringify(task)}],{env:process.env,cwd:${JSON.stringify(directory)}});fs.writeFileSync(${JSON.stringify(stateFile)},job.env.PWR_TOOLS_JOB_CANCEL);spawn(job.command,job.args,{env:job.env,stdio:'inherit',windowsHide:true});setInterval(()=>{},1000);`);
    const owner = spawn(process.execPath, [driver], { stdio: ["ignore", "pipe", "pipe"] });
    const done = new Promise((resolve, reject) => { owner.once("error", reject); owner.once("close", resolve); });
    owner.stdout.resume(); owner.stderr.resume();
    let state;
    try {
      let pid;
      for (let i = 0; i < 250; i++) {
        try { pid = Number(await readFile(marker, "utf8")); break; } catch { await delay(50); }
      }
      expect(pid).toBeGreaterThan(0);
      state = await readFile(stateFile, "utf8");
      owner.kill("SIGKILL");
      await done;
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      owner.kill("SIGKILL");
      await done;
      if (state) await rm(path.dirname(state), { recursive: true, force: true });
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
});

it.skipIf(process.platform !== "win32")("preserves .cmd shim arguments with spaces, quotes and shell metacharacters", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pwragent-job-argv-"));
  const bin = path.join(directory, "node_modules", ".bin");
  await mkdir(bin, { recursive: true });
  const entry = path.join(directory, "echo-args.cjs");
  const shim = path.join(bin, "fixture.cmd");
  await writeFile(entry, "console.log(JSON.stringify(process.argv.slice(2))); process.exitCode = 7;\n");
  await writeFile(shim, `@echo off\r\n"${process.execPath}" "${entry}" %*\r\n`);
  const args = ["two words", 'quotes "inside" & pipes | safe', "C:\\ending\\"];
  const job = prepareWindowsToolJob(shim, args, { env: process.env, cwd: directory });
  try {
    const child = spawn(job.command, job.args, { env: job.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    expect(code, stderr).toBe(7);
    expect(JSON.parse(stdout)).toEqual(args);
  } finally { job.cleanup(); await rm(directory, { recursive: true, force: true }); }
}, 30_000);
