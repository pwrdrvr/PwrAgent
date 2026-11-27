"""Compare identical scenarios by named work units and retain diagnostic samples."""
from collections import Counter
import json

# Work units that may decrease on a candidate. Timestamps, timings, serialized
# byte lengths and query outputs remain in the raw evidence for interpretation.
COUNTERS = {
    "token-miser": ["usageRows", "cardRows", "metadataRows", "publishedRows", "folds"],
    "live-threads": ["indicatorVisits", "retentionVisits", "projections", "projectionRows", "backgroundProjections", "commits", "ownerReads"],
    "navigation": ["joined", "targeted", "directoryRows", "providerLists", "checkoutPaths", "slotCopies", "lensTests"],
    "shape-navigation": ["joined", "targeted", "directoryRows", "providerLists", "checkoutPaths", "slotCopies", "lensTests"],
    "sqlite": ["joined", "lists", "compact", "checkoutPaths"],
    "terminal": ["activity", "reviews"],
    "held-auto-fix": ["reviewGets", "stackHoldChecks"],
    "pricing": ["eventRows", "readRows", "fullPageRows"],
    "federation": ["labelReads", "copiedEntries", "ownerIdReads", "neighborIdReads", "queuedInputReads", "writes"],
    "reopen-monitor": ["reads"], "review-merge": ["reads"], "stream": ["replaced"],
    "resize": ["styleWrites", "observers"], "git": ["calls"], "pins": ["requests", "servedRows", "publications"],
}
DIMENSIONS = ("n", "history", "gates", "limit", "mode", "delivery", "copies", "projectRows", "pins", "archived", "phase", "k", "via", "events",
              "peerCount", "depth", "retries", "reviews", "deltas", "count", "stage", "owners", "density")


def verify_measurements(rows, suites, archived):
    # Each scenario must emit its expected observations even when both sides
    # use the same broken probe. Zero archive pressure collapses two scenarios.
    expected = {
        "navigation": {"navigation": 54, "shape-navigation": 12},
        "sqlite": {"sqlite": 10 if archived else 6},
        "terminal": {"terminal": 14}, "held-auto-fix": {"held-auto-fix": 10},
        "pricing": {"pricing": 4}, "federation": {"federation": 9},
        "reopen": {"review-merge": 12, "reopen-monitor": 4}, "stream": {"stream": 4},
        "live-threads": {"live-threads": 12}, "token-miser": {"token-miser": 149},
        "width": {"resize": 3}, "git": {"git": 12}, "pins": {"pins": 12},
    }
    wanted = {kind: count for suite in suites for kind, count in expected.get(suite, {}).items()}
    actual = Counter(row["kind"] for row in rows if "kind" in row)
    if actual != wanted:
        raise ValueError(f"Measured scenario counts {dict(actual)} differ from expected {wanted}")


def index(rows):
    scenarios = {}
    for row in rows:
        if "family" in row:
            continue
        kind = row["kind"]
        dims = {key: row[key] for key in DIMENSIONS if key in row and key not in COUNTERS[kind]}
        # Pricing notification count is observed output, not an input dimension.
        if kind == "pricing":
            dims.pop("events")
        key = (kind, json.dumps(dims, sort_keys=True))
        if key in scenarios:
            raise ValueError(f"Duplicate scenario: {key}")
        scenarios[key] = row
    return scenarios


def summarize(output, runs, suites, args):
    for run in runs.values():
        verify_measurements(run["rows"], suites, args.archived)
    head = index(runs["candidate"]["rows"])
    base = index(runs["base"]["rows"]) if "base" in runs else None
    if base is not None and head.keys() != base.keys():
        raise ValueError(f"Different measured scenarios: {head.keys() ^ base.keys()}")
    changes = []
    for key, row in head.items():
        if base is None:
            continue
        for counter in COUNTERS[key[0]]:
            if counter not in row or counter not in base[key]:
                if counter not in ("slotCopies", "lensTests"):
                    raise ValueError(f"Missing {counter} in {key}")
                continue
            before, after = base[key][counter], row[counter]
            if before != after:
                changes.append({"kind": key[0], "scenario": json.loads(key[1]), "counter": counter,
                                "base": before, "candidate": after})
    increases = [c for c in changes if c["candidate"] > c["base"]]
    summary = {"schema": 1, "suites": suites, "casesPerProperty": args.cases, "copies": args.copies,
               "archived": args.archived, "runs": runs, "changes": changes, "increases": len(increases)}
    (output / "results.json").write_text(json.dumps(summary, indent=2) + "\n")
    lines = ["## Profile scaling audit", "", "| Revision | SHA | Tests | Work scenarios | Model cases |",
             "|---|---|---:|---:|---:|"]
    for name, run in runs.items():
        cases = sum(row["runs"] for row in run["rows"] if "family" in row)
        lines.append(f"| {name} | `{run['sha'][:12]}` | {run['tests']} | {len(index(run['rows']))} | {cases} |")
    if base is not None:
        lines += ["", f"{len(changes)} changed work counters, including {len(increases)} increases."]
        for change in sorted(changes, key=lambda c: c["candidate"] - c["base"], reverse=True)[:8]:
            lines.append(f"- {change['kind']} {change['scenario']} · {change['counter']} "
                         f"{change['base']} → {change['candidate']}")
    lines += ["", "Exact work and diagnostic timings are in `results.json`."]
    markdown = "\n".join(lines) + "\n"
    (output / "summary.md").write_text(markdown)
    print(markdown)
    return int(bool(increases))
