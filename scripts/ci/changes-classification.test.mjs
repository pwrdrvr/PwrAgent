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
  for (const name of ["code_impacting", "docs_only", "full_platforms", "a11y", "windows_e2e"]) {
    expect(outputs[name], `${name} output`).toMatch(/^(true|false)$/);
  }
  return {
    fullCi: outputs.code_impacting === "true",
    fullPlatforms: outputs.full_platforms === "true",
    a11y: outputs.a11y === "true",
    windowsE2e: outputs.windows_e2e === "true",
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
    expect(await classify([], { event })).toEqual({ fullCi: true, fullPlatforms: true, a11y: true, windowsE2e: true, lookupCalls: 0 });
  }
});

// Policy model for the cross-platform suite (macOS unit, macOS E2E, Windows
// E2E): a PR runs it only with `ci:full`, when it changes code that only a
// macOS or Windows runner exercises, or when a lookup the script cannot trust
// fails (fail open). Every other event runs it. It never runs where product
// CI does not.
const platformPaths = [
  { path: "pnpm-lock.yaml", platform: true },
  { path: "apps/desktop/e2e/get-started.spec.ts", platform: true },
  { path: "apps/desktop/e2e/fixtures/detached-profile-instances.ts", platform: true },
  { path: "apps/desktop/e2e/visual-regression.spec.ts", platform: true },
  { path: "apps/desktop/e2e/visual-regression.spec.ts-snapshots/pending-approval-darwin.webp", platform: true },
  { path: "apps/desktop/e2e/macos-window-activation.spec.ts", platform: true },
  { path: "apps/desktop/e2e/windows-titlebar-hover.spec.ts", platform: true },
  { path: "apps/desktop/native/dock-tile-plugin/main.m", platform: true },
  { path: "apps/desktop/build/icon.icon/icon.json", platform: true },
  { path: "scripts/ci/macos-e2e-run-lane.sh", platform: true },
  { path: "apps/desktop/scripts/app-icon.test.mjs", platform: true },
  { path: "apps/desktop/scripts/generate-macos-app-icon.swift", platform: true },
  { path: "apps/desktop/scripts/build-dock-tile-plugin.mjs", platform: true },
  { path: "apps/desktop/scripts/afterpack-sign-dock-tile-plugin.mjs", platform: true },
  { path: "apps/desktop/scripts/macos-dryrun-signing.test.mjs", platform: true },
  { path: "apps/desktop/scripts/assemble-mac-release.mjs", platform: true },
  { path: "apps/desktop/scripts/release.mjs", platform: false },
  { path: "apps/desktop/src/main/themed-dock-icon.swift-notes.ts", platform: false },
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

// Policy model for the accessibility audit: a PR runs `a11y.spec.ts` only with
// `ci:full` or `ci:a11y`, when it adds, edits, removes or renames that spec,
// wherever it runs the cross-platform suite, or when a lookup the script
// cannot trust fails. Every other event runs it.
it("runs the accessibility audit on PRs only when labelled, when the spec changes, or with the cross-platform suite", async () => {
  const spec = "apps/desktop/e2e/a11y.spec.ts";
  const labelSets = [[], ["ci:a11y"], ["ci:full"], ["ci:a11y", "dependencies"], ["CI:A11Y"], ["ci:a11y-ish"], ["ci:windows-package"]];
  const fileSets = [
    [{ filename: "apps/desktop/src/renderer/src/styles/app.css" }],
    [{ filename: spec }],
    [{ filename: spec, status: "removed" }],
    [{ filename: "apps/desktop/e2e/a11y-surfaces.spec.ts", previous_filename: spec, status: "renamed" }],
    [{ filename: spec, previous_filename: "apps/desktop/e2e/old-a11y.spec.ts", status: "renamed" }],
    [{ filename: "apps/desktop/e2e/thread-view.spec.ts" }, { filename: spec }],
    [{ filename: "apps/desktop/e2e/a11y.spec.ts-notes.md" }],
    [{ filename: "apps/desktop/e2e/fixtures/a11y.spec.ts" }],
    [{ filename: "pnpm-lock.yaml" }],
    [{ filename: "docs/operator.md" }],
  ];
  for (const labels of labelSets) {
    for (const files of fileSets) {
      const changesSpec = files.some((file) => file.filename === spec || file.previous_filename === spec);
      for (const failure of ["none", "labels", "files", "count"]) {
        const result = await classify(files, {
          labels,
          labelError: failure === "labels" ? new Error("labels unavailable") : undefined,
          lookupError: failure === "files" ? new Error("files unavailable") : undefined,
          reportedCount: failure === "count" ? files.length + 1 : files.length,
        });
        const name = `${labels.join("+") || "no labels"}, ${files.map((f) => f.filename).join("+")}, failure=${failure}`;
        const expected = labels.includes("ci:a11y") || labels.includes("ci:full") || changesSpec
          || failure !== "none" || result.fullPlatforms;
        expect(result.a11y, name).toBe(expected);
      }
    }
  }
});

it("runs full Windows Desktop E2E on PRs when ci:windows-e2e, ci:full, a platform path, or an untrusted lookup triggers it", async () => {
  const labelSets = [[], ["ci:windows-e2e"], ["ci:full"], ["ci:windows-e2e", "dependencies"], ["CI:WINDOWS-E2E"], ["ci:windows-e2e-ish"], ["ci:a11y"]];
  const fileSets = [
    [{ filename: "apps/desktop/src/main/index.ts" }],
    [{ filename: "apps/desktop/e2e/thread-view.spec.ts" }],
    [{ filename: "pnpm-lock.yaml" }],
    [{ filename: "docs/operator.md" }],
  ];
  for (const labels of labelSets) {
    for (const files of fileSets) {
      for (const failure of ["none", "labels", "files", "count"]) {
        const result = await classify(files, {
          labels,
          labelError: failure === "labels" ? new Error("labels unavailable") : undefined,
          lookupError: failure === "files" ? new Error("files unavailable") : undefined,
          reportedCount: failure === "count" ? files.length + 1 : files.length,
        });
        const name = `${labels.join("+") || "no labels"}, ${files.map((f) => f.filename).join("+")}, failure=${failure}`;
        const expected = labels.includes("ci:windows-e2e") || labels.includes("ci:full")
          || failure !== "none" || result.fullPlatforms;
        expect(result.windowsE2e, name).toBe(expected);
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
    /full_platforms == 'true'\n\s+\|\| needs\.changes\.outputs\.windows_e2e == 'true'\n\s+\|\| contains\(github\.event\.pull_request\.labels\.\*\.name, 'ci:windows-shutdown-diagnostics'\)\n\s+\|\| \(needs\.pr-test-impact-plan\.result == 'success'\n\s+&& needs\.pr-test-impact-plan\.outputs\.e2e_mode == 'selected'\n\s+&& needs\.pr-test-impact-plan\.outputs\.e2e_windows_lanes != ''\n\s+&& needs\.pr-test-impact-plan\.outputs\.e2e_windows_lanes != '\[\]'\)/,
  );
});

// Oracle: the required `Test` check passes only when the Linux unit lanes
// succeeded, or were skipped because the test plan succeeded and explicitly
// emitted `[]` for `unit_linux_lanes`. Run the step's actual shell.
it("accepts a skipped Test lane in the Test gate only when the test plan selected no unit test", () => {
  const gate = jobSection("test-result");
  const script = gate.split("        run: |\n")[1].split("\n").map((line) => line.slice(10)).join("\n");
  for (const testResult of ["success", "failure", "cancelled", "skipped"]) {
    for (const lanes of [undefined, "", "[]", "[1]", "[1,2,3,4]"]) {
      const env = { PATH: process.env.PATH, GITHUB_STEP_SUMMARY: "/dev/null", TEST_RESULT: testResult };
      if (lanes !== undefined) env.UNIT_LINUX_LANES = lanes;
      const run = spawnSync("bash", ["-c", script], { env, encoding: "utf8" });
      const pass = testResult === "success" || (lanes === "[]" && testResult === "skipped");
      expect(run.status === 0, `test=${testResult} lanes=${lanes}`).toBe(pass);
    }
  }
});

// Oracle: the required `Desktop E2E` check passes only when Linux succeeded,
// or was skipped because the test plan selected no spec; the accessibility
// audit succeeded, or was skipped because neither the classifier nor the
// plan asked for it; and macOS either succeeded or was skipped because the
// classifier said so. Run the step's actual shell for every result combination.
it("accepts a skipped lane in the Desktop E2E gate only when the classifier or the test plan skipped it", () => {
  const gate = jobSection("desktop-e2e-result");
  const script = gate.split("        run: |\n")[1].split("\n").map((line) => line.slice(10)).join("\n");
  const results = ["success", "failure", "cancelled", "skipped"];
  const cases = [];
  for (const linux of results) {
    for (const a11y of results) {
      for (const requested of ["true", "false"]) {
        for (const macos of results) {
          for (const full of ["true", "false"]) {
            // Unset when the plan job did not succeed, then no lane and one lane.
            for (const lanes of [undefined, "", "[]", "[1]"]) {
              cases.push({ linux, a11y, requested, macos, full, lanes });
            }
          }
        }
      }
    }
  }
  // One shell runs every case, without a subshell per case. A process per
  // case made 1,024 spawns, which took 8.6s on a GitHub-hosted macOS runner;
  // a subshell per case took 15.3s on Windows, where Git Bash emulates fork.
  // The step's one `exit` becomes `return`, so each case returns its status
  // to the driver. The program arrives on stdin: as one `-c` argument it
  // exceeds Linux's 128 KiB argument limit and Windows' command-line limit.
  const exits = script.match(/\bexit\b/g) ?? [];
  expect(exits, "the gate ends with its only exit").toHaveLength(1);
  expect(script.trimEnd().endsWith('exit "$status"')).toBe(true);
  const gateFunction = `gate() {\n${script.trimEnd().replace(/exit "\$status"$/, 'return "$status"')}\n}`;
  const runCase = ({ linux, a11y, requested, macos, full, lanes }, output) => [
    `export LINUX_E2E_RESULT='${linux}' A11Y_RESULT='${a11y}' A11Y_REQUESTED='${requested}'`,
    `export MACOS_E2E_RESULT='${macos}' FULL_PLATFORMS='${full}'`,
    lanes === undefined ? "unset E2E_LANES" : `export E2E_LANES='${lanes}'`,
    // `||` keeps a failing status from ending the driver under the step's
    // `set -e`.
    `code=0; gate < /dev/null${output} || code=$?`,
  ].join("\n");
  const runShell = (driver) => spawnSync("bash", ["-s"], {
    input: `${gateFunction}\n${driver}\n`,
    env: { PATH: process.env.PATH, GITHUB_STEP_SUMMARY: "/dev/null" },
    encoding: "utf8",
  });
  const run = runShell(cases.map((testCase, index) => `${runCase(testCase, " > /dev/null 2>&1")}\necho "${index} $code"`)
    .join("\n"));
  expect(run.status, `${run.error ?? ""}${run.stderr}`).toBe(0);
  const statuses = new Map(run.stdout.trim().split("\n").map((line) => line.split(" ").map(Number)));
  expect(statuses.size, run.stdout.slice(-500)).toBe(cases.length);
  cases.forEach((testCase, index) => {
    const { linux, a11y, requested, macos, full, lanes } = testCase;
    const pass = (linux === "success" || (lanes === "[]" && linux === "skipped"))
      && (a11y === "success" || (requested === "false" && a11y === "skipped"))
      && (macos === "success" || (full === "false" && macos === "skipped"));
    const name = `linux=${linux} a11y=${a11y} requested=${requested} macos=${macos} full=${full} lanes=${lanes}`;
    // Rerun only a mismatched case, with its output, so the failure shows
    // what the gate printed.
    const detail = (statuses.get(index) === 0) === pass ? "" : (() => {
      const single = runShell(runCase(testCase, " 2>&1"));
      return `: ${single.stdout}${single.stderr}`;
    })();
    expect(statuses.get(index) === 0, `${name}${detail}`).toBe(pass);
  });
});

it("gates the accessibility job, its required check and its flake slices on the same request", () => {
  const request = "(needs.changes.outputs.a11y == 'true' || needs.pr-test-impact-plan.outputs.e2e_a11y == 'true')";
  expect(jobSection("desktop-a11y")).toContain(`&& ${request} }}`);
  for (const job of ["desktop-e2e-result", "flake-report"]) {
    expect(jobSection(job)).toContain(`A11Y_REQUESTED: \${{ ${request} && 'true' || 'false' }}`);
  }
});

// Oracle: the flake report's not-run list must name exactly the slices whose
// jobs the `if:` conditions above skip, or a skipped platform is reported as
// missing (or a missing one is hidden). Run the step's actual shell.
it("tells the flake report exactly which gated platforms did not run", () => {
  const step = jobSection("flake-report").split("      - name: Consolidate reports\n")[1];
  const script = step.split("        run: |\n")[1].split("\n      - name:")[0]
    .split("\n").map((line) => line.slice(10)).join("\n")
    .replace(/FLAKE_NOT_RUN="\$not_run" node scripts\/ci\/write-flake-report\.mjs aggregate/, 'printf %s "$not_run"');
  expect(script).toContain('printf %s "$not_run"');
  for (const full of ["true", "false"]) {
    for (const windowsE2e of ["true", "false"]) {
      for (const diagnostics of ["true", "false"]) {
        for (const a11y of ["true", "false"]) {
          for (const windowsSelected of ["true", "false"]) {
            const run = spawnSync("bash", ["-c", script], {
              env: {
                PATH: process.env.PATH,
                FULL_PLATFORMS: full,
                WINDOWS_E2E_REQUESTED: windowsE2e,
                WINDOWS_DIAGNOSTICS: diagnostics,
                A11Y_REQUESTED: a11y,
                E2E_WINDOWS_SELECTED: windowsSelected,
              },
              encoding: "utf8",
            });
            expect(run.status, run.stderr).toBe(0);
            const ran = {
              "unit-macos": full === "true",
              "e2e-macos": full === "true",
              "e2e-windows": full === "true" || windowsE2e === "true" || diagnostics === "true" || windowsSelected === "true",
              "e2e-linux-a11y": a11y === "true",
            };
            const expected = Object.keys(ran).filter((pair) => !ran[pair]).sort();
            const name = `full=${full} windowsE2e=${windowsE2e} diagnostics=${diagnostics} a11y=${a11y} windowsSelected=${windowsSelected}`;
            expect(run.stdout, name).not.toMatch(/^,|,,|,$/);
            expect(run.stdout.split(",").filter(Boolean).sort(), name).toEqual(expected);
          }
        }
      }
    }
  }
});
