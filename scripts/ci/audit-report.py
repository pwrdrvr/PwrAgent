#!/usr/bin/env python3
"""Render the compact aggregate audit; raw evidence stays ignored."""
import argparse
import collections
import json
import pathlib


def one_decimal(value):
    return "unavailable" if value is None else f"{value:.1f}"


def case_cohort(platform, lane, sample):
    suffix = f" (diagnostic sample {sample[0]})" if sample and sample[0] is not None else ""
    return f"{platform}/{lane}{suffix}"


def main(root, output):
    manifest = json.loads((root / "manifest.json").read_text())
    summary = json.loads((root / "summary.json").read_text())
    artifacts = json.loads((root / "artifact-manifest.json").read_text())
    tests = json.loads((root / "test-summary.json").read_text())
    coverage = json.loads((root / "timing-coverage.json").read_text())
    head_sizes = collections.Counter(run["head_sha"] for run in manifest["runs"])
    repeated_heads = sum(size > 1 for size in head_sizes.values())
    if repeated_heads:
        cohorts = (f"Repeated head SHAs: {repeated_heads}, with up to {max(head_sizes.values())} runs per SHA. "
                   "Matching the SHA alone leaves runner and workload differences.")
    else:
        cohorts = "Each head SHA appears once in the manifest, so within-revision variation is unavailable."
    unreadable = sum(len(row.get("unreadableMembers", [])) for row in coverage)
    size_excluded = sum(len(row.get("sizeExcludedMembers", [])) for row in coverage)
    lines = ["# Primary CI timing audit", "", f"Frozen at {manifest['collectedAt']}. Source baseline `{manifest['sourceRevision']}`.", "", manifest["selection"], "", f"Sample range: {manifest['runs'][-1]['created_at']} through {manifest['runs'][0]['created_at']}. Workflow `{manifest['workflowId']}`. Manifest SHA-256: `{summary['manifestSha256']}`.", "", "## Coverage and interpretation", "", f"- Original-attempt job metadata: {summary['coverage']['collectedRuns']}/{len(manifest['runs'])} runs; {summary['coverage']['uniqueHeads']} distinct head SHAs.", f"- Events: {summary['coverage']['events']}; main branch: {sum(r['head_branch'] == 'main' for r in manifest['runs'])}, other branches: {sum(r['head_branch'] != 'main' for r in manifest['runs'])}.", f"- Latest conclusions at snapshot: {summary['coverage']['conclusionsLatest']}. These are not initial-test success rates: retries may recover failures.", f"- Rerun IDs: {summary['coverage']['rerunRunIds']}. Job statistics use attempt 1 only. Artifacts on these IDs and artifacts outside the verified attempt 1 job window have unknown provenance and are excluded from initial-test rankings.", f"- Artifacts: {dict(collections.Counter(a['state'] for a in artifacts))}. Download order is newest run then name; budget exclusions bias per-test coverage toward recent runs, not the job sample.", f"- Timing formats: {dict(collections.Counter(f for c in coverage for f in c['formats']))}; {len({c['runId'] for c in coverage if c['observations']})}/{len(manifest['runs'])} runs have downloaded per-test observations (including unknown-attempt artifacts).", f"- Per-test known-initial run coverage by platform: { {p: len({c['runId'] for c in coverage if c['platform'] == p and c['observations'] and c['attempt'] == 1}) for p in ('linux', 'macos', 'windows')} }. Unit duration coverage is macOS Vitest JSON only; Linux/Windows compact retry reports contain outcomes, not durations. Runs listing no artifacts: {sum(not json.loads(p.read_text())['artifacts'] for p in (root / 'runs').glob('*.json'))}. Listed expired artifacts: {sum(a['expired'] for a in artifacts)}.", f"- Skipped timing members: {unreadable} unreadable and {size_excluded} above the size limit. See timing-coverage.json.", "- Windows shutdown diagnostics are grouped by sample and lane. Ordinary Windows observations have no diagnostic sample.", "- Missing, interrupted, not-run, and skipped timings are not imputed. Interrupted/cancelled job durations are censored observations, not completed workloads. Timeout rates reflect API job conclusions; a job-budget termination may be labelled cancelled.", f"- Platforms/lane names/runner labels stay separate. Runner image versions are unavailable in job API metadata. All longitudinal tables below are descriptive mixtures across source revisions and potentially runner images; they establish observed cost, not matched performance or speedup. {cohorts}", "- queueAndDependencyS is run-created to job-start: it includes scheduling AND dependency waits. Pure scheduler queue is unavailable; do not quote it as queue alone.", "- Test-command steps include harness/startup/hooks; per-test Playwright durations include test hooks. Sum of case durations is serial load, not wall time or the workflow DAG critical path.", "", "## Highest observed job cost", "", "Seconds; total in runner-hours. n excludes skipped/absent durations; conclusions include all observed jobs. Failure/cancel/timeout percentages are job conclusions, not initial case outcomes.", "", "| Job | n | hours | p50 | p90 | p95 | max | IQR | MAD | CV | fail/cancel/timeout % |", "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|" ]
    for job in summary["jobs"][:18]:
        d = job["duration"]
        rates = "/".join(f"{100 * job['rates'][r]:.1f}" for r in ["failure", "cancelled", "timed_out"])
        values = [job["group"][0], str(d["n"]), f"{d.get('totalS', 0)/3600:.2f}", *[one_decimal(d.get(k)) for k in ["p50S", "p90S", "p95S", "maxS", "iqrS", "madS", "cv"]], rates]
        lines.append("| " + " | ".join(values) + " |")
    lines += ["", "## Setup/build/test-command separation", "", "Per-step seconds, descriptive p50 / p95. A missing phase is not zero; multiple commands in a phase remain separate observations in steps.jsonl.", "", "| Job | Phase | n | p50 / p95 s |", "|---|---|---:|---|"]
    top_names = {j["group"][0] for j in summary["jobs"][:3]}
    for item in summary["phases"]:
        if item["group"][0] in top_names and item["duration"]["n"] and item["group"][2] in ("setup/other", "build", "test-command", "retry"):
            d = item["duration"]
            lines.append(f"| {item['group'][0]} | {item['group'][2]} | {d['n']} | {d['p50S']:.1f} / {d['p95S']:.1f} |")
    critical_counts = collections.Counter(r["job"] for r in summary["slowestTestJobByRun"])
    lines += ["", "Slowest observed test-job wall duration per run (not a full DAG critical path): " + "; ".join(f"{name}: {count} runs" for name, count in critical_counts.most_common(6)) + "."]
    lines += ["", "## Highest observed per-case cost", "", "Rankings use the original workflow attempt and initial test command. Playwright uses internal retry index zero in that command. Results from the separate CI retry command remain in the evidence. Vitest JSON does not expose internal retry index (null), so unit observations are not claimed to be initial internal attempts. Durations omit skipped/interrupted cases; counts/statuses remain in evidence. Paths/titles are identities, not deletion evidence. Values across changed source remain descriptive.", "", "| Platform/lane | Test | n / runs | total s | p50 | p95 | max |", "|---|---|---:|---:|---:|---:|---:|"]
    for test in tests[:14]:
        kind, platform, lane, file, title, *sample = test["group"]
        d = test["duration"]
        label = f"{file}: {title}".replace("|", "/")
        if len(label) > 155:
            label = label[:152] + "..."
        lines.append(f"| {kind}/{case_cohort(platform, lane, sample)} | {label} | {d['n']} / {test['observedRuns']} | " + " | ".join(f"{d.get(k, 0):.1f}" for k in ["totalS", "p50S", "p95S", "maxS"]) + " |")
    lines += ["", "## High variation shortlist", "", "Descriptive only; n≥10 and p50≥1s. Ranked by IQR/median to resist isolated outliers. Check source/runner changes before attributing variance to tests.", "", "| Platform/lane | Test | n | IQR/median | MAD s | p50 / p95 / max s |", "|---|---|---:|---:|---:|---|"]
    eligible = [t for t in tests if t["duration"]["n"] >= 10 and t["duration"].get("p50S", 0) >= 1]
    eligible.sort(key=lambda t: t["duration"]["iqrS"] / t["duration"]["p50S"], reverse=True)
    for test in eligible[:10]:
        d = test["duration"]
        g = test["group"]
        label = (g[3] + ": " + g[4]).replace("|", "/")[:150]
        lines.append(f"| {case_cohort(g[1], g[2], g[5:])} | {label} | {d['n']} | {d['iqrS']/d['p50S']:.2f} | {d['madS']:.1f} | {d['p50S']:.1f} / {d['p95S']:.1f} / {d['maxS']:.1f} |")
    lines += ["", "## Reproduction and limits", "", f"Run `python3 scripts/ci/audit-runs.py collect --before {manifest['runs'][0]['created_at']}`, `python3 scripts/ci/audit-runs.py artifacts`, `python3 scripts/ci/audit-tests.py`, `python3 scripts/ci/audit-runs.py summarize`, then `python3 scripts/ci/audit-report.py`. Frozen cache makes resumption deterministic; use a fresh --root to select a new sample. Four workers, transport-only bounded backoff, 128 MiB/ZIP and 2 GiB compressed download budget. No reruns or remote mutations. Raw ZIPs, manifest, SHA hashes, JSONL observations, status counts, full quantiles and phase breakdowns remain under ignored `.local/ci-audit/`.", "", "Unit/E2E classification reports and deletion branches are independent. Timing alone cannot establish uselessness. Every removal needs protected behavior, a surviving stronger test, source evidence, and native CI validation. Expected deletion savings remain estimates until measured.", ""]
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text("\n".join(lines))
    print(f"Wrote {output} ({len(lines)} lines)")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=pathlib.Path, default=pathlib.Path(".local/ci-audit"))
    parser.add_argument("--output", type=pathlib.Path, default=pathlib.Path("docs/ci-timing-audit.md"))
    args = parser.parse_args()
    main(args.root, args.output)
