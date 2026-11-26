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
import { fileURLToPath, pathToFileURL } from "node:url";
import { baselineProvenance, capturedRange, containsMachinePath, hasVerifiedBaselineRange, sanitizeItems, sanitizeText } from "./cohort-data.mjs";
import {
  nativeClaudeCapturedRange,
  nativeClaudeCaptureKey,
  nativeClaudeCaptureMatchesTranscript,
} from "./native-claude-capture.mjs";

const checkedInCohorts = fileURLToPath(new URL("../cohorts/", import.meta.url));
const splitRecipe = {
  "codex-findings-high": 2, "codex-findings-med": 2, "codex-clean": 2,
  "claude-findings": 3, "claude-noisy": 1,
};

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

function readReviewRows(sqlite, db, limit, claudeCollection = false) {
  const where = claudeCollection ? "backend = 'claude'" : "status = 'handled'";
  // SQLite may need to initialize WAL sidecars after the collection owner exits.
  // Open the existing file without create permission and keep the SQL read-only.
  const connection = claudeCollection
    ? ["-cmd", "PRAGMA query_only=ON;", "-json", `${pathToFileURL(db).href}?mode=rw`]
    : ["-readonly", "-json", db];
  const rows = execFileSync(sqlite, [
    ...connection,
    `SELECT status, updated_at, payload FROM thread_reviews WHERE ${where} ORDER BY updated_at DESC LIMIT ${limit};`,
  ], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(rows || "[]");
}

function readClaudeCaptureRun(sqlite, directory, limit) {
  const results = path.join(directory, "results");
  const captures = new Map();
  for (const file of fs.readdirSync(results).filter((name) => name.endsWith("--claude-native.json"))) {
    const cell = JSON.parse(fs.readFileSync(path.join(results, file), "utf8"));
    if (!cell.nativeClaude || cell.status !== "completed") continue;
    const key = nativeClaudeCaptureKey(cell.parentThreadId, cell.nativeClaude.sourceKey);
    if (captures.has(key)) throw new Error("Collection run contains a duplicated native Claude capture.");
    captures.set(key, cell);
  }
  const state = path.join(directory, "pwragent-home", "profiles", "eval", "state");
  const db = path.join(state, "state.db");
  return readReviewRows(sqlite, db, limit, true).flatMap((row) => {
    const payload = JSON.parse(row.payload);
    const cell = captures.get(nativeClaudeCaptureKey(payload.threadId, payload.sourceKey));
    const range = nativeClaudeCapturedRange(payload, cell);
    if (!range || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(payload.threadId)) return [];
    // This is the normalized transcript written by the PwrAgent Claude owner.
    // Match the recorded command and automatic review to one completed turn.
    try {
      const transcript = fs.readFileSync(path.join(state, "claude", `${payload.threadId}.jsonl`), "utf8");
      const entries = transcript.split("\n").filter(Boolean).map((line) => JSON.parse(line));
      if (nativeClaudeCaptureMatchesTranscript(cell, entries)) return [{ ...row, range, receipt: cell }];
    } catch {
      // Missing or damaged evidence cannot be used for a blind cohort.
    }
    return [];
  });
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

function stageClaudePlan({ repo, remote, prHeads, reviewRows, excluded, count, noisyCount, seed, file }) {
  // These are prospective snapshots for new reviews. Prior artifacts help
  // sample likely strata; they supply no range or finding evidence to the draw.
  const main = git(repo, ["rev-parse", "--verify", `${remote}/main^{commit}`]);
  const planned = new Set();
  const pools = { findings: [], noisy: [] };
  for (const row of reviewRows) {
    const payload = JSON.parse(row.payload);
    if (baselineProvenance(payload)?.backend !== "claude") continue;
    const context = payload.context ?? {};
    if ((context.pullRequests?.length ?? 0) > 1 || (context.pullRequestSnapshots?.length ?? 0) > 1) continue;
    const match = /^https:\/\/github\.com\/pwrdrvr\/PwrAgent\/pull\/([1-9]\d*)\/?$/i.exec(context.pullRequest?.url ?? "");
    const pr = Number(match?.[1]);
    if (!Number.isSafeInteger(pr) || excluded.has(pr) || planned.has(pr)) continue;
    const items = Array.isArray(payload.items) ? payload.items : [];
    const noisy = items.filter((item) => item.status === "declined").length >= 2;
    if (!noisy && items.filter((item) => item.status === "addressed" || item.status === "deferred").length < 2) continue;
    const headCommit = context.headCommit;
    if (!hasLocalCommit(repo, headCommit)) continue;
    const baseCommit = git(repo, ["merge-base", "--all", main, headCommit], true);
    if (!baseCommit || !/^[a-f0-9]{40}$/.test(baseCommit) || baseCommit === headCommit) continue;
    const surv = checkSurvivability(repo, pr, baseCommit, headCommit, prHeads, false, remote);
    if (!surv.ok || surv.tier === "PERM_MAIN") continue;
    const stats = diffStats(repo, baseCommit, headCommit);
    if (stats.adds + stats.dels === 0) continue;
    pools[noisy ? "noisy" : "findings"].push({
      id: `pr${pr}-native-claude`, pr, backend: "claude",
      baseline: { baseCommit, headCommit, prNumber: pr },
    });
    planned.add(pr);
  }
  const selected = [
    ...shuffleWithSeed(pools.findings, seed).slice(0, count - noisyCount),
    ...shuffleWithSeed(pools.noisy, seed + 1).slice(0, noisyCount),
  ];
  if (selected.length !== count) {
    throw new Error(`Only ${selected.length} of ${count} prospective Claude cases are available in the requested strata.`);
  }
  const cases = shuffleWithSeed(selected, seed + 2);
  const plan = buildCohortDoc(
    "native-claude-collection", "collection", true,
    "Pinned targets for new native Claude reviews. This is a collection plan.",
    cases,
  );
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(plan, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  console.log(JSON.stringify({ planned: cases.length, historicalFindingsStratum: count - noisyCount,
    historicalNoisyStratum: noisyCount, blind: true }, null, 2));
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

function verifyCohorts(repo, outDir, remote, staged) {
  const files = fs.readdirSync(outDir).filter((f) => f.endsWith(".json")).sort();
  if (files.length === 0) {
    throw new Error(`No cohort JSON files found in ${outDir}`);
  }
  const prHeads = loadOriginPrHeads(repo, remote);
  const published = new Set(staged ? fs.readdirSync(checkedInCohorts)
    .filter((name) => name.endsWith(".json"))
    .flatMap((name) => JSON.parse(fs.readFileSync(path.join(checkedInCohorts, name), "utf8")).cases.map((c) => c.pr)) : []);
  const seenPrs = new Set();
  const splits = { dev: 0, test: 0 };
  let failures = 0;

  for (const file of files) {
    const full = path.join(outDir, file);
    const cohort = JSON.parse(fs.readFileSync(full, "utf8"));
    if (containsMachinePath(cohort)) {
      console.error(`[FAIL] ${file}: contains machine-local filesystem path`);
      failures += 1;
    }
    const cases = Array.isArray(cohort.cases) ? cohort.cases : [];
    if (staged) {
      if (Object.hasOwn(splits, cohort.split)) splits[cohort.split] += 1;
      if (cohort.blind !== (cohort.split === "test")
        || cases.length !== 10 || cases.some((c) => !hasVerifiedBaselineRange(c.baseline))
        || Object.entries(splitRecipe).some(([bucket, count]) =>
          cases.filter((c) => c.bucket === bucket).length !== count)) {
        console.error(`[FAIL] ${file}: verification, blinding, or the balanced split recipe is incomplete.`);
        failures += 1;
      }
    }
    let okCount = 0;
    for (const c of cases) {
      if (seenPrs.has(c.pr) || published.has(c.pr)) {
        console.error(`[FAIL] ${file}: a PR overlaps a published or staged cohort.`);
        failures += 1;
      } else {
        seenPrs.add(c.pr);
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
      if (!surv.ok || (staged && c.backend === "claude" && surv.tier === "PERM_MAIN")) {
        const reason = surv.ok ? "missing retained PR lineage" : surv.reason;
        console.error(`[FAIL] ${file}: a pinned snapshot is unavailable (${reason}).`);
        failures += 1;
      } else {
        okCount += 1;
      }
    }
    console.log(
      `[OK] ${file.padEnd(14)} split=${cohort.split} blind=${cohort.blind} cases=${cases.length} survivable=${okCount}/${cases.length}`,
    );
  }
  if (staged && (files.length !== 3 || splits.dev !== 1 || splits.test !== 2)) {
    console.error("[FAIL] Expected one development split and two blind holdouts.");
    failures += 1;
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
  const verifyStaged = hasFlag("--verify-staged");
  const verify = hasFlag("--verify") || verifyStaged;
  const outDir = path.resolve(parseArg("--out", verify ? checkedInCohorts : path.join(repo, ".local/managed-review-eval/new-cohorts")));
  const remote = parseArg("--remote", "origin");

  if (verify) {
    if (verifyStaged && !hasFlag("--out")) throw new Error("--verify-staged requires the private staging directory in --out.");
    verifyCohorts(repo, outDir, remote, verifyStaged);
    return;
  }

  const profile = parseArg("--profile", "default");
  const pwragentHome = parseArg("--pwragent-home", path.join(os.homedir(), ".pwragent"));
  const dbPath = parseArg("--db", path.join(pwragentHome, "profiles", profile, "state", "state.db"));
  const seedDev1Path = parseArg("--seed-dev1", "");
  const seed = Number(parseArg("--seed", "20261125"));
  const limit = Number(parseArg("--limit", "1000"));
  const inventory = hasFlag("--inventory");
  const claudePlan = parseArg("--plan-claude", "");
  const planCount = Number(parseArg("--plan-count", "12"));
  const planNoisy = Number(parseArg("--plan-noisy", String(Math.ceil(planCount / 4))));
  const claudeRuns = [...new Set(process.argv.flatMap((arg, index) => {
    if (arg !== "--claude-captures") return [];
    const directory = process.argv[index + 1];
    if (!directory || directory.startsWith("--")) throw new Error("--claude-captures requires a run directory.");
    return [path.resolve(directory)];
  }))];
  if (!Number.isSafeInteger(seed) || !Number.isSafeInteger(limit) || limit < 1) {
    throw new Error("Seed and limit must be integers, and limit must be positive.");
  }
  if (claudePlan && (!Number.isSafeInteger(planCount) || planCount < 1
    || !Number.isSafeInteger(planNoisy) || planNoisy < 0 || planNoisy > planCount || inventory)) {
    throw new Error("Specify valid plan counts and run planning separately from inventory.");
  }

  const sqlite = resolveSqliteBinary();
  const prHeads = loadOriginPrHeads(repo, remote);

  // Exclude published cases even when a caller runs without a dev-1 seed.
  const usedPrs = new Set();
  const lockedPrs = new Set();
  const lastSplit = { dev: 0, test: 0 };
  const extraExclusions = parseArg("--exclude-cohorts", "");
  for (const directory of [checkedInCohorts, ...(extraExclusions ? [extraExclusions] : [])]) {
    for (const name of fs.readdirSync(directory).filter((file) => file.endsWith(".json"))) {
      const cohort = JSON.parse(fs.readFileSync(path.join(directory, name), "utf8"));
      const split = /^(dev|test)-([1-9]\d*)\.json$/.exec(name);
      if (split) lastSplit[split[1]] = Math.max(lastSplit[split[1]], Number(split[2]));
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
      if (!hasVerifiedBaselineRange(c.baseline)) {
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
          rangeEvidence: c.baseline.rangeEvidence,
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

  const captured = claudeRuns.flatMap((directory) => readClaudeCaptureRun(sqlite, directory, limit));
  const reviewRows = [...readReviewRows(sqlite, dbPath, limit),
    ...captured.filter((row) => row.status === "handled")];

  const perPrCandidates = new Map();
  for (const row of reviewRows) {
    let payload;
    try {
      payload = JSON.parse(row.payload);
    } catch {
      continue;
    }
    const ctx = payload.context || {};
    const provenance = baselineProvenance(payload);
    // Normal Claude PR artifacts can carry context assembled after the turn.
    // Only an independently recorded native dispatch binds the actual range.
    const range = provenance?.backend === "claude" ? row.range : capturedRange(ctx);
    if (!range || !provenance || usedPrs.has(range.pr)) continue;
    const { pr: prNum, baseCommit, headCommit } = range;
    const { backend, reviewMode } = provenance;
    if (!hasLocalCommit(repo, baseCommit) || !hasLocalCommit(repo, headCommit)
      || !isAncestor(repo, baseCommit, headCommit)) continue;
    const baseBranch = row.receipt?.baseBranch || ctx.baseBranch || ctx.pullRequest?.baseRefName || "main";

    const surv = checkSurvivability(repo, prNum, baseCommit, headCommit, prHeads, false, remote);
    if (!surv.ok || (backend === "claude" && surv.tier === "PERM_MAIN")) continue;

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
        reviewerModel: row.receipt?.model ?? null,
        reviewerEffort: row.receipt?.reasoningEffort ?? null,
        reviewMode,
        prNumber: prNum,
        prUrl: `https://github.com/pwrdrvr/PwrAgent/pull/${prNum}`,
        prTitle: sanitizeText(ctx.pullRequest?.title || `PR #${prNum}`),
        branch: ctx.gitBranch || ctx.pullRequest?.headRefName || `pr-${prNum}`,
        baseBranch: baseBranch.replace(/^origin\//, ""),
        baseCommit,
        headCommit,
        reviewedRangeVerified: true,
        rangeEvidence: backend === "codex" ? "codex-pr-snapshot" : "claude-native-dispatch",
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
      || (backend === "claude" && prev.backend !== "claude")
      || (backend === prev.backend && (
        (cand.baseline.counts.total > 0 && prev.baseline.counts.total === 0)
        || (cand.baseline.counts.total === prev.baseline.counts.total && cand.updatedAt > prev.updatedAt)
      ))
    ) {
      perPrCandidates.set(prNum, cand);
    }
  }

  const allPool = [...perPrCandidates.values()];
  if (claudePlan) {
    stageClaudePlan({
      repo, remote, prHeads, reviewRows, excluded: new Set([...usedPrs, ...perPrCandidates.keys()]),
      count: planCount, noisyCount: planNoisy, seed, file: path.resolve(claudePlan),
    });
    return;
  }
  const pools = {
    "codex-findings-high": shuffleWithSeed(allPool.filter((c) => c.bucket === "codex-findings-high"), seed + 1),
    "codex-findings-med": shuffleWithSeed(allPool.filter((c) => c.bucket === "codex-findings-med"), seed + 2),
    "codex-clean": shuffleWithSeed(allPool.filter((c) => c.bucket === "codex-clean"), seed + 3),
    "claude-findings": shuffleWithSeed(allPool.filter((c) => c.bucket === "claude-findings"), seed + 4),
    "claude-noisy": shuffleWithSeed(allPool.filter((c) => c.bucket === "claude-noisy"), seed + 5),
  };
  const required = Object.fromEntries(Object.entries(splitRecipe).map(([bucket, count]) => [bucket, 3 * count]));
  const poolCountsBeforeDraw = Object.fromEntries(Object.entries(pools).map(([name, cases]) => [name, cases.length]));
  const shortages = Object.fromEntries(Object.entries(required)
    .filter(([name, count]) => poolCountsBeforeDraw[name] < count)
    .map(([name, count]) => [name, count - poolCountsBeforeDraw[name]]));
  if (inventory) {
    console.log(JSON.stringify({
      poolCountsBeforeDraw, required, shortages,
      nativeClaudeCaptures: {
        verified: captured.length,
        awaitingSettlement: captured.filter((row) => row.status === "open").length,
      },
    }, null, 2));
    return;
  }
  if (Object.keys(shortages).length) {
    throw new Error(`Insufficient verified baselines for three disjoint splits: ${JSON.stringify(shortages)}`);
  }

  function drawCohortCases() {
    return Object.entries(splitRecipe).flatMap(([bucket, count]) =>
      pools[bucket].splice(0, count).map(({ updatedAt: _u, ...rest }) => rest));
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
      `dev-${lastSplit.dev + 1}`,
      "dev",
      false,
      "Verified development cohort (10 PRs) for iterative prompt tuning and error analysis.",
      drawCohortCases(),
    ),
    buildCohortDoc(
      `test-${lastSplit.test + 1}`,
      "test",
      true,
      "Verified blind holdout (10 PRs). Report aggregate Decision scores only.",
      drawCohortCases(),
    ),
    buildCohortDoc(
      `test-${lastSplit.test + 2}`,
      "test",
      true,
      "Verified blind lockbox (10 PRs) for final validation.",
      drawCohortCases(),
    ),
  );

  if (docs.some(containsMachinePath)) throw new Error("Draft cohorts contain machine-local paths.");
  if (docs.some((doc) => fs.existsSync(path.join(outDir, `${doc.name}.json`)))) {
    throw new Error("This staging directory already contains one of the proposed splits.");
  }
  fs.mkdirSync(outDir, { recursive: true });
  for (const doc of docs) {
    const outPath = path.join(outDir, `${doc.name}.json`);
    fs.writeFileSync(outPath, `${JSON.stringify(doc, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  }

  console.log(JSON.stringify({
    poolCountsBeforeDraw,
    cohorts: docs.map(summarizeCohortSafe),
  }, null, 2));
}

main();
