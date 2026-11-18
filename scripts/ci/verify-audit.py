#!/usr/bin/env python3
"""Offline audit oracle. Generates artifact evidence without contacting GitHub."""
import base64
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import zipfile

SCRIPTS = Path(__file__).resolve().parent


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value))


def report(status, bad_member=False):
    payload = io.BytesIO()
    with zipfile.ZipFile(payload, "w") as out:
        if bad_member:
            out.writestr("truncated.json", "{")
        out.writestr(zipfile.ZipInfo("spec.json"), json.dumps({"fileName": "case.spec.ts", "tests": [{
            "testId": "case", "title": "same case",
            "results": [{"duration": 1000, "retry": 0, "status": status}],
        }]}))
    return b"data:application/zip;base64," + base64.b64encode(payload.getvalue())


def oracle(scripts, root):
    start, end, later = ("2026-11-18T10:00:00Z", "2026-11-18T10:59:00Z", "2026-11-18T12:00:00Z")
    originals = []
    for run_id in (1, 2):
        run = {"id": run_id, "head_sha": "same-head", "status": "completed", "run_attempt": 1,
               "created_at": start, "event": "push", "head_branch": "main", "conclusion": "success"}
        originals.append(run)
        # The frozen manifest is deliberately stale for run 2.
        save(root / "runs" / f"{run_id}.json", {"run": run, "latest": run, "artifacts": [], "jobs": [{
            "id": run_id, "run_attempt": 1, "name": "unit lane zero", "labels": ["hosted"], "runner_name": "",
            "conclusion": "success", "started_at": end, "completed_at": end, "steps": [
                {"name": name, "conclusion": "success", "started_at": start, "completed_at": end}
                for name in (
                    "Checkout repository", "Test", "Test (unit)", "Test standalone headless CLI",
                    "Run desktop replay-backed Electron tests", "Retry failed unit tests", "Retry failed E2E tests",
                    "Select failed E2E tests", "Record retry slice", "Check E2E retry results", "Upload unit retry reports",
                )],
        }, {"id": 10 + run_id, "run_attempt": 1, "name": "setup", "labels": ["hosted"], "runner_name": "",
            "conclusion": "success", "started_at": start, "completed_at": start, "steps": []}]})
    save(root / "manifest.json", {"collectedAt": end, "workflowId": 1, "sourceRevision": "source",
                                 "selection": "Synthetic audit evidence", "runs": originals})
    inventory = []
    (root / "zips").mkdir()
    first = "retry/first-playwright-report/index.html"
    current = "playwright-report/index.html"
    for index, (run, time, name, members) in enumerate((
        (1, end, "desktop-e2e-windows-lane-1-artifacts", {first: report("failed"), current: report("failed")}),
        (1, end, "desktop-e2e-windows-sample-1-lane-1-artifacts", {first: report("failed"), current: report("passed")}),
        (1, end, "desktop-e2e-windows-sample-2-lane-1-artifacts", {current: report("passed")}),
        (1, end, "desktop-e2e-windows-sample-3-lane-1-artifacts", {current: report("passed")}),
        (2, later, "desktop-e2e-windows-lane-1-artifacts", {current: report("passed")}),
        (1, end, "macos-unit-timings-lane-1", {"macos-unit-results.json": b'{"testResults":'}),
        (1, end, "desktop-e2e-linux-lane-1-artifacts", {current: b"data:application/zip;base64,YmFk"}),
        (1, end, "desktop-e2e-linux-lane-2-artifacts", {current: report("passed", bad_member=True)}),
        (1, end, "desktop-e2e-linux-lane-3-artifacts", {current: report("passed"), "e2e-first-last.json": "{}"}),
    ), 1):
        inventory.append({"runId": run, "artifactId": index, "name": name,
                          "createdAt": time, "state": "downloaded", "expired": False})
        with zipfile.ZipFile(root / "zips" / f"{index}.zip", "w") as archive:
            for name, value in members.items():
                archive.writestr(name, value)
    save(root / "artifact-manifest.json", inventory)

    def cli(name, *args):
        subprocess.run([sys.executable, scripts / name, "--root", root, *args], check=True, capture_output=True)

    cli("audit-runs.py", "summarize")
    steps = {r["step"]: r["phase"] for r in map(json.loads, (root / "steps.jsonl").read_text().splitlines())}
    assert steps["Checkout repository"] == "setup/other"
    queues = {
        "test-command": ["Test", "Test (unit)", "Test standalone headless CLI", "Run desktop replay-backed Electron tests"],
        "retry": ["Retry failed unit tests", "Retry failed E2E tests"],
        "report/check": ["Select failed E2E tests", "Record retry slice", "Check E2E retry results", "Upload unit retry reports"],
    }
    problems = [(name, steps[name]) for phase, names in queues.items() for name in names if steps[name] != phase]

    cli("audit-tests.py")
    assert not problems, problems
    rows = list(map(json.loads, (root / "tests.jsonl").read_text().splitlines()))
    assert [r["command"] for r in rows if r["artifactId"] == 1] == ["initial"]
    assert [r["command"] for r in rows if r["artifactId"] == 2] == ["initial", "retry"]
    assert next(r for r in rows if r["artifactId"] == 5)["attempt"] is None
    assert next(r for r in rows if r["artifactId"] == 9)["command"] is None
    coverage = {r["artifactId"]: r for r in json.loads((root / "timing-coverage.json").read_text())}
    assert all(coverage[i]["unreadableMembers"] for i in (6, 7, 8))
    assert coverage[8]["observations"] == 1
    groups = json.loads((root / "test-summary.json").read_text())
    assert [g["group"][-1] for g in groups if g["group"][1] == "windows"] == [None, 1, 2, 3]
    assert all(g["duration"]["n"] == 1 for g in groups)
    cli("audit-report.py", "--output", root / "audit.md")
    rendered = (root / "audit.md").read_text()
    assert "CV" in rendered and "| unavailable |" in rendered
    assert "Repeated head SHAs: 1" in rendered
    assert "boundaries passed" not in rendered


if __name__ == "__main__":
    with tempfile.TemporaryDirectory(prefix="pwragent-ci-audit-") as root:
        oracle(Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else SCRIPTS, Path(root))
    print("Offline CI audit oracle passed")
