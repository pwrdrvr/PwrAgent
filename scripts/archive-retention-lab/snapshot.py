"""Consistent online backup of PwrAgent state only; no StateDb startup/migration.

Run from the repository root. The source connection uses mode=ro and is never
given a mutating SQL statement or PRAGMA. SQLite's backup API includes WAL.
"""
import argparse
import json
import os
from pathlib import Path
import sqlite3
import time


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("directory", type=Path)
    args = parser.parse_args()
    root = args.directory.resolve()
    if not root.is_relative_to(Path(".local").resolve()):
        raise ValueError("Use private ignored .local storage")
    os.umask(0o077)
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    target = root / "baseline.db"
    if target.exists():
        raise ValueError("Refusing to overwrite an existing baseline")
    source = Path.home() / ".pwragent/profiles/default/state/state.db"
    started = time.monotonic()
    src = sqlite3.connect(source.as_uri() + "?mode=ro", uri=True)
    dst = sqlite3.connect(target)
    try:
        src.backup(dst, pages=256, sleep=.01)
    finally:
        src.close()
    report = {"backupSeconds": time.monotonic() - started, "sqlite": sqlite3.sqlite_version,
              "integrity": dst.execute("PRAGMA integrity_check").fetchone()[0],
              "pragmas": {p: dst.execute("PRAGMA " + p).fetchone()[0] for p in
                          ["page_size", "page_count", "freelist_count", "auto_vacuum", "user_version"]}}
    schema = []
    for (name,) in dst.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").fetchall():
        q = '"' + name.replace('"', '""') + '"'
        schema.append({"table": name, "rows": dst.execute("SELECT count(*) FROM " + q).fetchone()[0],
                       "columns": [r[1] for r in dst.execute("PRAGMA table_info(" + q + ")")]})
    pages = dst.execute("SELECT name,count(*),sum(pgsize),sum(payload),sum(unused) FROM dbstat GROUP BY name ORDER BY sum(pgsize) DESC").fetchall()
    for filename, value in [("snapshot.json", report), ("schema-inventory.json", schema), ("page-inventory.json", pages)]:
        (root / filename).write_text(json.dumps(value, indent=2))
    dst.close()
    print(json.dumps(report))


if __name__ == "__main__":
    main()
