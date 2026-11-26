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
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { reviewedMergeBase } from "./review-range.mjs";

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
const unverifiedBaselineCount = cohortCases.filter(({ baseline }) => baseline.reviewedRangeVerified !== true).length;
if (unverifiedBaselineCount && (rawCohort.blind || !process.argv.includes("--allow-legacy-baselines"))) {
  throw new Error(`Cohort contains ${unverifiedBaselineCount} baseline(s) without a verified original range.`);
}
const definitionsFile = new URL("./scoring-definitions.json", import.meta.url);
const definitionSha256 = createHash("sha256").update(fs.readFileSync(definitionsFile)).digest("hex");

const repoRoot = fs.realpathSync(repoCwd);

function relPath(value, workspacePath) {
  if (typeof value !== "string" || !value) return "";
  let relative = value;
  if (path.isAbsolute(value)) {
    const roots = typeof workspacePath === "string" && path.isAbsolute(workspacePath)
      ? [workspacePath]
      : [repoCwd, repoRoot];
    relative = roots.map((root) => path.relative(root, value)).find((candidate) =>
      candidate && !path.isAbsolute(candidate)
      && candidate !== ".." && !candidate.startsWith(`..${path.sep}`)) ?? "";
  } else if (path.win32.isAbsolute(value)) {
    return "";
  }
  const portable = path.posix.normalize(relative.replace(/\\/g, "/"));
  return !relative || portable === "." || portable === ".." || portable.startsWith("../") ? "" : portable;
}

function centeredExcerpt(text, center, limit) {
  const buffer = Math.max(0, limit - 12);
  const start = Math.max(0, Math.min(center - Math.floor(buffer / 2), text.length - buffer));
  return `${start > 0 ? "...\n" : ""}${text.slice(start, start + buffer)}${start + buffer < text.length ? "\n..." : ""}`;
}

function excerptAtHeadLine(diff, startLine, limit) {
  if (diff.length <= limit) return diff;
  if (!Number.isInteger(startLine)) return centeredExcerpt(diff, 0, limit);
  let best;
  for (const hunk of diff.split(/(?=^@@ )/m).slice(1)) {
    const header = hunk.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@[^\n]*\n/);
    if (!header) continue;
    const body = hunk.slice(header[0].length);
    let headLine = Number(header[1]);
    let offset = 0;
    for (const line of body.split("\n")) {
      if (line.startsWith("+") || line.startsWith(" ")) {
        const distance = Math.abs(headLine - startLine);
        if (!best || distance < best.distance) best = { body, offset, distance };
        headLine += 1;
      }
      offset += line.length + 1;
    }
  }
  if (!best) return centeredExcerpt(diff, 0, limit);
  // Preserve the cited line even when its hunk starts thousands of lines earlier.
  return centeredExcerpt(best.body, best.offset, limit);
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

function getFileDiffExcerpt(baseCommit, headCommit, rel, startLine, maxChars = 1600) {
  if (!rel) return "(no file path specified)";
  try {
    const diff = execFileSync(
      "git",
      [
        "-C", repoCwd, "--literal-pathspecs", "diff", "--no-ext-diff", "--no-textconv",
        "-U3", `${baseCommit}..${headCommit}`, "--", rel,
      ],
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
    return excerptAtHeadLine(diff, startLine, maxChars);
  } catch {
    return "(Git diff unavailable)";
  }
}

function fmtFindingShort(f, idx, workspacePath) {
  const file = relPath(f.code_location?.absolute_file_path ?? f.file, workspacePath);
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

  const mergeBase = reviewedMergeBase(repoCwd, c.baseline.baseCommit, c.baseline.headCommit);
  const resultsByArm = {};
  for (const arm of arms) {
    const file = path.join(resultsDir, `${c.id}--${arm}.json`);
    const res = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
    if (res?.status !== "completed" || res.structured !== true || !Array.isArray(res.findings)
      || res.findingsCount !== res.findings.length
      || (res.mergeBaseCommit !== undefined && res.mergeBaseCommit !== mergeBase)
      || (res.headCommit !== undefined && res.headCommit !== c.baseline.headCommit)) {
      throw new Error(`Review matrix is incomplete or has a different snapshot at ${rawCohort.blind ? "a blind cell" : `${c.id}/${arm}`}`);
    }
    resultsByArm[arm] = res;
  }

  for (let bi = 0; bi < c.baseline.items.length; bi += 1) {
    const b = c.baseline.items[bi];
    const bLoc = `${relPath(b.file)}${b.startLine ? `:${b.startLine}${b.endLine && b.endLine !== b.startLine ? `-${b.endLine}` : ""}` : ""}`;
    for (const arm of arms) {
      const res = resultsByArm[arm];
      const candList = res.findings.length
        ? res.findings.map((f, idx) => fmtFindingShort(f, idx, res.workspacePath)).join("\n\n")
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
      const fPath = relPath(f.code_location?.absolute_file_path ?? f.file, res.workspacePath);
      const fStart = f.code_location?.line_range?.start ?? null;
      const fEnd = f.code_location?.line_range?.end ?? null;
      const diffExcerpt = getFileDiffExcerpt(
        mergeBase,
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
        file: fPath,
        startLine: fStart,
        endLine: fEnd,
      });
      precisionInputs.push({
        pr: `PR #${c.pr}: ${c.baseline.prTitle ?? c.id} (${c.baseline.diffFiles} files, +${c.baseline.diffAdds}/-${c.baseline.diffDels})`,
        finding: {
          title: f.title,
          p: f.priority,
          loc: `${fPath}${fStart ? `:${fStart}${fEnd && fEnd !== fStart ? `-${fEnd}` : ""}` : ""}`,
          body: (f.body || "").slice(0, 600),
        },
        baseline_findings: baselineSummary,
        diff: diffExcerpt,
      });
    }
  }

  const armsForHolistic = [
    { arm: "baseline", findings: c.baseline.items },
    ...arms.map((arm) => ({
      arm, findings: resultsByArm[arm].findings, workspacePath: resultsByArm[arm].workspacePath,
    })),
  ];

  for (const { arm, findings, workspacePath } of armsForHolistic) {
    holisticMeta.push({
      index: holisticInputs.length,
      caseId: c.id,
      prNumber: c.pr,
      baselineBucket: c.bucket,
      baselineBackend: c.backend,
      arm,
      findingsCount: findings.length,
    });
    holisticInputs.push({
      pr: `PR #${c.pr}: ${c.baseline.prTitle ?? c.id} (${c.baseline.diffFiles} files, +${c.baseline.diffAdds}/-${c.baseline.diffDels})`,
      count: findings.length,
      findings: findings.map((finding, index) => fmtFindingShort(finding, index, workspacePath).slice(0, 320))
        .join("\n---\n")
        .slice(0, 2800),
    });
  }
}

function planChunks(name, items, maxItems) {
  const maxBytes = 37 * 1024;
  const chunks = [];
  let parts = [];
  let bytes = 2;
  let start = 0;

  function flush() {
    const data = `[${parts.join(",")}]`;
    chunks.push({
      file: path.join(scoringDir, `${name}-chunk-${chunks.length}.json`),
      start, count: parts.length, bytes,
      inputsSha256: createHash("sha256").update(data).digest("hex"),
      data,
    });
    start += parts.length;
    parts = [];
    bytes = 2;
  }

  for (const [index, item] of items.entries()) {
    const json = JSON.stringify(item);
    const itemBytes = Buffer.byteLength(json);
    if (itemBytes + 2 > maxBytes) {
      throw new Error(`${name} input ${index} exceeds the 37 KiB scoring chunk budget on its own.`);
    }
    if (parts.length && (parts.length === maxItems || bytes + itemBytes + 1 > maxBytes)) flush();
    bytes += itemBytes + (parts.length ? 1 : 0);
    parts.push(json);
  }
  if (parts.length) flush();
  return chunks;
}

const plans = {
  recall: planChunks("recall", recallInputs, 8),
  precision: planChunks("precision", precisionInputs, 8),
  holistic: planChunks("holistic", holisticInputs, 12),
};
const manifest = { arms, definitionSha256, unverifiedBaselineCount };
for (const [name, chunks] of Object.entries(plans)) {
  manifest[name] = chunks.map(({ data, ...chunk }) => {
    fs.writeFileSync(chunk.file, data);
    return chunk;
  });
}

fs.writeFileSync(path.join(scoringDir, "recall-meta.json"), JSON.stringify(recallMeta, null, 2));
fs.writeFileSync(path.join(scoringDir, "precision-meta.json"), JSON.stringify(precisionMeta, null, 2));
fs.writeFileSync(path.join(scoringDir, "holistic-meta.json"), JSON.stringify(holisticMeta, null, 2));

fs.copyFileSync(definitionsFile, path.join(scoringDir, "scoring-definitions.json"));
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
