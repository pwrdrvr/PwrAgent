import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import desktopE2eTimings from "../../docs/desktop-e2e-shard-durations.json" with { type: "json" };

const codeFile = /\.[cm]?[jt]sx?$/;
// Unit-test inputs that the application bundle never loads.
export const testSidePath = /(?:^|\/)(?:__tests__|test-setup)\/|\.test\.[cm]?[jt]sx?$/;
const e2eDirectory = "apps/desktop/e2e/";
const e2eSpec = /^apps\/desktop\/e2e\/(?!.*\.inspect\.spec\.ts$).+\.(?:spec|test)\.[cm]?[jt]sx?$/;
const full = (reason, file) => ({ mode: "full", reason, ...(file ? { file } : {}) });
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
const patch = (root, range) => git(root, "diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--binary", range, "--");
const isAncestor = (root, ancestor, descendant) => {
  try {
    git(root, "merge-base", "--is-ancestor", ancestor, descendant);
    return true;
  } catch (error) {
    if (error.status === 1) return false;
    throw error;
  }
};

export function getPushDiff(root, { before, after, forced }) {
  if (forced !== false || !sha.test(before) || !sha.test(after) || /^0+$/.test(before)
    || git(root, "rev-parse", "HEAD").trim() !== after || !isAncestor(root, before, after)) {
    return { before, after, fallback: "checkout is not a verified fast-forward push" };
  }
  return { before, after, mergeFiles: gitFiles(root, `${before}..${after}`) };
}

export function getPrDiff(root, { base, head, changedFiles }, githubFiles) {
  if (!sha.test(base) || !sha.test(head)) throw new Error("Expected immutable PR base and head SHAs");
  const merge = git(root, "rev-parse", "HEAD").trim();
  const parents = git(root, "show", "-s", "--format=%P", merge).trim().split(" ");
  const mergeBase = git(root, "merge-base", base, head).trim();
  const branchFiles = gitFiles(root, `${base}...${head}`);
  const testedBase = parents[0];
  // GitHub stacks can first merge the declared base into trunk, then
  // merge the child into that synthetic first parent.
  const stacked = parents.length === 2 && parents[1] === head && testedBase !== base
    && git(root, "show", "-s", "--format=%P", testedBase).trim().split(" ").length === 2
    && git(root, "rev-parse", `${testedBase}^2`).trim() === base;
  const movedBase = parents.length === 2 && parents[1] === head && testedBase !== base && !stacked
    && isAncestor(root, base, testedBase);
  const testedRange = `${stacked || movedBase ? testedBase : base}..${merge}`;
  const mergeFiles = gitFiles(root, testedRange);
  // The tested merge is the base tip plus this PR. Its first-parent diff is
  // what the PR changes there, including on a branch behind its base: a test
  // that reaches none of those files runs the same code as on the base tip.
  const source = {
    base, head, mergeBase, merge, testedBase, stacked, movedBase, behindBase: mergeBase !== base,
    githubFiles, branchFiles, mergeFiles,
  };
  if (!Array.isArray(githubFiles) || !githubFiles.length || githubFiles.length !== changedFiles) {
    return { ...source, fallback: "incomplete GitHub diff" };
  }
  if (!sameFiles(apiFileEntries(githubFiles), branchFiles)) return { ...source, fallback: "GitHub and three-dot diff disagree" };
  if (parents.length !== 2 || (!stacked && !movedBase && testedBase !== base) || parents[1] !== head) {
    return { ...source, fallback: "checkout is not the merge of the event base and head" };
  }
  if (stacked) {
    if (mergeBase !== base || !sameFiles(branchFiles, mergeFiles)) {
      return { ...source, fallback: "stack base advanced or the merge diff differs from the PR diff" };
    }
    if (patch(root, `${base}..${head}`) !== patch(root, testedRange)) {
      return { ...source, fallback: "tested stack merge changed the child patch" };
    }
  }
  if (movedBase && (!sameFiles(branchFiles, mergeFiles)
    || patch(root, `${mergeBase}..${head}`) !== patch(root, testedRange))) {
    return { ...source, fallback: "advanced base changed the tested PR patch" };
  }
  return source;
}

const nonProduct = (file) => file.startsWith("docs/") || file.toLowerCase().endsWith(".md") || file.startsWith(".agents/skills/");

export function wholeSuiteReason(files) {
  if (!files.length) return "empty diff";
  for (const { status, file } of files) {
    if (status !== "A" && status !== "M" && status !== "D") return "type change or unsupported Git status";
    if (file === "pnpm-lock.yaml" || file === "pnpm-workspace.yaml" || /(?:^|\/)package\.json$/.test(file)
      || /^\.(?:npmrc|nvmrc|pnpmfile\.cjs)$/.test(file) || file.startsWith("patches/")) return "dependency metadata or patch";
    if (file === "docs/desktop-e2e-shard-durations.json"
      || /^\.github\/|^scripts\/ci\/|(?:^|\/)(?:electron\.)?(?:vitest|vite|playwright|tsconfig)[.-]|(?:^|\/)\.env(?:\.|$)/.test(file)) {
      return "CI or test/build configuration";
    }
    if (/^apps\/desktop\/(?:native|build)\/|^apps\/desktop\/scripts\/(?:macos-|assemble-mac-|app-icon)|\.swift$|^apps\/desktop\/e2e\/(?:macos-|windows-|visual-regression\.spec\.ts|get-started\.spec\.ts|fixtures\/detached-profile-instances\.ts)/.test(file)) {
      return "native or platform-only input";
    }
  }
  return undefined;
}

/**
 * Whether a text names a file in a string: a data file by its basename, a
 * module by its path without extension or by its basename, and an `index`
 * module by its directory.
 */
export function namesFile(file) {
  const base = path.posix.basename(file);
  const stem = base.replace(codeFile, "");
  if (stem === base) return (text) => text.includes(base);
  if (stem === "index") {
    const directory = `/${path.posix.basename(path.posix.dirname(file))}`;
    return (text) => text.includes(directory);
  }
  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const named = new RegExp(`/${escape(stem)}|(?<![\\w.-])${escape(base)}`);
  return (text) => named.test(text);
}

/**
 * Follows string references through the Playwright directory. A spec can
 * reach a helper without importing it: several drivers are bundled or
 * spawned by path, and Playwright records neither.
 */
export function harnessReferences(root = process.cwd(), config = "apps/desktop/playwright.config.ts") {
  const texts = new Map();
  for (const entry of readdirSync(path.join(root, e2eDirectory), { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !codeFile.test(entry.name)) continue;
    const file = path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join("/");
    texts.set(file, readFileSync(path.join(root, file), "utf8"));
  }
  const configText = readFileSync(path.join(root, config), "utf8");
  return (changed) => {
    const seen = new Set([changed]);
    const queue = [changed];
    const specs = new Set();
    let suite = false;
    while (queue.length) {
      const named = namesFile(queue.pop());
      if (named(configText)) suite = true;
      for (const [file, text] of texts) {
        if (seen.has(file) || !named(text)) continue;
        seen.add(file);
        if (/(?:^|\/)global-(?:setup|teardown)\./.test(file)) suite = true;
        else if (e2eSpec.test(file)) specs.add(file);
        else queue.push(file);
      }
    }
    return { specs: [...specs], suite };
  };
}

/**
 * Playwright launches the built application, and no recorded map says which
 * specs execute a given product module. Only a diff confined to unit tests
 * and the E2E harness narrows, to the specs that Playwright's import
 * tracking or a string reference connects to a changed file.
 */
export async function planE2e(changes, { inventory, affected, testOnly = () => false, harness = () => ({ specs: [], suite: false }) }) {
  const reasons = new Map();
  const select = (file, reason) => reasons.set(file, [...new Set([...reasons.get(file) ?? [], reason])]);
  for (const { status, file } of changes) {
    const inside = file.startsWith(e2eDirectory);
    if (inside && (status === "D" || !codeFile.test(file))) return full("deleted or non-module Playwright input", file);
    if (inside && /(?:^|\/)global-(?:setup|teardown)\./.test(file)) return full("Playwright suite setup or configuration input", file);
    if (!inside && (!testSidePath.test(file) || !await testOnly(file))) {
      return full("application impact has no recorded Playwright spec owner", file);
    }
    if (e2eSpec.test(file)) {
      select(file, "edited spec");
      continue;
    }
    const { specs, suite } = harness(file);
    if (suite) return full("Playwright suite setup or configuration input", file);
    // Nothing names this harness file, so nothing says which specs load it.
    if (inside && !specs.length) return full("Playwright harness file has no spec owner", file);
    specs.forEach((spec) => select(spec, "names a changed file"));
  }
  let files;
  try {
    files = await inventory();
    for (const spec of await affected()) if (!reasons.has(spec)) select(spec, "imports a changed file");
  } catch (error) {
    return { ...full("Playwright collection failed"), detail: error.message };
  }
  const missing = [...reasons.keys()].find((file) => !files.includes(file));
  if (missing) return full("edited spec is absent from Playwright collection", missing);
  const ambiguous = [...reasons.keys()].find((file) => !playwrightListPath(file));
  if (ambiguous) return full("spec path cannot be represented in a Playwright test list", ambiguous);
  // One lane runs a narrowed plan. A wider selection needs the full suite's
  // four balanced lanes.
  if (reasons.size > Math.ceil(files.length / 4)) return full("selection is wider than one Playwright lane");
  return {
    mode: "selected",
    total: files.length,
    selected: [...reasons].sort(([a], [b]) => a.localeCompare(b, "en")).map(([file, why]) => ({ file, reasons: why })),
  };
}

// The accessibility audit runs in its own CI job (`desktop-a11y`), never in a
// Desktop E2E lane. A narrowed plan that selects it leaves it out of the
// lane's specs and asks that job to run instead.
export const a11ySpec = "apps/desktop/e2e/a11y.spec.ts";

export function separateA11y(e2e) {
  if (e2e.mode !== "selected") return { e2e, a11y: false };
  return {
    e2e: { ...e2e, selected: e2e.selected.filter(({ file }) => file !== a11ySpec) },
    a11y: e2e.selected.some(({ file }) => file === a11ySpec),
  };
}

const range = (count) => Array.from({ length: count }, (_, index) => index + 1);

// Full Windows lanes model about eight minutes of tests. Leave the rest
// of the fifteen-minute job for setup, reporting, retries, and runner variance.
const windowsE2eTestBudgetSeconds = 8 * 60;
const windowsTimingColumn = desktopE2eTimings.platforms.indexOf("windows");
const windowsE2eSecondsBySpec = new Map();
for (const { spec, seconds } of desktopE2eTimings.groups) {
  const duration = seconds[windowsTimingColumn];
  const file = `${e2eDirectory}${spec}`;
  const estimate = Number.isFinite(duration) && duration >= 0 ? duration : Infinity;
  windowsE2eSecondsBySpec.set(file, (windowsE2eSecondsBySpec.get(file) ?? 0) + estimate);
}

// Every matrix and the retry report consume the same lane inventory.
export function scheduleImpact(plan, { allPlatforms, windowsFull, auditRequested, e2eOnly }) {
  const { e2e, a11y } = separateA11y(plan.e2e);
  const unit = (group) => range(plan.unit.mode === "selected"
    ? unitLaneCount(unitGroupFiles(plan.unit.selected, group).length, group)
    : unitGroups[group].lanes);
  const e2eLanes = (suite, fullLanes) => suite.mode === "full" ? range(fullLanes) : range(suite.selected.length ? 1 : 0);
  const nativeE2e = allPlatforms ? plan.e2e : e2e;
  let windowsMode = "off";
  if (windowsFull || ((allPlatforms || e2eOnly) && nativeE2e.mode === "full")) {
    windowsMode = "full";
  } else if (nativeE2e.mode === "selected" && nativeE2e.selected.length) {
    const seconds = nativeE2e.selected.reduce((sum, { file }) => sum + (windowsE2eSecondsBySpec.get(file) ?? Infinity), 0);
    windowsMode = seconds <= windowsE2eTestBudgetSeconds ? "selected" : "full";
  }
  return {
    e2e,
    nativeE2e,
    windowsMode,
    a11y,
    lanes: {
      "unit-linux": unit("linux"),
      "unit-windows-main": unit("windows-main"),
      "unit-windows-renderer": unit("windows-renderer"),
      "unit-macos": allPlatforms ? unit("macos") : [],
      "e2e-linux": e2eLanes(e2e, 4),
      "e2e-linux-a11y": a11y || auditRequested || (allPlatforms && e2e.mode === "full") ? [1, 2] : [],
      "e2e-windows": windowsMode === "full" ? range(4) : windowsMode === "selected" ? [1] : [],
      "e2e-macos": allPlatforms ? e2eLanes(nativeE2e, 5) : [],
    },
  };
}

// The pinned Playwright test-list format uses paths relative to its root,
// with optional title and location delimiters. Ambiguous names widen E2E.
export function playwrightListPath(file) {
  if (!file.startsWith(e2eDirectory)) return undefined;
  const relative = file.slice(e2eDirectory.length);
  return relative && relative === relative.trim() && !/^[#\[]|[>:›\\\r\n]/u.test(relative) ? relative : undefined;
}

export async function planImpact(files, { fallback, unit, e2e }) {
  const reason = fallback ?? wholeSuiteReason(files);
  if (reason) return { unit: full(reason), e2e: full(reason) };
  const changes = files.filter(({ file }) => !nonProduct(file)).sort((a, b) => a.file.localeCompare(b.file, "en"));
  const guarded = async (name, planner) => {
    if (!changes.length) return full("no product input");
    try {
      return await planner(changes);
    } catch (error) {
      return { ...full(`${name} planner error`), detail: String(error.message ?? error) };
    }
  };
  return {
    unit: await guarded("Vitest", unit),
    e2e: await guarded("Playwright", (input) => planE2e(input, e2e)),
  };
}

function listPlaywright(root, config, extra) {
  const cli = createRequire(path.resolve("apps/desktop/package.json")).resolve("@playwright/test/cli");
  const configFile = path.resolve(root, config);
  const directory = mkdtempSync(path.join(os.tmpdir(), "pr-impact-playwright-"));
  const output = path.join(directory, "collected.json");
  try {
    execFileSync(process.execPath, [cli, "test", "--list", "--reporter=json", "--config", configFile, ...extra], {
      cwd: path.dirname(configFile), env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_FILE: output },
      timeout: 60_000, stdio: ["ignore", "pipe", "pipe"],
    });
    const { config: { rootDir }, suites, errors } = JSON.parse(readFileSync(output, "utf8"));
    if (errors.length || !path.isAbsolute(rootDir)) throw new Error("Missing or incomplete Playwright collection");
    return [...new Set(suites.map(({ file }) => path.relative(root, path.resolve(rootDir, file)).split(path.sep).join("/")))].sort();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function listE2eFiles(root = process.cwd(), config = "apps/desktop/playwright.config.ts") {
  const files = listPlaywright(root, config, []);
  if (!files.length) throw new Error("Missing or incomplete Playwright collection");
  return files;
}

// Playwright's own `--only-changed`: specs that changed since `base`, or
// whose imports reach a file that did.
export function listAffectedE2eFiles(root, base, config = "apps/desktop/playwright.config.ts") {
  return listPlaywright(root, config, [`--only-changed=${base}`, "--pass-with-no-tests"]);
}

// The jobs that run unit tests. Windows splits the projects it collects
// across two jobs; Linux runs every project in one.
export const unitGroups = {
  linux: { config: "vitest.linux-ci.mts", lanes: 4 },
  macos: { config: "vitest.workspace.mts", lanes: 4 },
  "windows-main": { config: "vitest.workspace.mts", lanes: 4, projects: ["desktop-main"] },
  "windows-renderer": {
    config: "vitest.workspace.mts", lanes: 2,
    projects: ["desktop-renderer", "desktop-renderer-node", "messaging", "owner-core", "shared"],
  },
};

export const unitGroupFiles = (selected, group) => selected.filter(({ project }) => !unitGroups[group].projects
  || unitGroups[group].projects.includes(project));

// A lane holds about 150 selected files. A group never uses more lanes than
// its full run does, so a wide selection is no slower than the full suite.
export const unitLaneCount = (files, group) => Math.min(unitGroups[group].lanes, Math.ceil(files / 150));
