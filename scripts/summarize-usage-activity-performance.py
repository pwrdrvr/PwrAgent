#!/usr/bin/env python3
"""Summarize opt-in, contrived usage-activity-performance*.test.ts runs.

CPU is process user+system time, not wall time or SQLite VM instructions.
Keep the raw JSONL for dispersion and audit. All rates are assumptions supplied
by the caller; the UI has no periodic refresh timer.
"""

import argparse
from collections import defaultdict
import json
from pathlib import Path
from statistics import median


def summarize(directory):
    groups = defaultdict(list)
    for source in sorted(directory.glob("*.jsonl")):
        for line in source.read_text().splitlines():
            row = json.loads(line)
            key = (row["variant"], row["shape"], row["workload"], row["readEvery"])
            groups[key].append(row)
    result = []
    for (variant, shape, workload, read_every), rows in sorted(groups.items()):
        entry = dict(variant=variant, shape=shape, workload=workload,
                     readEvery=read_every, repetitions=len(rows))
        for field in ("writeCpuMs", "readCpuMs", "totalCpuMs", "walBytes"):
            values = [row[field] for row in rows]
            entry[field] = round(median(values), 3)
            entry[field + "Range"] = [round(min(values), 3), round(max(values), 3)]
        entry["writes"] = 0 if workload.startswith("read") else rows[0]["iterations"]
        entry["reads"] = rows[0]["readCount"]
        entry["cacheHits"] = sum(row["cacheHits"] for row in rows)
        entry["cacheRequests"] = sum(row["readCount"] for row in rows)
        entry["assumedWriteIntervalMs"] = rows[0]["stride"]
        result.append(entry)
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    args = parser.parse_args()
    print(json.dumps(summarize(args.directory), indent=2))
