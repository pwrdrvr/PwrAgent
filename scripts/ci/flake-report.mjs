import path from "node:path";

const keyOf = ({ kind, platform, lane, sample }) => `${kind}-${platform}-lane-${lane}-sample-${sample}`;

export function expectedSlices(samples = 1) {
  const slices = [];
  const add = (kind, platform, lanes, count = 1) => {
    for (let lane = 1; lane <= lanes; lane++) {
      for (let sample = 1; sample <= count; sample++) slices.push({ kind, platform, lane, sample });
    }
  };
  add("unit", "linux", 2);
  add("unit", "macos", 4);
  add("unit", "windows-main", 2);
  add("unit", "windows-renderer", 2);
  add("e2e", "linux", 4);
  add("e2e", "macos", 4);
  add("e2e", "windows", 4, samples);
  return slices.map((slice) => ({ ...slice, key: keyOf(slice) }));
}

function relativeFile(file, workspace) {
  if (typeof file !== "string") return file;
  const normalized = file.replaceAll("\\", "/");
  const root = workspace?.replaceAll("\\", "/").replace(/\/$/, "");
  return root && normalized.toLowerCase().startsWith(`${root.toLowerCase()}/`)
    ? normalized.slice(root.length + 1) : normalized;
}

export function createSlice({ kind, platform, lane, sample = 1, workspace, first, retries, jobStatus, firstOutcome, retryOutcome }) {
  const slice = { kind, platform, lane: Number(lane), sample: Number(sample) };
  const firstTests = kind === "unit"
    ? (first?.suites ?? []).flatMap((suite) => (suite.tests ?? []).map((test) => ({ ...test, project: suite.project, file: relativeFile(suite.file, workspace) })))
    : (first?.tests ?? []);
  const retryTests = retries.flatMap((report) => kind === "unit"
    ? (report?.suites ?? []).flatMap((suite) => suite.tests ?? []) : (report?.tests ?? []));
  const failed = firstTests.filter((test) => kind === "unit" ? test.state === "failed" : test.outcome === "unexpected");
  const failures = failed.map((test) => {
    const candidates = retryTests.filter((candidate) => candidate.id === test.id
      && (kind !== "unit" || candidate.state !== "skipped"));
    let retry = "unknown";
    if (test.completed && failed.filter((other) => other.id === test.id).length === 1
      && candidates.length === 1 && candidates[0].completed) {
      const state = kind === "unit" ? candidates[0].state : candidates[0].outcome;
      if (state === (kind === "unit" ? "passed" : "expected")) retry = "recovered";
      else if (state === (kind === "unit" ? "failed" : "unexpected")) retry = "failed";
    }
    return { id: test.id, name: test.name, ...(kind === "unit" ? { project: test.project, file: test.file } : {}), retry };
  });
  return {
    ...slice, key: keyOf(slice), jobStatus, firstOutcome, retryOutcome,
    first: { available: !!first, complete: first?.complete === true, status: first?.reason ?? first?.status ?? null,
      tests: first ? firstTests.length : null, errors: first ? (kind === "unit" ? first.unhandledErrors + (first.suites ?? []).reduce((n, suite) => n + (suite.errors ?? 0), 0) : first.errors) : null,
      ...(kind === "unit" && first?.completion ? { completion: first.completion } : {}) },
    failures,
  };
}

export function aggregateSlices({ slices, samples = 1, runId, attempt, sha, headSha, warnings = [] }) {
  const expected = expectedSlices(samples);
  const byKey = new Map();
  const allowed = new Set(expected.map((slice) => slice.key));
  for (const slice of slices) {
    if (!allowed.has(slice.key) || slice.key !== keyOf(slice)) throw new Error(`Unexpected slice: ${slice.key}`);
    if (byKey.has(slice.key)) throw new Error(`Duplicate slice: ${slice.key}`);
    byKey.set(slice.key, slice);
  }
  const missingSlices = expected.filter((slice) => !byKey.has(slice.key));
  const ordered = expected.filter((slice) => byKey.has(slice.key)).map((slice) => byKey.get(slice.key));
  const failures = ordered.flatMap((slice) => slice.failures);
  return { schemaVersion: 1, runId: runId ?? null, attempt: Number(attempt ?? 1), sha: sha ?? null, headSha: headSha || null,
    generatedAt: new Date().toISOString(), expectedSlices: expected.length, missingSlices, warnings,
    totals: { initialFailures: failures.length, recovered: failures.filter((test) => test.retry === "recovered").length,
      failed: failures.filter((test) => test.retry === "failed").length, unknown: failures.filter((test) => test.retry === "unknown").length },
    slices: ordered };
}
