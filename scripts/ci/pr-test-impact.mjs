import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

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
  const testedRange = `${stacked ? testedBase : base}..${merge}`;
  const mergeFiles = gitFiles(root, testedRange);
  // The tested merge is the base tip plus this PR. Its first-parent diff is
  // what the PR changes there, including on a branch behind its base: a test
  // that reaches none of those files runs the same code as on the base tip.
  const source = {
    base, head, mergeBase, merge, testedBase, stacked, behindBase: mergeBase !== base,
    githubFiles, branchFiles, mergeFiles,
  };
  if (!Array.isArray(githubFiles) || !githubFiles.length || githubFiles.length !== changedFiles) {
    return { ...source, fallback: "incomplete GitHub diff" };
  }
  if (!sameFiles(apiFileEntries(githubFiles), branchFiles)) return { ...source, fallback: "GitHub and three-dot diff disagree" };
  if (parents.length !== 2 || (!stacked && testedBase !== base) || parents[1] !== head) {
    return { ...source, fallback: "checkout is not the merge of the event base and head" };
  }
  if (stacked) {
    if (mergeBase !== base || !sameFiles(branchFiles, mergeFiles)) {
      return { ...source, fallback: "stack base advanced or the merge diff differs from the PR diff" };
    }
    const patch = (range) => git(root, "diff", "--no-ext-diff", "--no-renames", "--binary", range, "--");
    if (patch(`${base}..${head}`) !== patch(testedRange)) {
      return { ...source, fallback: "tested stack merge changed the child patch" };
    }
  }
  return source;
}

const nonProduct = (file) => file.startsWith("docs/") || file.toLowerCase().endsWith(".md") || file.startsWith(".agents/skills/");

export function wholeSuiteReason(files) {
  if (!files.length) return "empty diff";
  for (const { status, file } of files) {
    if (status !== "A" && status !== "M" && status !== "D") return "type change or unsupported Git status";
    if (file === "pnpm-lock.yaml" || file === "pnpm-workspace.yaml" || /(?:^|\/)package\.json$/.test(file)
      || file.startsWith("patches/")) return "dependency metadata or patch";
    if (/^\.github\/|^scripts\/ci\/|(?:^|\/)(?:vitest|vite|playwright|tsconfig)[.-]|(?:^|\/)\.env(?:\.|$)/.test(file)) {
      return "CI or test/build configuration";
    }
    if (/^apps\/desktop\/(?:native|build)\/|^apps\/desktop\/scripts\/(?:macos-|assemble-mac-|app-icon)|\.swift$|^apps\/desktop\/e2e\/(?:macos-|windows-|visual-regression\.spec\.ts|onboarding-wizard\.spec\.ts|fixtures\/detached-profile-instances\.ts)/.test(file)) {
      return "native or platform-only input";
    }
  }
  return undefined;
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
  // A module is named by its path without extension, `index` by its directory.
  const needle = (file) => {
    const stem = path.posix.basename(file).replace(codeFile, "");
    return `/${stem === "index" ? path.posix.basename(path.posix.dirname(file)) : stem}`;
  };
  return (changed) => {
    const seen = new Set([changed]);
    const queue = [changed];
    const specs = new Set();
    let suite = false;
    while (queue.length) {
      const name = needle(queue.pop());
      if (configText.includes(name)) suite = true;
      for (const [file, text] of texts) {
        if (seen.has(file) || !text.includes(name)) continue;
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
  return {
    mode: "selected",
    total: files.length,
    selected: [...reasons].sort(([a], [b]) => a.localeCompare(b, "en")).map(([file, why]) => ({ file, reasons: why })),
  };
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
  "windows-main": { config: "vitest.workspace.mts", lanes: 2, projects: ["desktop-main"] },
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
