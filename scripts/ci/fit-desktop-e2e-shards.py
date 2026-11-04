#!/usr/bin/env python3
"""Fit shared Playwright count weights to measured, ordered test groups."""

import argparse
import itertools
import json
from pathlib import Path


def allocate(groups, weights):
    count = sum(group["count"] for group in groups)
    sizes = [weight * count // sum(weights) for weight in weights]
    for index in range(count - sum(sizes)):
        sizes[index] += 1
    boundaries = list(itertools.accumulate(sizes))
    lanes = [[] for _ in weights]
    position = 0
    for group in groups:
        lane = next(index for index, end in enumerate(boundaries) if position < end)
        lanes[lane].append(group)
        position += group["count"]
    return lanes


def summarize(groups, weights, platforms):
    lanes = allocate(groups, weights)
    return {
        "weights": ":".join(map(str, weights)),
        "counts": [sum(group["count"] for group in lane) for lane in lanes],
        "seconds": {
            platform: [round(sum(group["seconds"][index] for group in lane), 1) for lane in lanes]
            for index, platform in enumerate(platforms)
        },
        "last_spec": [lane[-1]["spec"] if lane else None for lane in lanes],
    }


def fit(groups, platforms):
    # Every distinct assignment is a partition at three group boundaries.
    # Using its collected test counts as weights reproduces that partition.
    counts = [0]
    durations = [[0] for _ in platforms]
    for group in groups:
        counts.append(counts[-1] + group["count"])
        for index, prefix in enumerate(durations):
            prefix.append(prefix[-1] + group["seconds"][index])
    best = None
    for cuts in itertools.combinations(range(1, len(groups)), 3):
        edges = (0, *cuts, len(groups))
        maxima = [
            max(prefix[end] - prefix[start] for start, end in zip(edges, edges[1:]))
            for prefix in durations
        ]
        score = sum(maxima)
        if best is None or score < best[0]:
            best = (score, edges)
    if best is None:
        raise ValueError("At least four test groups are required")
    return [counts[end] - counts[start] for start, end in zip(best[1], best[1][1:])]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, default=Path(__file__).resolve().parents[2] / "docs/desktop-e2e-shard-durations.json")
    parser.add_argument("--weights", default="9:12:12:14")
    parser.add_argument("--fit", action="store_true")
    args = parser.parse_args()
    try:
        weights = [int(weight) for weight in args.weights.split(":")]
        if len(weights) != 4 or min(weights) <= 0:
            raise ValueError()
    except ValueError:
        parser.error("--weights requires four positive integers separated by colons")
    data = json.loads(args.data.read_text())
    groups, platforms = data["groups"], data["platforms"]
    if not groups or any(
        group["count"] <= 0
        or len(group["seconds"]) != len(platforms)
        or any(seconds < 0 for seconds in group["seconds"])
        for group in groups
    ):
        parser.error("data requires ordered nonempty groups with nonnegative durations for each platform")
    print(json.dumps(summarize(groups, weights, platforms), indent=2))
    if args.fit:
        print(json.dumps(summarize(groups, fit(groups, platforms), platforms), indent=2))


if __name__ == "__main__":
    main()
