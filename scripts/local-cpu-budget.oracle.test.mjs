import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_LOCAL_CPU_BUDGET } from "./local-cpu-budget.mjs";

const REPOSITORY_ROOT = fileURLToPath(new URL("../", import.meta.url));
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

describe("vitest workspace local CPU budget oracle", () => {
  it("applies the active thread checkout as maxWorkers unless overridden", () => {
    const pwragentRoot = makeTempDir("pwragent-vitest-oracle-");
    writeBudgetSnapshot(pwragentRoot, "default", [
      {
        allocationId: "alloc-vitest",
        units: 3,
        deadlineAt: Date.now() + 300_000,
        backend: "claude",
        threadId: "thread-oracle",
        directories: [REPOSITORY_ROOT],
      },
    ]);

    const probe = (extraArgs, extraEnv = {}) => {
      const env = { ...process.env };
      delete env.CI;
      delete env.VITEST_MAX_WORKERS;
      delete env.PWRAGENT_CPU_BUDGET;
      delete env.PWRAGENT_THREAD_ID;
      delete env.PWRAGENT_BACKEND;
      delete env.ROLLDOWN_WORKER_THREADS;
      delete env.TOKIO_WORKER_THREADS;
      delete env.RAYON_NUM_THREADS;
      delete env.UV_THREADPOOL_SIZE;
      delete env.GOMAXPROCS;
      Object.assign(env, { PWRAGENT_HOME: pwragentRoot, ...extraEnv });
      const result = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          [
            `const mod = await import(${JSON.stringify(new URL("../vitest.workspace.mts", import.meta.url).href)});`,
            "const cfg = mod.default;",
            "const shared = cfg.test.projects.find((p) => p.test?.name === 'shared');",
            "console.log(JSON.stringify({ maxWorkers: cfg.test.maxWorkers ?? null, rolldown: shared?.test?.env?.ROLLDOWN_WORKER_THREADS ?? null, go: process.env.GOMAXPROCS ?? null }));",
          ].join(" "),
          "--",
          "vitest",
          ...extraArgs,
        ],
        { cwd: REPOSITORY_ROOT, env, encoding: "utf8" },
      );
      expect(result.status, result.stderr).toBe(0);
      return JSON.parse(result.stdout.trim());
    };

    const expectedDefault = Math.min(DEFAULT_LOCAL_CPU_BUDGET, Math.max(1, os.availableParallelism()));
    const emptyRoot = makeTempDir("pwragent-vitest-empty-");

    // Regression case: `npx vitest run --config vitest.workspace.mts` without --maxWorkers
    // automatically honors the thread's 3-CPU checkout instead of defaulting to 17 workers.
    expect(probe([])).toEqual({ maxWorkers: 3, rolldown: "3", go: "3" });
    // An explicitly identified thread without its own grant falls back to the local default
    // rather than inheriting another thread's directory grant.
    expect(probe([], { PWRAGENT_BACKEND: "claude", PWRAGENT_THREAD_ID: "unreserved-thread" })).toEqual({
      maxWorkers: expectedDefault,
      rolldown: String(expectedDefault),
      go: String(expectedDefault),
    });
    // Even without an active checkout file, local runs stay capped at the 4-CPU default
    // rather than spawning `availableParallelism() - 1` workers.
    expect(probe([], { PWRAGENT_HOME: emptyRoot })).toEqual({
      maxWorkers: expectedDefault,
      rolldown: String(expectedDefault),
      go: String(expectedDefault),
    });
    // A larger active checkout scales Vitest up to the reserved units.
    writeBudgetSnapshot(emptyRoot, "default", [
      {
        allocationId: "alloc-large",
        units: 12,
        deadlineAt: Date.now() + 300_000,
        backend: "claude",
        threadId: "thread-large",
        directories: [REPOSITORY_ROOT],
      },
    ]);
    expect(probe([], { PWRAGENT_HOME: emptyRoot })).toEqual({ maxWorkers: 12, rolldown: "12", go: "12" });
    // Explicit CLI --maxWorkers wins over the checkout default.
    expect(probe(["--maxWorkers=7"]).maxWorkers).toBeNull();
    // CI always ignores local machine-CPU checkouts and defaults.
    expect(probe([], { CI: "true" })).toEqual({ maxWorkers: null, rolldown: null, go: null });
  });
});
