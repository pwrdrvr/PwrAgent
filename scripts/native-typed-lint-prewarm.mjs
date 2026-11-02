// Pay the native typed-lint backend's first execution once per run, before any
// test file starts, instead of billing it to `lint-typed.test.mjs`.
//
// That test spawns oxlint, which loads its native binding and then runs the
// tsgolint executable: 12 MB and 22 MB of ad-hoc signed Mach-O. On macOS the
// kernel and system policy validate a binary file the first time it runs, and
// every macOS CI job starts with a fresh install of node_modules, so every job
// ran new copies of both inside the test.
//
// Measured for the same one-file fixture: 49 to 85 ms warm on an idle
// 4-core macOS 15 guest, and 262 ms on Ubuntu, against 1,509 to 11,950 ms in
// 29 self-hosted macOS unit lanes on 2026-11-01. Three of those exceeded the
// test's then 5,000 ms timeout. A byte-identical copy of tsgolint took 13 to
// 19 ms for its first exec and 4 ms after on macOS 15, and 220 ms against 1 ms
// on a newer host; Linux showed no difference. On GitHub-hosted macos-26 this
// warm took 93 and 105 ms, and the test's launch 437 ms.
//
// The warm runs both binaries in child processes. It loads no native code into
// the Vitest host, and the test still runs the real backend on its own fixture.
// It adds no retry, no timeout headroom, and no serialization.
import { execFile } from "node:child_process";
import { writeSync } from "node:fs";
import { oxlintBin, tsgolintExecutable } from "./oxlint.mjs";

function warm(label, resolveCommand) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const [command, args] = resolveCommand();
    execFile(command, args, { timeout: 120_000 }, (error) => {
      // A non-zero exit still ran the binary, which is all the warm needs.
      if (error && typeof error.code !== "number") {
        reject(error);
        return;
      }
      // Written directly: compare this cold cost with the test's own
      // `[native-typed-lint]` launch phase in the same log.
      writeSync(2, `[native-typed-lint-prewarm] ${JSON.stringify({
        label,
        ms: Math.round(performance.now() - started),
        status: error ? error.code : 0,
      })}\n`);
      resolve();
    });
  });
}

export default async function setup() {
  // Warming is an optimization. A failure must not fail the run; the test
  // then pays that cold start as it did before, and says so here. The two
  // binaries are independent, so each warms on its own.
  const steps = [
    ["oxlint-binding", () => [process.execPath, [oxlintBin(), "--version"]]],
    ["tsgolint", () => [tsgolintExecutable(), ["-h"]]],
  ];
  // A resolver that throws rejects only its own step: warm's executor catches it.
  const results = await Promise.allSettled(steps.map(([label, resolveCommand]) => warm(label, resolveCommand)));
  results.forEach((result, index) => {
    if (result.status === "rejected") {
      const error = result.reason;
      console.warn(`[native-typed-lint-prewarm] ${steps[index][0]} skipped; the typed-lint test will pay its cold start: ${
        error instanceof Error ? error.message : String(error)
      }`);
    }
  });
}
