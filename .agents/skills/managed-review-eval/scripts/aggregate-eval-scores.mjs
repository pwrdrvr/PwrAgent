#!/usr/bin/env node
/**
 * Aggregate PwrAgent Decision-model scoring batches (`decisions_invoke` JSONL
 * files or workflow child transcript fallback) into eval summary JSON and CSVs.
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
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
const workflowLogPath = parseArg("--workflow-log", "");
const brainDir = parseArg("--brain-dir", path.join(os.homedir(), ".gemini/antigravity-cli/brain"));
const allowInspectTest = process.argv.includes("--allow-inspect-test");

if (!cohortPath || !resultsDir || !scoringDir) {
  throw new Error("Required flags: --cohort <file> --results <dir> --scoring <dir>");
}

const rawCohort = JSON.parse(fs.readFileSync(cohortPath, "utf8"));
const isBlind = !Array.isArray(rawCohort) && Boolean(rawCohort.blind);
const cohortCases = Array.isArray(rawCohort) ? rawCohort : rawCohort.cases;

const summary = JSON.parse(
  fs.readFileSync(path.join(scoringDir, "decision-batches-summary.json"), "utf8"),
);
const manifest = JSON.parse(
  fs.readFileSync(path.join(scoringDir, "chunks-manifest.json"), "utf8"),
);
const arms = manifest.arms ?? ["codex", "neon"];
const recallMeta = JSON.parse(fs.readFileSync(path.join(scoringDir, "recall-meta.json"), "utf8"));
const precisionMeta = JSON.parse(
  fs.readFileSync(path.join(scoringDir, "precision-meta.json"), "utf8"),
);
const holisticMeta = JSON.parse(
  fs.readFileSync(path.join(scoringDir, "holistic-meta.json"), "utf8"),
);

const childConvByKey = new Map();
if (workflowLogPath && fs.existsSync(workflowLogPath)) {
  const wfText = fs.readFileSync(workflowLogPath, "utf8");
  for (const m of wfText.matchAll(/Score (recall|precision|holistic) #(\d+): done \(([0-9a-f-]+)\)/g)) {
    childConvByKey.set(`${m[1]}:${m[2]}`, m[3]);
  }
}

function loadChunkItems(chunk) {
  if (chunk.resultsFile && fs.existsSync(chunk.resultsFile)) {
    const lines = fs.readFileSync(chunk.resultsFile, "utf8").trim().split("\n");
    const items = [];
    for (const line of lines) {
      const row = JSON.parse(line);
      if (row.type === "item") {
        items.push({
          localIndex: row.index,
          ok: row.ok,
          answers: row.response?.answers ?? [],
          costUsd: row.usage?.estimatedCostUsd ?? 0,
        });
      }
    }
    items.sort((a, b) => a.localIndex - b.localIndex);
    return items;
  }

  const childId = childConvByKey.get(`${chunk.batchType}:${chunk.chunkIndex}`);
  if (!childId) {
    throw new Error(
      `Missing resultsFile (${chunk.resultsFile}) and no --workflow-log fallback for ${chunk.batchType}#${chunk.chunkIndex}`,
    );
  }
  const transcriptPath = path.join(brainDir, childId, ".system_generated/logs/transcript_full.jsonl");
  const lines = fs.readFileSync(transcriptPath, "utf8").trim().split("\n");
  for (const line of lines) {
    if (!line.includes(chunk.batchId)) continue;
    const step = JSON.parse(line);
    const walk = (obj) => {
      if (typeof obj === "string") {
        if (obj.includes(chunk.batchId) && obj.includes('"results"')) {
          try {
            const startBrace = obj.indexOf("{");
            const parsed = JSON.parse(startBrace >= 0 ? obj.slice(startBrace) : obj);
            if (parsed.batchId === chunk.batchId && Array.isArray(parsed.results)) {
              return parsed;
            }
          } catch {
            // ignore
          }
        }
        return null;
      }
      if (obj && typeof obj === "object") {
        for (const v of Object.values(obj)) {
          const found = walk(v);
          if (found) return found;
        }
      }
      return null;
    };
    const found = walk(step);
    if (found) {
      return found.results
        .map((r) => ({
          localIndex: r.index,
          ok: r.ok,
          answers: r.answers ?? r.response?.answers ?? [],
          costUsd: r.usage?.estimatedCostUsd ?? 0,
        }))
        .sort((a, b) => a.localIndex - b.localIndex);
    }
  }
  throw new Error(`Could not recover batch ${chunk.batchId} from ${transcriptPath}`);
}

function getAnswer(answers, name) {
  return answers.find((a) => a.name === name);
}

function loadAllFor(batchType, metaList) {
  const chunks = summary[batchType] ?? [];
  const merged = new Array(metaList.length);
  let totalCostUsd = 0;
  for (const chunk of chunks) {
    totalCostUsd += chunk.estimatedCostUsd ?? 0;
    const items = loadChunkItems(chunk);
    if (items.length !== chunk.count) {
      throw new Error(
        `Count mismatch for ${batchType}#${chunk.chunkIndex}: got ${items.length}, expected ${chunk.count}`,
      );
    }
    for (const item of items) {
      const globalIdx = chunk.start + item.localIndex;
      merged[globalIdx] = {
        ...metaList[globalIdx],
        ok: item.ok,
        answers: item.answers,
      };
    }
  }
  const missing = merged.filter((x) => !x).length;
  if (missing > 0) throw new Error(`Missing ${missing} items in ${batchType}`);
  return { items: merged, totalCostUsd };
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

const caseRows = [];
for (const c of cohortCases) {
  const baseH = holisticRows.find((h) => h.caseId === c.id && h.arm === "baseline");
  const armStats = {};
  for (const arm of arms) {
    const raw = JSON.parse(
      fs.readFileSync(path.join(resultsDir, `${c.id}--${arm}.json`), "utf8"),
    );
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
      findings: raw.findingsCount,
      ledgerTotal: raw.ledger?.total ?? 0,
      ledgerKeep: raw.ledger?.keep ?? 0,
      ledgerDrop: raw.ledger?.drop ?? 0,
      ledgerPending: raw.ledger?.pending ?? 0,
      addrTotal: recAddr.length,
      addrExact,
      addrPartial,
      declTotal: recDecl.length,
      declRepeated,
      concreteCount: concrete,
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

  return {
    cases: subsetCases.length,
    totalFindings: prec.length,
    meanElapsedSec: avg(armCases.map((a) => a.elapsedSec)),
    medianElapsedSec: median(armCases.map((a) => a.elapsedSec)),
    structuredRate: `${armCases.filter((a) => a.structured).length}/${armCases.length}`,
    ledger: {
      total: armCases.reduce((s, a) => s + a.ledgerTotal, 0),
      keep: armCases.reduce((s, a) => s + a.ledgerKeep, 0),
      drop: armCases.reduce((s, a) => s + a.ledgerDrop, 0),
      pending: armCases.reduce((s, a) => s + a.ledgerPending, 0),
    },
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
      concrete: prec.filter((p) => p.concreteDefect).length,
      total: prec.length,
      concretePct: prec.length
        ? Number(((100 * prec.filter((p) => p.concreteDefect).length) / prec.length).toFixed(1))
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

const totalDecisionCostUsd = Number(
  (recallData.totalCostUsd + precisionData.totalCostUsd + holisticData.totalCostUsd).toFixed(5),
);

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

const report = {
  generatedAt: new Date().toISOString(),
  cohortName: Array.isArray(rawCohort) ? path.basename(cohortPath, ".json") : rawCohort.name,
  blind: isBlind,
  decisionScoring: {
    model: "gpt-6-luna",
    totalItems: recallRows.length + precisionRows.length + holisticRows.length,
    totalCostUsd: totalDecisionCostUsd,
  },
  aggregates,
  ...(isBlind && !allowInspectTest
    ? { note: "Blind test cohort: per-case and per-finding details omitted from stdout; inspect aggregates only." }
    : { cases: caseRows, recallRows, precisionRows, holisticRows }),
};

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "eval-matrix-summary.json"), `${JSON.stringify(report, null, 2)}\n`);

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
