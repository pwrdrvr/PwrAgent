import { test } from "vitest";
import assert from "node:assert/strict";
import { createSlice, aggregateSlices, expectedSlices } from "./flake-report.mjs";

const unit = (tests, complete = true) => ({ complete, reason: "failed", unhandledErrors: 0, completion: { reportedTests: tests.length }, suites: [{ project: "desktop-main", file: "/repo/a.test.ts", errors: 0, tests }] });
const item = (id, state) => ({ id, name: `suite > ${id}`, state, completed: true });

test("each initially failed unit test has its own retry outcome regardless of report order", () => {
  const initial = unit([item("a", "failed"), item("b", "failed"), item("c", "passed")]);
  for (const reports of [[unit([item("b", "failed"), item("a", "passed")])], [unit([item("a", "passed")]), unit([item("b", "failed")])]]) {
    const slice = createSlice({ kind: "unit", platform: "linux", lane: 1, sample: 1, workspace: "/repo", first: initial, retries: reports });
    assert.deepEqual(slice.failures.map(({ id, retry }) => [id, retry]), [["a", "recovered"], ["b", "failed"]]);
    assert.equal(slice.failures[0].file, "a.test.ts");
  }
});

test("missing, skipped, interrupted, and ambiguous retry results cannot count as recovered", () => {
  const first = unit([item("a", "failed"), item("b", "failed"), item("c", "failed"), item("d", "failed")], false);
  const retry = unit([item("a", "skipped"), { ...item("b", "passed"), completed: false }, item("c", "passed"), item("c", "failed")]);
  const slice = createSlice({ kind: "unit", platform: "windows-main", lane: 1, sample: 1, first, retries: [retry] });
  assert.equal(slice.first.complete, false);
  assert.deepEqual(slice.failures.map(({ retry }) => retry), ["unknown", "unknown", "unknown", "unknown"]);
});

test("E2E identifies first unexpected outcomes and matches retry results by ID", () => {
  const first = { status: "failed", complete: true, errors: 0, tests: [{ id: "x", name: "one", outcome: "unexpected", completed: true }, { id: "y", name: "two", outcome: "unexpected", completed: true }] };
  const retry = { status: "failed", complete: true, errors: 0, tests: [{ id: "y", outcome: "unexpected", completed: true }, { id: "x", outcome: "expected", completed: true }] };
  const slice = createSlice({ kind: "e2e", platform: "macos", lane: 2, sample: 1, first, retries: [retry] });
  assert.deepEqual(slice.failures.map(({ retry }) => retry), ["recovered", "failed"]);
});

test("aggregation preserves missing slices, attempts, and distinct diagnostic samples", () => {
  const expected = expectedSlices(3);
  assert.equal(expected.length, 30);
  const slice = createSlice({ kind: "e2e", platform: "windows", lane: 1, sample: 2, first: null, retries: [] });
  const report = aggregateSlices({ slices: [slice], samples: 3, runId: "123", attempt: "2" });
  assert.equal(report.slices.length, 1);
  assert.equal(report.missingSlices.length, 29);
  assert.equal(report.slices.find((s) => s.key === slice.key).first.available, false);
  assert.equal(report.attempt, 2);
  assert.throws(() => aggregateSlices({ slices: [slice, slice], samples: 3 }), /duplicate/i);
});

test("the expected slice inventory follows every configured workflow matrix", async () => {
  const { readFileSync } = await import("node:fs");
  const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
  const jobs = [
    ["test", "unit", "linux"], ["test-macos", "unit", "macos"],
    ["windows-desktop-main", "unit", "windows-main"], ["windows-renderer-packages", "unit", "windows-renderer"],
    ["desktop-e2e", "e2e", "linux"], ["desktop-e2e-macos", "e2e", "macos"], ["windows-e2e", "e2e", "windows"],
  ];
  for (const [job, kind, platform] of jobs) {
    const section = workflow.split(`\n  ${job}:\n`)[1]?.split(/\n  [a-z][a-z0-9-]*:\n/)[0];
    assert.ok(section, `missing job ${job}`);
    const lanes = section.match(/lane: \[([\d, ]+)\]/)?.[1].split(",").map(Number);
    assert.ok(lanes, `missing matrix in ${job}`);
    assert.deepEqual(expectedSlices().filter((s) => s.kind === kind && s.platform === platform).map((s) => s.lane), lanes);
    assert.match(section, new RegExp(`kind: ${kind}\\n\\s+platform: ${platform}\\n`));
    assert.match(section, /uses: \.\/\.github\/actions\/flake-slice/);
  }
  assert.match(workflow, /sample: \$\{\{ fromJSON\(contains\(github\.event\.pull_request\.labels\.\*\.name, 'ci:windows-shutdown-diagnostics'\) && '\[1, 2, 3\]' \|\| '\[1\]'\) \}\}/);
});

test("the CLI produces a consolidated report including incomplete and absent slices", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join, resolve } = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const cwd = mkdtempSync(join(tmpdir(), "flake-report-test-"));
  const script = resolve("scripts/ci/write-flake-report.mjs");
  try {
    mkdirSync(join(cwd, ".local/ci/retry"), { recursive: true });
    writeFileSync(join(cwd, ".local/ci/retry/unit-first.json"), JSON.stringify(unit([item("a", "failed")], false)));
    const env = { ...process.env, FLAKE_KIND: "unit", FLAKE_PLATFORM: "linux", FLAKE_LANE: "1", FLAKE_SAMPLE: "1", GITHUB_WORKSPACE: "/repo" };
    const slice = spawnSync(process.execPath, [script, "slice"], { cwd, env, encoding: "utf8" });
    assert.equal(slice.status, 0, slice.stderr);
    const downloads = join(cwd, ".local/ci/flake-slices");
    const namedArtifact = join(downloads, "flake-slice-1-unit-linux-lane-1-sample-1");
    for (const artifact of [downloads, namedArtifact]) {
      rmSync(downloads, { recursive: true, force: true });
      mkdirSync(artifact, { recursive: true });
      writeFileSync(join(artifact, "flake-slice.json"), readFileSync(join(cwd, ".local/ci/flake-slice.json")));
      const aggregate = spawnSync(process.execPath, [script, "aggregate"], { cwd, env: { ...env, FLAKE_SAMPLES: "1", GITHUB_RUN_ATTEMPT: "1" }, encoding: "utf8" });
      assert.equal(aggregate.status, 0, aggregate.stderr);
      const result = JSON.parse(readFileSync(join(cwd, ".local/ci/flake-report/flake-report.json")));
      assert.equal(result.expectedSlices, 22);
      assert.equal(result.missingSlices.length, 21);
      assert.equal(result.slices[0].first.complete, false);
      assert.equal(result.slices[0].failures[0].retry, "unknown");
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("the job summary counts every unavailable or incomplete first report even when all slices arrived", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join, resolve } = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const cwd = mkdtempSync(join(tmpdir(), "flake-summary-test-"));
  const script = resolve("scripts/ci/write-flake-report.mjs");
  try {
    const expected = expectedSlices();
    const summary = join(cwd, "summary.md");
    for (const incomplete of [1, 2, 3, 0]) {
      const downloads = join(cwd, ".local/ci/flake-slices");
      rmSync(downloads, { recursive: true, force: true });
      for (const [index, dimension] of expected.entries()) {
        const first = index >= incomplete ? (dimension.kind === "unit"
          ? unit([item("passing", "passed")])
          : { status: "passed", complete: true, errors: 0, tests: [{ id: "passing", name: "passing", outcome: "expected", completed: true }] })
          : index % 2 === 0 ? null : (dimension.kind === "unit" ? unit([], false) : { status: "interrupted", complete: false, errors: 0, tests: [] });
        const slice = createSlice({ ...dimension, first, retries: [] });
        const artifact = join(downloads, slice.key);
        mkdirSync(artifact, { recursive: true });
        writeFileSync(join(artifact, "flake-slice.json"), JSON.stringify(slice));
      }
      writeFileSync(summary, "");
      const result = spawnSync(process.execPath, [script, "aggregate"], { cwd, encoding: "utf8", env: { ...process.env, FLAKE_SAMPLES: "1", GITHUB_RUN_ATTEMPT: String(incomplete + 1), GITHUB_STEP_SUMMARY: summary } });
      assert.equal(result.status, 0, result.stderr);
      const content = readFileSync(summary, "utf8");
      assert.match(content, /Slices received: 22\/22; missing: 0/);
      assert.ok(content.includes(`Download the \`ci-flake-report-${incomplete + 1}\` artifact`));
      assert.match(content, new RegExp(`First reports unavailable or incomplete: ${incomplete}\\.`));
      if (incomplete > 0) assert.match(content, /failure counts may be incomplete/i);
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
