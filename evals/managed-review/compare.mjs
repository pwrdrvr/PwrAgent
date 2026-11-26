#!/usr/bin/env node
/**
 * Compare two or more scored managed-review eval runs side-by-side.
 *
 * Usage:
 *   pnpm eval:review:compare -- evals/runs/v1.5.1 evals/runs/main evals/runs/candidate
 *   pnpm eval:review:compare -- v1.5.1=evals/runs/v1.5.1 main=evals/runs/main --slice codexBaselineCases
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { buildComparisonReport } from "../shared/report-format.mjs";

const callerCwd = process.env.INIT_CWD ? path.resolve(process.env.INIT_CWD) : process.cwd();

function stripLeadingDoubleDash(argv) {
  return argv[0] === "--" ? argv.slice(1) : argv;
}

export function loadSummaryTarget(spec) {
  let label;
  let targetPath = spec;
  const eq = spec.indexOf("=");
  if (eq > 0 && !fs.existsSync(path.resolve(callerCwd, spec))) {
    label = spec.slice(0, eq).trim();
    targetPath = spec.slice(eq + 1).trim();
  }
  const resolved = path.resolve(callerCwd, targetPath);
  const summaryPath = fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()
    ? path.join(resolved, "eval-matrix-summary.json")
    : resolved;
  if (!fs.existsSync(summaryPath)) {
    throw new Error(`Summary file not found: ${summaryPath}`);
  }
  const report = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
  const defaultLabel = report.runMetadata?.revLabel
    ? `${path.basename(path.dirname(summaryPath))} (${report.runMetadata.revLabel})`
    : path.basename(path.dirname(summaryPath));
  return {
    label: label || defaultLabel,
    summaryPath,
    report,
  };
}

function main() {
  const { values, positionals } = parseArgs({
    args: stripLeadingDoubleDash(process.argv.slice(2)),
    allowPositionals: true,
    options: {
      slice: { type: "string", default: "all" },
      json: { type: "boolean", default: false },
      out: { type: "string" },
      help: { type: "boolean", default: false },
    },
  });

  if (values.help || positionals.length === 0) {
    console.log(
      "Usage: pnpm eval:review:compare -- [label=]<run-dir|summary.json>... [--slice all|codexBaselineCases|claudeBaselineCases|cleanCases] [--json] [--out <file>]",
    );
    process.exitCode = values.help ? 0 : 1;
    return;
  }

  const entries = positionals.map(loadSummaryTarget);
  const comparison = buildComparisonReport(entries, { slice: values.slice });
  const output = values.json
    ? `${JSON.stringify(comparison, null, 2)}\n`
    : comparison.markdown;

  if (values.out) {
    const outPath = path.resolve(callerCwd, values.out);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, output);
  }
  process.stdout.write(output);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
