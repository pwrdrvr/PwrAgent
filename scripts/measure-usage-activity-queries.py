#!/usr/bin/env python3
"""Replay contrived query artifacts exported by usage-activity-read-budget.test.ts.

PWRAGENT_USAGE_QUERY_REPORT_DIR=<ignored directory> pnpm test \
  apps/desktop/src/main/__tests__/usage-activity-read-budget.test.ts
python3 scripts/measure-usage-activity-queries.py <ignored directory>

Uses Python's SQLite progress callback to measure VDBE instructions in blocks
of 100. This is a query-work comparison, not an Electron CPU benchmark.
Databases are opened read-only. Never point this script at an operator profile.
"""

import json
from pathlib import Path
import sqlite3
import sys
import time


def measure(directory):
    for artifact in sorted(directory.glob("*.json")):
        database = artifact.with_suffix(".db")
        if not database.exists():
            continue
        connection = sqlite3.connect(f"{database.resolve().as_uri()}?mode=ro", uri=True)
        queries = json.loads(artifact.read_text())
        results = []
        for query in queries:
            args = query["args"]
            bindings = args[0] if len(args) == 1 and isinstance(args[0], dict) else args
            blocks = 0

            def progress():
                nonlocal blocks
                blocks += 1
                return 0

            connection.set_progress_handler(progress, 100)
            began = time.perf_counter()
            rows = connection.execute(query["sql"], bindings).fetchall()
            elapsed = time.perf_counter() - began
            connection.set_progress_handler(None, 0)
            results.append({"rows": len(rows), "vm_steps_rounded": blocks * 100,
                            "ms": round(elapsed * 1000, 3), "plan": query["plan"]})
        print(json.dumps({"workload": artifact.stem, "sqlite": sqlite3.sqlite_version,
                          "queries": len(results), "rows": sum(r["rows"] for r in results),
                          "vm_steps_rounded": sum(r["vm_steps_rounded"] for r in results),
                          "details": results}))
        connection.close()


if __name__ == "__main__":
    measure(Path(sys.argv[1]))
