"""Summarize comparable, verified native active-paint replay samples."""
import argparse
from collections import defaultdict
import json
import math
from pathlib import Path
from statistics import median

from active_paint import RETRY_COHORTS, REVISIONS

LEGACY_LANES = dict(zip(("inbound", "outbound"), RETRY_COHORTS))


def p95(values):
    return sorted(values)[math.ceil(len(values) * .95) - 1]


def stats(values):
    if not values:
        return "—"
    return f"{median(values):.1f} / {p95(values):.1f} / {max(values):.1f}"


def row(*cells):
    print("| " + " | ".join(map(str, cells)) + " |")


def table(*headings):
    row(*headings)
    row(*(["---"] * len(headings)))


def main():
    args = argparse.ArgumentParser(description=__doc__)
    args.add_argument("results", type=Path, nargs="+")
    args = args.parse_args()
    interactions = defaultdict(list)
    queries = defaultdict(list)
    pending_queries = defaultdict(list)
    startup = defaultdict(list)
    cadence = defaultdict(lambda: {"rate": [], "late": [], "work": [], "overlap": [0, 0]})
    phases = defaultdict(list)
    platform_signature = None
    platform_label = None
    observed = set()
    scenario_settings = {}
    for folder in args.results:
        for file in sorted(folder.glob("*.json")):
            if file.name.startswith("topology-"):
                continue
            result = json.loads(file.read_text())
            if not result.get("verified"):
                raise ValueError(f"Replay assertions did not finish in {file}")
            options = result["options"]
            revision, copies, scenario = (options[key] for key in ("revision", "copies", "scenario"))
            intervals = {LEGACY_LANES.get(lane, lane): interval for lane, interval in options["cadence"].items()}
            settings = (*[options[key] for key in ("warm", "leadMs", "held", "queueDepth", "redeliveries")], intervals)
            if scenario_settings.setdefault(scenario, settings) != settings:
                raise ValueError(f"Mixed settings for the {scenario} workload in {file}")
            launch = (revision, copies, scenario, options["repeat"])
            if launch in observed:
                raise ValueError(f"Duplicate launch {launch}")
            observed.add(launch)
            inventory = result["inventory"]
            if (inventory["total"], inventory["pinned"]) != (869 * copies, 105 * copies):
                raise ValueError(f"Wrong inventory in {file}")
            platform = result["platform"]
            gpu = "disabled" if platform["gpuDisabled"] else "enabled"
            label = f"{platform['arch']}, Darwin {platform['os']}, {platform['cpuCount']} vCPUs, GPU {gpu}"
            if platform_signature is None:
                platform_signature, platform_label = platform, label
            elif platform_signature != platform:
                raise ValueError(f"Mixed platform signatures in {file}: {platform_signature} and {platform}")
            if "lensReadyAfterInventoryMs" in result:
                startup[launch[:3]].append(result["lensReadyAfterInventoryMs"])
            owner = result["owner"]
            start, stop = result["began"]["startedAt"], owner["stoppedAt"]
            pending = owner.get("pendingQueriesAtStop")
            if pending is not None:
                pending_queries[launch[:3]].append(pending)
            events = owner["events"]
            phases[launch[:3]].append((
                sum(event.get("pricingRows", 0) for event in events),
                sum("pricingRows" in event for event in events),
                owner["readReviewCalls"],
                owner["countedReviews"] - result["began"]["startReviews"],
            ))
            for sample in result["samples"]:
                if not start <= sample["input"] <= sample["frame"] <= stop:
                    raise ValueError(f"Frame outside owner capture in {file}")
                interactions[(*launch[:3], sample["phase"], sample["name"])].append(sample["ms"])
            for query in owner["queries"]:
                if query["end"] > stop:
                    if pending is not None:
                        raise ValueError(f"Owner query completed after capture in {file}")
                    # Older traces could include queries that finished while deliveries drained.
                    continue
                kind = "thread read" if query["kind"].startswith("thread:") else query["kind"]
                queries[(*launch[:3], kind)].append(query["end"] - query["start"])
            for lane, interval in intervals.items():
                if not interval:
                    continue
                deliveries = [delivery for delivery in owner["deliveries"] if LEGACY_LANES.get(delivery["lane"], delivery["lane"]) == lane]
                metrics = cadence[(*launch[:3], lane, interval)]
                per_burst = options["redeliveries"] if lane in RETRY_COHORTS else 1
                metrics["rate"].append(len(deliveries) / ((stop - start) / 1000) * per_burst)
                metrics["late"].extend(max(0, delivery["start"] - delivery["due"]) for delivery in deliveries)
                metrics["work"].extend(delivery["end"] - delivery["start"] for delivery in deliveries)
                for sample in result["samples"]:
                    metrics["overlap"][1] += 1
                    metrics["overlap"][0] += any(
                        delivery["start"] < sample["frame"] and delivery["end"] > sample["input"]
                        for delivery in deliveries
                    )
    if not observed:
        raise ValueError("No replay samples")
    print("# Native navigation replay\n")
    print(f"{len(observed)} verified launches. {platform_label}.\n")
    table("Revision", "Commit")
    for revision in sorted({key[0] for key in observed}):
        row(revision, REVISIONS.get(revision, revision))
    print()
    print("## Input to visible frame\n")
    print("Cold is the first measured action per kind after fresh Electron startup and population checks.")
    print("Warm uses repeated lens changes and previously opened threads. All durations are milliseconds.\n")
    table("Revision", "Copies", "Load", "Phase", "Action", "Samples", "Median / p95 / max")
    for key, values in sorted(interactions.items()):
        row(*key, len(values), stats(values))
    if startup:
        print("\n## Startup readiness\n")
        print("Time from verified owner inventory to the first lens leaving its loading state.\n")
        table("Revision", "Copies", "Load", "Launches", "Median / p95 / max (ms)")
        for key, values in sorted(startup.items()):
            row(*key, len(values), stats(values))
    print("\n## Owner query time\n")
    print("Elapsed time inside owner reads that completed by the capture cutoff.\n")
    table("Revision", "Copies", "Load", "Query", "Samples", "Median / p95 / max")
    for key, values in sorted(queries.items()):
        row(*key, len(values), stats(values))
    if pending_queries:
        print("\n### Queries pending at cutoff\n")
        print("Pending totals cover launches that recorded this count.\n")
        table("Revision", "Copies", "Load", "Recorded launches", "Pending queries")
        for key, values in sorted(pending_queries.items()):
            row(*key, len(values), sum(values))
    print("\n## Event cadence\n")
    print("Each loopback retry cohort exercises the viewer and owner paths in the measured Electron process.")
    print("Retry rates count individual redeliveries. Their configured intervals and timing columns describe bursts.")
    print("Overlap counts input-to-frame windows intersecting at least one delivery in that lane.\n")
    table("Revision", "Copies", "Load", "Lane", "Target interval (ms)", "Median events/s", "Delivery lag ms median / p95 / max",
          "Delivery duration ms median / p95 / max", "Overlapping frames")
    for key, metrics in sorted(cadence.items()):
        overlap = metrics["overlap"]
        row(*key, f"{median(metrics['rate']):.1f}", stats(metrics["late"]), stats(metrics["work"]), f"{overlap[0]}/{overlap[1]}")
    print("\n## Owner events\n")
    print("Totals across repeated launches.\n")
    table("Revision", "Copies", "Load", "Pricing rows", "Pricing notifications", "Review record reads", "Completed reviews")
    for key, values in sorted(phases.items()):
        row(*key, *(sum(column) for column in zip(*values)))


if __name__ == "__main__":
    main()
