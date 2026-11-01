// Pay the native typed-lint backend's first execution once per run, before any
// test file starts, instead of billing it to `lint-typed.test.mjs`.
//
// That test spawns oxlint, which loads its native binding and then runs the
// tsgolint executable: 12 MB and 22 MB of ad-hoc signed Mach-O. On macOS the
// kernel and system policy validate a binary file the first time it runs, and
// the macOS CI lane reinstalls node_modules for every job (`git clean -ffdx`,
// then pnpm imports every package again), so every job ran fresh copies.
//
// Measured for the same one-file fixture: 49 to 85 ms warm on an idle
// 4-core macOS 15 guest, and 262 ms on Ubuntu, against 1,509 to 11,950 ms in
// 29 macOS unit lanes on 2026-11-01. Three of those exceeded the test's
// 5,000 ms timeout. A byte-identical copy of tsgolint took 13 to 19 ms for
// its first exec and 4 ms after on macOS 15, and 220 ms against 1 ms on a
// newer host; Linux showed no difference.
//
// The warm runs both binaries in child processes. It loads no native code into
// the Vitest host, and the test still runs the real backend on its own fixture.
// It adds no retry, no timeout headroom, and no serialization.
import { spawnSync } from "node:child_process";
import { writeSync } from "node:fs";
import { oxlintBin, tsgolintExecutable } from "./oxlint.mjs";

function warm(label, command, args) {
  const started = performance.now();
  const result = spawnSync(command, args, { stdio: "ignore", timeout: 120_000 });
  if (result.error) throw result.error;
  // Written directly: compare this cold cost with the test's own
  // `[native-typed-lint]` launch phase in the same log.
  writeSync(2, `[native-typed-lint-prewarm] ${JSON.stringify({
    label,
    ms: Math.round(performance.now() - started),
    status: result.status,
  })}\n`);
}

export default function setup() {
  // Warming is an optimization. A failure must not fail the run; the test
  // then pays the cold start as it did before, and says so here.
  try {
    warm("oxlint-binding", process.execPath, [oxlintBin(), "--version"]);
    warm("tsgolint", tsgolintExecutable(), ["-h"]);
  } catch (error) {
    console.warn(`[native-typed-lint-prewarm] skipped; the typed-lint test will pay the cold start: ${
      error instanceof Error ? error.message : String(error)
    }`);
  }
}
