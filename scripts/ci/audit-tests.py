#!/usr/bin/env python3
"""Normalize bounded timing fields from downloaded audit ZIPs; never execute tests."""
import argparse
import base64
import collections
import importlib.util
import io
import json
import pathlib
import re
import zipfile
import zlib

spec = importlib.util.spec_from_file_location("audit_runs", pathlib.Path(__file__).with_name("audit-runs.py"))
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


MAX_MEMBER_BYTES = 32 * 1024 ** 2
MAX_REPORT_BYTES = 128 * 1024 ** 2
UNREADABLE_ZIP = (OSError, EOFError, RuntimeError, NotImplementedError, zipfile.BadZipFile, zlib.error)
UNREADABLE_REPORT = (*UNREADABLE_ZIP, KeyError, TypeError, ValueError, AttributeError, OverflowError)


def artifact_attempt(run, artifact):
    # Use the original attempt's job window, not the mutable run's updated_at.
    # A rerun can start after the manifest was frozen, before artifacts are listed.
    original = run["run"]
    if run["latest"].get("run_attempt") != 1 or original.get("run_attempt") != 1 or original.get("status") != "completed":
        return None
    jobs = [j for j in run["jobs"] if j.get("run_attempt") == 1]
    starts = [j["started_at"] for j in jobs if j.get("started_at")]
    ends = [j["completed_at"] for j in jobs if j.get("completed_at")]
    created = artifact.get("createdAt")
    if not created or not starts or not ends:
        return None
    try:
        if audit.seconds(min(starts), created) is not None and audit.seconds(created, max(ends)) is not None:
            return 1
    except ValueError:
        pass
    return None


def duration_seconds(value):
    return value / 1000 if isinstance(value, (int, float)) else None


def text_field(record, key):
    value = record[key]
    if not isinstance(value, str):
        raise ValueError(f"Expected a string for {key}")
    return value


def playwright_rows(report, member, context, command, source):
    value = json.loads(report.read(member))
    file = text_field(value, "fileName")
    rows = []
    for test in value["tests"]:
        for result in test.get("results", []):
            rows.append({
                **context, "kind": "e2e", "command": command, "file": file,
                "testId": test["testId"], "title": " > ".join([*test.get("path", []), test["title"]]),
                "project": test.get("projectName"), "retry": result.get("retry"),
                "status": result.get("status"), "outcome": test.get("outcome"),
                "durationS": duration_seconds(result.get("duration")), "member": source,
            })
    return rows


def vitest_rows(archive, info, context):
    value = json.loads(archive.read(info))
    return [{
        **context, "kind": "unit", "command": "initial", "file": text_field(suite, "name"),
        "title": text_field(test, "fullName"), "testId": None, "project": None, "retry": None,
        "status": test["status"], "outcome": None, "durationS": duration_seconds(test.get("duration")),
        "member": info.filename,
    } for suite in value["testResults"] for test in suite.get("assertionResults", [])]


def reports(archive, context, formats, unreadable, skipped):
    first = []
    regular = []
    has_retry_marker = False
    for info in archive.infolist():
        member = pathlib.PurePosixPath(info.filename)
        if member.name == "index.html" and member.parent.name == "first-playwright-report":
            first.append(info)
        elif member.name == "index.html" and member.parent.name == "playwright-report":
            regular.append(info)
        elif member.name in {"e2e-retry.json", "e2e-first-last.json"}:
            has_retry_marker = True
        elif member.name == "macos-unit-results.json":
            if info.file_size > MAX_MEMBER_BYTES:
                skipped.append(info.filename)
                continue
            try:
                rows = vitest_rows(archive, info, context)
            except UNREADABLE_REPORT:
                unreadable.append(info.filename)
                continue
            formats.add("vitest-json")
            yield from rows

    first_hashes = set()
    for info in first + regular:
        preserved = info in first
        if info.file_size > MAX_MEMBER_BYTES:
            skipped.append(info.filename)
            continue
        try:
            match = re.search(rb'data:application/zip;base64,([A-Za-z0-9+/=]+)', archive.read(info))
            if not match:
                unreadable.append(info.filename)
                continue
            payload = base64.b64decode(match[1], validate=True)
            checksum = audit.digest(payload)
            if not preserved and checksum in first_hashes:
                # Playwright never replaced the initial report. The preserved copy is authoritative.
                continue
            with zipfile.ZipFile(io.BytesIO(payload)) as report:
                if sum(i.file_size for i in report.infolist()) > MAX_REPORT_BYTES:
                    skipped.append(info.filename)
                    continue
                if preserved:
                    first_hashes.add(checksum)
                    command = "initial"
                elif first_hashes:
                    command = "retry"
                else:
                    command = "initial" if not first and not has_retry_marker else None
                formats.add("playwright-html-embedded-zip")
                for member in report.infolist():
                    if not member.filename.endswith(".json") or member.filename == "report.json":
                        continue
                    source = info.filename + "!" + member.filename
                    if member.file_size > MAX_MEMBER_BYTES:
                        skipped.append(source)
                        continue
                    try:
                        rows = playwright_rows(report, member, context, command, source)
                    except UNREADABLE_REPORT:
                        unreadable.append(source)
                        continue
                    yield from rows
        except UNREADABLE_REPORT:
            unreadable.append(info.filename)


def main(root):
    inventory = json.loads((root / "artifact-manifest.json").read_text())
    coverage = []
    groups = collections.defaultdict(list)
    observed_runs = set()
    unknown_attempts = 0
    count = 0
    output = root / "tests.jsonl"
    temporary = output.with_suffix(".jsonl.tmp")

    with temporary.open("w") as out:
        for artifact in inventory:
            if artifact["state"] != "downloaded":
                continue
            run = json.loads((root / "runs" / f"{artifact['runId']}.json").read_text())
            name = artifact["name"]
            platform = next((p for p in ["macos", "windows", "linux"] if p in name), "unknown")
            lane = re.search(r"lane-(\d+)", name)
            sample = re.match(r"desktop-e2e-windows-sample-(\d+)-lane-", name)
            context = {
                "runId": artifact["runId"], "artifactId": artifact["artifactId"], "artifact": name,
                "attempt": artifact_attempt(run, artifact), "headSha": run["run"]["head_sha"],
                "platform": platform, "lane": int(lane[1]) if lane else None,
                "diagnosticSample": int(sample[1]) if sample else None, "runnerImageVersion": None,
            }
            count_before = count
            formats, unreadable, skipped = set(), [], []
            try:
                archive = zipfile.ZipFile(root / "zips" / f"{artifact['artifactId']}.zip")
            except UNREADABLE_ZIP:
                unreadable.append(f"{artifact['artifactId']}.zip")
            else:
                with archive:
                    for row in reports(archive, context, formats, unreadable, skipped):
                        count += 1
                        observed_runs.add(row["runId"])
                        unknown_attempts += row["attempt"] is None
                        # Normalize hosted checkout roots, preserving repo-relative identity.
                        row["file"] = re.sub(r"^.*?[/\\]PwrAg(?:e)?nt[/\\](?:PwrAg(?:e)?nt[/\\])?", "", row["file"], flags=re.I).replace("\\", "/")
                        out.write(json.dumps(row) + "\n")
                        if row["attempt"] == 1 and row["command"] == "initial" and row["retry"] in (0, None):
                            key = (row["kind"], platform, row["lane"], row["file"], row["title"], row["diagnosticSample"])
                            groups[key].append((row["durationS"], row["status"], row["runId"], row["headSha"]))
            coverage.append({
                **context, "formats": sorted(formats), "observations": count - count_before,
                "unreadableMembers": unreadable, "sizeExcludedMembers": skipped,
            })

    summary = []
    for group, values in groups.items():
        summary.append({"group": group, "duration": audit.stats([v[0] for v in values if v[1] not in ("skipped", "interrupted")]), "observedRuns": len({v[2] for v in values}), "heads": len({v[3] for v in values}), "statuses": dict(collections.Counter(str(v[1]) for v in values))})
    summary.sort(key=lambda g: g["duration"].get("totalS", 0), reverse=True)
    temporary.replace(output)
    audit.save(root / "test-summary.json", summary)
    audit.save(root / "timing-coverage.json", coverage)
    print(json.dumps({"observations": count, "groups": len(groups), "formats": dict(collections.Counter(f for c in coverage for f in c["formats"])), "runsWithTimings": len(observed_runs), "unknownAttemptObservations": unknown_attempts}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=pathlib.Path, default=pathlib.Path(".local/ci-audit"))
    main(parser.parse_args().root)
