// Fails any test that runs Git against the repository checkout the suite runs
// in. A test whose subject is not Git gets a temporary directory or an
// injected `gitWorkingStateService` / `gitDirectoryService`; a test whose
// subject is Git builds its own repository under the OS temp dir.
//
// Reading the checkout is the slow, CI-only kind of flaky. One
// `get_thread_status` on a thread started in `process.cwd()` read its working
// state with ten Git commands across the whole tree (`diff --numstat HEAD`,
// `status --porcelain`, `for-each-ref … ahead-behind`, `merge-base`,
// `rev-list`, …): about a second per call on a GitHub runner, under 100 ms on
// a warm local worktree. A property test did it 30 times and timed out on CI
// only (#3687). `startThread` also runs `git rev-parse --abbrev-ref HEAD`
// whenever the head-branch file probe cannot prove the layout, which a linked
// worktree — the usual checkout here — is enough to cause. The results also
// depend on whatever the checkout's branch and working tree happen to be.
//
// Like `agent-cli-spawn-guard.ts`, the hook is `ChildProcess.prototype.spawn`:
// every async launch funnels through it, however a module imported
// `child_process`. Production Git always launches asynchronously as
// `git -C <directory> …` from the temp dir; `checkout-git-spawn.ts` also
// follows a plain `cwd`, relative and chained `-C`, `--git-dir` and
// `--work-tree`. Sync launches (`execFileSync`) are not covered.
//
// It records and throws. The throw keeps Git from starting; the record fails
// the test, because callers such as the working-state reader catch a failed
// command and carry on.
import { ChildProcess } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach } from "vitest";
import { checkoutGitTarget } from "./checkout-git-spawn";

/** This file sits at `apps/desktop/src/main/__tests__/setup/`. */
const REPOSITORY_ROOT = realpathOrSelf(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../../.."),
);

type SpawnOptions = { args?: string[]; cwd?: string; file?: string };

/** `ChildProcess#spawn` is internal to Node and absent from `@types/node`. */
type SpawnableChildProcess = ChildProcess & {
  spawn: (options: SpawnOptions) => unknown;
};

type Violation = { args: string[]; target: string };

const INSTALLED = Symbol.for("pwragent.checkoutGitSpawnGuard.installed");
const VIOLATIONS = Symbol.for("pwragent.checkoutGitSpawnGuard.violations");

type GuardGlobal = typeof globalThis & {
  [INSTALLED]?: true;
  [VIOLATIONS]?: Violation[];
};

const guardGlobal = globalThis as GuardGlobal;
const violations: Violation[] = (guardGlobal[VIOLATIONS] ??= []);

// Setup files re-run for every test file in a worker, but the builtin
// prototype is shared across all of them — patch it exactly once.
if (guardGlobal[INSTALLED] !== true) {
  guardGlobal[INSTALLED] = true;
  const prototype = ChildProcess.prototype as SpawnableChildProcess;
  const original = prototype.spawn;
  prototype.spawn = function guardedSpawn(
    this: SpawnableChildProcess,
    options: SpawnOptions,
  ) {
    const args = options?.args ?? [];
    const target = checkoutGitTarget(
      { args, cwd: options?.cwd, file: options?.file ?? "" },
      { parentCwd: process.cwd(), repositoryRoot: REPOSITORY_ROOT, resolve: realpathOrSelf },
    );
    if (target !== undefined) {
      const violation: Violation = { args, target };
      violations.push(violation);
      throw new Error(describeViolation(violation));
    }
    return original.call(this, options);
  };
}

afterEach(() => {
  reportRecordedViolations("This test");
});

// A launch from `afterAll`, or from work that settles after the last test,
// would otherwise sit unread in the record.
afterAll(() => {
  reportRecordedViolations("This test file, after its last test,");
});

function reportRecordedViolations(subject: string): void {
  const observed = violations.splice(0);
  if (observed.length > 0) {
    // A property test repeats the same launch once per run.
    const counts = new Map<string, number>();
    for (const violation of observed) {
      const line = describeViolation(violation);
      counts.set(line, (counts.get(line) ?? 0) + 1);
    }
    throw new Error(
      [
        `${subject} ran Git against the repository checkout ${observed.length} time(s):`,
        ...[...counts].map(([line, count]) => `  ${line}${count > 1 ? ` ×${count}` : ""}`),
        "Give the thread a temporary directory, or inject gitWorkingStateService /",
        "gitDirectoryService. A test of Git itself builds its own repository under",
        "the OS temp dir. See apps/desktop/src/main/__tests__/setup/checkout-git-spawn-guard.ts.",
      ].join("\n"),
    );
  }
}

function realpathOrSelf(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    return target;
  }
}

function describeViolation(violation: Violation): string {
  return `git ${violation.args.slice(1).join(" ")} (in ${violation.target})`;
}
