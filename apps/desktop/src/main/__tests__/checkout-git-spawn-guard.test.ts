// Self-test for the suite-wide guard in `setup/checkout-git-spawn-guard.ts`.
//
// The rule: no desktop-main test runs Git against the repository checkout the
// suite runs in. Reading a whole working tree costs about a second per call on
// a CI runner and well under 100 ms on a warm local worktree, so a test that
// does it is slow and flaky on CI only, and it asserts against whatever state
// the checkout happens to be in.
//
// The guard is loaded as a `desktop-main` setup file, so it is already active
// here. Tests that trip it on purpose drain its record before its `afterEach`
// reads it.
import { execFile as execFileCallback } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { checkoutGitTarget, gitRepositoryTargets } from "./setup/checkout-git-spawn";

const execFile = promisify(execFileCallback);

const VIOLATIONS = Symbol.for("pwragent.checkoutGitSpawnGuard.violations");
const REPOSITORY_ROOT = realpathSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../.."),
);

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("checkout Git spawn guard", () => {
  it("blocks Git aimed at the checkout with -C", async () => {
    const error = await captureSpawnError(() =>
      execFile("git", ["-C", REPOSITORY_ROOT, "status", "--porcelain"]));

    expect(error.message).toContain("status --porcelain");
    expect(drainViolations()).toEqual([
      expect.objectContaining({ target: REPOSITORY_ROOT }),
    ]);
  });

  it("blocks Git started inside the checkout without -C", async () => {
    const directory = path.join(REPOSITORY_ROOT, "apps", "desktop");

    await captureSpawnError(() =>
      execFile("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: directory }));

    expect(drainViolations()).toEqual([
      expect.objectContaining({ target: directory }),
    ]);
  });

  it("allows Git in a temporary repository and Git that opens no repository", async () => {
    const directory = makeTempDir();
    await execFile("git", ["init", "--quiet", directory]);
    await execFile("git", ["-C", directory, "status", "--porcelain"]);
    await execFile("git", ["--version"], { cwd: REPOSITORY_ROOT });

    expect(drainViolations()).toEqual([]);
  });

  // `init` and `clone` write a repository instead of opening the one they
  // start in, so a fixture may create one from the suite's own cwd.
  it("follows init and clone to the directory they write", () => {
    const target = (args: string[]) => checkoutGitTarget(
      { args: ["git", ...args], cwd: REPOSITORY_ROOT, file: "git" },
      { parentCwd: REPOSITORY_ROOT, repositoryRoot: REPOSITORY_ROOT, resolve: (entry) => entry },
    );
    const outside = path.join(os.tmpdir(), "fixture-repo");

    expect(target(["init", "--initial-branch=main", outside])).toBeUndefined();
    expect(target(["clone", "--branch", "main", outside, `${outside}-clone`])).toBeUndefined();
    expect(target(["init"])).toBe(REPOSITORY_ROOT);
    expect(target(["init", "nested"])).toBe(path.join(REPOSITORY_ROOT, "nested"));
  });

  // Oracle: Git itself decides which repository a launch opens. In a tree of
  // temporary directories holding one repository that stands in for the
  // checkout, the classifier must flag exactly the launches whose
  // `rev-parse --show-toplevel` Git answers with that repository.
  it("flags exactly the launches Git resolves into the checkout", async () => {
    const tree = makeTempDir();
    const checkout = path.join(tree, "checkout");
    const directories = [
      tree,
      checkout,
      path.join(checkout, "apps"),
      path.join(checkout, "apps", "desktop"),
      path.join(tree, "elsewhere"),
      path.join(tree, "elsewhere", "nested"),
    ];
    for (const directory of directories) {
      mkdirSync(directory, { recursive: true });
    }
    await execFile("git", ["init", "--quiet", checkout]);
    // Native, so a Windows runner's 8.3 temp path (`RUNNER~1`) and Git's
    // `C:/…` spelling both come back in one long, backslashed form.
    const resolve = (target: string) => {
      try {
        return realpathSync.native(target);
      } catch {
        return target;
      }
    };
    const fold = (value: string | undefined) =>
      process.platform === "win32" ? value?.toLowerCase() : value;
    const root = resolve(checkout);
    // Git must not walk above the tree into whatever holds the temp dir.
    const env = { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(tree) };

    const directoryArb = fc.constantFrom(...directories);
    const relativeArb = fc.constantFrom(".", "..", "apps", "desktop", "nested", "elsewhere", "checkout");
    const globalArb = fc.oneof(
      fc.record({ kind: fc.constant("C-absolute" as const), value: directoryArb }),
      fc.record({ kind: fc.constant("C-relative" as const), value: relativeArb }),
      fc.record({ kind: fc.constant("config" as const), value: fc.constant("core.quotePath=false") }),
      fc.record({ kind: fc.constant("flag" as const), value: fc.constant("--no-optional-locks") }),
    );

    await fc.assert(fc.asyncProperty(
      directoryArb,
      fc.array(globalArb, { maxLength: 4 }),
      async (cwd, globals) => {
        const options = globals.flatMap((option) => {
          switch (option.kind) {
            case "C-absolute":
            case "C-relative":
              return ["-C", option.value];
            case "config":
              return ["-c", option.value];
            case "flag":
              return [option.value];
          }
        });
        const args = [...options, "rev-parse", "--show-toplevel"];
        const toplevel = await execFile("git", args, { cwd, env })
          .then(({ stdout }) => resolve(stdout.trim()))
          .catch((error: { stderr?: string }) =>
            (error.stderr ?? "").includes("cannot change to") ? "missing" : undefined);
        // A -C into a directory that does not exist opens nothing, so Git
        // has no answer to compare with.
        fc.pre(toplevel !== "missing");

        const flagged = checkoutGitTarget(
          { args: ["git", ...args], cwd, file: "git" },
          { parentCwd: process.cwd(), repositoryRoot: root, resolve },
        );

        expect(flagged !== undefined).toBe(fold(toplevel) === fold(root));
      },
    ), { numRuns: 60 });
  });

  it("never flags a launch that is not Git", () => {
    fc.assert(fc.property(
      fc.constantFrom("node", "/bin/echo", "gitk", "legit", "C:\\Git\\bin\\bash.exe"),
      fc.array(fc.constantFrom("-C", REPOSITORY_ROOT, "status", "git"), { maxLength: 6 }),
      (file, rest) => {
        expect(gitRepositoryTargets({ args: [file, ...rest], cwd: REPOSITORY_ROOT, file }, REPOSITORY_ROOT))
          .toEqual([]);
      },
    ));
  });
});

/**
 * The guard throws from inside `ChildProcess.prototype.spawn`, and
 * `execFile`'s promisifier calls through outside its promise executor, so the
 * throw arrives synchronously. See `agent-cli-spawn-guard.test.ts`.
 */
async function captureSpawnError(spawn: () => Promise<unknown>): Promise<Error> {
  try {
    await spawn();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the guard to block this spawn");
}

/** Consumes the guard's record so its own `afterEach` sees a clean slate. */
function drainViolations(): { args: string[]; target: string }[] {
  const recorded = (globalThis as Record<symbol, unknown>)[VIOLATIONS] as
    | { args: string[]; target: string }[]
    | undefined;
  return recorded?.splice(0) ?? [];
}

function makeTempDir(): string {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "pwragent-checkout-git-"));
  tempDirs.push(tempDir);
  return tempDir;
}
