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

spec = importlib.util.spec_from_file_location("audit_runs", pathlib.Path(__file__).with_name("audit-runs.py"))
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


def main(root):
    inventory = json.loads((root / "artifact-manifest.json").read_text())
    rows, coverage = [], []
    for artifact in inventory:
        if artifact["state"] != "downloaded":
            continue
        run = json.loads((root / "runs" / f"{artifact['runId']}.json").read_text())
        name = artifact["name"]
        platform = next((p for p in ["macos", "windows", "linux"] if p in name), "unknown")
        lane = re.search(r"lane-(\d+)", name)
        # Run-scoped artifact endpoint can contain later attempts. Never assume initial.
        attempt = 1 if run["latest"]["run_attempt"] == 1 else None
        context = {"runId": artifact["runId"], "artifactId": artifact["artifactId"], "artifact": name, "attempt": attempt, "headSha": run["run"]["head_sha"], "platform": platform, "lane": int(lane[1]) if lane else None, "runnerImageVersion": None}
        count_before = len(rows)
        formats = set()
        with zipfile.ZipFile(root / "zips" / f"{artifact['artifactId']}.zip") as archive:
            for info in archive.infolist():
                if info.file_size > 32 * 1024 ** 2:
                    continue
                if info.filename.endswith("playwright-report/index.html"):
                    match = re.search(rb'data:application/zip;base64,([A-Za-z0-9+/=]+)', archive.read(info))
                    if not match:
                        continue
                    with zipfile.ZipFile(io.BytesIO(base64.b64decode(match[1]))) as report:
                        if sum(i.file_size for i in report.infolist()) > 128 * 1024 ** 2:
                            continue
                        formats.add("playwright-html-embedded-zip")
                        for member in report.infolist():
                            if not member.filename.endswith(".json") or member.filename == "report.json":
                                continue
                            value = json.loads(report.read(member))
                            for test in value.get("tests", []):
                                for result in test.get("results", []):
                                    duration = result.get("duration")
                                    rows.append({**context, "kind": "e2e", "file": value["fileName"], "testId": test["testId"], "title": " > ".join([*test.get("path", []), test["title"]]), "project": test.get("projectName"), "retry": result.get("retry"), "status": result.get("status"), "outcome": test.get("outcome"), "durationS": duration / 1000 if isinstance(duration, (int, float)) else None, "member": info.filename + "!" + member.filename})
                elif info.filename.endswith(".json") and "unit" in info.filename:
                    value = json.loads(archive.read(info))
                    if not isinstance(value, dict) or "testResults" not in value:
                        continue
                    formats.add("vitest-json")
                    for suite in value["testResults"]:
                        for test in suite.get("assertionResults", []):
                            duration = test.get("duration")
                            rows.append({**context, "kind": "unit", "file": suite["name"], "title": test["fullName"], "testId": None, "project": None, "retry": None, "status": test["status"], "outcome": None, "durationS": duration / 1000 if isinstance(duration, (int, float)) else None, "member": info.filename})
        coverage.append({**context, "formats": sorted(formats), "observations": len(rows) - count_before})
    with (root / "tests.jsonl").open("w") as out:
        for row in rows:
            out.write(json.dumps(row) + "\n")
    groups = collections.defaultdict(list)
    for row in rows:
        if row["attempt"] == 1 and (row["retry"] in (0, None)):
            groups[(row["kind"], row["platform"], row["lane"], row["file"], row["title"])].append(row)
    summary = []
    for group, values in groups.items():
        summary.append({"group": group, "duration": audit.stats([v["durationS"] for v in values]), "observedRuns": len({v["runId"] for v in values}), "heads": len({v["headSha"] for v in values}), "statuses": dict(collections.Counter(str(v["status"]) for v in values))})
    summary.sort(key=lambda g: g["duration"].get("totalS", 0), reverse=True)
    audit.save(root / "test-summary.json", summary)
    audit.save(root / "timing-coverage.json", coverage)
    print(json.dumps({"observations": len(rows), "groups": len(groups), "formats": dict(collections.Counter(f for c in coverage for f in c["formats"])), "runsWithTimings": len({r["runId"] for r in rows}), "unknownAttemptObservations": sum(r["attempt"] is None for r in rows)}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=pathlib.Path, default=pathlib.Path(".local/ci-audit"))
    main(parser.parse_args().root)
