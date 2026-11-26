import { readdirSync, readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const BUDGET_DIR_SEGMENTS = ["runtime", "machine-cpu-budgets"];
export const DEFAULT_LOCAL_CPU_BUDGET = 4;
const THREAD_POOL_ENV_KEYS = [
  "ROLLDOWN_WORKER_THREADS",
  "TOKIO_WORKER_THREADS",
  "RAYON_NUM_THREADS",
  "UV_THREADPOOL_SIZE",
  "GOMAXPROCS",
];

function isCi(env) {
  const value = env.CI?.trim().toLowerCase();
  return Boolean(value && value !== "0" && value !== "false");
}

function parsePositiveInt(value) {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 1 ? value : undefined;
  }
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!/^[1-9]\d*$/.test(trimmed)) return undefined;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : undefined;
}

export function resolvePwragentRootFromEnv(env = process.env) {
  const explicit = env.PWRAGENT_HOME?.trim();
  return explicit ? path.resolve(explicit) : path.join(os.homedir(), ".pwragent");
}

function pathApi(platform = process.platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

function normalizeDirectory(directory, platform = process.platform) {
  const api = pathApi(platform);
  const resolved = api.resolve(directory);
  let canonical = resolved;
  if (platform === process.platform) {
    try {
      canonical = (realpathSync.native ?? realpathSync)(resolved);
    } catch {
      canonical = resolved;
    }
  }
  return platform === "win32" ? canonical.toLowerCase() : canonical;
}

function directoryMatchDepth(cwdNormalized, grantDirNormalized, platform = process.platform) {
  const api = pathApi(platform);
  const relative = api.relative(grantDirNormalized, cwdNormalized);
  if (
    relative === ""
    || (relative !== ".."
      && !relative.startsWith(`..${api.sep}`)
      && !api.isAbsolute(relative))
  ) {
    return grantDirNormalized.length;
  }
  return undefined;
}

function readActiveBudgetGrants(budgetDir, now) {
  let filenames;
  try {
    filenames = readdirSync(budgetDir).filter((name) => name.endsWith(".json")).sort();
  } catch {
    return [];
  }
  const active = [];
  for (const filename of filenames) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(path.join(budgetDir, filename), "utf8"));
    } catch {
      continue;
    }
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.grants)) continue;
    for (const grant of parsed.grants) {
      if (!grant || typeof grant !== "object") continue;
      const units = parsePositiveInt(grant.units);
      const deadlineAt = typeof grant.deadlineAt === "number" ? grant.deadlineAt : undefined;
      if (units === undefined || deadlineAt === undefined || deadlineAt <= now) continue;
      active.push({
        allocationId: typeof grant.allocationId === "string" ? grant.allocationId : "",
        units,
        deadlineAt,
        backend: typeof grant.backend === "string" ? grant.backend : "",
        threadId: typeof grant.threadId === "string" ? grant.threadId : "",
        directories: Array.isArray(grant.directories)
          ? grant.directories.filter((entry) => typeof entry === "string" && entry.trim().length > 0)
          : [],
      });
    }
  }
  return active;
}

export function resolveLocalCpuBudget({
  cwd = process.cwd(),
  env = process.env,
  now = Date.now(),
  budgetDir,
  platform = process.platform,
  fallback = DEFAULT_LOCAL_CPU_BUDGET,
} = {}) {
  if (isCi(env)) return undefined;

  const explicit = parsePositiveInt(env.PWRAGENT_CPU_BUDGET);
  if (explicit !== undefined) {
    return { units: explicit, source: "env" };
  }

  const directory = budgetDir ?? path.join(resolvePwragentRootFromEnv(env), ...BUDGET_DIR_SEGMENTS);
  const grants = readActiveBudgetGrants(directory, now);

  if (grants.length > 0) {
    const threadId = env.PWRAGENT_THREAD_ID?.trim();
    const backend = env.PWRAGENT_BACKEND?.trim();
    if (threadId) {
      const matched = grants.filter((grant) =>
        grant.threadId === threadId && (!backend || grant.backend === backend),
      );
      if (matched.length > 0) {
        return {
          units: Math.min(...matched.map((grant) => grant.units)),
          source: "thread-checkout",
          allocationId: matched[0].allocationId,
          deadlineAt: Math.min(...matched.map((grant) => grant.deadlineAt)),
        };
      }
    } else {
      const normalizedCwd = normalizeDirectory(cwd, platform);
      let bestDepth = -1;
      let bestMatches = [];
      for (const grant of grants) {
        let grantBest = -1;
        for (const candidate of grant.directories) {
          const depth = directoryMatchDepth(
            normalizedCwd,
            normalizeDirectory(candidate, platform),
            platform,
          );
          if (depth !== undefined && depth > grantBest) {
            grantBest = depth;
          }
        }
        if (grantBest < 0) continue;
        if (grantBest > bestDepth) {
          bestDepth = grantBest;
          bestMatches = [grant];
        } else if (grantBest === bestDepth) {
          bestMatches.push(grant);
        }
      }

      if (bestMatches.length > 0) {
        return {
          units: Math.min(...bestMatches.map((grant) => grant.units)),
          source: "directory-checkout",
          allocationId: bestMatches[0].allocationId,
          deadlineAt: Math.min(...bestMatches.map((grant) => grant.deadlineAt)),
        };
      }
    }
  }

  const fallbackUnits = parsePositiveInt(fallback);
  if (fallbackUnits !== undefined) {
    const hostCpus = Math.max(1, os.availableParallelism?.() ?? os.cpus().length ?? 1);
    return { units: Math.min(fallbackUnits, hostCpus), source: "default" };
  }

  return undefined;
}

export function hasCliFlag(argv, names) {
  const lowered = names.map((name) => name.toLowerCase());
  for (const arg of argv) {
    const normalized = String(arg).toLowerCase();
    for (const flag of lowered) {
      if (normalized === flag || normalized.startsWith(`${flag}=`)) {
        return true;
      }
    }
  }
  return false;
}

export function buildBudgetThreadEnv(units, baseEnv = process.env) {
  const validated = parsePositiveInt(units);
  if (validated === undefined) return {};
  const value = String(validated);
  const overrides = {};
  for (const key of THREAD_POOL_ENV_KEYS) {
    if (!baseEnv[key]) {
      overrides[key] = value;
    }
  }
  return overrides;
}

export function splitTypedLintBudget(units) {
  const validated = parsePositiveInt(units) ?? 1;
  return {
    oxlintThreads: Math.max(1, Math.floor(validated / 2)),
    goMaxProcs: Math.max(1, Math.ceil(validated / 2)),
  };
}
