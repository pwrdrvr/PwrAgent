import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const sourcePath = /^(?:apps\/desktop\/src|packages\/.+\/src)\/.+\.[cm]?[jt]sx?$/;
const e2eDirectory = "apps/desktop/e2e/";
const e2eSpec = /^apps\/desktop\/e2e\/(?!.*\.inspect\.spec\.ts$).+\.(?:spec|test)\.[cm]?[jt]sx?$/;
const full = (reason) => ({ mode: "full", reason });
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });

function gitFiles(root, revisions) {
  const records = git(root, "diff", "--no-ext-diff", "--no-renames", "--name-status", "-z", revisions, "--")
    .split("\0").slice(0, -1);
  if (records.length % 2 !== 0) throw new Error("Malformed Git changed-file list");
  const files = [];
  for (let i = 0; i < records.length; i += 2) {
    files.push({ status: records[i], file: records[i + 1] });
  }
  return files;
}

function apiFileEntries(files) {
  const statusCodes = { added: "A", modified: "M", removed: "D", changed: "T" };
  return files.flatMap(({ filename, previous_filename, status }) => status === "renamed"
    ? [{ status: "D", file: previous_filename }, { status: "A", file: filename }]
    : [{ status: Object.hasOwn(statusCodes, status) ? statusCodes[status] : "?", file: filename }]);
}

const fileKeys = (files) => files.map(({ status, file }) => JSON.stringify([status, file])).sort();
const sameFiles = (a, b) => JSON.stringify(fileKeys(a)) === JSON.stringify(fileKeys(b));
const sha = /^[a-f0-9]{40}$/;

export function getPrDiff(root, { base, head, changedFiles }, githubFiles) {
  if (!sha.test(base) || !sha.test(head)) throw new Error("Expected immutable PR base and head SHAs");
  const merge = git(root, "rev-parse", "HEAD").trim();
  const parents = git(root, "show", "-s", "--format=%P", merge).trim().split(" ");
  const mergeBase = git(root, "merge-base", base, head).trim();
  const branchFiles = gitFiles(root, `${base}...${head}`);
  const mergeFiles = gitFiles(root, `${base}..${merge}`);
  const source = { base, head, mergeBase, merge, githubFiles, branchFiles, mergeFiles };
  if (!Array.isArray(githubFiles) || !githubFiles.length || githubFiles.length !== changedFiles) {
    return { ...source, fallback: "incomplete GitHub diff" };
  }
  if (!sameFiles(apiFileEntries(githubFiles), branchFiles)) return { ...source, fallback: "GitHub and three-dot diff disagree" };
  if (parents.length !== 2 || parents[0] !== base || parents[1] !== head) {
    return { ...source, fallback: "checkout is not the merge of the event base and head" };
  }
  if (mergeBase !== base || !sameFiles(branchFiles, mergeFiles)) {
    return { ...source, fallback: "base advanced or the merge diff differs from the PR diff" };
  }
  return source;
}

export function wholeSuiteReason(files) {
  if (!files.length) return "empty diff";
  for (const { status, file } of files) {
    if (status !== "A" && status !== "M") return "deletion, rename, type change or unsupported Git status";
    if (file === "pnpm-lock.yaml" || file === "pnpm-workspace.yaml" || /(?:^|\/)package\.json$/.test(file)
      || file.startsWith("patches/")) return "dependency metadata or patch";
    if (/^\.github\/|^scripts\/ci\/|(?:^|\/)(?:vitest|vite|playwright|tsconfig)[.-]|(?:^|\/)\.env(?:\.|$)/.test(file)) {
      return "CI or test/build configuration";
    }
    if (/^apps\/desktop\/(?:native|build)\/|^apps\/desktop\/scripts\/(?:macos-|assemble-mac-|app-icon)|\.swift$|^apps\/desktop\/e2e\/(?:macos-|windows-|visual-regression\.spec\.ts|onboarding-wizard\.spec\.ts|fixtures\/detached-profile-instances\.ts)/.test(file)) {
      return "native or platform-only input";
    }
    if (/(?:^|\/)(?:fixtures|__fixtures__|snapshots|__snapshots__|[^/]+-snapshots|generated|dist|out|resources|test-setup|setup)\/|(?:^|\/)(?:global-setup|global-teardown|setup|act-warning-runner|sqlite-write-metrics-setup)\.[cm]?[jt]s$|\.snap$/.test(file)) {
      return "fixture, generated input, snapshot or suite setup";
    }
  }
  return undefined;
}

export async function planImpact(files, { fallback, unit, e2eFiles = listE2eFiles }) {
  const reason = fallback ?? wholeSuiteReason(files);
  if (reason) return { unit: full(reason), e2e: full(reason) };

  const changed = files.map(({ file }) => file).sort();
  let e2e = full(changed.some((file) => !file.startsWith(e2eDirectory))
    ? "application impact has no explicit Playwright spec owner"
    : "non-spec Playwright input or unrecognized spec");
  if (changed.every((file) => e2eSpec.test(file))) {
    try {
      const inventory = await e2eFiles();
      e2e = changed.every((file) => inventory.includes(file))
        ? { mode: "selected", total: inventory.length, selected: changed.map((file) => ({ file, reasons: ["edited spec"] })) }
        : full("edited spec is absent from Playwright collection");
    } catch (error) {
      e2e = { ...full("Playwright collection failed"), detail: error.message };
    }
  }

  if (changed.some((file) => !sourcePath.test(file)) || changed.length > 6) {
    return { e2e, unit: full("unsupported unit input or more than six changed source files") };
  }
  try {
    return { e2e, unit: await unit(changed) };
  } catch (error) {
    return { e2e, unit: { ...full("Vitest planner error"), detail: String(error.message ?? error) } };
  }
}

export function listE2eFiles(root = process.cwd(), config = "apps/desktop/playwright.config.ts") {
  const cli = createRequire(path.resolve("apps/desktop/package.json")).resolve("@playwright/test/cli");
  const configFile = path.resolve(root, config);
  const directory = mkdtempSync(path.join(os.tmpdir(), "pr-impact-playwright-"));
  const output = path.join(directory, "collected.json");
  try {
    execFileSync(process.execPath, [cli, "test", "--list", "--reporter=json", "--config", configFile], {
      cwd: path.dirname(configFile), env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_FILE: output },
      timeout: 60_000, stdio: ["ignore", "pipe", "pipe"],
    });
    const { config: { rootDir }, suites, errors } = JSON.parse(readFileSync(output, "utf8"));
    if (errors.length || !suites.length || !path.isAbsolute(rootDir)) throw new Error("Missing or incomplete Playwright collection");
    return [...new Set(suites.map(({ file }) => path.relative(root, path.resolve(rootDir, file)).split(path.sep).join("/")))].sort();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function describeLinuxEvidence(observed) {
  if (observed.unavailable) return "evidence unavailable";
  const counts = `${observed.covered}/${observed.missed}/${observed.unknown}`;
  const missing = observed.missingLinuxSlices;
  const incomplete = observed.incompleteLinuxSlices.length;
  const errors = observed.linuxSlicesWithErrors.length;
  return missing || incomplete || errors
    ? `${counts} (partial evidence: ${missing} missing, ${incomplete} incomplete, ${errors} with errors)`
    : counts;
}

const testKey = ({ project, file }) => JSON.stringify([project, file]);

export function compareFailures(plan, report) {
  const selected = {
    unit: new Set((plan.unit.selected ?? []).map(testKey)),
    e2e: new Set((plan.e2e.selected ?? []).map(({ file }) => file)),
  };
  const slices = report.slices.filter(({ platform }) => platform === "linux");
  const cases = slices.flatMap(({ kind, key, failures }) => failures.map((failure) => {
    const outcome = !failure.file || (kind === "unit" && typeof failure.project !== "string")
      ? "unknown"
      : plan[kind].mode === "full" || selected[kind].has(kind === "unit" ? testKey(failure) : failure.file)
        ? "covered" : "missed";
    return { ...failure, slice: key, outcome };
  }));
  return {
    cases,
    covered: cases.filter(({ outcome }) => outcome === "covered").length,
    missed: cases.filter(({ outcome }) => outcome === "missed").length,
    unknown: cases.filter(({ outcome }) => outcome === "unknown").length,
    receivedLinuxSlices: slices.length,
    missingLinuxSlices: report.missingSlices.filter(({ platform }) => platform === "linux").length,
    incompleteLinuxSlices: slices.filter(({ first }) => !first.complete).map(({ key }) => key),
    linuxSlicesWithErrors: slices.filter(({ first }) => first.errors > 0).map(({ key }) => key),
  };
}
