#!/usr/bin/env node
/**
 * Aggregate PwrAgent Decision-model scoring batches (`decisions_invoke` JSONL
 * or caller-requested output files) into eval summary JSON and CSVs.
 *
 * Blind test discipline:
 *   When the cohort JSON sets `"blind": true`, this script prints ONLY
 *   aggregate metrics (overall, per-baseline-family, clean subset, union recall)
 *   and suppresses individual finding titles, diffs, and per-case breakdowns
 *   unless `--allow-inspect-test` is explicitly passed.
 *
 * Usage:
 *   node .agents/skills/managed-review-eval/scripts/aggregate-eval-scores.mjs \
 *     --cohort .agents/skills/managed-review-eval/cohorts/dev-1.json \
 *     --results .local/managed-review-eval/runs/dev-1/results \
 *     --scoring .local/managed-review-eval/runs/dev-1/scoring \
 *     --out .local/managed-review-eval/runs/dev-1
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { hasVerifiedBaselineRange } from "./cohort-data.mjs";
import { completeDecisionAnswers, readDecisionOutput } from "./decision-file-batches.mjs";
import { renderRunSummaryMarkdown } from "../../shared/report-format.mjs";

function nonNeg(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function optionalNonNeg(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function roundTo(value, digits) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function aggregateUsage(usages) {
  const totalCells = usages.length;
  let measuredCells = 0;
  let pricedCells = 0;
  let unpricedCells = 0;
  let uncachedInputTokens = 0;
  let cachedInputTokens = 0;
  let cacheWriteInputTokens = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let reasoningOutputTokens = 0;
  let totalTokens = 0;
  let replayObservedCells = 0;
  let coldReplayCount = 0;
  let hotReplayCount = 0;
  let maxPeakContextTokens = null;
  let totalCostMicros = 0;

  for (const usage of usages) {
    if (!usage || usage.source === "none") continue;
    measuredCells += 1;
    uncachedInputTokens += nonNeg(usage.uncachedInputTokens);
    cachedInputTokens += nonNeg(usage.cachedInputTokens);
    cacheWriteInputTokens += nonNeg(usage.cacheWriteInputTokens);
    inputTokens += nonNeg(usage.inputTokens);
    outputTokens += nonNeg(usage.outputTokens);
    reasoningOutputTokens += nonNeg(usage.reasoningOutputTokens);
    totalTokens += nonNeg(usage.totalTokens);
    if (nonNeg(usage.pricedLineCount) > 0) {
      pricedCells += 1;
      totalCostMicros += nonNeg(usage.totalCostMicros);
      if (nonNeg(usage.unpricedLineCount) > 0) unpricedCells += 1;
    } else {
      unpricedCells += 1;
    }
    if (usage.replayObserved) {
      replayObservedCells += 1;
      coldReplayCount += nonNeg(usage.coldReplayCount);
      hotReplayCount += nonNeg(usage.hotReplayCount);
    }
    const peak = optionalNonNeg(usage.peakContextTokens);
    if (peak !== null) {
      maxPeakContextTokens = maxPeakContextTokens === null ? peak : Math.max(maxPeakContextTokens, peak);
    }
  }

  const totalReplayCount = replayObservedCells > 0 ? coldReplayCount + hotReplayCount : null;
  const estimatedCostUsd = pricedCells > 0 ? roundTo(totalCostMicros / 1_000_000, 6) : null;
  return {
    measuredCells,
    totalCells,
    pricedCells,
    unpricedCells,
    uncachedInputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    inputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens,
    meanTotalTokens: measuredCells > 0 ? Math.round(totalTokens / measuredCells) : null,
    replayObservedCells,
    coldReplayCount: replayObservedCells > 0 ? coldReplayCount : null,
    hotReplayCount: replayObservedCells > 0 ? hotReplayCount : null,
    totalReplayCount,
    meanReplayCount: totalReplayCount !== null && replayObservedCells > 0
      ? roundTo(totalReplayCount / replayObservedCells, 2)
      : null,
    maxPeakContextTokens,
    totalCostMicros,
    estimatedCostUsd,
    meanCostUsd: estimatedCostUsd !== null && pricedCells > 0
      ? roundTo(estimatedCostUsd / pricedCells, 6)
      : null,
  };
}

function parseArg(name, fallback) {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && idx + 1 < process.argv.length) {
    return process.argv[idx + 1];
  }
  return fallback;
}

const cohortPath = path.resolve(parseArg("--cohort", ""));
const resultsDir = path.resolve(parseArg("--results", ""));
const scoringDir = path.resolve(parseArg("--scoring", ""));
const outDir = path.resolve(parseArg("--out", path.dirname(resultsDir)));
const casesArg = parseArg("--cases", "").trim();
const allowInspectTest = process.argv.includes("--allow-inspect-test");

if (!cohortPath || !resultsDir || !scoringDir) {
  throw new Error("Required flags: --cohort <file> --results <dir> --scoring <dir>");
}

const cohortBytes = fs.readFileSync(cohortPath);
const rawCohort = JSON.parse(cohortBytes);
const isBlind = !Array.isArray(rawCohort) && Boolean(rawCohort.blind);
const allCohortCases = Array.isArray(rawCohort) ? rawCohort : rawCohort.cases;

const summary = JSON.parse(
  fs.readFileSync(path.join(scoringDir, "decision-batches-summary.json"), "utf8"),
);
const manifest = JSON.parse(
  fs.readFileSync(path.join(scoringDir, "chunks-manifest.json"), "utf8"),
);
if (manifest.cohortSha256 !== createHash("sha256").update(cohortBytes).digest("hex") || !manifest.cellSha256) {
  throw new Error("Scoring sources changed or the manifest lacks source digests. Prepare the batches again.");
}
let cohortCases = allCohortCases;
if (Array.isArray(manifest.selectedCaseIds)) {
  if (isBlind && manifest.selectedCaseIds.length !== allCohortCases.length) {
    throw new Error("Blind holdout cohorts cannot be aggregated from a partial case subset.");
  }
  const selectedSet = new Set(manifest.selectedCaseIds);
  cohortCases = allCohortCases.filter((c) => selectedSet.has(c.id));
  if (cohortCases.length !== manifest.selectedCaseIds.length) {
    throw new Error("Scoring manifest selectedCaseIds do not match the cohort. Prepare the batches again.");
  }
  if (casesArg && casesArg !== "all") {
    const requested = new Set(casesArg.split(",").map((s) => s.trim()).filter(Boolean));
    if (requested.size !== selectedSet.size || [...requested].some((id) => !selectedSet.has(id))) {
      throw new Error("Scoring manifest was prepared for a different --cases subset. Prepare the batches again.");
    }
  }
} else if (casesArg && casesArg !== "all") {
  if (isBlind) {
    throw new Error("Blind holdout cohorts cannot be aggregated with a --cases subset.");
  }
  const requested = new Set(casesArg.split(",").map((s) => s.trim()).filter(Boolean));
  cohortCases = allCohortCases.filter((c) => requested.has(c.id));
}
const unverifiedBaselineCount = cohortCases.filter(({ baseline }) => !hasVerifiedBaselineRange(baseline)).length;
if (unverifiedBaselineCount !== manifest.unverifiedBaselineCount || (isBlind && unverifiedBaselineCount)) {
  throw new Error("Decision scoring prerequisites changed or the blind cohort has an unverified baseline range.");
}
const arms = manifest.arms ?? ["codex", "neon"];
const recallMeta = JSON.parse(fs.readFileSync(path.join(scoringDir, "recall-meta.json"), "utf8"));
const precisionMeta = JSON.parse(
  fs.readFileSync(path.join(scoringDir, "precision-meta.json"), "utf8"),
);
const holisticMeta = JSON.parse(
  fs.readFileSync(path.join(scoringDir, "holistic-meta.json"), "utf8"),
);

function loadChunkItems(chunk) {
  let rows;
  if (chunk.outputFile) {
    const output = readDecisionOutput(chunk.outputFile, chunk.count, definitions[chunk.batchType]);
    if (output.batchId !== chunk.batchId) throw new Error("Decision output batch ID changed.");
    rows = output.results;
  } else {
    const lines = fs.readFileSync(chunk.resultsFile, "utf8").trim().split("\n");
    const header = JSON.parse(lines.shift());
    if (header.type !== "batch" || header.batchId !== chunk.batchId || header.count !== chunk.count) {
      throw new Error(`Decision archive is incomplete or mismatched for ${chunk.batchType}#${chunk.chunkIndex}.`);
    }
    rows = lines.map((line) => JSON.parse(line)).filter((row) => row.type === "item");
  }
  return rows.map((row) => ({
    localIndex: row.index,
    ok: row.ok,
    answers: row.answers ?? row.response?.answers ?? [],
  })).sort((a, b) => a.localIndex - b.localIndex);
}

function getAnswer(answers, name) {
  return answers.find((a) => a.name === name);
}

const definitionsBytes = fs.readFileSync(path.join(scoringDir, "scoring-definitions.json"));
const definitionSha256 = createHash("sha256").update(definitionsBytes).digest("hex");
if (definitionSha256 !== manifest.definitionSha256) {
  throw new Error("Decision definitions changed after preparation.");
}
const definitions = JSON.parse(definitionsBytes);
const seenBatches = new Set();

function loadAllFor(batchType, metaList) {
  const chunks = summary[batchType];
  const expected = manifest[batchType];
  if (!Array.isArray(chunks) || !Array.isArray(expected) || chunks.length !== expected.length) {
    throw new Error(`Decision scorecard is incomplete for ${batchType}.`);
  }
  const merged = [];
  let totalCostUsd = 0;
  let costKnown = true;
  const observedModels = new Set();
  for (const [index, entry] of expected.entries()) {
    const chunk = chunks[index];
    if (chunk?.batchType !== batchType || chunk.chunkIndex !== index
      || chunk.start !== merged.length || chunk.start !== entry.start || chunk.count !== entry.count
      || !Number.isInteger(chunk.count) || chunk.count <= 0 || chunk.start + chunk.count > metaList.length
      || chunk.succeeded !== chunk.count || chunk.failed !== 0
      || typeof chunk.batchId !== "string" || !chunk.batchId || seenBatches.has(chunk.batchId)) {
      throw new Error(`Decision scorecard is incomplete or duplicated at ${batchType}#${index}.`);
    }
    const currentInputsSha256 = createHash("sha256").update(fs.readFileSync(entry.file)).digest("hex");
    if (chunk.definitionSha256 !== definitionSha256
      || chunk.inputsSha256 !== entry.inputsSha256 || chunk.inputsSha256 !== currentInputsSha256) {
      throw new Error(`Decision judgments for ${batchType}#${index} use different inputs or definitions.`);
    }
    seenBatches.add(chunk.batchId);
    const items = loadChunkItems(chunk);
    if (items.length !== chunk.count || items.some((item, i) =>
      item.localIndex !== i || item.ok !== true || !completeDecisionAnswers(item.answers, definitions[batchType].questions)
    )) {
      throw new Error(`Decision answers are incomplete at ${batchType}#${index}.`);
    }
    for (const item of items) {
      merged.push({ ...metaList[chunk.start + item.localIndex], ok: item.ok, answers: item.answers });
    }
    if (typeof chunk.model === "string" && chunk.model.trim()) {
      observedModels.add(chunk.model.trim());
    }
    if (typeof chunk.estimatedCostUsd === "number" && Number.isFinite(chunk.estimatedCostUsd)) {
      totalCostUsd += chunk.estimatedCostUsd;
    } else {
      costKnown = false;
    }
  }
  if (merged.length !== metaList.length) throw new Error(`Decision scorecard is incomplete for ${batchType}.`);
  return {
    items: merged,
    totalCostUsd: expected.length === 0 ? 0 : costKnown ? totalCostUsd : null,
    models: [...observedModels],
  };
}

const recallData = loadAllFor("recall", recallMeta);
const precisionData = loadAllFor("precision", precisionMeta);
const holisticData = loadAllFor("holistic", holisticMeta);

const recallRows = recallData.items.map((r) => {
  const src = getAnswer(r.answers, "same_root_cause");
  const grade = getAnswer(r.answers, "match_grade");
  const srcProb = typeof src?.probability === "number" ? src.probability : null;
  return {
    ...r,
    sameRootCause: srcProb !== null ? srcProb >= 0.5 : Boolean(src?.answer),
    sameRootCauseProb: srcProb,
    matchGrade: grade?.choice ?? "missed",
    matchGradeConf: grade?.confidence ?? null,
  };
});

const precisionRows = precisionData.items.map((r) => {
  const mb = getAnswer(r.answers, "matches_baseline");
  const cd = getAnswer(r.answers, "concrete_defect");
  const dv = getAnswer(r.answers, "defect_value");
  const mbProb = typeof mb?.probability === "number" ? mb.probability : null;
  const cdProb = typeof cd?.probability === "number" ? cd.probability : null;
  const score1to5 = typeof dv?.score === "number" ? Number((dv.score + 1).toFixed(2)) : null;
  const topLabel = dv?.probabilities
    ? [...dv.probabilities].sort((a, b) => b.probability - a.probability)[0]?.label
    : null;
  return {
    ...r,
    matchesBaseline: mbProb !== null ? mbProb >= 0.5 : Boolean(mb?.answer),
    matchesBaselineProb: mbProb,
    concreteDefect: cdProb !== null ? cdProb >= 0.5 : Boolean(cd?.answer),
    concreteDefectProb: cdProb,
    defectValue1to5: score1to5,
    defectValueTopLabel: topLabel,
  };
});

const holisticRows = holisticData.items.map((r) => {
  const stn = getAnswer(r.answers, "signal_to_noise");
  const act = getAnswer(r.answers, "actionability");
  const ovq = getAnswer(r.answers, "overall_quality");
  return {
    ...r,
    signalToNoise: typeof stn?.score === "number" ? Number((stn.score + 1).toFixed(2)) : null,
    actionability: typeof act?.score === "number" ? Number((act.score + 1).toFixed(2)) : null,
    overallQuality: typeof ovq?.score === "number" ? Number((ovq.score + 1).toFixed(2)) : null,
  };
});

const avg = (arr) => {
  const valid = arr.filter((x) => typeof x === "number");
  return valid.length ? Number((valid.reduce((a, b) => a + b, 0) / valid.length).toFixed(3)) : null;
};
const median = (arr) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Number(((s[m - 1] + s[m]) / 2).toFixed(1));
};

function readScoredCell(caseId, arm) {
  const name = `${caseId}--${arm}.json`;
  try {
    const bytes = fs.readFileSync(path.join(resultsDir, name));
    if (manifest.cellSha256[name] !== createHash("sha256").update(bytes).digest("hex")) {
      throw new Error(`Scoring sources changed at ${name}. Prepare the batches again.`);
    }
    return JSON.parse(bytes);
  } catch (error) {
    if (!isBlind || allowInspectTest) throw error;
    try {
      fs.mkdirSync(outDir, { recursive: true });
      fs.appendFileSync(path.join(outDir, "aggregation-error.log"), `${new Date().toISOString()} ${name}: ${error}\n`, { mode: 0o600 });
    } catch {
      // Keep the diagnostic private even when the output directory is unusable.
    }
    throw new Error("Scoring sources changed or are unreadable at a blind cell. See the local aggregation error log.");
  }
}

const caseRows = [];
for (const c of cohortCases) {
  const baseH = holisticRows.find((h) => h.caseId === c.id && h.arm === "baseline");
  const armStats = {};
  for (const arm of arms) {
    const raw = readScoredCell(c.id, arm);
    const recAll = recallRows.filter((r) => r.caseId === c.id && r.arm === arm);
    const recAddr = recAll.filter(
      (r) => r.baselineStatus === "addressed" || r.baselineStatus === "deferred",
    );
    const recDecl = recAll.filter((r) => r.baselineStatus === "declined");
    const addrExact = recAddr.filter((r) => r.matchGrade === "exact_match" || r.sameRootCause).length;
    const addrPartial = recAddr.filter(
      (r) => !r.sameRootCause && r.matchGrade === "partial_match",
    ).length;
    const declRepeated = recDecl.filter(
      (r) => r.sameRootCause || r.matchGrade === "exact_match",
    ).length;
    const prec = precisionRows.filter((p) => p.caseId === c.id && p.arm === arm);
    const concrete = prec.filter((p) => p.concreteDefect).length;
    const novel = prec.filter((p) => !p.matchesBaseline);
    const novelConcrete = novel.filter((p) => p.concreteDefect).length;
    const h = holisticRows.find((x) => x.caseId === c.id && x.arm === arm);
    armStats[arm] = {
      elapsedSec: raw.elapsedSec,
      structured: raw.structured,
      approvals: raw.approvals,
      abortedOnApproval: Boolean(raw.abortedOnApproval),
      findings: raw.findingsCount,
      ledgerTotal: raw.ledger?.total ?? 0,
      ledgerKeep: raw.ledger?.keep ?? 0,
      ledgerDrop: raw.ledger?.drop ?? 0,
      ledgerPending: raw.ledger?.pending ?? 0,
      usage: raw.usage ?? null,
      addrTotal: recAddr.length,
      addrExact,
      addrPartial,
      declTotal: recDecl.length,
      declRepeated,
      concreteCount: concrete,
      unverifiedCount: Math.max(0, prec.length - concrete),
      avgDefectValue: avg(prec.map((p) => p.defectValue1to5)),
      novelCount: novel.length,
      novelConcrete,
      signalToNoise: h?.signalToNoise ?? null,
      actionability: h?.actionability ?? null,
      overallQuality: h?.overallQuality ?? null,
    };
  }
  caseRows.push({
    caseId: c.id,
    pr: c.pr,
    bucket: c.bucket,
    baselineBackend: c.backend,
    diffFiles: c.baseline.diffFiles,
    diffAdds: c.baseline.diffAdds,
    diffDels: c.baseline.diffDels,
    baseFindings: c.baseline.counts.total,
    baseAddressed: c.baseline.counts.addressed + (c.baseline.counts.deferred || 0),
    baseDeclined: c.baseline.counts.declined,
    baseSignalToNoise: baseH?.signalToNoise ?? null,
    baseActionability: baseH?.actionability ?? null,
    baseOverallQuality: baseH?.overallQuality ?? null,
    ...armStats,
  });
}

function aggregateArm(arm, filterFn = () => true) {
  const subsetCases = caseRows.filter(filterFn);
  const caseIds = new Set(subsetCases.map((c) => c.caseId));
  const recAddr = recallRows.filter(
    (r) =>
      caseIds.has(r.caseId)
      && r.arm === arm
      && (r.baselineStatus === "addressed" || r.baselineStatus === "deferred"),
  );
  const recDecl = recallRows.filter(
    (r) => caseIds.has(r.caseId) && r.arm === arm && r.baselineStatus === "declined",
  );
  const prec = precisionRows.filter((p) => caseIds.has(p.caseId) && p.arm === arm);
  const novel = prec.filter((p) => !p.matchesBaseline);
  const hol = holisticRows.filter((h) => caseIds.has(h.caseId) && h.arm === arm);

  const addrExact = recAddr.filter((r) => r.matchGrade === "exact_match" || r.sameRootCause).length;
  const addrPartial = recAddr.filter(
    (r) => !r.sameRootCause && r.matchGrade === "partial_match",
  ).length;
  const declRepeated = recDecl.filter(
    (r) => r.sameRootCause || r.matchGrade === "exact_match",
  ).length;
  const armCases = subsetCases.map((c) => c[arm]);

  const concreteTotal = prec.filter((p) => p.concreteDefect).length;
  return {
    cases: subsetCases.length,
    totalFindings: prec.length,
    meanElapsedSec: avg(armCases.map((a) => a.elapsedSec)),
    medianElapsedSec: median(armCases.map((a) => a.elapsedSec)),
    structuredRate: `${armCases.filter((a) => a.structured).length}/${armCases.length}`,
    abortedOnApprovalCount: armCases.filter((a) => a.abortedOnApproval).length,
    ledger: {
      total: armCases.reduce((s, a) => s + a.ledgerTotal, 0),
      keep: armCases.reduce((s, a) => s + a.ledgerKeep, 0),
      drop: armCases.reduce((s, a) => s + a.ledgerDrop, 0),
      pending: armCases.reduce((s, a) => s + a.ledgerPending, 0),
    },
    usage: aggregateUsage(armCases.map((a) => a.usage)),
    addressedRecall: {
      exact: addrExact,
      partial: addrPartial,
      total: recAddr.length,
      exactPct: recAddr.length ? Number(((100 * addrExact) / recAddr.length).toFixed(1)) : null,
      exactOrPartialPct: recAddr.length
        ? Number(((100 * (addrExact + addrPartial)) / recAddr.length).toFixed(1))
        : null,
      meanProb: avg(recAddr.map((r) => r.sameRootCauseProb)),
    },
    declinedRepeated: { repeated: declRepeated, total: recDecl.length },
    precision: {
      concrete: concreteTotal,
      unverifiedOrInvalid: Math.max(0, prec.length - concreteTotal),
      total: prec.length,
      concretePct: prec.length
        ? Number(((100 * concreteTotal) / prec.length).toFixed(1))
        : null,
      meanConcreteProb: avg(prec.map((p) => p.concreteDefectProb)),
      avgDefectValue: avg(prec.map((p) => p.defectValue1to5)),
    },
    novel: {
      total: novel.length,
      concrete: novel.filter((p) => p.concreteDefect).length,
      concretePct: novel.length
        ? Number(((100 * novel.filter((p) => p.concreteDefect).length) / novel.length).toFixed(1))
        : null,
      meanConcreteProb: avg(novel.map((p) => p.concreteDefectProb)),
    },
    holistic: {
      signalToNoise: avg(hol.map((h) => h.signalToNoise)),
      actionability: avg(hol.map((h) => h.actionability)),
      overallQuality: avg(hol.map((h) => h.overallQuality)),
    },
  };
}

function aggregateBaselineHolistic(filterFn = () => true) {
  const caseIds = new Set(caseRows.filter(filterFn).map((c) => c.caseId));
  const hol = holisticRows.filter((h) => caseIds.has(h.caseId) && h.arm === "baseline");
  return {
    signalToNoise: avg(hol.map((h) => h.signalToNoise)),
    actionability: avg(hol.map((h) => h.actionability)),
    overallQuality: avg(hol.map((h) => h.overallQuality)),
  };
}

// Compute union recall if both codex and neon ran
let unionRecall = null;
if (arms.includes("codex") && arms.includes("neon")) {
  const byItem = new Map();
  for (const row of recallRows) {
    if (row.baselineStatus !== "addressed" && row.baselineStatus !== "deferred") continue;
    const k = `${row.caseId}::${row.baselineItemId}`;
    if (!byItem.has(k)) byItem.set(k, {});
    byItem.get(k)[row.arm] = row.sameRootCause || row.matchGrade === "exact_match";
  }
  let both = 0;
  let codexOnly = 0;
  let neonOnly = 0;
  let neither = 0;
  for (const v of byItem.values()) {
    if (v.codex && v.neon) both += 1;
    else if (v.codex) codexOnly += 1;
    else if (v.neon) neonOnly += 1;
    else neither += 1;
  }
  const unionHit = both + codexOnly + neonOnly;
  unionRecall = {
    totalAddressed: byItem.size,
    both,
    codexOnly,
    neonOnly,
    neither,
    unionHit,
    unionPct: byItem.size ? Number(((100 * unionHit) / byItem.size).toFixed(1)) : null,
  };
}

const allBatchCosts = [recallData.totalCostUsd, precisionData.totalCostUsd, holisticData.totalCostUsd];
const totalDecisionCostUsd = allBatchCosts.every((cost) => typeof cost === "number")
  ? Number(allBatchCosts.reduce((sum, cost) => sum + cost, 0).toFixed(5))
  : null;
const observedJudgeModels = [
  ...new Set([...recallData.models, ...precisionData.models, ...holisticData.models]),
];

const aggregates = {
  all: {
    ...Object.fromEntries(arms.map((arm) => [arm, aggregateArm(arm)])),
    baselineHolistic: aggregateBaselineHolistic(),
    unionRecall,
  },
  codexBaselineCases: {
    ...Object.fromEntries(
      arms.map((arm) => [arm, aggregateArm(arm, (c) => c.baselineBackend === "codex")]),
    ),
    baselineHolistic: aggregateBaselineHolistic((c) => c.baselineBackend === "codex"),
  },
  claudeBaselineCases: {
    ...Object.fromEntries(
      arms.map((arm) => [arm, aggregateArm(arm, (c) => c.baselineBackend === "claude")]),
    ),
    baselineHolistic: aggregateBaselineHolistic((c) => c.baselineBackend === "claude"),
  },
  cleanCases: Object.fromEntries(
    arms.map((arm) => [arm, aggregateArm(arm, (c) => c.baseFindings === 0)]),
  ),
};

let runMetadata = null;
const runMetaFile = path.join(outDir, "run-meta.json");
if (fs.existsSync(runMetaFile)) {
  try {
    runMetadata = JSON.parse(fs.readFileSync(runMetaFile, "utf8"));
  } catch {
    runMetadata = null;
  }
}

const resolvedJudgeProvider = definitions.precision.provider
  ?? summary.precision?.[0]?.provider
  ?? summary.recall?.[0]?.provider
  ?? summary.holistic?.[0]?.provider
  ?? "default";

const resolvedJudgeModel = observedJudgeModels.length > 0
  ? observedJudgeModels.join(", ")
  : resolvedJudgeProvider === "openai"
    ? "gpt-6-luna"
    : resolvedJudgeProvider === "jev"
      ? "jev-latest"
      : resolvedJudgeProvider === "local"
        ? "clef-flash"
        : undefined;

const report = {
  generatedAt: new Date().toISOString(),
  cohortName: Array.isArray(rawCohort) ? path.basename(cohortPath, ".json") : rawCohort.name,
  blind: isBlind,
  ...(runMetadata ? { runMetadata } : {}),
  decisionScoring: {
    provider: resolvedJudgeProvider,
    ...(resolvedJudgeModel ? { model: resolvedJudgeModel } : {}),
    totalItems: recallRows.length + precisionRows.length + holisticRows.length,
    totalCostUsd: totalDecisionCostUsd,
    unverifiedBaselineCount,
  },
  aggregates,
  ...(isBlind && !allowInspectTest
    ? { note: "Blind test cohort: per-case and per-finding details omitted from stdout; inspect aggregates only." }
    : { cases: caseRows, recallRows, precisionRows, holisticRows }),
};

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "eval-matrix-summary.json"), `${JSON.stringify(report, null, 2)}\n`);
fs.writeFileSync(path.join(outDir, "summary.md"), renderRunSummaryMarkdown(report));

if (!isBlind || allowInspectTest) {
  const csvEsc = (v) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const findingHeader = [
    "case_id",
    "pr",
    "arm",
    "finding_idx",
    "priority",
    "title",
    "file",
    "start_line",
    "end_line",
    "matches_baseline",
    "matches_baseline_prob",
    "concrete_defect",
    "concrete_defect_prob",
    "defect_value_1to5",
    "defect_value_label",
  ];
  const findingLines = [findingHeader.join(",")];
  for (const p of precisionRows) {
    findingLines.push(
      [
        p.caseId,
        p.prNumber,
        p.arm,
        p.findingIndex + 1,
        p.priority,
        p.title,
        p.file,
        p.startLine,
        p.endLine,
        p.matchesBaseline,
        p.matchesBaselineProb,
        p.concreteDefect,
        p.concreteDefectProb,
        p.defectValue1to5,
        p.defectValueTopLabel,
      ]
        .map(csvEsc)
        .join(","),
    );
  }
  fs.writeFileSync(path.join(outDir, "eval-matrix-findings-scored.csv"), `${findingLines.join("\n")}\n`);
}

console.log("=== AGGREGATES ===");
if (unverifiedBaselineCount) {
  console.log(`[PROVISIONAL] ${unverifiedBaselineCount} development baselines lack a captured original range.`);
}
console.log(JSON.stringify(aggregates, null, 2));
console.log(`\nDecision cost: $${totalDecisionCostUsd} across ${report.decisionScoring.totalItems} items`);
if (isBlind && !allowInspectTest) {
  console.log("\n[BLIND TEST COHORT] Per-case and per-finding details suppressed to prevent overfitting.");
} else {
  console.log("\n=== PER-CASE SUMMARY ===");
  for (const c of caseRows) {
    const armParts = arms.map((arm) => {
      const a = c[arm];
      return `${arm}=${a.findings}F(${a.elapsedSec}s) rec=${a.addrExact}+${a.addrPartial}p/${a.addrTotal} conc=${a.concreteCount}/${a.findings} Q=${a.overallQuality}`;
    });
    console.log(
      `${c.caseId.padEnd(20)} | base=${c.baseAddressed}A/${c.baseDeclined}X Q=${c.baseOverallQuality} | ${armParts.join(" | ")}`,
    );
  }
}
