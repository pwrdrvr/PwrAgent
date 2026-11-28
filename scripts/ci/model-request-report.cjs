const { execFileSync, spawnSync } = require("node:child_process");
const { mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const ARTIFACT = "model-request-results";
const RESULT = "model-request-result.json";
const MCP_ARTIFACT = "model-request-mcp-results";
const MCP_RESULT = "model-request-mcp-result.json";
const MARKER = "<!-- pwragent-model-request -->";
const MAX_ARTIFACT_BYTES = 16 * 1024;
const GIT_SHA = /^[a-f0-9]{40}$/;
const ANTIGRAVITY = "acp:antigravity";
const PROVIDERS = { codex: "Codex", claude: "Claude", [ANTIGRAVITY]: "Antigravity" };
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
const LARGE_METRICS = {
  firstBytes: SUMMARY_METRICS.firstBytes,
  firstToolBytes: DETAIL_METRICS.firstToolBytes,
  firstCalls: SUMMARY_METRICS.firstCalls,
  nextBytes: SUMMARY_METRICS.nextBytes,
  nextToolBytes: DETAIL_METRICS.nextToolBytes,
  nextCalls: SUMMARY_METRICS.nextCalls,
};
const TURN_KEYS = ["bytes", "calls", "primaryBytes", "inputBytes", "instructionBytes", "toolBytes"];
const TOOL_USE_METRICS = {
  bytes: "Total body bytes",
  primaryBytes: "Largest conversation request",
  toolBytes: "Peak tool definitions",
  continuationBytes: "Continuation body bytes",
  calls: "Total model calls",
  roundTripCalls: "Model calls after tool results",
};
const KIMI = "codex:kimi-k3";
const KIMI_LABEL = "Codex · Kimi K3";
const TOOL_USE_PROVIDERS = { ...PROVIDERS, [KIMI]: KIMI_LABEL };

function hasKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function validBaseSha(value) {
  return value === null || (typeof value === "string" && GIT_SHA.test(value));
}

function validMetrics(value, keys = METRIC_KEYS) {
  return hasKeys(value, keys)
    && keys.every((key) => Number.isSafeInteger(value[key]) && value[key] > 0);
}

function validateResult(result) {
  if (!hasKeys(result, ["version", "baseSha", "results"]) || result.version !== 2
    || !validBaseSha(result.baseSha)
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

function validRows(rows, providers, validate, complete = true) {
  return Array.isArray(rows) && (!complete || rows.length === Object.keys(providers).length)
    && rows.length <= Object.keys(providers).length
    && new Set(rows.map((row) => row?.provider)).size === rows.length
    && rows.every((row) => typeof row?.provider === "string" && Object.hasOwn(providers, row.provider) && validate(row));
}

function validCatalogRow(row) {
  return hasKeys(row, ["provider", "first", "next", "ceilings", "fullSchemasAdvertised"])
    && typeof row.provider === "string"
    && [row.first, row.next].every((turn) => validMetrics(turn, TURN_KEYS)
      && turn.toolBytes <= turn.primaryBytes && turn.primaryBytes <= turn.bytes)
    && validMetrics(row.ceilings, Object.keys(LARGE_METRICS))
    && Array.isArray(row.fullSchemasAdvertised) && row.fullSchemasAdvertised.length === 2
    && row.fullSchemasAdvertised.every((value) => typeof value === "boolean");
}

function validToolUseRow(row) {
  const keys = Object.keys(TOOL_USE_METRICS);
  return hasKeys(row, ["provider", "observed", "ceilings"]) && typeof row.provider === "string"
    && validMetrics(row.observed, keys) && validMetrics(row.ceilings, keys)
    && row.observed.primaryBytes <= row.observed.bytes
    && row.observed.toolBytes <= row.observed.primaryBytes
    && row.observed.continuationBytes < row.observed.bytes
    && row.observed.roundTripCalls < row.observed.calls;
}

function validateMcpResult(result) {
  const keys = ["version", "results"];
  switch (result?.version) {
    case 1:
      break;
    case 4:
      if (!validBaseSha(result.baseSha)) return undefined;
      keys.push("baseSha");
      // Falls through to the route-tagged format.
    case 3:
      if (typeof result.antigravityNative !== "boolean") return undefined;
      keys.push("antigravityNative", "thirdParty", "toolUse");
      break;
    case 2:
      keys.push("thirdParty", "toolUse");
      break;
    default:
      return undefined;
  }
  if (!hasKeys(result, keys) || !validRows(result.results, PROVIDERS, validCatalogRow, result.version < 4)) return undefined;
  if (result.version === 1) return result;
  if (result.thirdParty !== null && (!validCatalogRow(result.thirdParty) || result.thirdParty.provider !== KIMI)) return undefined;
  if (!validRows(result.toolUse, TOOL_USE_PROVIDERS, validToolUseRow, false)) return undefined;
  if (result.version === 4 && !result.results.length && !result.thirdParty && !result.toolUse.length) return undefined;
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

function readArtifact(data, kind = "default") {
  const [member, validate] = kind === "mcp" ? [MCP_RESULT, validateMcpResult] : [RESULT, validateResult];
  const bytes = data instanceof ArrayBuffer ? Buffer.from(data) : data;
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_ARTIFACT_BYTES) return undefined;
  const directory = mkdtempSync(join(tmpdir(), "model-request-report-"));
  try {
    const archive = join(directory, "measurement.zip");
    writeFileSync(archive, bytes);
    // Stream only the known file. No archive entry can write to the workspace.
    const result = spawnSync("/usr/bin/unzip", ["-p", archive, member], {
      encoding: "utf8", maxBuffer: MAX_ARTIFACT_BYTES, timeout: 5_000,
    });
    if (result.status !== 0 || result.error) return undefined;
    return validate(JSON.parse(result.stdout));
  } catch {
    return undefined;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function format(value, metric) {
  if (metric === "calls" || metric.endsWith("Calls")) return String(value);
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

function renderTable(rows, baselineRows, metrics, { exactBytes = false, flagIncreases = false } = {}) {
  const historical = new Map(baselineRows.map(({ provider, observed }) => [provider, observed]));
  return [
    "| Provider | Metric | Main baseline | This PR | Impact | PR ceiling | Status |",
    "| --- | --- | ---: | ---: | ---: | ---: | :---: |",
    ...rows.flatMap(({ provider, name, observed, ceilings }) => Object.entries(metrics).map(([key, label]) => {
      const value = observed[key];
      const base = historical.get(provider)?.[key];
      const limit = ceilings[key];
      const display = (amount) => exactBytes && key.toLowerCase().endsWith("bytes")
        ? `${amount.toLocaleString("en-US")} B` : format(amount, key);
      const delta = impact(value, base, key);
      return `| ${name} | ${label} | ${base === undefined ? "—" : display(base)} | ${display(value)} | ${flagIncreases && value > base ? `**${delta}**` : delta} | ${display(limit)} | ${value <= limit ? "✅" : "❌"} |`;
    })),
  ];
}

function catalogTableRow(row) {
  const observed = Object.fromEntries(["first", "next"].flatMap((turn) =>
    ["Bytes", "Calls", "ToolBytes"].map((key) => [turn + key, row[turn][key[0].toLowerCase() + key.slice(1)]])));
  return { ...row, observed, name: TOOL_USE_PROVIDERS[row.provider] };
}

function addMcpReport(lines, current, baseline) {
  const options = { exactBytes: true, flagIncreases: true };
  lines.push("### 240 configured MCP tools", "");
  if (!current) {
    lines.push("> This CI attempt has no usable 240-tool measurement.", "");
    return;
  }
  if (!baseline) lines.push("> The selected main run has no usable 240-tool measurement. Deltas are unavailable.", "");
  const results = current.results.map(catalogTableRow);
  const availableCatalogs = new Set(results.map(({ provider }) => provider));
  const historicalCatalogs = new Set(baseline?.results.map(({ provider }) => provider));
  const missingCatalogs = Object.entries(PROVIDERS).filter(([provider]) => !availableCatalogs.has(provider));
  if (missingCatalogs.length) {
    lines.push(`> This CI attempt has no 240-tool measurement for ${missingCatalogs.map(([, name]) => name).join(", ")}.`, "");
  }
  const missingCatalogBaselines = results.filter(({ provider }) => !historicalCatalogs.has(provider));
  if (baseline && missingCatalogBaselines.length) {
    lines.push(`> The selected main run has no 240-tool measurement for ${missingCatalogBaselines.map(({ name }) => name).join(", ")}.`, "");
  }
  const catalogs = [...results, ...(current.thirdParty ? [catalogTableRow(current.thirdParty)] : [])];
  const violations = catalogs.filter(({ observed, ceilings }) => Object.keys(LARGE_METRICS)
    .some((key) => observed[key] > ceilings[key]));
  if (violations.length) lines.push(`❌ Budget exceeded by ${violations.map(({ name }) => name).join(", ")}.`, "");
  if (results.length) lines.push(...renderTable(results, baseline?.results.map(catalogTableRow) ?? [], LARGE_METRICS, options), "");
  if (current.antigravityNative) {
    lines.push("> Antigravity uses native stdio and is expected to advertise a subset of fixture schemas up front.", "");
  }
  for (const { provider, name, fullSchemasAdvertised } of catalogs) {
    const native = provider === ANTIGRAVITY && current.antigravityNative;
    if (provider === ANTIGRAVITY && current.version === 1 && fullSchemasAdvertised.some(Boolean)) {
      lines.push("> The historical Antigravity artifact recorded eager schemas with an unknown expected route.", "");
      continue;
    }
    for (const [index, advertised] of fullSchemasAdvertised.entries()) {
      if (advertised && !native) lines.push(`❌ ${name} advertised full fixture schemas on the ${index ? "follow-up" : "first turn"}.`, "");
      if (!advertised && native) lines.push(`❌ ${name} native stdio exposed no fixture schemas on the ${index ? "follow-up" : "first turn"}.`, "");
    }
  }
  lines.push("#### Codex with Kimi K3", "");
  if (current.thirdParty) {
    if (!baseline?.thirdParty) lines.push("> The selected main run has no Kimi K3 measurement. Deltas are unavailable.", "");
    lines.push(...renderTable([catalogTableRow(current.thirdParty)],
      baseline?.thirdParty ? [catalogTableRow(baseline.thirdParty)] : [], LARGE_METRICS, options), "");
  } else {
    lines.push("> This CI attempt has no Kimi K3 measurement.", "");
  }
  lines.push("### Scripted MCP tool use", "");
  if (current.toolUse?.length) {
    const available = new Map(current.toolUse.map((row) => [row.provider, row]));
    const historical = new Map(baseline?.toolUse?.map((row) => [row.provider, row]));
    const routeChanged = available.has(ANTIGRAVITY) && historical.has(ANTIGRAVITY)
      && Boolean(current.antigravityNative) !== Boolean(baseline?.antigravityNative);
    const missing = Object.entries(TOOL_USE_PROVIDERS).filter(([provider]) => !available.has(provider));
    const missingBaseline = Object.entries(TOOL_USE_PROVIDERS).filter(([provider]) => available.has(provider) && !historical.has(provider));
    if (missing.length) lines.push(`> This CI attempt has no tool-use measurement for ${missing.map(([, name]) => name).join(", ")}.`, "");
    if (routeChanged) {
      historical.delete(ANTIGRAVITY);
      lines.push("> Antigravity used a different MCP route from the selected main run. Scripted tool-use deltas are unavailable for that case.", "");
    }
    if (missingBaseline.length) lines.push(`> The selected main run has no tool-use measurement for ${missingBaseline.map(([, name]) => name).join(", ")}. Deltas are unavailable for those cases.`, "");
    if ((current.version === 4) !== (baseline?.version === 4)) {
      const affected = [KIMI, ...(!current.antigravityNative ? [ANTIGRAVITY] : [])]
        .filter((provider) => available.has(provider) && historical.has(provider));
      for (const provider of affected) {
        const row = historical.get(provider);
        historical.set(provider, { ...row, observed: { ...row.observed, toolBytes: undefined } });
      }
      if (affected.length) {
        lines.push(`> Peak tool definition deltas for ${affected.map((provider) => TOOL_USE_PROVIDERS[provider]).join(", ")} require matching discovery accounting.`, "");
      }
    }
    lines.push(...renderTable(Object.entries(TOOL_USE_PROVIDERS).flatMap(([provider, name]) =>
      available.has(provider) ? [{ ...available.get(provider), name }] : []),
    [...historical.values()], TOOL_USE_METRICS, options), "",
    "Continuations count requests carrying tool results. Peak tool definition bytes include schema-bearing discovery results in the conversation requests.", "");
  } else {
    lines.push("> This CI attempt has no scripted tool-use measurements.", "");
  }
}

function addDefaultReport(lines, current, baseline, exactBase) {
  const measurements = new Map(current.results.map((row) => [row.provider, row]));
  const baselineMeasurements = new Map(baseline?.results.map((row) => [row.provider, row]));
  const providers = Object.entries(PROVIDERS);
  const withinBudget = current.results.every(({ observed, ceilings }) =>
    METRIC_KEYS.every((key) => observed[key] <= ceilings[key]));
  lines.push(withinBudget
    ? "✅ Default outbound model requests stayed within their ceilings."
    : "❌ Default outbound model requests exceeded one or more ceilings.", "");
  if (!baseline) {
    lines.push("> A successful, usable default `main` baseline is unavailable. CI still checks the PR ceilings.", "");
  } else if (!exactBase) {
    lines.push("> Deltas use the latest available successful `main` measurement. The exact base has no usable measurement.", "");
  }

  const rows = providers.map(([provider, name]) => ({ ...measurements.get(provider), name }));
  const historical = baseline?.results ?? [];
  lines.push(...renderTable(rows, historical, SUMMARY_METRICS), "", "<details>",
    "<summary>Primary request, input and history, instructions, and tools</summary>", "",
    ...renderTable(rows, historical, DETAIL_METRICS), "", "</details>", "");
  if (baseline) {
    const changes = providers.flatMap(([provider, name]) => {
      const previous = baselineMeasurements.get(provider).ceilings;
      const next = measurements.get(provider).ceilings;
      return METRIC_KEYS.filter((key) => previous[key] !== next[key]).map((key) =>
        `- ${name} · ${METRICS[key]} from ${format(previous[key], key)} to ${format(next[key], key)}`);
    });
    if (changes.length) lines.push("**Ceiling changes**", "", ...changes, "");
  }
}

function renderComment({
  current, currentMcp, baseline, baselineMcp, source, baselineRun, baselineMcpRun, exactBase, exactMcpBase, runUrl,
}) {
  const hasMeasurement = current || currentMcp;
  const stamp = `<!-- model-request-run ${source.sha} ${source.number} ${source.attempt} ${hasMeasurement ? "result" : "missing"} -->`;
  const lines = [MARKER, stamp, "## Model request impact", ""];
  const sourceLink = `[\`${source.sha.slice(0, 7)}\`](${runUrl(source.id)})`;
  if (!hasMeasurement) {
    lines.push(`⚠️ [CI](${runUrl(source.id)}) did not produce a usable model request measurement for \`${source.sha.slice(0, 7)}\`.`);
    return lines.join("\n");
  }

  if (current) {
    addDefaultReport(lines, current, baseline, exactBase);
  } else {
    lines.push(`⚠️ [CI](${runUrl(source.id)}) did not produce a usable default model request measurement.`, "");
  }
  if (baselineMcpRun && !exactMcpBase && (!baselineRun || baselineRun.id !== baselineMcpRun.id || exactBase)) {
    lines.push("> MCP deltas use a recent successful `main` measurement. The tested base has no usable MCP measurement or is unavailable.", "");
  }
  addMcpReport(lines, currentMcp, baselineMcp);
  lines.push("Real agent processes sent these HTTP request bodies to local fake model endpoints. Totals include PwrAgent and native title generation. First turn and follow-up breakdowns measure JSON fields in the primary conversation request. Bold deltas mark increases in the MCP tables.", "");
  if (currentMcp) lines.push(`The \`${MCP_ARTIFACT}-attempt-${source.attempt}\` artifact is in the [CI run](${runUrl(source.id)}).`, "");
  const baselineLink = ({ id, sha }) => `[\`${sha.slice(0, 7)}\`](${runUrl(id)})`;
  const baselines = baselineRun && baselineMcpRun && baselineRun.id !== baselineMcpRun.id
    ? `Default baseline ${baselineLink(baselineRun)} · MCP baseline ${baselineLink(baselineMcpRun)}`
    : `Baseline ${baselineRun || baselineMcpRun ? baselineLink(baselineRun ?? baselineMcpRun) : "unavailable"}`;
  lines.push(`${baselines} · PR ${sourceLink} · CI attempt ${source.attempt} · ${source.conclusion}`);
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

function findAttemptArtifact(artifacts, attempt, kind = "default") {
  const name = `${kind === "mcp" ? MCP_ARTIFACT : ARTIFACT}-attempt-${attempt}`;
  return artifacts.find((artifact) => artifact.name === name && !artifact.expired
    && artifact.size_in_bytes > 0 && artifact.size_in_bytes <= MAX_ARTIFACT_BYTES);
}

async function downloadMeasurement(github, repo, run, core, kind = "default") {
  if (!Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1) return undefined;
  try {
    const { data } = await github.rest.actions.listWorkflowRunArtifacts({
      ...repo, run_id: run.id, name: `${kind === "mcp" ? MCP_ARTIFACT : ARTIFACT}-attempt-${run.run_attempt}`, per_page: 100,
    });
    const artifact = findAttemptArtifact(data.artifacts, run.run_attempt, kind);
    if (!artifact) return undefined;
    const archive = await github.rest.actions.downloadArtifact({
      ...repo, artifact_id: artifact.id, archive_format: "zip",
      request: { signal: AbortSignal.timeout(5_000) },
    });
    return readArtifact(archive.data, kind);
  } catch {
    core.info(`Could not read model request artifact for run ${run.id} attempt ${run.run_attempt}.`);
    return undefined;
  }
}

async function findBaseline(github, repo, source, current, currentMcp, core) {
  const baseSha = current?.baseSha ?? currentMcp?.baseSha;
  const runs = async (filters) => {
    const { data } = await github.rest.actions.listWorkflowRuns({
      ...repo, workflow_id: source.workflow_id, branch: "main", event: "push",
      status: "success", per_page: 8, ...filters,
    });
    return data.workflow_runs;
  };
  const [exactRuns, recentRuns] = await Promise.all([
    baseSha ? runs({ head_sha: baseSha }) : [],
    runs({}),
  ]);
  const candidates = new Map([...exactRuns, ...recentRuns].map((run) => [run.id, run]));
  const comparison = {};
  for (const run of candidates.values()) {
    const [baseline, baselineMcp] = await Promise.all([
      current && !comparison.baseline ? downloadMeasurement(github, repo, run, core) : undefined,
      currentMcp && !comparison.baselineMcp ? downloadMeasurement(github, repo, run, core, "mcp") : undefined,
    ]);
    const selected = { id: run.id, sha: run.head_sha };
    const exact = run.head_sha === baseSha;
    if (baseline?.baseSha === null) {
      Object.assign(comparison, { baseline, baselineRun: selected, exactBase: exact });
    }
    if (baselineMcp && baselineMcp.baseSha == null) {
      Object.assign(comparison, { baselineMcp, baselineMcpRun: selected, exactMcpBase: exact });
    }
    if ((!current || comparison.baseline) && (!currentMcp || comparison.baselineMcp)) break;
  }
  return comparison;
}

async function publish({ github, context, core }) {
  const run = context.payload.workflow_run;
  const matchedPull = await findPull(github, context, run);
  if (!matchedPull) return core.info("No current pull request into main matches this CI run.");
  const pullNumber = matchedPull.number;
  const [measurement, mcpMeasurement] = await Promise.all([
    downloadMeasurement(github, context.repo, run, core),
    downloadMeasurement(github, context.repo, run, core, "mcp"),
  ]);
  const current = measurement?.baseSha ? measurement : undefined;
  const currentMcp = mcpMeasurement?.baseSha === null ? undefined : mcpMeasurement;
  const hasMeasurement = current || currentMcp;
  if (!hasMeasurement && run.conclusion === "success") {
    return core.info("This successful CI attempt has no usable model request measurement.");
  }
  const source = { sha: run.head_sha, id: run.id, number: run.run_number, attempt: run.run_attempt, conclusion: run.conclusion };
  const runUrl = (id) => `https://github.com/${context.repo.owner}/${context.repo.repo}/actions/runs/${id}`;
  const params = { ...context.repo, issue_number: pullNumber };
  const comments = await github.paginate(github.rest.issues.listComments, { ...params, per_page: 100 });
  const existing = comments.find((comment) => comment.user?.login === "github-actions[bot]" && comment.body?.startsWith(MARKER));
  const previous = existing?.body.match(/<!-- model-request-run ([a-f0-9]{40}) (\d+) (\d+) (result|missing) -->/);
  if (previous && previous[1] === source.sha
    && ((!hasMeasurement && previous[4] === "result") || Number(previous[2]) > source.number
      || (Number(previous[2]) === source.number && Number(previous[3]) > source.attempt))) {
    return core.info("The comment already has a newer or more complete measurement for this head.");
  }

  const comparison = hasMeasurement ? await findBaseline(github, context.repo, run, current, currentMcp, core) : {};
  const body = renderComment({ current, currentMcp, source, runUrl, ...comparison });
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

module.exports = { findAttemptArtifact, publish, readArtifact, renderComment, testedMergeBase, validateMcpResult, validateResult };
