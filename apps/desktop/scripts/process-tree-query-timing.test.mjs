// TEMPORARY measurement probe for the Windows process-tree query used by
// playwright-shutdown-diagnostics.mjs. It runs inside the Windows
// desktop-main lane so it sees that lane's load, prints timings, and asserts
// nothing. Remove before merge.
import { execFile } from "node:child_process";
import os from "node:os";
import { it } from "vitest";

const select = "Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress";
const projection = "Get-CimInstance -Query 'SELECT ProcessId,ParentProcessId,Name FROM Win32_Process'";
const breakdown = [
  "$t = [Diagnostics.Stopwatch]::StartNew()",
  "Import-Module CimCmdlets; $import = $t.ElapsedMilliseconds; $t.Restart()",
  "$full = @(Get-CimInstance Win32_Process); $fullMs = $t.ElapsedMilliseconds; $t.Restart()",
  `$proj = @(${projection}); $projMs = $t.ElapsedMilliseconds; $t.Restart()`,
  `$null = $full | ${select}; $jsonMs = $t.ElapsedMilliseconds`,
  "@($import, $fullMs, $projMs, $jsonMs, $full.Count) -join ' '",
].join("; ");

function run(command, args) {
  const started = performance.now();
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 60_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      resolve({
        ms: Math.round(performance.now() - started),
        error: error && { killed: error.killed, signal: error.signal, code: error.code, stderr: String(stderr).slice(0, 300) },
        stdout,
      });
    });
  });
}

function summary(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return { n: sorted.length, min: sorted[0], p50: at(0.5), p90: at(0.9), max: sorted.at(-1) };
}

it.runIf(process.platform === "win32")("TEMPORARY: time the Windows process-tree query under lane load", async () => {
  const pwsh = await run("pwsh.exe", ["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"]);
  const variants = {
    current: ["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Get-CimInstance Win32_Process | ${select}`]],
    startup: ["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$null"]],
    projected: ["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `${projection} | ${select}`]],
    breakdown: ["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", breakdown]],
    ...(pwsh.error ? {} : {
      pwshStartup: ["pwsh.exe", ["-NoProfile", "-NonInteractive", "-Command", "$null"]],
      pwshProjected: ["pwsh.exe", ["-NoProfile", "-NonInteractive", "-Command", `${projection} | ${select}`]],
    }),
  };
  const names = Object.keys(variants);
  const samples = Object.fromEntries(names.map((name) => [name, []]));
  const failures = [];
  const inShell = [];
  for (let round = 0; round < 8; round++) {
    for (let i = 0; i < names.length; i++) {
      const name = names[(round + i) % names.length];
      const result = await run(...variants[name]);
      samples[name].push(result.ms);
      if (result.error) failures.push({ name, round, ms: result.ms, ...result.error });
      else if (name === "breakdown") inShell.push(result.stdout.trim());
    }
  }
  process.stderr.write(`[tree-timing] ${JSON.stringify({
    cpus: os.availableParallelism(), pwsh: pwsh.error ? null : pwsh.stdout.trim(),
    wallMs: Object.fromEntries(names.map((name) => [name, summary(samples[name])])),
    rawMs: samples, inShellImportFullProjJsonCount: inShell, failures,
  })}\n`);
}, 300_000);
