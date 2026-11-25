#!/usr/bin/env node

import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

// Reference budgets from docs/property-model-oracle-testing.md#what-to-check-in:
// - In-memory property files: under ~200 ms on Linux
// - Heavy-fixture property tests: under ~500 ms per test
export const IN_MEMORY_FILE_BUDGET_MS = 200;
export const HEAVY_TEST_BUDGET_MS = 500;
export const DEFAULT_MAX_REPORT_ROWS = 40;

const PROPERTY_TEST_FILE_PATTERN = /\.property\.test\.[cm]?[jt]sx?$/;

// Lightweight zero-dependency classifier so this report script can run in CI
// jobs (such as flake-report) that do not install node_modules.
export function detectHeavyFixturesLightweight(source) {
  const heavy = new Set();
  const childProcessMocked = /vi\.(?:do)?[Mm]ock\(\s*["'](?:node:)?child_process["']/.test(source);

  if (
    !childProcessMocked
    && (
      /(?:from|require\()\s*["'](?:node:)?child_process["']/.test(source)
      || /from\s+["'][^"']*\/outpost-daemon(?:\.[cm]?[jt]s)?["']/.test(source)
    )
  ) {
    heavy.add("child_process");
  }

  if (
    /(?:from|require\()\s*["']dugite["']/.test(source)
    || /from\s+["'][^"']*\/(?:isolated-git|managed-git-fixture)(?:\.[cm]?[jt]s)?["']/.test(source)
    || /\b(?:runIsolatedGit(?:Sync)?|GitProcess\.exec)\s*\(/.test(source)
    || (!childProcessMocked
      && /\b(?:execFile|execFileSync|spawn|spawnSync|exec|execSync)\s*\(\s*["']git(?:\.exe)?(?:\s|["'])/.test(source))
  ) {
    heavy.add("git");
  }

  if (
    /(?:from|require\()\s*["']better-sqlite3["']/.test(source)
    || /from\s+["'][^"']*\/(?:desktop-owner-fixture|built-owner-fixture|retained-owner-fixture|token-miser-test-store|messaging-[a-z-]+-harness|private-response-harness)(?:\.[cm]?[jt]s)?["']/.test(source)
    || /\b(?:new\s+StateDb|StateDb\.open|openInMemoryStateDb|createTempStateDb|openFreshStateDb|openStateDb|createStateDb|registryWithInMemoryStore)\s*\(/.test(source)
  ) {
    heavy.add("state-db");
  }

  if (
    /import\s+\{[^}]*\b(?:render|renderHook)\b[^}]*\}\s+from\s+["'](?:@testing-library\/[^"']+|[^"']*\/phase-probes(?:\.[cm]?[jt]sx?)?)["']/.test(source)
    || /import\s+\*\s+as\s+\w+\s+from\s+["']@testing-library\/react["']/.test(source)
  ) {
    heavy.add("testing-library");
  }

  return [...heavy].sort();
}

export function normalizeTimingFilePath(rawPath, repoRoot = REPO_ROOT) {
  if (typeof rawPath !== "string" || rawPath.length === 0) return "";
  const posix = rawPath.replaceAll("\\", "/");
  const normalizedRoot = repoRoot.replaceAll("\\", "/").replace(/\/+$/, "");
  if (posix.startsWith(`${normalizedRoot}/`)) {
    return posix.slice(normalizedRoot.length + 1);
  }
  const marker = /(?:^|\/)(apps\/|packages\/|scripts\/|\.agents\/)/.exec(posix);
  if (marker) {
    return posix.slice(marker.index + (marker[0].startsWith("/") ? 1 : 0));
  }
  return posix;
}

export function discoverVitestJsonReports(directory) {
  if (!directory || !existsSync(directory)) return [];
  const reports = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = path.join(fullPath, "macos-unit-results.json");
      if (existsSync(nested)) reports.push(nested);
    } else if (entry.name === "macos-unit-results.json") {
      reports.push(fullPath);
    }
  }
  return reports.sort();
}

export function classifyPropertyFile(relPath, repoRoot = REPO_ROOT) {
  const fullPath = path.resolve(repoRoot, relPath);
  if (!existsSync(fullPath)) return { kind: "in-memory", heavyFixtures: [] };
  const source = readFileSync(fullPath, "utf8");
  const heavyFixtures = detectHeavyFixturesLightweight(source);
  return {
    kind: heavyFixtures.length > 0 ? "heavy" : "in-memory",
    heavyFixtures,
  };
}

export function summarizePropertyTimings(reports, {
  repoRoot = REPO_ROOT,
  classifyFile = (relPath) => classifyPropertyFile(relPath, repoRoot),
  inMemoryFileBudgetMs = IN_MEMORY_FILE_BUDGET_MS,
  heavyTestBudgetMs = HEAVY_TEST_BUDGET_MS,
} = {}) {
  const rows = [];
  let totalPropertyFiles = 0;
  let totalPropertyMs = 0;

  for (const report of reports) {
    for (const suite of report?.testResults ?? []) {
      const relPath = normalizeTimingFilePath(suite?.name ?? "", repoRoot);
      if (!PROPERTY_TEST_FILE_PATTERN.test(relPath)) continue;

      const assertions = Array.isArray(suite.assertionResults) ? suite.assertionResults : [];
      const sumAssertionMs = assertions.reduce(
        (sum, test) => sum + (typeof test?.duration === "number" && Number.isFinite(test.duration) ? test.duration : 0),
        0,
      );
      const wallMs =
        typeof suite.startTime === "number" && typeof suite.endTime === "number" && suite.endTime >= suite.startTime
          ? suite.endTime - suite.startTime
          : sumAssertionMs;
      let slowestTestMs = 0;
      let slowestTestName = "";
      for (const test of assertions) {
        const duration = typeof test?.duration === "number" && Number.isFinite(test.duration) ? test.duration : 0;
        if (duration > slowestTestMs) {
          slowestTestMs = duration;
          slowestTestName = typeof test?.fullName === "string" ? test.fullName : "";
        }
      }

      totalPropertyFiles += 1;
      totalPropertyMs += wallMs;

      const classification = classifyFile(relPath);
      const isHeavy = classification.kind === "heavy";
      const budgetMs = isHeavy ? heavyTestBudgetMs : inMemoryFileBudgetMs;
      const measuredMs = isHeavy ? (assertions.length > 0 ? slowestTestMs : wallMs) : wallMs;

      if (measuredMs > budgetMs) {
        rows.push({
          file: relPath,
          kind: classification.kind,
          heavyFixtures: classification.heavyFixtures,
          fileMs: Math.round(wallMs),
          slowestTestMs: Math.round(slowestTestMs),
          slowestTestName,
          measuredMs: Math.round(measuredMs),
          budgetMs,
          testCount: assertions.length,
        });
      }
    }
  }

  rows.sort((left, right) => right.fileMs - left.fileMs || left.file.localeCompare(right.file));

  return {
    totalPropertyFiles,
    totalPropertyMs: Math.round(totalPropertyMs),
    overBudget: rows,
  };
}

export function formatPropertyTimingsMarkdown(summary, {
  reportFilesCount = 0,
  warnings = [],
  maxRows = DEFAULT_MAX_REPORT_ROWS,
} = {}) {
  const lines = ["### Property test timing report (macOS unit lanes, informational)", ""];

  if (reportFilesCount === 0) {
    lines.push("No `macos-unit-results.json` timing artifacts were found for this run.");
    return lines.join("\n");
  }

  const totalSeconds = (summary.totalPropertyMs / 1000).toFixed(1);
  lines.push(
    `Scanned ${summary.totalPropertyFiles} \`*.property.test.*\` file(s) across ${reportFilesCount} macOS lane artifact(s) (${totalSeconds} s total). `
      + `${summary.overBudget.length} file(s) exceeded reference budgets `
      + `(${IN_MEMORY_FILE_BUDGET_MS} ms/file in-memory, ${HEAVY_TEST_BUDGET_MS} ms/test heavy-fixture; non-gating).`,
  );

  if (warnings.length > 0) {
    lines.push("", `Warnings (${warnings.length}): ${warnings.join("; ")}`);
  }

  if (summary.overBudget.length === 0) {
    lines.push("", "All property test files were within budget.");
    return lines.join("\n");
  }

  const shown = summary.overBudget.slice(0, maxRows);
  lines.push(
    "",
    "| File | Kind | File (ms) | Slowest test (ms) | Budget (ms) | Tests |",
    "| --- | --- | ---: | ---: | ---: | ---: |",
  );
  for (const row of shown) {
    const kindLabel = row.heavyFixtures.length > 0 ? `heavy (${row.heavyFixtures.join(", ")})` : "in-memory";
    lines.push(
      `| \`${row.file}\` | ${kindLabel} | ${row.fileMs} | ${row.slowestTestMs} | ${row.budgetMs} | ${row.testCount} |`,
    );
  }
  if (summary.overBudget.length > shown.length) {
    lines.push("", `Showing top ${shown.length} of ${summary.overBudget.length} over-budget property test files.`);
  }
  return lines.join("\n");
}

function runCli(argv = process.argv.slice(2)) {
  const directory = argv[0] ?? ".local/ci/macos-unit-timings";
  const reportPaths = discoverVitestJsonReports(directory);
  const reports = [];
  const warnings = [];

  for (const reportPath of reportPaths) {
    try {
      reports.push(JSON.parse(readFileSync(reportPath, "utf8")));
    } catch (error) {
      warnings.push(`${path.basename(path.dirname(reportPath))}: ${error.message}`);
    }
  }

  const summary = summarizePropertyTimings(reports);
  const markdown = formatPropertyTimingsMarkdown(summary, {
    reportFilesCount: reports.length,
    warnings,
  });

  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n\n`);
  }
  console.log(markdown);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli();
}
