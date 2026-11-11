import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workflow = readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8");
const step = workflow.split("      - name: Classify changed files\n")[1].split("\n  install-deps:")[0];
const source = step.split("          script: |\n")[1].split("\n").map((line) => line.slice(12)).join("\n");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

async function classify(files, {
  event = "pull_request", reportedCount = files.length, lookupError, labels = [], labelError,
} = {}) {
  const outputs = {};
  let lookupCalls = 0;
  const summary = {
    addHeading() { return this; },
    addTable() { return this; },
    addRaw() { return this; },
    async write() {},
  };
  const listFiles = () => {};
  const listLabelsOnIssue = () => {};
  await new AsyncFunction("core", "context", "github", source)(
    { setOutput: (name, value) => { outputs[name] = value; }, notice() {}, summary },
    { eventName: event, payload: { pull_request: { changed_files: reportedCount } },
      repo: { owner: "fixture", repo: "fixture" }, issue: { number: 1 } },
    { rest: { pulls: { listFiles }, issues: { listLabelsOnIssue } }, paginate: async (method) => {
      lookupCalls++;
      if (method === listLabelsOnIssue) {
        if (labelError) throw labelError;
        return labels.map((name) => ({ name }));
      }
      if (method !== listFiles) throw new Error("unexpected lookup");
      if (lookupError) throw lookupError;
      return files;
    } },
  );
  for (const name of ["code_impacting", "docs_only", "full_platforms"]) {
    expect(outputs[name], `${name} output`).toMatch(/^(true|false)$/);
  }
  return {
    fullCi: outputs.code_impacting === "true",
    fullPlatforms: outputs.full_platforms === "true",
    lookupCalls,
  };
}

// The policy model assigns classes to fixture paths. Execute the workflow's
// actual script against every rename direction and every mixed-file pair.
const paths = [
  { path: "docs/operator.json", product: false },
  { path: "README.MD", product: false },
  { path: ".agents/skills/example/SKILL.md", product: false },
  { path: ".agents/skills/example/agents/openai.yaml", product: false },
  { path: ".agents/skills/example/scripts/tool.py", product: false },
  { path: ".agents/skills/example/tests/tool.test.mjs", product: false },
  { path: ".agents/skills-other/tool.py", product: true },
  { path: ".agents/scripts/tool.py", product: true },
  { path: "scripts/tool.test.mjs", product: true },
  { path: ".github/workflows/ci.yml", product: true },
  { path: "apps/desktop/src/main/index.ts", product: true },
  { path: "package.json", product: true },
];

it("matches the policy model for additions, modifications, deletions, renames and mixed changes", async () => {
  for (const current of paths) {
    for (const status of ["added", "modified", "removed"]) {
      expect((await classify([{ filename: current.path, status }])).fullCi,
        `${status}: ${current.path}`).toBe(current.product);
    }
    for (const previous of paths) {
      const expected = current.product || previous.product;
      expect((await classify([{ filename: current.path, previous_filename: previous.path, status: "renamed" }])).fullCi,
        `${previous.path} -> ${current.path}`).toBe(expected);
      expect((await classify([{ filename: current.path }, { filename: previous.path }])).fullCi,
        `${previous.path} + ${current.path}`).toBe(expected);
    }
  }
});

it("fails closed for missing or incomplete provider data", async () => {
  const files = [{ filename: ".agents/skills/example/tool.py" }];
  expect((await classify([])).fullCi).toBe(true);
  expect((await classify(files, { reportedCount: 2 })).fullCi).toBe(true);
  expect((await classify(files, { lookupError: new Error("provider unavailable") })).fullCi).toBe(true);
});

it("always runs full CI for non-PR events without a changed-file lookup", async () => {
  for (const event of ["push", "workflow_dispatch"]) {
    expect(await classify([], { event })).toEqual({ fullCi: true, fullPlatforms: true, lookupCalls: 0 });
  }
});

// Policy model for the cross-platform suite (macOS unit, macOS E2E, Windows
// E2E): a PR runs it only with `ci:full`, when it changes code that only a
// macOS or Windows runner exercises, or when a lookup the script cannot trust
// fails (fail open). Every other event runs it. It never runs where product
// CI does not.
const platformPaths = [
  { path: "pnpm-lock.yaml", platform: true },
  { path: "apps/desktop/e2e/visual-regression.spec.ts", platform: true },
  { path: "apps/desktop/e2e/visual-regression.spec.ts-snapshots/pending-approval-darwin.webp", platform: true },
  { path: "apps/desktop/e2e/macos-window-activation.spec.ts", platform: true },
  { path: "apps/desktop/e2e/windows-titlebar-hover.spec.ts", platform: true },
  { path: "apps/desktop/native/dock-tile-plugin/main.m", platform: true },
  { path: "apps/desktop/build/icon.icon/icon.json", platform: true },
  { path: "scripts/ci/macos-e2e-run-lane.sh", platform: true },
  { path: "apps/desktop/native/dock-tile-plugin/README.md", platform: false },
  { path: "packages/pnpm-lock.yaml", platform: false },
  { path: "apps/desktop/e2e/thread-view.spec.ts", platform: false },
  { path: "apps/desktop/src/main/index.ts", platform: false },
  { path: "scripts/ci/flake-report.mjs", platform: false },
  { path: ".github/workflows/ci.yml", platform: false },
  { path: "docs/operator.md", platform: false },
];
const isDoc = (path) => path.startsWith("docs/") || path.toLowerCase().endsWith(".md");

it("runs the cross-platform suite for changes that only macOS or Windows runners exercise", async () => {
  for (const current of platformPaths) {
    for (const previous of [undefined, ...platformPaths]) {
      const file = { filename: current.path, ...(previous ? { previous_filename: previous.path } : {}) };
      const expected = current.platform || previous?.platform === true;
      const name = `${previous?.path ?? "(new)"} -> ${current.path}`;
      expect((await classify([file])).fullPlatforms, name).toBe(expected);
      expect((await classify([file, { filename: "apps/desktop/src/main/index.ts" }])).fullPlatforms, name).toBe(expected);
    }
  }
});

it("runs the cross-platform suite on PRs only with ci:full or when a lookup is untrustworthy", async () => {
  const labelSets = [[], ["ci:full"], ["ci:windows-package"], ["ci:full", "dependencies"], ["CI:FULL"], ["ci:full-ish"]];
  const fileSets = [
    [{ filename: "apps/desktop/src/main/index.ts" }],
    [{ filename: "docs/operator.md" }],
    [{ filename: "docs/operator.md" }, { filename: "package.json" }],
    [{ filename: "docs/operator.md" }, { filename: "pnpm-lock.yaml" }],
  ];
  for (const labels of labelSets) {
    const labelled = labels.includes("ci:full");
    for (const files of fileSets) {
      const product = files.some(({ filename }) => !isDoc(filename));
      const platform = files.some(({ filename }) => platformPaths.find((p) => p.path === filename)?.platform);
      for (const failure of ["none", "labels", "files", "count"]) {
        const result = await classify(files, {
          labels,
          labelError: failure === "labels" ? new Error("labels unavailable") : undefined,
          lookupError: failure === "files" ? new Error("files unavailable") : undefined,
          reportedCount: failure === "count" ? files.length + 1 : files.length,
        });
        const untrusted = failure !== "none";
        const name = `${labels.join("+") || "no labels"}, ${files.map((f) => f.filename).join("+")}, failure=${failure}`;
        expect(result.fullPlatforms, name).toBe(labelled || untrusted || platform);
        expect(result.fullCi, name).toBe(product || labelled || untrusted);
        if (result.fullPlatforms) expect(result.fullCi, name).toBe(true);
      }
    }
  }
});

it("reads labels live rather than from the event payload", () => {
  expect(source).toContain("github.rest.issues.listLabelsOnIssue");
  expect(source).not.toMatch(/payload\.pull_request\.labels/);
});

const jobSection = (job) => workflow.split(`\n  ${job}:\n`)[1].split(/\n  [a-z][a-z0-9-]*:\n/)[0];

it("gates every cross-platform job on the classifier and nothing else on it", () => {
  const gated = ["macos-install-deps", "test-macos", "desktop-e2e-macos", "windows-e2e"];
  const jobs = [...workflow.matchAll(/\n  ([a-z][a-z0-9-]*):\n/g)].map((match) => match[1])
    .filter((job) => job !== "changes");
  for (const job of jobs) {
    const condition = jobSection(job).match(/\n    if: (>-\n(?:      .*\n)+|.*\n)/)?.[1] ?? "";
    expect(condition.includes("needs.changes.outputs.full_platforms == 'true'"), job).toBe(gated.includes(job));
  }
  expect(jobSection("windows-e2e")).toMatch(
    /full_platforms == 'true'\n\s+\|\| contains\(github\.event\.pull_request\.labels\.\*\.name, 'ci:windows-shutdown-diagnostics'\)/,
  );
});

// Oracle: the required `Desktop E2E` check passes only when Linux succeeded
// and macOS either succeeded or was skipped because the classifier said so.
// Run the step's actual shell for every result combination.
it("accepts a skipped macOS lane in the Desktop E2E gate only when the classifier skipped it", () => {
  const gate = jobSection("desktop-e2e-result");
  const script = gate.split("        run: |\n")[1].split("\n").map((line) => line.slice(10)).join("\n");
  const results = ["success", "failure", "cancelled", "skipped"];
  for (const linux of results) {
    for (const macos of results) {
      for (const full of ["true", "false"]) {
        const run = spawnSync("bash", ["-c", script], {
          env: { PATH: process.env.PATH, LINUX_E2E_RESULT: linux, MACOS_E2E_RESULT: macos, FULL_PLATFORMS: full,
            GITHUB_STEP_SUMMARY: "/dev/null" },
          encoding: "utf8",
        });
        const pass = linux === "success" && (macos === "success" || (full === "false" && macos === "skipped"));
        expect(run.status === 0, `linux=${linux} macos=${macos} full=${full}: ${run.stdout}${run.stderr}`).toBe(pass);
      }
    }
  }
});
