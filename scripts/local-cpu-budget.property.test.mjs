import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildBudgetThreadEnv,
  DEFAULT_LOCAL_CPU_BUDGET,
  hasCliFlag,
  resolveLocalCpuBudget,
  splitTypedLintBudget,
} from "./local-cpu-budget.mjs";

/**
 * Rule: when a thread holds an active machine CPU checkout, local repo commands
 * run in that thread's worktree automatically cap their worker/thread count to
 * the granted units unless explicitly overridden by CLI flags, env vars, or CI.
 *
 * Pre-fix failure mode: `vitest.workspace.mts` left `maxWorkers` undefined, so
 * an agent running `npx vitest run --config vitest.workspace.mts ...` without
 * `--maxWorkers=4` defaulted to `availableParallelism() - 1` (17 workers inside
 * one `node` process on an 18-core host) even while holding a 4-CPU checkout.
 */

const tempDirs = [];

function makeTempDir(prefix) {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

function writeBudgetSnapshot(pwragentRoot, profile, grants, capacity = 18) {
  const dir = path.join(pwragentRoot, "runtime", "machine-cpu-budgets");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, `${profile}.json`),
    JSON.stringify({
      version: 1,
      instanceId: `inst-${profile}`,
      profile,
      capacity,
      updatedAt: 1_000,
      grants,
    }),
    "utf8",
  );
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("local CPU budget resolution", () => {
  it("resolves every active worktree grant to its exact units and ignores unrelated or expired grants", () => {
    const dirSegmentArb = fc.stringMatching(/^[a-z0-9]{2,8}$/);
    fc.assert(fc.property(
      fc.integer({ min: 1, max: 32 }),
      fc.integer({ min: 1, max: 32 }),
      dirSegmentArb,
      dirSegmentArb,
      dirSegmentArb,
      fc.integer({ min: 100, max: 100_000 }),
      (targetUnits, otherUnits, targetName, otherName, subName, now) => {
        fc.pre(targetName !== otherName);
        const root = makeTempDir("pwragent-budget-prop-");
        const worktrees = path.join(root, "worktrees");
        const targetWorktree = path.join(worktrees, targetName);
        const nestedDir = path.join(targetWorktree, subName);
        const otherWorktree = path.join(worktrees, otherName);
        mkdirSync(nestedDir, { recursive: true });
        mkdirSync(otherWorktree, { recursive: true });

        writeBudgetSnapshot(root, "default", [
          {
            allocationId: "alloc-target",
            units: targetUnits,
            deadlineAt: now + 60_000,
            backend: "claude",
            threadId: "t-target",
            directories: [targetWorktree],
          },
          {
            allocationId: "alloc-other",
            units: otherUnits,
            deadlineAt: now + 60_000,
            backend: "codex",
            threadId: "t-other",
            directories: [otherWorktree],
          },
          {
            allocationId: "alloc-expired",
            units: 1,
            deadlineAt: now,
            backend: "claude",
            threadId: "t-expired",
            directories: [targetWorktree],
          },
        ]);

        const env = { PWRAGENT_HOME: root };
        const expectedDefault = Math.min(DEFAULT_LOCAL_CPU_BUDGET, Math.max(1, os.availableParallelism()));
        expect(resolveLocalCpuBudget({ cwd: targetWorktree, env, now })?.units).toBe(targetUnits);
        expect(resolveLocalCpuBudget({ cwd: nestedDir, env, now })?.units).toBe(targetUnits);
        expect(resolveLocalCpuBudget({ cwd: otherWorktree, env, now })?.units).toBe(otherUnits);
        expect(resolveLocalCpuBudget({ cwd: worktrees, env, now })).toEqual({ units: expectedDefault, source: "default" });
        expect(resolveLocalCpuBudget({ cwd: worktrees, env, now, fallback: null })).toBeUndefined();
        expect(resolveLocalCpuBudget({ cwd: targetWorktree, env: { ...env, CI: "true" }, now })).toBeUndefined();
      },
    ), { numRuns: 40 });
  });

  it("prefers deepest matching directory, uses minimum on same-directory overlap, and honors exact thread match", () => {
    fc.assert(fc.property(
      fc.integer({ min: 1, max: 16 }),
      fc.integer({ min: 1, max: 16 }),
      fc.integer({ min: 1, max: 16 }),
      (parentUnits, childUnitsA, childUnitsB) => {
        const root = makeTempDir("pwragent-budget-depth-");
        const parentDir = path.join(root, "repo");
        const childDir = path.join(parentDir, "sub");
        mkdirSync(childDir, { recursive: true });
        const now = 5_000;

        writeBudgetSnapshot(root, "default", [
          {
            allocationId: "alloc-parent",
            units: parentUnits,
            deadlineAt: now + 10_000,
            backend: "codex",
            threadId: "t-parent",
            directories: [parentDir],
          },
          {
            allocationId: "alloc-child-a",
            units: childUnitsA,
            deadlineAt: now + 10_000,
            backend: "claude",
            threadId: "t-a",
            directories: [childDir],
          },
          {
            allocationId: "alloc-child-b",
            units: childUnitsB,
            deadlineAt: now + 10_000,
            backend: "claude",
            threadId: "t-b",
            directories: [childDir],
          },
        ]);

        const baseEnv = { PWRAGENT_HOME: root };
        // Without thread identity, deepest matching directory wins and overlap takes the minimum.
        expect(resolveLocalCpuBudget({ cwd: childDir, env: baseEnv, now })?.units).toBe(
          Math.min(childUnitsA, childUnitsB),
        );
        // With thread identity, the calling thread's own grant wins even on shared directories.
        expect(resolveLocalCpuBudget({
          cwd: childDir,
          env: { ...baseEnv, PWRAGENT_BACKEND: "claude", PWRAGENT_THREAD_ID: "t-a" },
          now,
        })?.units).toBe(childUnitsA);
        expect(resolveLocalCpuBudget({
          cwd: childDir,
          env: { ...baseEnv, PWRAGENT_BACKEND: "claude", PWRAGENT_THREAD_ID: "t-b" },
          now,
        })?.units).toBe(childUnitsB);
        // An explicitly identified thread without its own grant must never inherit
        // another thread's directory checkout.
        expect(resolveLocalCpuBudget({
          cwd: childDir,
          env: { ...baseEnv, PWRAGENT_BACKEND: "claude", PWRAGENT_THREAD_ID: "t-unreserved" },
          now,
          fallback: null,
        })).toBeUndefined();
      },
    ), { numRuns: 40 });
  });

  it("matches subdirectories whose names begin with '..' and respects explicit platform paths", () => {
    const root = makeTempDir("pwragent-budget-dotdot-");
    const worktree = path.join(root, "wt");
    const dotdotSubdir = path.join(worktree, "..cache", "nested");
    const siblingDir = path.join(root, "wt-other");
    mkdirSync(dotdotSubdir, { recursive: true });
    mkdirSync(siblingDir, { recursive: true });
    const now = 5_000;

    writeBudgetSnapshot(root, "default", [
      {
        allocationId: "alloc-dotdot",
        units: 6,
        deadlineAt: now + 10_000,
        backend: "codex",
        threadId: "t-dotdot",
        directories: [worktree],
      },
      {
        allocationId: "alloc-win",
        units: 5,
        deadlineAt: now + 10_000,
        backend: "codex",
        threadId: "t-win",
        directories: ["C:\\Users\\Dev\\Worktrees\\Repo"],
      },
    ]);

    const env = { PWRAGENT_HOME: root };
    expect(resolveLocalCpuBudget({ cwd: dotdotSubdir, env, now, fallback: null })?.units).toBe(6);
    expect(resolveLocalCpuBudget({ cwd: siblingDir, env, now, fallback: null })).toBeUndefined();
    expect(resolveLocalCpuBudget({
      cwd: "c:\\users\\dev\\worktrees\\repo\\..cache\\sub",
      env,
      now,
      platform: "win32",
      fallback: null,
    })?.units).toBe(5);
    expect(resolveLocalCpuBudget({
      cwd: "c:\\users\\dev\\worktrees\\other",
      env,
      now,
      platform: "win32",
      fallback: null,
    })).toBeUndefined();
  });

  it("splits typed lint budgets without exceeding units >= 2 and preserves explicit thread env overrides", () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 64 }), (units) => {
      const { oxlintThreads, goMaxProcs } = splitTypedLintBudget(units);
      expect(oxlintThreads).toBeGreaterThanOrEqual(1);
      expect(goMaxProcs).toBeGreaterThanOrEqual(1);
      if (units >= 2) {
        expect(oxlintThreads + goMaxProcs).toBe(units);
      } else {
        expect(oxlintThreads).toBe(1);
        expect(goMaxProcs).toBe(1);
      }

      const overrides = buildBudgetThreadEnv(units, { GOMAXPROCS: "99" });
      expect(overrides.GOMAXPROCS).toBeUndefined();
      expect(overrides.ROLLDOWN_WORKER_THREADS).toBe(String(units));
      expect(overrides.TOKIO_WORKER_THREADS).toBe(String(units));
      expect(overrides.RAYON_NUM_THREADS).toBe(String(units));
      expect(overrides.UV_THREADPOOL_SIZE).toBe(String(units));
    }));
  });

  it("detects CLI worker flags in all supported spellings", () => {
    expect(hasCliFlag(["--maxWorkers=4"], ["--maxWorkers"])).toBe(true);
    expect(hasCliFlag(["--max-workers", "4"], ["--maxWorkers", "--max-workers"])).toBe(true);
    expect(hasCliFlag(["--no-file-parallelism"], ["--no-file-parallelism"])).toBe(true);
    expect(hasCliFlag(["--project", "shared"], ["--maxWorkers", "--max-workers"])).toBe(false);
  });
});
