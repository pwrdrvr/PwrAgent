const { execFileSync, spawnSync } = require("node:child_process");
const { mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const ARTIFACT = "model-request-results";
const RESULT = "model-request-result.json";
const MARKER = "<!-- pwragent-model-request -->";
const MAX_ARTIFACT_BYTES = 16 * 1024;
const GIT_SHA = /^[a-f0-9]{40}$/;
const PROVIDERS = { codex: "Codex", claude: "Claude", "acp:antigravity": "Antigravity" };
const SUMMARY_METRICS = {
  firstBytes: "First turn total body bytes",
  firstCalls: "First turn model calls",
  nextBytes: "Follow-up total body bytes",
  nextCalls: "Follow-up model calls",
};
const DETAIL_METRICS = {
  firstPrimaryBytes: "First turn primary body",
  firstInputBytes: "First turn input and history",
  firstInstructionBytes: "First turn instructions",
  firstToolBytes: "First turn tool definitions",
  nextPrimaryBytes: "Follow-up primary body",
  nextInputBytes: "Follow-up input and history",
  nextInstructionBytes: "Follow-up instructions",
  nextToolBytes: "Follow-up tool definitions",
};
const METRICS = { ...SUMMARY_METRICS, ...DETAIL_METRICS };
const METRIC_KEYS = Object.keys(METRICS);

function hasKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function validMetrics(value) {
  return hasKeys(value, METRIC_KEYS)
    && METRIC_KEYS.every((key) => Number.isSafeInteger(value[key]) && value[key] > 0);
}

function validateResult(result) {
  if (!hasKeys(result, ["version", "baseSha", "results"]) || result.version !== 2
    || (result.baseSha !== null && (typeof result.baseSha !== "string" || !GIT_SHA.test(result.baseSha)))
    || !Array.isArray(result.results) || result.results.length !== Object.keys(PROVIDERS).length) {
    return undefined;
  }
  const seen = new Set();
  for (const row of result.results) {
    if (!hasKeys(row, ["provider", "observed", "ceilings"]) || typeof row.provider !== "string"
      || !Object.hasOwn(PROVIDERS, row.provider) || seen.has(row.provider) || !validMetrics(row.observed)
      || !validMetrics(row.ceilings)
      || row.observed.firstPrimaryBytes > row.observed.firstBytes
      || row.observed.nextPrimaryBytes > row.observed.nextBytes) {
      return undefined;
    }
    seen.add(row.provider);
  }
  return result;
}

function testedMergeBase(cwd = process.cwd()) {
  // Read the commit object directly so both parents are visible in a shallow
  // checkout of GitHub's synthetic merge.
  const commit = execFileSync("git", ["cat-file", "commit", "HEAD"], { cwd, encoding: "utf8" });
  const headers = commit.split("\n\n", 1)[0];
  const parents = [...headers.matchAll(/^parent ([a-f0-9]{40})$/gm)];
  if (parents.length !== 2) throw new Error("Expected CI to test a two-parent PR merge.");
  return parents[0][1];
}

function readArtifact(data) {
  const bytes = data instanceof ArrayBuffer ? Buffer.from(data) : data;
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_ARTIFACT_BYTES) return undefined;
  const directory = mkdtempSync(join(tmpdir(), "model-request-report-"));
  try {
    const archive = join(directory, "measurement.zip");
    writeFileSync(archive, bytes);
    // Stream only the known file. No archive entry can write to the workspace.
    const result = spawnSync("/usr/bin/unzip", ["-p", archive, RESULT], {
      encoding: "utf8", maxBuffer: MAX_ARTIFACT_BYTES, timeout: 5_000,
    });
    if (result.status !== 0 || result.error) return undefined;
    return validateResult(JSON.parse(result.stdout));
  } catch {
    return undefined;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function format(value, metric) {
  if (metric.endsWith("Calls")) return String(value);
  if (value < 1024) return `${value} B`;
  return `${(value / 1024).toFixed(1)} KiB`;
}

function impact(current, baseline, metric) {
  if (baseline === undefined) return "—";
  const change = current - baseline;
  if (change === 0) return "0";
  const sign = change > 0 ? "+" : "−";
  return `${sign}${format(Math.abs(change), metric)} (${sign}${(Math.abs(change) / baseline * 100).toFixed(1)}%)`;
}

function renderComment({ current, baseline, source, baselineRun, exactBase, runUrl }) {
  const stamp = `<!-- model-request-run ${source.sha} ${source.number} ${source.attempt} ${current ? "result" : "missing"} -->`;
  const lines = [MARKER, stamp, "## Model request impact", ""];
  const sourceLink = `[\`${source.sha.slice(0, 7)}\`](${runUrl(source.id)})`;
  if (!current) {
    lines.push(`⚠️ [CI](${runUrl(source.id)}) did not produce a usable model request measurement for \`${source.sha.slice(0, 7)}\`.`);
    return lines.join("\n");
  }

  const measurements = new Map(current.results.map((row) => [row.provider, row]));
  const baselineMeasurements = new Map(baseline?.results.map((row) => [row.provider, row]));
  const providers = Object.entries(PROVIDERS);
  const withinBudget = current.results.every(({ observed, ceilings }) =>
    METRIC_KEYS.every((key) => observed[key] <= ceilings[key]));
  lines.push(withinBudget
    ? "✅ Default outbound model requests stayed within their ceilings."
    : "❌ Default outbound model requests exceeded one or more ceilings.", "");
  if (!baseline) {
    lines.push("> A successful, usable `main` baseline is unavailable. CI still checks the PR ceilings.", "");
  } else if (!exactBase) {
    lines.push("> Deltas use the latest available successful `main` measurement. The exact base has no usable measurement.", "");
  }

  function table(keys) {
    return [
      "| Provider | Metric | Main baseline | This PR | Impact | PR ceiling | Status |",
      "| --- | --- | ---: | ---: | ---: | ---: | :---: |",
      ...providers.flatMap(([provider, name]) => keys.map((key) => {
        const { observed, ceilings } = measurements.get(provider);
        const currentValue = observed[key];
        const base = baselineMeasurements.get(provider)?.observed[key];
        const ceiling = ceilings[key];
        return `| ${name} | ${METRICS[key]} | ${base === undefined ? "—" : format(base, key)} | ${format(currentValue, key)} | ${impact(currentValue, base, key)} | ${format(ceiling, key)} | ${currentValue <= ceiling ? "✅" : "❌"} |`;
      })),
    ];
  }

  lines.push(...table(Object.keys(SUMMARY_METRICS)), "", "<details>", "<summary>Primary request, input and history, instructions, and tools</summary>", "",
    ...table(Object.keys(DETAIL_METRICS)), "", "</details>", "");
  if (baseline) {
    const changes = providers.flatMap(([provider, name]) => {
      const previous = baselineMeasurements.get(provider).ceilings;
      const next = measurements.get(provider).ceilings;
      return METRIC_KEYS.filter((key) => previous[key] !== next[key]).map((key) =>
        `- ${name} · ${METRICS[key]} from ${format(previous[key], key)} to ${format(next[key], key)}`);
    });
    if (changes.length) lines.push("**Ceiling changes**", "", ...changes, "");
  }
  lines.push("Real agent processes sent these HTTP request bodies to local fake model endpoints. Totals include PwrAgent and native title generation. The breakdown measures JSON fields in the primary conversation request.",
    "",
    `The \`model-request-mcp-results-attempt-${source.attempt}\` artifact in the [CI run](${runUrl(source.id)}) contains measurements for the large MCP catalog.`,
    "", `Baseline ${baseline ? `[\`${baselineRun.sha.slice(0, 7)}\`](${runUrl(baselineRun.id)})` : "unavailable"} · PR ${sourceLink} · CI attempt ${source.attempt} · ${source.conclusion}`);
  return lines.join("\n");
}

function matchesPull(pull, source, repositoryId) {
  return pull.state === "open" && pull.base.ref === "main" && pull.base.repo?.id === repositoryId
    && pull.head.repo?.id === source.head_repository?.id
    && pull.head.ref === source.head_branch && pull.head.sha === source.head_sha;
}

async function findPull(github, context, source) {
  const repositoryId = context.payload.repository.id;
  if (!source.head_repository?.id || !source.head_branch || !GIT_SHA.test(source.head_sha)) return undefined;
  const associated = source.pull_requests ?? [];
  if (associated.length === 1) {
    const { data: pull } = await github.rest.pulls.get({ ...context.repo, pull_number: associated[0].number });
    return matchesPull(pull, source, repositoryId) ? pull : undefined;
  }
  // workflow_run commonly omits the association for fork branches.
  const pulls = await github.paginate(github.rest.pulls.list, {
    ...context.repo, state: "open", head: `${source.head_repository.owner.login}:${source.head_branch}`,
    base: "main", per_page: 100,
  });
  const matching = pulls.filter((pull) => matchesPull(pull, source, repositoryId));
  return matching.length === 1 ? matching[0] : undefined;
}

function findAttemptArtifact(artifacts, attempt) {
  const name = `${ARTIFACT}-attempt-${attempt}`;
  return artifacts.find((artifact) => artifact.name === name && !artifact.expired
    && artifact.size_in_bytes > 0 && artifact.size_in_bytes <= MAX_ARTIFACT_BYTES);
}

async function downloadMeasurement(github, repo, run, core) {
  if (!Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1) return undefined;
  try {
    const { data } = await github.rest.actions.listWorkflowRunArtifacts({
      ...repo, run_id: run.id, name: `${ARTIFACT}-attempt-${run.run_attempt}`, per_page: 100,
    });
    const artifact = findAttemptArtifact(data.artifacts, run.run_attempt);
    if (!artifact) return undefined;
    const archive = await github.rest.actions.downloadArtifact({
      ...repo, artifact_id: artifact.id, archive_format: "zip",
      request: { signal: AbortSignal.timeout(5_000) },
    });
    return readArtifact(archive.data);
  } catch {
    core.info(`Could not read model request artifact for run ${run.id} attempt ${run.run_attempt}.`);
    return undefined;
  }
}

async function findBaseline(github, repo, source, baseSha, core) {
  const runs = async (filters) => {
    const { data } = await github.rest.actions.listWorkflowRuns({
      ...repo, workflow_id: source.workflow_id, branch: "main", event: "push",
      status: "success", per_page: 8, ...filters,
    });
    return data.workflow_runs;
  };
  const [exactRuns, recentRuns] = await Promise.all([
    runs({ head_sha: baseSha }),
    runs({}),
  ]);
  const candidates = new Map([...exactRuns, ...recentRuns].map((run) => [run.id, run]));
  for (const run of candidates.values()) {
    const baseline = await downloadMeasurement(github, repo, run, core);
    if (baseline?.baseSha === null) {
      return {
        baseline, baselineRun: { id: run.id, sha: run.head_sha }, exactBase: run.head_sha === baseSha,
      };
    }
  }
  return {};
}

async function publish({ github, context, core }) {
  const run = context.payload.workflow_run;
  const matchedPull = await findPull(github, context, run);
  if (!matchedPull) return core.info("No current pull request into main matches this CI run.");
  const pullNumber = matchedPull.number;
  const measurement = await downloadMeasurement(github, context.repo, run, core);
  const current = measurement?.baseSha ? measurement : undefined;
  if (!current && run.conclusion === "success") {
    return core.info("This successful CI attempt has no usable model request measurement.");
  }
  const source = { sha: run.head_sha, id: run.id, number: run.run_number, attempt: run.run_attempt, conclusion: run.conclusion };
  const runUrl = (id) => `https://github.com/${context.repo.owner}/${context.repo.repo}/actions/runs/${id}`;
  const params = { ...context.repo, issue_number: pullNumber };
  const comments = await github.paginate(github.rest.issues.listComments, { ...params, per_page: 100 });
  const existing = comments.find((comment) => comment.user?.login === "github-actions[bot]" && comment.body?.startsWith(MARKER));
  const previous = existing?.body.match(/<!-- model-request-run ([a-f0-9]{40}) (\d+) (\d+) (result|missing) -->/);
  if (previous && previous[1] === source.sha
    && ((!current && previous[4] === "result") || Number(previous[2]) > source.number
      || (Number(previous[2]) === source.number && Number(previous[3]) > source.attempt))) {
    return core.info("The comment already has a newer or more complete measurement for this head.");
  }

  const comparison = current ? await findBaseline(github, context.repo, run, current.baseSha, core) : {};
  const body = renderComment({ current, source, runUrl, ...comparison });
  const { data: pull } = await github.rest.pulls.get({ ...context.repo, pull_number: pullNumber });
  if (!matchesPull(pull, run, context.payload.repository.id)) {
    return core.info("The pull request no longer matches this CI run.");
  }
  if (existing) {
    await github.rest.issues.updateComment({ ...context.repo, comment_id: existing.id, body });
  } else {
    await github.rest.issues.createComment({ ...params, body });
  }
}

module.exports = { findAttemptArtifact, publish, readArtifact, renderComment, testedMergeBase, validateResult };
