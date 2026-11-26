function fmtNum(value, digits = 1) {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "-";
}

function fmtInt(value) {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value).toLocaleString("en-US") : "-";
}

function fmtTokens(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}

function fmtUsd(value, digits = 3) {
  return typeof value === "number" && Number.isFinite(value) ? `$${value.toFixed(digits)}` : "-";
}

function fmtPct(value) {
  return typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(1)}%` : "-";
}

function fmtDelta(candidate, baseline, formatter = (v) => v.toFixed(1)) {
  if (typeof candidate !== "number" || typeof baseline !== "number"
    || !Number.isFinite(candidate) || !Number.isFinite(baseline)) {
    return "";
  }
  const diff = candidate - baseline;
  if (Math.abs(diff) < 1e-9) return " (0)";
  const sign = diff > 0 ? "+" : "-";
  return ` (${sign}${formatter(Math.abs(diff))})`;
}

/**
 * Compute aggregate metrics for one arm in a summary report.
 */
export function extractArmRow(label, arm, stats, judgeCostUsd = null) {
  const totalFindings = stats.totalFindings ?? 0;
  const concreteFindings = stats.precision?.concrete ?? 0;
  const unverifiedFindings = Math.max(0, totalFindings - concreteFindings);
  const novelTotal = stats.novel?.total ?? 0;
  const novelVerified = stats.novel?.concrete ?? 0;
  const usage = stats.usage ?? null;
  return {
    label,
    arm,
    cases: stats.cases ?? 0,
    structuredRate: stats.structuredRate ?? "-",
    recallExact: stats.addressedRecall?.exact ?? null,
    recallExactOrPartial: stats.addressedRecall
      ? (stats.addressedRecall.exact ?? 0) + (stats.addressedRecall.partial ?? 0)
      : null,
    recallTotal: stats.addressedRecall?.total ?? null,
    recallExactPct: stats.addressedRecall?.exactPct ?? null,
    recallExactOrPartialPct: stats.addressedRecall?.exactOrPartialPct ?? null,
    declinedRepeated: stats.declinedRepeated?.repeated ?? null,
    declinedTotal: stats.declinedRepeated?.total ?? null,
    totalFindings,
    concreteFindings,
    concretePct: stats.precision?.concretePct ?? null,
    newVerifiedIssues: novelVerified,
    novelTotal,
    unverifiedOrInvalid: unverifiedFindings,
    holisticQuality: stats.holistic?.overallQuality ?? null,
    signalToNoise: stats.holistic?.signalToNoise ?? null,
    actionability: stats.holistic?.actionability ?? null,
    meanElapsedSec: stats.meanElapsedSec ?? null,
    medianElapsedSec: stats.medianElapsedSec ?? null,
    totalReplays: usage?.totalReplayCount ?? null,
    coldReplays: usage?.coldReplayCount ?? null,
    hotReplays: usage?.hotReplayCount ?? null,
    meanReplays: usage?.meanReplayCount ?? null,
    uncachedInputTokens: usage?.uncachedInputTokens ?? null,
    cachedInputTokens: usage?.cachedInputTokens ?? null,
    cacheWriteInputTokens: usage?.cacheWriteInputTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
    reasoningOutputTokens: usage?.reasoningOutputTokens ?? null,
    totalTokens: usage?.totalTokens ?? null,
    maxPeakContextTokens: usage?.maxPeakContextTokens ?? null,
    reviewerCostUsd: usage?.estimatedCostUsd ?? null,
    judgeCostUsd,
  };
}

/**
 * Render a concise Markdown scorecard for one scored evaluation run.
 * Respects `report.blind`: never emits per-case or per-finding details for blind cohorts.
 */
export function renderRunSummaryMarkdown(report) {
  const lines = [
    `# Managed Review Eval Summary — ${report.cohortName ?? "cohort"}`,
    "",
    `- **Generated**: ${report.generatedAt}`,
    `- **Blind holdout**: ${report.blind ? "yes (aggregates only)" : "no"}`,
  ];
  if (report.runMetadata) {
    if (report.runMetadata.revLabel) lines.push(`- **Revision**: \`${report.runMetadata.revLabel}\``);
    if (report.runMetadata.prompt) {
      lines.push(`- **Prompt override**: \`${report.runMetadata.prompt.shortHash}\` (${report.runMetadata.prompt.words} words)`);
    }
  }
  if (report.decisionScoring) {
    lines.push(
      `- **Judge**: \`${report.decisionScoring.provider}\`${report.decisionScoring.model ? ` (${report.decisionScoring.model})` : ""} · ${report.decisionScoring.totalItems} items · ${fmtUsd(report.decisionScoring.totalCostUsd, 4)}`,
    );
    if (report.decisionScoring.unverifiedBaselineCount) {
      lines.push(`- **Provisional**: ${report.decisionScoring.unverifiedBaselineCount} development baseline(s) lack a verified original range.`);
    }
  }
  lines.push("");

  const all = report.aggregates?.all ?? {};
  const arms = Object.keys(all).filter((key) => key !== "baselineHolistic" && key !== "unionRecall");
  lines.push("## Quality & Efficiency (All Cases)", "");
  lines.push(
    "| Arm | Cases | Recall (Exact / +Part) | New Verified | Unverified/Invalid | Declined Rep | Holistic Q | Mean / Med Time | Replays (Cold/Hot) | Uncached In | Cached In | Output (Reas) | Total Tokens | Est. List Cost |",
  );
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");

  for (const arm of arms) {
    const row = extractArmRow(report.cohortName ?? "run", arm, all[arm], report.decisionScoring?.totalCostUsd ?? null);
    const recallCell = row.recallTotal
      ? `${row.recallExact}/${row.recallTotal} (${fmtPct(row.recallExactPct)}) / ${fmtPct(row.recallExactOrPartialPct)}`
      : "-";
    const replayCell = row.totalReplays !== null
      ? `${fmtInt(row.totalReplays)} (${fmtInt(row.coldReplays)}/${fmtInt(row.hotReplays)})`
      : "-";
    const outCell = row.outputTokens !== null
      ? `${fmtTokens(row.outputTokens)}${row.reasoningOutputTokens ? ` (${fmtTokens(row.reasoningOutputTokens)})` : ""}`
      : "-";
    lines.push(
      `| ${arm} | ${row.cases} (${row.structuredRate}) | ${recallCell} | ${row.newVerifiedIssues}/${row.novelTotal} | ${row.unverifiedOrInvalid}/${row.totalFindings} | ${row.declinedRepeated ?? "-"}/${row.declinedTotal ?? "-"} | ${fmtNum(row.holisticQuality, 2)} | ${fmtNum(row.meanElapsedSec, 1)}s / ${fmtNum(row.medianElapsedSec, 1)}s | ${replayCell} | ${fmtTokens(row.uncachedInputTokens)} | ${fmtTokens(row.cachedInputTokens)} | ${outCell} | ${fmtTokens(row.totalTokens)} | ${fmtUsd(row.reviewerCostUsd)} |`,
    );
  }

  if (all.baselineHolistic) {
    lines.push(
      "",
      `Baseline holistic averages: quality=${fmtNum(all.baselineHolistic.overallQuality, 2)}, signal/noise=${fmtNum(all.baselineHolistic.signalToNoise, 2)}, actionability=${fmtNum(all.baselineHolistic.actionability, 2)}.`,
    );
  }
  if (all.unionRecall) {
    lines.push(
      `Union recall (codex + neon): ${all.unionRecall.unionHit}/${all.unionRecall.totalAddressed} (${fmtPct(all.unionRecall.unionPct)}) — both=${all.unionRecall.both}, codexOnly=${all.unionRecall.codexOnly}, neonOnly=${all.unionRecall.neonOnly}, neither=${all.unionRecall.neither}.`,
    );
  }

  if (report.blind) {
    lines.push("", "_Blind holdout cohort: per-case and per-finding details are suppressed._");
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Compare multiple scored runs side-by-side. If any input run is marked blind,
 * strictly suppresses all per-case and per-finding details.
 */
export function buildComparisonReport(entries, { slice = "all" } = {}) {
  const anyBlind = entries.some((entry) => Boolean(entry.report.blind));
  const rows = [];
  for (const entry of entries) {
    const sliceObj = entry.report.aggregates?.[slice] ?? {};
    const arms = Object.keys(sliceObj).filter((key) => key !== "baselineHolistic" && key !== "unionRecall");
    for (const arm of arms) {
      rows.push(extractArmRow(entry.label, arm, sliceObj[arm], entry.report.decisionScoring?.totalCostUsd ?? null));
    }
  }

  const baselineByArm = new Map();
  if (entries.length > 1) {
    const firstLabel = entries[0].label;
    for (const row of rows) {
      if (row.label === firstLabel && !baselineByArm.has(row.arm)) {
        baselineByArm.set(row.arm, row);
      }
    }
  }

  const lines = [
    `# Eval Comparison (${slice})`,
    "",
    anyBlind
      ? "_Blind holdout detected in one or more runs: reporting aggregate metrics only._"
      : `Comparing ${entries.length} run(s). Deltas shown relative to \`${entries[0]?.label ?? "baseline"}\` on matching arms.`,
    "",
    "| Run | Arm | Recall (Exact) | New Verified | Unverified/Invalid | Declined Rep | Holistic Q | Mean Time | Replays | Total Tokens (Uncached / Cached / Out) | Est. List Cost |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];

  for (const row of rows) {
    const base = row.label === entries[0]?.label ? undefined : baselineByArm.get(row.arm);
    const recallCell = row.recallExactPct !== null
      ? `${fmtPct(row.recallExactPct)}${base ? fmtDelta(row.recallExactPct, base.recallExactPct, (v) => `${v.toFixed(1)}pp`) : ""}`
      : "-";
    const newVerifiedCell = `${row.newVerifiedIssues}/${row.novelTotal}${base ? fmtDelta(row.newVerifiedIssues, base.newVerifiedIssues, (v) => String(Math.round(v))) : ""}`;
    const invalidCell = `${row.unverifiedOrInvalid}/${row.totalFindings}${base ? fmtDelta(row.unverifiedOrInvalid, base.unverifiedOrInvalid, (v) => String(Math.round(v))) : ""}`;
    const qCell = `${fmtNum(row.holisticQuality, 2)}${base ? fmtDelta(row.holisticQuality, base.holisticQuality, (v) => v.toFixed(2)) : ""}`;
    const timeCell = `${fmtNum(row.meanElapsedSec, 1)}s${base ? fmtDelta(row.meanElapsedSec, base.meanElapsedSec, (v) => `${v.toFixed(1)}s`) : ""}`;
    const replayCell = row.totalReplays !== null
      ? `${fmtInt(row.totalReplays)}${base ? fmtDelta(row.totalReplays, base.totalReplays, (v) => String(Math.round(v))) : ""}`
      : "-";
    const tokenCell = row.totalTokens !== null
      ? `${fmtTokens(row.totalTokens)} (${fmtTokens(row.uncachedInputTokens)} / ${fmtTokens(row.cachedInputTokens)} / ${fmtTokens(row.outputTokens)})`
      : "-";
    const costCell = `${fmtUsd(row.reviewerCostUsd)}${base ? fmtDelta(row.reviewerCostUsd, base.reviewerCostUsd, (v) => `$${v.toFixed(3)}`) : ""}`;
    lines.push(
      `| ${row.label} | ${row.arm} | ${recallCell} | ${newVerifiedCell} | ${invalidCell} | ${row.declinedRepeated ?? "-"}/${row.declinedTotal ?? "-"} | ${qCell} | ${timeCell} | ${replayCell} | ${tokenCell} | ${costCell} |`,
    );
  }

  return {
    generatedAt: new Date().toISOString(),
    slice,
    blind: anyBlind,
    runs: entries.map((e) => ({
      label: e.label,
      cohortName: e.report.cohortName ?? null,
      blind: Boolean(e.report.blind),
      judgeProvider: e.report.decisionScoring?.provider ?? null,
    })),
    rows,
    markdown: `${lines.join("\n")}\n`,
  };
}
