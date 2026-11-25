#!/usr/bin/env node
/**
 * Prepare diff-grounded Decision-model scoring batches (recall, precision,
 * blinded holistic) and <=37 KiB chunks ready for PwrAgent's `decisions_invoke`.
 *
 * Usage:
 *   node .agents/skills/managed-review-eval/scripts/prepare-scoring-batches.mjs \
 *     --repo /path/to/PwrAgnt \
 *     --cohort .agents/skills/managed-review-eval/cohorts/dev-1.json \
 *     --results .local/managed-review-eval/runs/dev-1/results \
 *     --out .local/managed-review-eval/runs/dev-1/scoring
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function parseArg(name, fallback) {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && idx + 1 < process.argv.length) {
    return process.argv[idx + 1];
  }
  return fallback;
}

const repoCwd = path.resolve(parseArg("--repo", process.cwd()));
const cohortPath = path.resolve(parseArg("--cohort", ""));
const resultsDir = path.resolve(parseArg("--results", ""));
const scoringDir = path.resolve(parseArg("--out", ""));
const remote = parseArg("--remote", "origin");
const arms = parseArg("--arms", "codex,neon")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (!cohortPath || !resultsDir || !scoringDir) {
  throw new Error("Required flags: --cohort <file> --results <dir> --out <dir>");
}

fs.mkdirSync(scoringDir, { recursive: true });
const rawCohort = JSON.parse(fs.readFileSync(cohortPath, "utf8"));
const cohortCases = Array.isArray(rawCohort) ? rawCohort : rawCohort.cases;

function relPath(p) {
  if (!p) return "";
  const normalized = p.replace(/\\/g, "/");
  for (const marker of ["/PwrAgnt/", "/PwrAgent/"]) {
    const idx = normalized.lastIndexOf(marker);
    if (idx >= 0) return normalized.slice(idx + marker.length);
  }
  return normalized.replace(/^\/+/, "");
}

function ensureCommit(prNumber, sha) {
  try {
    execFileSync("git", ["-C", repoCwd, "cat-file", "-e", `${sha}^{commit}`], {
      stdio: "ignore",
    });
    return;
  } catch {
    // fetch from permanent PR ref
  }
  try {
    execFileSync(
      "git",
      ["-C", repoCwd, "fetch", "--no-tags", "--no-write-fetch-head", remote, `refs/pull/${prNumber}/head`],
      { stdio: "ignore" },
    );
  } catch {
    // ignore
  }
}

function getFileDiffExcerpt(baseCommit, headCommit, filePath, startLine, maxChars = 1600) {
  const rel = relPath(filePath);
  if (!rel) return "(no file path specified)";
  try {
    const diff = execFileSync(
      "git",
      ["-C", repoCwd, "diff", "-U3", `${baseCommit}..${headCommit}`, "--", rel],
      { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
    );
    if (!diff.trim()) {
      try {
        const content = execFileSync(
          "git",
          ["-C", repoCwd, "show", `${headCommit}:${rel}`],
          { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
        );
        const lines = content.split("\n");
        const s = Math.max(1, (startLine || 1) - 15);
        const e = Math.min(lines.length, s + 40);
        const snippet = lines.slice(s - 1, e).map((l, i) => `${s + i}: ${l}`).join("\n");
        return `[File not in diff; showing ${rel}:${s}-${e} at head]\n${snippet.slice(0, maxChars)}`;
      } catch {
        return `(file ${rel} not present in diff or headCommit)`;
      }
    }
    if (diff.length <= maxChars) return diff;
    if (startLine) {
      const hunks = diff.split(/(?=^@@ )/m);
      const header = hunks[0] ?? "";
      let best = hunks[1] ?? "";
      let bestDist = Infinity;
      for (const h of hunks.slice(1)) {
        const m = h.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
        if (m) {
          const hs = Number(m[1]);
          const he = hs + Number(m[2] ?? 1);
          const dist =
            startLine >= hs && startLine <= he
              ? 0
              : Math.min(Math.abs(startLine - hs), Math.abs(startLine - he));
          if (dist < bestDist) {
            bestDist = dist;
            best = h;
          }
        }
      }
      const focused = `${header}${best}`;
      if (focused.length <= maxChars) return focused;
      return `${focused.slice(0, maxChars)}\n... [truncated]`;
    }
    return `${diff.slice(0, maxChars)}\n... [truncated]`;
  } catch (err) {
    return `(git diff unavailable: ${String(err).slice(0, 120)})`;
  }
}

function fmtFindingShort(f, idx) {
  const file = relPath(f.code_location?.absolute_file_path ?? f.file ?? "");
  const lr = f.code_location?.line_range;
  const lines = lr
    ? `${lr.start}-${lr.end}`
    : f.startLine
      ? `${f.startLine}${f.endLine && f.endLine !== f.startLine ? `-${f.endLine}` : ""}`
      : "";
  const prio = typeof f.priority === "number" ? `P${f.priority}` : "P?";
  return `[#${idx + 1} ${prio}] ${f.title} (${file}${lines ? `:${lines}` : ""})\n${(f.body || "").slice(0, 700)}`;
}

const recallMeta = [];
const recallInputs = [];
const precisionMeta = [];
const precisionInputs = [];
const holisticMeta = [];
const holisticInputs = [];

for (const c of cohortCases) {
  ensureCommit(c.pr, c.baseline.baseCommit);
  ensureCommit(c.pr, c.baseline.headCommit);

  const resultsByArm = {};
  for (const arm of arms) {
    resultsByArm[arm] = JSON.parse(
      fs.readFileSync(path.join(resultsDir, `${c.id}--${arm}.json`), "utf8"),
    );
  }

  for (let bi = 0; bi < c.baseline.items.length; bi += 1) {
    const b = c.baseline.items[bi];
    const bLoc = `${relPath(b.file)}${b.startLine ? `:${b.startLine}${b.endLine && b.endLine !== b.startLine ? `-${b.endLine}` : ""}` : ""}`;
    for (const arm of arms) {
      const res = resultsByArm[arm];
      const candList = res.findings.length
        ? res.findings.map((f, idx) => fmtFindingShort(f, idx)).join("\n\n")
        : "(Candidate review reported 0 findings.)";
      recallMeta.push({
        index: recallInputs.length,
        caseId: c.id,
        prNumber: c.pr,
        baselineBucket: c.bucket,
        baselineBackend: c.backend,
        baselineItemId: b.id,
        baselineIndex: bi,
        baselineStatus: b.status,
        baselinePriority: b.priority,
        baselineTitle: b.title,
        arm,
      });
      recallInputs.push({
        pr: `PR #${c.pr}: ${c.baseline.prTitle ?? c.id}`,
        baseline: {
          title: b.title,
          loc: bLoc,
          p: b.priority,
          body: (b.body || "").slice(0, 450),
        },
        candidate_findings: candList
          .split("\n\n")
          .map((block) => block.slice(0, 320))
          .join("\n---\n"),
      });
    }
  }

  const baselineSummary = c.baseline.items.length
    ? c.baseline.items
        .map(
          (b, i) =>
            `[B${i + 1} status=${b.status} P${b.priority ?? "?"}] ${b.title} (${relPath(b.file)}:${b.startLine ?? "?"}): ${(b.body || "").slice(0, 220)}`,
        )
        .join("\n")
    : "(Baseline review reported 0 findings — clean PR.)";

  for (const arm of arms) {
    const res = resultsByArm[arm];
    for (let fi = 0; fi < res.findings.length; fi += 1) {
      const f = res.findings[fi];
      const fPath = f.code_location?.absolute_file_path ?? "";
      const fStart = f.code_location?.line_range?.start ?? null;
      const fEnd = f.code_location?.line_range?.end ?? null;
      const diffExcerpt = getFileDiffExcerpt(
        c.baseline.baseCommit,
        c.baseline.headCommit,
        fPath,
        fStart,
        950,
      );
      precisionMeta.push({
        index: precisionInputs.length,
        caseId: c.id,
        prNumber: c.pr,
        baselineBucket: c.bucket,
        baselineBackend: c.backend,
        arm,
        findingIndex: fi,
        title: f.title,
        priority: f.priority ?? null,
        confidence: f.confidence_score ?? null,
        file: relPath(fPath),
        startLine: fStart,
        endLine: fEnd,
      });
      precisionInputs.push({
        pr: `PR #${c.pr}: ${c.baseline.prTitle ?? c.id} (${c.baseline.diffFiles} files, +${c.baseline.diffAdds}/-${c.baseline.diffDels})`,
        finding: {
          title: f.title,
          p: f.priority,
          loc: `${relPath(fPath)}${fStart ? `:${fStart}${fEnd && fEnd !== fStart ? `-${fEnd}` : ""}` : ""}`,
          body: (f.body || "").slice(0, 600),
        },
        baseline_findings: baselineSummary,
        diff: diffExcerpt,
      });
    }
  }

  const armsForHolistic = [
    {
      arm: "baseline",
      findingsCount: c.baseline.items.length,
      overallCorrectness:
        c.baseline.items.length === 0 ? "patch is correct" : "patch is incorrect",
      overallExplanation: "(baseline review)",
      findingsText: c.baseline.items.length
        ? c.baseline.items.map((b, i) => fmtFindingShort(b, i)).join("\n\n")
        : "(0 findings reported — reviewer judged patch clean.)",
    },
    ...arms.map((arm) => {
      const r = resultsByArm[arm];
      return {
        arm,
        findingsCount: r.findingsCount,
        overallCorrectness: r.overallCorrectness ?? "",
        overallExplanation: (r.overallExplanation ?? "").slice(0, 300),
        findingsText: r.findings.length
          ? r.findings.map((f, i) => fmtFindingShort(f, i)).join("\n\n")
          : "(0 findings reported — reviewer judged patch clean.)",
      };
    }),
  ];

  for (const h of armsForHolistic) {
    holisticMeta.push({
      index: holisticInputs.length,
      caseId: c.id,
      prNumber: c.pr,
      baselineBucket: c.bucket,
      baselineBackend: c.backend,
      arm: h.arm,
      findingsCount: h.findingsCount,
    });
    holisticInputs.push({
      pr: `PR #${c.pr}: ${c.baseline.prTitle ?? c.id} (${c.baseline.diffFiles} files, +${c.baseline.diffAdds}/-${c.baseline.diffDels})`,
      verdict: h.overallCorrectness,
      summary: h.overallExplanation,
      count: h.findingsCount,
      findings: h.findingsText
        .split("\n\n")
        .map((b) => b.slice(0, 320))
        .join("\n---\n")
        .slice(0, 2800),
    });
  }
}

function writeChunks(name, items, chunkSize) {
  const chunks = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    const slice = items.slice(i, i + chunkSize);
    const file = path.join(scoringDir, `${name}-chunk-${chunks.length}.json`);
    fs.writeFileSync(file, JSON.stringify(slice));
    chunks.push({ file, start: i, count: slice.length, bytes: fs.statSync(file).size });
  }
  return chunks;
}

fs.writeFileSync(path.join(scoringDir, "recall-meta.json"), JSON.stringify(recallMeta, null, 2));
fs.writeFileSync(path.join(scoringDir, "precision-meta.json"), JSON.stringify(precisionMeta, null, 2));
fs.writeFileSync(path.join(scoringDir, "holistic-meta.json"), JSON.stringify(holisticMeta, null, 2));

const manifest = {
  arms,
  recall: writeChunks("recall", recallInputs, 8),
  precision: writeChunks("precision", precisionInputs, 8),
  holistic: writeChunks("holistic", holisticInputs, 12),
};
fs.writeFileSync(
  path.join(scoringDir, "chunks-manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);

console.log(
  JSON.stringify(
    {
      recall: {
        items: recallInputs.length,
        chunks: manifest.recall.length,
        maxBytes: Math.max(0, ...manifest.recall.map((c) => c.bytes)),
      },
      precision: {
        items: precisionInputs.length,
        chunks: manifest.precision.length,
        maxBytes: Math.max(0, ...manifest.precision.map((c) => c.bytes)),
      },
      holistic: {
        items: holisticInputs.length,
        chunks: manifest.holistic.length,
        maxBytes: Math.max(0, ...manifest.holistic.map((c) => c.bytes)),
      },
    },
    null,
    2,
  ),
);
