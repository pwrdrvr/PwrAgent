"""Read-only Codex App Server discovery; saves only IDs/timestamps in private storage.

No Codex-owned file is opened by this script. Provider listing is positive
evidence only; missing IDs remain unknown. No archive/restore requests are sent.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import time


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("directory", type=Path)
    args = parser.parse_args()
    args.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.umask(0o077)
    started = time.monotonic()
    proc = subprocess.Popen(["codex", "app-server"], stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    sequence = 0

    def request(method, params):
        nonlocal sequence
        sequence += 1
        proc.stdin.write(json.dumps({"id": sequence, "method": method, "params": params}) + "\n")
        proc.stdin.flush()
        while True:
            line = proc.stdout.readline()
            if not line:
                raise RuntimeError("Provider exited before responding")
            result = json.loads(line)
            if result.get("id") != sequence:
                continue
            if "error" in result:
                raise RuntimeError("Provider request failed; no eligibility inferred")
            return result["result"]

    try:
        request("initialize", {"clientInfo": {"name": "pwragent_retention_lab", "version": "1"}})
        proc.stdin.write(json.dumps({"method": "initialized", "params": {}}) + "\n")
        proc.stdin.flush()
        records = []
        metrics = []
        for archived in (True, False):
            cursor = None
            seen = set()
            pages = 0
            size = 0
            begin = time.monotonic()
            while True:
                response = request("thread/list", {"archived": archived, "cursor": cursor,
                    "limit": 100, "sortKey": "updated_at", "sourceKinds": [], "useStateDbOnly": True})
                pages += 1
                size += len(json.dumps(response).encode())
                for thread in response["data"]:
                    records.append({"backend": "codex", "id": thread["id"], "archived": archived,
                                    "updatedAt": thread.get("updatedAt"), "createdAt": thread.get("createdAt")})
                cursor = response.get("nextCursor")
                if not cursor:
                    break
                if cursor in seen:
                    raise RuntimeError("Repeated cursor; discovery incomplete")
                seen.add(cursor)
            metrics.append({"archived": archived, "pages": pages, "responseBytes": size,
                            "seconds": time.monotonic() - begin,
                            "count": sum(r["archived"] == archived for r in records)})
        (args.directory / "provider-evidence.json").write_text(json.dumps(records))
        report = {"source": "Codex App Server thread/list; sourceKinds=[]; useStateDbOnly=true",
                  "observedAt": time.time(), "seconds": time.monotonic() - started, "requests": metrics}
        (args.directory / "discovery.json").write_text(json.dumps(report, indent=2))
        print(json.dumps(report))
    finally:
        proc.terminate()
        proc.wait(timeout=10)


if __name__ == "__main__":
    main()
