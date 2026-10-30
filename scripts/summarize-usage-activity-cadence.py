#!/usr/bin/env python3
"""Summarize complete contrived Registry.emit cadence replays, not live profiles."""

from collections import defaultdict
import json
from pathlib import Path
from statistics import median
import sys


def summarize(directory):
    groups = defaultdict(list)
    for source in sorted(directory.glob("*.jsonl")):
        for line in source.read_text().splitlines():
            row = json.loads(line)
            groups[(row["variant"], row["scenario"])].append(row)
    result = []
    for (variant, scenario), rows in sorted(groups.items()):
        if len(rows) != 5:
            raise ValueError(f"{variant}/{scenario}: expected five complete samples, got {len(rows)}")
        item = dict(variant=variant, scenario=scenario, samples=len(rows))
        for key in ("observations", "activeDurationMs", "batches", "activityReads"):
            values = [r[key] for r in rows]
            if min(values) != max(values):
                raise ValueError(f"{variant}/{scenario}: unstable {key}: {values}")
            item[key] = values[0]
        for key in ("activeCpuMs", "flushCpuMs", "activityReadCpuMs"):
            values = [r[key] for r in rows]
            item[key] = round(median(values), 3)
            item[key + "Range"] = [round(min(values), 3), round(max(values), 3)]
        for phase in ("active", "terminal", "idle"):
            item[phase] = {}
            for key in ("commits", "statements", "rowsChanged", "walBytes"):
                values = [r[phase][key] for r in rows]
                if key != "walBytes" and min(values) != max(values):
                    raise ValueError(f"{variant}/{scenario}/{phase}: unstable {key}: {values}")
                item[phase][key] = median(values)
                if key == "walBytes":
                    item[phase][key + "Range"] = [min(values), max(values)]
        result.append(item)
    return result


if __name__ == "__main__":
    print(json.dumps(summarize(Path(sys.argv[1])), indent=2))
