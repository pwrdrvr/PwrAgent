"""Replay the matched profile workload in one or two independently installed checkouts."""
import argparse
from collections import Counter, defaultdict
from contextlib import ExitStack
import json
import os
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory

KIT = Path(__file__).resolve().parent
ROOT = KIT.parents[1]
MAIN = Path("apps/desktop/src/main/__tests__")
RENDERER = Path("apps/desktop/src/renderer/src/features/thread-detail/__tests__")
PROPERTIES = json.loads((KIT / "properties.json").read_text())
REVISIONS = json.loads((KIT / "revisions.json").read_text())
MATCHED = ["navigation", "sqlite", "terminal", "held-auto-fix", "pricing", "federation", "reopen", "stream", "properties"]
LIVE = "live-threads"
CI = MATCHED + [LIVE, "token-miser"]
EXTRA = ["width", "pins", "git", "dispatcher", "incremental"]
# Exact historical heads for workloads introduced during the investigation.
HISTORICAL = {
    "main2": ["sqlite"], "pr4589": ["pricing"], "pr4593": ["pricing"], "pr4593new": ["pricing"],
    "pr4590": ["navigation", "incremental"], "pr4590b": ["navigation", "incremental", "sqlite"],
    "pr4612": ["pricing", "token-miser"],
    "pr4605": ["terminal"], "pr4605new": ["terminal", "held-auto-fix"],
}


def revision(repo):
    return subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()


def select(args, historical):
    available = HISTORICAL.get(historical, (MATCHED if historical else CI) + EXTRA[:-1])
    if historical in ("v150", "v151"):
        available = [suite for suite in available if suite != "dispatcher"]
    if historical in ("main", "latest"):
        available = [suite for suite in available if suite != "sqlite" and
                     (suite != "held-auto-fix" or historical == "latest")]
    selected = args.suites or (available if historical else CI)
    for name in selected:
        if name not in available:
            raise ValueError(f"{name} unavailable on {historical or 'current'} (supported: {', '.join(available)})")
    return selected


def run(repo, output, suites, args):
    sha = revision(repo)
    label = next((key for key, value in REVISIONS.items() if value == sha), None)
    output.mkdir(parents=True)
    print(f"Running {', '.join(suites)} at {sha[:12]} in {repo}", flush=True)
    projects = defaultdict(list)
    with ExitStack() as cleanup:
        def stage(path, content):
            target = repo / path
            with target.open("x") as file:
                cleanup.callback(target.unlink, missing_ok=True)
                file.write(content)

        def probe(folder, name, source, project):
            path = folder / f"scaling-audit-{name}.audit{source.suffix}"
            stage(path, source.read_text())
            projects[project].append(path.as_posix())

        helpers = set()
        for name in suites:
            if name == "properties":
                for family, meta in PROPERTIES.items():
                    original = Path(meta["source"])
                    source = KIT / meta["corpus"] if "corpus" in meta else ROOT / original
                    contents = source.read_text()
                    # Use the candidate's same corpus on both sides. Preserve adjacent helper imports.
                    anchor = 'import fc from "fast-check";'
                    if contents.count(anchor) != 1:
                        raise ValueError(f"Cannot bind the matched fast-check driver in {source}")
                    contents = contents.replace(anchor, 'import { matchedModel } from "./scaling-audit-model";\n'
                                                f'const fc = matchedModel("{family}", {meta["seed"]});')
                    project = ("owner-core" if original.parts[0] == "packages" else
                               "desktop-main" if original.parent == MAIN else "desktop-renderer-node")
                    target = original.with_name(f"scaling-audit-{family}.audit.ts")
                    stage(target, contents)
                    projects[project].append(target.as_posix())
                    helpers.add(original.parent)
                continue
            folder = RENDERER if name in ("stream", "width", LIVE) else MAIN
            project = {"width": "desktop-renderer", LIVE: "desktop-renderer", "stream": "desktop-renderer-node"}.get(name, "desktop-main")
            source = KIT / ("historical" if name == "incremental" else "probes") / (name + (".tsx" if name in ("width", LIVE) else ".ts"))
            probe(folder, name, source, project)
            helpers.add(folder)

        for folder in helpers:
            stage(folder / "scaling-audit-results.ts", (KIT / "results.ts").read_text())
            if "properties" in suites:
                stage(folder / "scaling-audit-model.ts", (KIT / "matched-model.ts").read_text())
        if "pricing" in suites or "token-miser" in suites:
            stage(MAIN / "scaling-audit-pricing-rows.ts", (KIT / "pricing-rows.ts").read_text())
        if "navigation" in suites or "sqlite" in suites:
            stage(MAIN / "scaling-audit-navigation-fixture.ts", (KIT / "navigation-fixture.ts").read_text())
            stage(MAIN / "scaling-audit-generate.mjs", (KIT / "generate.mjs").read_text().replace("./shape.json", "./scaling-audit-shape.json"))
            stage(MAIN / "scaling-audit-shape.json", (KIT / "shape.json").read_text())
        config = "scaling-audit.workspace.mts"
        stage(config, (KIT / "workspace.mts").read_text())
        home = cleanup.enter_context(TemporaryDirectory(prefix="scaling-audit-profile-"))
        raw = output / "work.jsonl"
        raw.touch()
        env = dict(os.environ, PWRAGENT_HOME=home, PWRAGENT_PROFILE="default", UV_THREADPOOL_SIZE="4",
                   AUDIT_KEYED_SESSIONS=str(int((repo / "apps/desktop/src/renderer/src/lib/thread-session-cache.ts").is_file())),
                   AUDIT_LIVE_THREADS=str(int(LIVE in suites)), AUDIT_FILES=json.dumps(projects), AUDIT_CASES=str(args.cases), AUDIT_RESULTS=str(raw),
                   AUDIT_COPIES=str(args.copies), AUDIT_ARCHIVED=str(args.archived),
                   AUDIT_LEGACY_OWNER=str(int(label in ("v150", "v151", "v152"))),
                   AUDIT_LIVE_INDEX=str(int((repo / MAIN.parent / "app-server/live-navigation-index.ts").is_file())),
                   AUDIT_COUNT_PROJECTION=str(int("navigation" in suites)))
        result = subprocess.run(["pnpm", "exec", "vitest", "run", "--config", config, "--maxWorkers=1",
                                 "--testTimeout=180000", "--reporter=json", "--outputFile", str(output / "vitest.json")],
                                cwd=repo, env=env)
        if result.returncode:
            raise ValueError(f"Vitest exited {result.returncode}. See {output / 'vitest.json'}")
    rows = [json.loads(line) for line in raw.read_text().splitlines()]
    if "properties" in suites:
        counts = Counter(row["family"] for row in rows if "family" in row)
        if counts != {key: value["assertions"] for key, value in PROPERTIES.items()}:
            raise ValueError(f"Matched property corpus changed: {counts}")
        if any(row["runs"] != args.cases or row["failed"] for row in rows if "family" in row):
            raise ValueError("Incomplete matched model run")
    report = json.loads((output / "vitest.json").read_text())
    if report["numPassedTests"] == 0 or report["numPendingTests"] or report["numFailedTests"]:
        raise ValueError("Vitest did not pass every selected test")
    return {"sha": sha, "historical": label, "tests": report["numPassedTests"], "rows": rows}


def positive(value):
    number = int(value)
    if number < 1:
        raise argparse.ArgumentTypeError("expected a positive integer")
    return number


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--candidate", type=Path, default=ROOT, help="installed target checkout")
    parser.add_argument("--base", type=Path, help="installed pinned comparison checkout")
    parser.add_argument("--historical", choices=REVISIONS, help="verify candidate SHA and select applicable historical probes")
    parser.add_argument("--suites", nargs="+", choices=CI + EXTRA)
    parser.add_argument("--cases", type=positive, default=1000, help="repetitions per matched assertion")
    parser.add_argument("--copies", type=positive, default=1, help="multiply shaped navigation and SQLite live cardinalities")
    parser.add_argument("--archived", type=int, default=2807, help="SQLite archive control")
    parser.add_argument("--output", type=Path, required=True, help="fresh results directory")
    args = parser.parse_args()
    if args.archived < 0 or len(set(args.suites or [])) != len(args.suites or []):
        parser.error("use a nonnegative archive count and unique suites")
    candidate = args.candidate.resolve()
    if args.historical and revision(candidate) != REVISIONS[args.historical]:
        parser.error(f"use the checkout at {REVISIONS[args.historical]}")
    suites = select(args, args.historical)
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    from report import summarize
    runs = {}
    for name, repo in [("base", args.base), ("candidate", candidate)]:
        if repo:
            runs[name] = run(repo.resolve(), output / name, suites, args)
    return summarize(output, runs, suites, args)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        sys.exit(str(error))
