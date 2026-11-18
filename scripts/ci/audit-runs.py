#!/usr/bin/env python3
"""Read-only, cached CI evidence collector. No dependencies beyond Python and gh."""
import argparse
import concurrent.futures
import datetime as dt
import hashlib
import io
import json
import math
import pathlib
import re
import statistics
import subprocess
import time
import zipfile

REPO = "repos/pwrdrvr/PwrAgent"
SCHEMA = 1


def digest(data):
    return hashlib.sha256(data).hexdigest()


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    data = json.dumps(value, sort_keys=True, indent=2).encode()
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_bytes(data)
    temporary.replace(path)


def api(endpoint, path, binary=False):
    if path.exists():
        data = path.read_bytes()
        return data if binary else json.loads(data)
    for attempt in range(4):
        result = subprocess.run(["gh", "api", endpoint], capture_output=True, timeout=180)
        if result.returncode == 0:
            path.parent.mkdir(parents=True, exist_ok=True)
            temporary = path.with_suffix(path.suffix + ".tmp")
            temporary.write_bytes(result.stdout)
            temporary.replace(path)
            return result.stdout if binary else json.loads(result.stdout)
        error = result.stderr.decode(errors="replace")
        # Retry transport/temporary server/rate-limit failures only, never CI.
        if not re.search(r"HTTP 50[234]|HTTP 429|rate limit|connection|TLS|timeout", error, re.I):
            raise RuntimeError(error[:400])
        if attempt == 3:
            raise RuntimeError(error[:400])
        time.sleep(min(60, 10 * 2 ** attempt))


def pages(endpoint, field, cache):
    rows = []
    for page in range(1, 101):
        data = api(f"{endpoint}{'&' if '?' in endpoint else '?'}per_page=100&page={page}", cache / f"{page}.json")
        rows.extend(data[field])
        if len(data[field]) < 100:
            return rows
    raise RuntimeError("Pagination budget exceeded")


def seconds(start, end):
    if not start or not end:
        return None
    value = (dt.datetime.fromisoformat(end.replace("Z", "+00:00")) - dt.datetime.fromisoformat(start.replace("Z", "+00:00"))).total_seconds()
    return value if value >= 0 else None


def phase(name):
    name = name.lower()
    if "retry" in name:
        return "retry"
    if "upload" in name or "record" in name or "verify" in name or "check" in name:
        return "report/check"
    if "test" in name and "install" not in name:
        return "test-command"
    if "build" in name or "package" in name:
        return "build"
    return "setup/other"


def collect(root):
    cache = root / "cache"
    workflow = api(f"{REPO}/actions/workflows/ci.yml", cache / "workflow.json")
    manifest_path = root / "manifest.json"
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text())
    else:
        runs = []
        for page in range(1, 4):
            data = api(f"{REPO}/actions/workflows/{workflow['id']}/runs?per_page=100&page={page}", cache / f"runs-{page}.json")
            runs.extend(data["workflow_runs"])
            if len({r['id'] for r in runs}) >= 200:
                break
        unique = {r["id"]: r for r in runs}
        selected = sorted(unique.values(), key=lambda r: (r["created_at"], r["id"]), reverse=True)[:200]
        if len(selected) != 200:
            raise RuntimeError("Need exactly 200 runs")
        manifest = {"schemaVersion": SCHEMA, "collectedAt": dt.datetime.now(dt.timezone.utc).isoformat(), "repository": "github.com/pwrdrvr/PwrAgent", "workflowId": workflow["id"], "selection": "Latest 200 unique CI workflow run IDs by created_at/id; all events, branches and conclusions. Analyze original attempt 1; retain latest attempt metadata separately.", "sourceRevision": subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip(), "runs": selected}
        save(manifest_path, manifest)

    def one(run):
        rid = run["id"]
        base = cache / str(rid)
        try:
            original = api(f"{REPO}/actions/runs/{rid}/attempts/1", base / "original.json")
            jobs = pages(f"{REPO}/actions/runs/{rid}/attempts/1/jobs", "jobs", base / "jobs")
            artifacts = pages(f"{REPO}/actions/runs/{rid}/artifacts", "artifacts", base / "artifacts")
            save(root / "runs" / f"{rid}.json", {"run": original, "latest": run, "jobs": jobs, "artifacts": artifacts})
            return {"runId": rid, "jobs": len(jobs), "artifacts": len(artifacts)}
        except (RuntimeError, subprocess.TimeoutExpired) as error:
            return {"runId": rid, "error": str(error)[:400]}
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(one, manifest["runs"]))
    save(root / "collection.json", results)
    print(json.dumps({"runs": len(results), "errors": sum("error" in r for r in results)}))


def artifacts(root, budget_mb):
    # Deterministic newest-run/name order; explicit budget exclusions, not silent sampling.
    used = sum(p.stat().st_size for p in (root / "zips").glob("*.zip"))
    inventory = []
    manifest = json.loads((root / "manifest.json").read_text())
    for run in manifest["runs"]:
        path = root / "runs" / f"{run['id']}.json"
        if not path.exists():
            continue
        for artifact in sorted(json.loads(path.read_text())["artifacts"], key=lambda a: a["name"]):
            row = {"runId": run["id"], "artifactId": artifact["id"], "name": artifact["name"], "sizeBytes": artifact["size_in_bytes"], "expired": artifact["expired"], "createdAt": artifact["created_at"]}
            inventory.append(row)
            if not re.search(r"unit-timings|unit-retry|e2e.*artifacts|flake-report|flake-slice", artifact["name"]):
                row["state"] = "not-timing-artifact"
                continue
            destination = root / "zips" / f"{artifact['id']}.zip"
            if artifact["expired"]:
                row["state"] = "expired"
                continue
            if not destination.exists() and (artifact["size_in_bytes"] > 128 * 1024 ** 2 or used + artifact["size_in_bytes"] > budget_mb * 1024 ** 2):
                row["state"] = "budget-excluded"
                continue
            try:
                existed = destination.exists()
                data = api(f"{REPO}/actions/artifacts/{artifact['id']}/zip", destination, True)
                if not existed:
                    used += len(data)
                row.update(state="downloaded", sha256=digest(data))
                with zipfile.ZipFile(io.BytesIO(data)) as archive:
                    members = []
                    for info in archive.infolist():
                        # Never extract paths, traces, screenshots, or private logs.
                        if info.file_size > 32 * 1024 ** 2 or not info.filename.endswith(".json"):
                            continue
                        payload = archive.read(info)
                        try:
                            value = json.loads(payload)
                        except (ValueError, UnicodeDecodeError):
                            continue
                        member = digest(info.filename.encode())[:16] + ".json"
                        save(root / "evidence" / str(artifact["id"]) / member, value)
                        members.append({"member": info.filename, "path": f"evidence/{artifact['id']}/{member}", "sha256": digest(payload)})
                    row["members"] = members
            except (RuntimeError, subprocess.TimeoutExpired, zipfile.BadZipFile) as error:
                row.update(state="unavailable", error=str(error)[:400])
        save(root / "artifact-manifest.json", inventory)
    print(json.dumps({"artifacts": len(inventory), "downloaded": sum(r["state"] == "downloaded" for r in inventory), "bytes": used}))


def stats(values):
    values = sorted(v for v in values if v is not None and math.isfinite(v))
    if not values:
        return {"n": 0}
    def q(p):
        index = (len(values) - 1) * p
        lo = int(index)
        return values[lo] + (values[min(lo + 1, len(values) - 1)] - values[lo]) * (index - lo)
    median = q(.5)
    mean = statistics.mean(values)
    return {"n": len(values), "totalS": sum(values), "p50S": median, "p90S": q(.9), "p95S": q(.95), "maxS": values[-1], "iqrS": q(.75) - q(.25), "madS": statistics.median(abs(v - median) for v in values), "cv": statistics.pstdev(values) / mean if mean else None}


def summarize(root):
    manifest = json.loads((root / "manifest.json").read_text())
    rows, steps = [], []
    for path in sorted((root / "runs").glob("*.json")):
        data = json.loads(path.read_text())
        run = data["run"]
        for job in data["jobs"]:
            # SHA is retained: across-SHA summaries are observational, never speedup evidence.
            row = {"runId": run["id"], "attempt": 1, "headSha": run["head_sha"], "event": run["event"], "branch": run["head_branch"], "jobId": job["id"], "job": job["name"], "labels": job["labels"], "runnerName": job["runner_name"], "runnerImageVersion": None, "conclusion": job["conclusion"], "durationS": seconds(job["started_at"], job["completed_at"]), "queueAndDependencyS": seconds(run["created_at"], job["started_at"])}
            rows.append(row)
            for step in job["steps"]:
                steps.append({**row, "step": step["name"], "phase": phase(step["name"]), "conclusion": step["conclusion"], "durationS": seconds(step["started_at"], step["completed_at"])})
    for name, records in [("jobs", rows), ("steps", steps)]:
        with (root / f"{name}.jsonl").open("w") as out:
            for row in records:
                out.write(json.dumps(row) + "\n")
    groups = {}
    for row in rows:
        key = json.dumps([row["job"], row["labels"]])
        groups.setdefault(key, []).append(row)
    report = {"schemaVersion": SCHEMA, "manifestSha256": digest((root / "manifest.json").read_bytes()), "coverage": {"runs": len(manifest["runs"]), "collectedRuns": len(list((root / "runs").glob("*.json"))), "events": {}, "conclusionsLatest": {}, "rerunRunIds": [], "uniqueHeads": len({r["head_sha"] for r in manifest["runs"]})}, "jobs": []}
    for run in manifest["runs"]:
        for field, source in [("events", "event"), ("conclusionsLatest", "conclusion")]:
            key = str(run[source])
            report["coverage"][field][key] = report["coverage"][field].get(key, 0) + 1
        if run["run_attempt"] > 1:
            report["coverage"]["rerunRunIds"].append(run["id"])
    for key, samples in groups.items():
        conclusions = {}
        for row in samples:
            name = str(row["conclusion"])
            conclusions[name] = conclusions.get(name, 0) + 1
        report["jobs"].append({"group": json.loads(key), "duration": stats([r["durationS"] for r in samples if r["conclusion"] != "skipped"]), "queueAndDependency": stats([r["queueAndDependencyS"] for r in samples if r["conclusion"] != "skipped"]), "conclusions": conclusions})
    report["jobs"].sort(key=lambda j: j["duration"].get("totalS", 0), reverse=True)
    save(root / "summary.json", report)
    hashes = {str(p.relative_to(root)): digest(p.read_bytes()) for p in sorted(root.rglob("*.json")) if "cache" not in p.parts and p.name != "hashes.json"}
    save(root / "hashes.json", hashes)
    print(json.dumps(report["coverage"]))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["collect", "artifacts", "summarize"])
    parser.add_argument("--root", type=pathlib.Path, default=pathlib.Path(".local/ci-audit"))
    parser.add_argument("--budget-mb", type=int, default=2048)
    args = parser.parse_args()
    args.root.mkdir(parents=True, exist_ok=True)
    {"collect": lambda: collect(args.root), "artifacts": lambda: artifacts(args.root, args.budget_mb), "summarize": lambda: summarize(args.root)}[args.command]()


if __name__ == "__main__":
    main()
