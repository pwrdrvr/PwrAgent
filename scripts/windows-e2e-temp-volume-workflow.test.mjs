import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

// Every Desktop E2E fixture root, Electron profile, state database and
// app-spawned temp file is created under `os.tmpdir()`. On hosted Windows
// that is `C:\Users\runneradmin\AppData\Local\Temp`, on the OS volume, while
// the checkout and `RUNNER_TEMP` are on D:. The OS volume stalls for minutes
// at a time: in the native stacks of stalled Electron closes, 30 of 32 had a
// thread blocked in CreateFile, WriteFile or FlushFileBuffers on fixture
// storage, while the same closes appended to a D: file in a median 61 ms.
// Electron's main process then outlives its quit, holding the launcher pipe.
test("Windows Desktop E2E keeps fixture storage on the runner temp volume", () => {
  const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const job = workflow.split(/\n  (?=[\w-]+:\n)/).find((block) => block.startsWith("windows-e2e:"));
  expect(job).toBeDefined();
  const testSteps = job.split("\n      - ").filter((step) => /\btest:desktop-e2e\b/.test(step));
  expect(testSteps).toHaveLength(1);
  // Node reads TEMP and TMP on Windows; Electron and every child inherit them.
  expect(testSteps[0]).toMatch(/^ {10}TEMP: \$\{\{ runner\.temp \}\}$/m);
  expect(testSteps[0]).toMatch(/^ {10}TMP: \$\{\{ runner\.temp \}\}$/m);
});

// CDB's startup loads its engine and extension packages from its install
// directory inside the controlled probe's 5 s readiness check. Run from
// C:\Program Files (x86), 30 of 227 hosted startups missed it, stalled at
// different stages (no output, mid Extension Gallery, before the prompt).
test.each(["ci.yml", "windows-native-quit-repro.yml"])(
  "%s runs CDB from a copy on the runner temp volume",
  (name) => {
    const workflow = readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8");
    const steps = workflow.split("\n      - ").filter((step) => step.includes("PWRAGENT_WINDOWS_CDB_EXE="));
    expect(steps.length).toBeGreaterThan(0);
    for (const step of steps) {
      const assignments = new Map(
        [...step.matchAll(/^\s*\$(\w+) = Join-Path (\S+) "[^"]+"\s*$/gm)].map((match) => [match[1], match[2]]),
      );
      let value = step.match(/"PWRAGENT_WINDOWS_CDB_EXE=\$(\w+)"/)?.[1];
      expect(value).toBeDefined();
      const seen = new Set();
      while (assignments.has(value) && !seen.has(value)) {
        seen.add(value);
        value = assignments.get(value).replace(/^\$/, "");
      }
      expect(value).toBe("env:RUNNER_TEMP");
      expect(step).toMatch(/Copy-Item -LiteralPath \(Join-Path \$\{env:ProgramFiles\(x86\)\} "Windows Kits\\10\\Debuggers\\x64"\)/);
    }
  },
);
