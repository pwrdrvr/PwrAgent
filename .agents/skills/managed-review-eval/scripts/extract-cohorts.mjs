#!/usr/bin/env node
/**
 * Extract, sanitize, and verify permanently GitHub-survivable managed-review
 * evaluation cohorts from a local PwrAgent profile SQLite database.
 *
 * Usage:
 *   node .agents/skills/managed-review-eval/scripts/extract-cohorts.mjs \
 *     --repo /path/to/PwrAgnt \
 *     --out .agents/skills/managed-review-eval/cohorts \
 *     --seed-dev1 /path/to/existing/cohort-10.json
 *
 *   node .agents/skills/managed-review-eval/scripts/extract-cohorts.mjs \
 *     --verify --repo /path/to/PwrAgnt --out .agents/skills/managed-review-eval/cohorts
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { baselineProvenance, capturedRange, containsMachinePath, sanitizeItems, sanitizeText } from "./cohort-data.mjs";

const checkedInCohorts = fileURLToPath(new URL("../cohorts/", import.meta.url));

function parseArg(name, fallback) {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && idx + 1 < process.argv.length) {
    return process.argv[idx + 1];
  }
  return fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function resolveSqliteBinary() {
  for (const candidate of ["/usr/bin/sqlite3", "sqlite3"]) {
    try {
      execFileSync(candidate, ["--version"], { stdio: "ignore" });
      return candidate;
    } catch {
      // try next
    }
  }
  throw new Error("sqlite3 binary not found on PATH or at /usr/bin/sqlite3");
}

function git(repo, args, allowFailure = false) {
  try {
    return execFileSync("git", ["-C", repo, ...args], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (err) {
    if (allowFailure) return null;
    throw err;
  }
}

function hasLocalCommit(repo, sha) {
  if (!sha || !/^[0-9a-f]{40}$/.test(sha)) return false;
  return git(repo, ["cat-file", "-e", `${sha}^{commit}`], true) !== null;
}

function isAncestor(repo, anc, desc) {
  if (!anc || !desc) return false;
  return git(repo, ["merge-base", "--is-ancestor", anc, desc], true) !== null;
}

function loadOriginPrHeads(repo, remote = "origin") {
  const out = git(repo, ["ls-remote", remote, "refs/pull/*/head"]);
  const map = new Map();
  for (const line of out.split("\n")) {
    const [sha, ref] = line.trim().split(/\s+/);
    const m = ref?.match(/^refs\/pull\/(\d+)\/head$/);
    if (m && sha && /^[0-9a-f]{40}$/.test(sha)) {
      map.set(Number(m[1]), sha);
    }
  }
  return map;
}

function diffStats(repo, baseCommit, headCommit) {
  const out = git(repo, ["diff", "--numstat", `${baseCommit}..${headCommit}`], true);
  if (out === null) return { files: 0, adds: 0, dels: 0 };
  let files = 0;
  let adds = 0;
  let dels = 0;
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    files += 1;
    const [a, d] = line.split("\t");
    if (a && a !== "-") adds += Number(a) || 0;
    if (d && d !== "-") dels += Number(d) || 0;
  }
  return { files, adds, dels };
}

function checkSurvivability(repo, prNumber, baseCommit, headCommit, prHeads, fetchMissing = false, remote = "origin") {
  const remoteTip = prHeads.get(prNumber) ?? null;
  if (!remoteTip) {
    return { ok: false, reason: "missing_remote_pr_ref", remoteTip: null };
  }
  if (!hasLocalCommit(repo, baseCommit) || !isAncestor(repo, baseCommit, `${remote}/main`)) {
    return { ok: false, reason: "base_not_on_origin_main", remoteTip };
  }
  if (fetchMissing && (!hasLocalCommit(repo, remoteTip) || !hasLocalCommit(repo, headCommit))) {
    git(repo, ["fetch", "--no-tags", "--no-write-fetch-head", remote, `refs/pull/${prNumber}/head`], true);
  }
  if (!hasLocalCommit(repo, headCommit)) {
    return { ok: false, reason: "head_missing_locally", remoteTip };
  }
  if (remoteTip === headCommit) {
    return { ok: true, tier: "PERM_PR_TIP", remoteTip };
  }
  if (hasLocalCommit(repo, remoteTip) && isAncestor(repo, headCommit, remoteTip)) {
    return { ok: true, tier: "PERM_PR_ANCESTOR", remoteTip };
  }
  if (isAncestor(repo, headCommit, `${remote}/main`)) {
    return { ok: true, tier: "PERM_MAIN", remoteTip };
  }
  return { ok: false, reason: "dangling_not_in_pr_tip", remoteTip };
}

function mulberry32(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleWithSeed(items, seed) {
  const arr = [...items];
  const rand = mulberry32(seed);
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function verifyCohorts(repo, outDir, remote) {
  const files = fs.readdirSync(outDir).filter((f) => f.endsWith(".json")).sort();
  if (files.length === 0) {
    throw new Error(`No cohort JSON files found in ${outDir}`);
  }
  const prHeads = loadOriginPrHeads(repo, remote);
  const seenPrs = new Map();
  let failures = 0;

  for (const file of files) {
    const full = path.join(outDir, file);
    const cohort = JSON.parse(fs.readFileSync(full, "utf8"));
    if (containsMachinePath(cohort)) {
      console.error(`[FAIL] ${file}: contains machine-local filesystem path`);
      failures += 1;
    }
    const cases = Array.isArray(cohort.cases) ? cohort.cases : [];
    let okCount = 0;
    for (const c of cases) {
      if (seenPrs.has(c.pr)) {
        console.error(`[FAIL] ${file}: duplicate PR #${c.pr} (also in ${seenPrs.get(c.pr)})`);
        failures += 1;
      } else {
        seenPrs.set(c.pr, file);
      }
      const surv = checkSurvivability(
        repo,
        c.pr,
        c.baseline.baseCommit,
        c.baseline.headCommit,
        prHeads,
        true,
        remote,
      );
      if (!surv.ok) {
        console.error(`[FAIL] ${file} ${c.id} (PR #${c.pr}): ${surv.reason}`);
        failures += 1;
      } else {
        okCount += 1;
      }
    }
    console.log(
      `[OK] ${file.padEnd(14)} split=${cohort.split} blind=${cohort.blind} cases=${cases.length} survivable=${okCount}/${cases.length}`,
    );
  }
  if (failures > 0) {
    throw new Error(`Cohort verification failed with ${failures} error(s)`);
  }
  console.log(`Verified ${files.length} cohorts (${seenPrs.size} disjoint PRs with reachable pinned commits).`);
}

function buildCohortDoc(name, split, blind, description, cases) {
  return {
    schemaVersion: 1,
    name,
    split,
    blind,
    repository: "pwrdrvr/PwrAgent",
    description,
    createdAt: new Date().toISOString(),
    caseCount: cases.length,
    cases,
  };
}

function summarizeCohortSafe(doc) {
  const byBucket = {};
  let totalF = 0;
  let totalA = 0;
  let totalD = 0;
  let totalX = 0;
  const tiers = {};
  for (const c of doc.cases) {
    byBucket[c.bucket] = (byBucket[c.bucket] || 0) + 1;
    totalF += c.baseline.counts.total;
    totalA += c.baseline.counts.addressed;
    totalD += c.baseline.counts.deferred;
    totalX += c.baseline.counts.declined;
    tiers[c.survivability] = (tiers[c.survivability] || 0) + 1;
  }
  return {
    name: doc.name,
    split: doc.split,
    blind: doc.blind,
    cases: doc.cases.length,
    prs: doc.blind ? "(redacted for blind test set)" : doc.cases.map((c) => c.pr),
    buckets: byBucket,
    baselineTotals: { findings: totalF, addressed: totalA, deferred: totalD, declined: totalX },
    survivability: tiers,
  };
}

function main() {
  const repo = path.resolve(parseArg("--repo", process.cwd()));
  const verify = hasFlag("--verify");
  const outDir = path.resolve(parseArg("--out", verify ? checkedInCohorts : path.join(repo, ".local/managed-review-eval/new-cohorts")));
  const remote = parseArg("--remote", "origin");

  if (verify) {
    verifyCohorts(repo, outDir, remote);
    return;
  }

  const profile = parseArg("--profile", "default");
  const pwragentHome = parseArg("--pwragent-home", path.join(os.homedir(), ".pwragent"));
  const dbPath = parseArg("--db", path.join(pwragentHome, "profiles", profile, "state", "state.db"));
  const seedDev1Path = parseArg("--seed-dev1", "");
  const seed = Number(parseArg("--seed", "20261125"));
  const limit = Number(parseArg("--limit", "1000"));
  if (!Number.isSafeInteger(seed) || !Number.isSafeInteger(limit) || limit < 1) {
    throw new Error("Seed and limit must be integers, and limit must be positive.");
  }

  fs.mkdirSync(outDir, { recursive: true });
  const sqlite = resolveSqliteBinary();
  const prHeads = loadOriginPrHeads(repo, remote);

  // Exclude published cases even when a caller runs without a dev-1 seed.
  const usedPrs = new Set();
  const lockedPrs = new Set();
  const extraExclusions = parseArg("--exclude-cohorts", "");
  for (const directory of [checkedInCohorts, ...(extraExclusions ? [extraExclusions] : [])]) {
    for (const name of fs.readdirSync(directory).filter((file) => file.endsWith(".json"))) {
      const cohort = JSON.parse(fs.readFileSync(path.join(directory, name), "utf8"));
      const cases = Array.isArray(cohort) ? cohort : cohort.cases;
      for (const c of cases) {
        usedPrs.add(c.pr);
        if (cohort.blind) lockedPrs.add(c.pr);
      }
    }
  }
  const dev1Cases = [];
  if (seedDev1Path) {
    const rawDev1 = JSON.parse(fs.readFileSync(seedDev1Path, "utf8"));
    if (rawDev1.blind) throw new Error("A blind cohort cannot be used as a development seed.");
    for (const c of Array.isArray(rawDev1) ? rawDev1 : rawDev1.cases) {
      if (lockedPrs.has(c.pr)) throw new Error("The development seed overlaps a blind cohort.");
      if (!["codex-native", "claude-code-review"].includes(c.baseline.reviewMode)
        || c.baseline.reviewedRangeVerified !== true) {
        throw new Error("The development seed requires verified reviewer and range provenance.");
      }
      const surv = checkSurvivability(repo, c.pr, c.baseline.baseCommit, c.baseline.headCommit, prHeads, true, remote);
      if (!surv.ok) {
        throw new Error(`dev-1 case ${c.id} (PR #${c.pr}) failed survivability check: ${surv.reason}`);
      }
      const stats = diffStats(repo, c.baseline.baseCommit, c.baseline.headCommit);
      dev1Cases.push({
        id: c.id,
        pr: c.pr,
        backend: c.backend,
        bucket: c.bucket,
        survivability: surv.tier,
        remotePrHeadCommit: surv.remoteTip,
        baseline: {
          reviewerBackend: c.baseline.reviewerBackend || c.backend,
          reviewerModel: c.baseline.reviewerModel ?? null,
          reviewerEffort: c.baseline.reviewerEffort ?? null,
          reviewMode: c.baseline.reviewMode,
          prNumber: c.pr,
          prUrl: `https://github.com/pwrdrvr/PwrAgent/pull/${c.pr}`,
          prTitle: sanitizeText(c.baseline.prTitle || `PR #${c.pr}`),
          branch: c.baseline.branch || `pr-${c.pr}`,
          baseBranch: c.baseline.baseBranch || "main",
          baseCommit: c.baseline.baseCommit,
          headCommit: c.baseline.headCommit,
          reviewedRangeVerified: true,
          diffFiles: stats.files,
          diffAdds: stats.adds,
          diffDels: stats.dels,
          counts: c.baseline.counts,
          items: sanitizeItems(c.baseline.items),
        },
      });
      usedPrs.add(c.pr);
    }
  }

  // 2. Query PwrAgent-owned state.db (read-only) for remaining settled reviews
  const reviewsJson = execFileSync(
    sqlite,
    [
      "-readonly",
      "-json",
      dbPath,
      `SELECT updated_at, payload FROM thread_reviews WHERE status = 'handled' ORDER BY updated_at DESC LIMIT ${limit};`,
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const reviewRows = JSON.parse(reviewsJson || "[]");

  const perPrCandidates = new Map();
  for (const row of reviewRows) {
    let payload;
    try {
      payload = JSON.parse(row.payload);
    } catch {
      continue;
    }
    const ctx = payload.context || {};
    const range = capturedRange(ctx);
    const provenance = baselineProvenance(payload);
    if (!range || !provenance || usedPrs.has(range.pr)) continue;
    const { pr: prNum, baseCommit, headCommit } = range;
    const { backend, reviewMode } = provenance;
    if (!hasLocalCommit(repo, baseCommit) || !hasLocalCommit(repo, headCommit)
      || !isAncestor(repo, baseCommit, headCommit)) continue;
    const baseBranch = ctx.baseBranch || ctx.pullRequest?.baseRefName || "main";

    const surv = checkSurvivability(repo, prNum, baseCommit, headCommit, prHeads, false, remote);
    if (!surv.ok) continue;

    const stats = diffStats(repo, baseCommit, headCommit);
    if (stats.files === 0 || (stats.adds + stats.dels) === 0) continue;

    const items = sanitizeItems(payload.items, ctx);
    const addressed = items.filter((i) => i.status === "addressed").length;
    const deferred = items.filter((i) => i.status === "deferred").length;
    const declined = items.filter((i) => i.status === "declined").length;
    const open = items.length - addressed - deferred - declined;
    if (open > 0) continue;

    let bucket;
    if (backend === "codex") {
      if (items.length === 0) bucket = "codex-clean";
      else if (addressed + deferred >= 3) bucket = "codex-findings-high";
      else bucket = "codex-findings-med";
    } else {
      if (declined >= 2) bucket = "claude-noisy";
      else if (items.length > 0 && addressed + deferred >= 2) bucket = "claude-findings";
      else continue;
    }

    const cand = {
      id: `pr${prNum}-${backend}${bucket.endsWith("-clean") ? "-clean" : bucket.endsWith("-noisy") ? "-noisy" : ""}`,
      pr: prNum,
      backend,
      bucket,
      survivability: surv.tier,
      remotePrHeadCommit: surv.remoteTip,
      updatedAt: row.updated_at,
      baseline: {
        reviewerBackend: backend,
        reviewerModel: null,
        reviewerEffort: null,
        reviewMode,
        prNumber: prNum,
        prUrl: `https://github.com/pwrdrvr/PwrAgent/pull/${prNum}`,
        prTitle: sanitizeText(ctx.pullRequest?.title || `PR #${prNum}`),
        branch: ctx.gitBranch || ctx.pullRequest?.headRefName || `pr-${prNum}`,
        baseBranch: baseBranch.replace(/^origin\//, ""),
        baseCommit,
        headCommit,
        reviewedRangeVerified: true,
        diffFiles: stats.files,
        diffAdds: stats.adds,
        diffDels: stats.dels,
        counts: { total: items.length, addressed, deferred, declined, open: 0 },
        items,
      },
    };

    const prev = perPrCandidates.get(prNum);
    if (
      !prev
      || (cand.baseline.counts.total > 0 && prev.baseline.counts.total === 0)
      || (cand.baseline.counts.total === prev.baseline.counts.total && cand.updatedAt > prev.updatedAt)
    ) {
      perPrCandidates.set(prNum, cand);
    }
  }

  const allPool = [...perPrCandidates.values()];
  const pools = {
    "codex-findings-high": shuffleWithSeed(allPool.filter((c) => c.bucket === "codex-findings-high"), seed + 1),
    "codex-findings-med": shuffleWithSeed(allPool.filter((c) => c.bucket === "codex-findings-med"), seed + 2),
    "codex-clean": shuffleWithSeed(allPool.filter((c) => c.bucket === "codex-clean"), seed + 3),
    "claude-findings": shuffleWithSeed(allPool.filter((c) => c.bucket === "claude-findings"), seed + 4),
    "claude-noisy": shuffleWithSeed(allPool.filter((c) => c.bucket === "claude-noisy"), seed + 5),
  };

  function takeFrom(bucketName, count) {
    const arr = pools[bucketName];
    if (arr.length < count) {
      throw new Error(`Not enough candidates in bucket ${bucketName}: need ${count}, have ${arr.length}`);
    }
    return arr.splice(0, count).map(({ updatedAt: _u, ...rest }) => rest);
  }

  // Exact stratified recipe matching dev-1 (10 cases per cohort):
  //   2 codex-findings-high + 2 codex-findings-med + 2 codex-clean + 3 claude-findings + 1 claude-noisy
  function drawCohortCases() {
    return [
      ...takeFrom("codex-findings-high", 2),
      ...takeFrom("codex-findings-med", 2),
      ...takeFrom("codex-clean", 2),
      ...takeFrom("claude-findings", 3),
      ...takeFrom("claude-noisy", 1),
    ];
  }

  const docs = [];
  if (dev1Cases.length > 0) {
    docs.push(
      buildCohortDoc(
        "dev-1",
        "dev",
        false,
        "Primary development cohort (10 PRs) used for baseline benchmarking and error analysis.",
        dev1Cases,
      ),
    );
  }
  docs.push(
    buildCohortDoc(
      "dev-2",
      "dev",
      false,
      "Secondary development cohort (10 PRs) for iterative prompt tuning and error analysis.",
      drawCohortCases(),
    ),
    buildCohortDoc(
      "test-1",
      "test",
      true,
      "Held-out blind test cohort 1 (10 PRs). Do NOT inspect individual findings or diffs when tuning prompts; read aggregate Decision scores only.",
      drawCohortCases(),
    ),
    buildCohortDoc(
      "test-2",
      "test",
      true,
      "Held-out blind lockbox test cohort 2 (10 PRs). Reserve for final pre-release validation; never inspect individual cases.",
      drawCohortCases(),
    ),
  );

  if (docs.some(containsMachinePath)) throw new Error("Draft cohorts contain machine-local paths.");
  for (const doc of docs) {
    const outPath = path.join(outDir, `${doc.name}.json`);
    fs.writeFileSync(outPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  }

  console.log(JSON.stringify({
    poolCountsBeforeDraw: {
      totalDisjointSurvivable: allPool.length,
      codexFindingsHigh: allPool.filter((c) => c.bucket === "codex-findings-high").length,
      codexFindingsMed: allPool.filter((c) => c.bucket === "codex-findings-med").length,
      codexClean: allPool.filter((c) => c.bucket === "codex-clean").length,
      claudeFindings: allPool.filter((c) => c.bucket === "claude-findings").length,
      claudeNoisy: allPool.filter((c) => c.bucket === "claude-noisy").length,
    },
    cohorts: docs.map(summarizeCohortSafe),
  }, null, 2));
}

main();
