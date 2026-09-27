"""Export a fixed allowlist of aggregate reports. Never exports IDs or DB rows."""
import json
from pathlib import Path

root = Path(".local/archive-retention")
target = Path("docs/design/archived-thread-retention-measurements.json")
reports = {name: json.loads((root / (name + ".json")).read_text()) for name in
           ["discovery", "preparation", "rebuild", "recovery", "sliced", "startup"]}
fields = ["name", "mode", "batch", "order", "yieldMs", "indexed", "concurrent", "giant",
          "secureDelete", "cacheKiB", "pinnedReader", "repetition", "threads", "elapsedMs",
          "lookupMs", "lockMs", "waitMs", "batchFrames", "wal", "pages", "free", "checkpointMs",
          "checkpoint", "releasedCheckpoint", "releasedCheckpointMs", "integrity", "foreignKeyErrors",
          "probes", "incremental256", "incrementalAll", "vacuum"]
reports["runs"] = [{k: r[k] for k in fields if k in r} for r in
                   map(json.loads, (root / "results.jsonl").read_text().splitlines())]
reports["pageInventory"] = json.loads((root / "page-inventory.json").read_text())
reports["schemaInventory"] = json.loads((root / "schema-inventory.json").read_text())
reports["sourceCommit"] = "9dddfffbe067622815df55f65bf7663db468384a"
target.write_text(json.dumps(reports, indent=2) + "\n")
print("Exported", len(reports["runs"]), "aggregate runs; no candidate IDs, payloads, or DB paths")
