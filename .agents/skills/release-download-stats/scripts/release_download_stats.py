#!/usr/bin/env python3
"""Summarize GitHub Release asset download stats for PwrAgent."""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
from datetime import datetime, timezone
from typing import Any


DEFAULT_REPO = "pwrdrvr/PwrAgent"


def run_gh(repo: str) -> list[dict[str, Any]]:
    if not shutil.which("gh"):
        raise SystemExit("gh CLI is not installed or not on PATH")

    result = subprocess.run(
        ["gh", "api", f"repos/{repo}/releases", "--paginate"],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    if result.returncode != 0:
        raise SystemExit(result.stderr.strip() or "gh api failed")

    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"failed to parse gh api JSON: {exc}") from exc

    if not isinstance(data, list):
        raise SystemExit("expected GitHub releases API to return a list")
    return data


def normalize_selector(selector: str) -> list[str]:
    selector = selector.strip()
    candidates = [selector]
    lowered = selector.lower()

    if lowered.startswith(("beta.", "alpha.")):
        candidates.append(f"v1.0.0-{lowered}")
    elif lowered.startswith(("beta-", "alpha-")):
        candidates.append(f"v1.0.0-{lowered.replace('-', '.', 1)}")
    elif any(
        lowered.startswith(prefix) and lowered[len(prefix) :].isdigit()
        for prefix in ("beta", "alpha")
    ):
        prefix = "beta" if lowered.startswith("beta") else "alpha"
        number = lowered[len(prefix) :]
        candidates.append(f"v1.0.0-{prefix}.{number}")
    elif selector.isdigit():
        candidates.append(f"v1.0.0-beta.{selector}")
    elif not selector.startswith("v"):
        candidates.append(f"v{selector}")

    seen: set[str] = set()
    return [
        candidate for candidate in candidates if not (candidate in seen or seen.add(candidate))
    ]


def published_sort_key(release: dict[str, Any]) -> str:
    return str(release.get("published_at") or release.get("created_at") or "")


def select_releases(
    releases: list[dict[str, Any]],
    selectors: list[str],
    latest: int | None,
) -> list[dict[str, Any]]:
    sorted_releases = sorted(releases, key=published_sort_key, reverse=True)
    if latest is not None:
        return sorted_releases[:latest]

    if not selectors:
        return sorted_releases

    by_tag = {str(release.get("tag_name")): release for release in releases}
    selected: list[dict[str, Any]] = []
    missing: list[str] = []

    for selector in selectors:
        release = None
        for candidate in normalize_selector(selector):
            release = by_tag.get(candidate)
            if release is not None:
                break
        if release is None:
            missing.append(selector)
        else:
            selected.append(release)

    if missing:
        known = ", ".join(str(release.get("tag_name")) for release in sorted_releases[:10])
        raise SystemExit(f"release tag not found: {', '.join(missing)}. Recent tags: {known}")

    return selected


def classify_asset(name: str) -> str | None:
    lowered = name.lower()
    if lowered.endswith(".zip"):
        return "zip"
    if lowered.endswith(".dmg"):
        return "stable_dmg" if name == "PwrAgent.dmg" else "versioned_dmg"
    return None


def collect_assets(releases: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for release in releases:
        for asset in release.get("assets") or []:
            name = str(asset.get("name") or "")
            kind = classify_asset(name)
            if kind is None:
                continue
            size = int(asset.get("size") or 0)
            downloads = int(asset.get("download_count") or 0)
            rows.append(
                {
                    "tag": release.get("tag_name"),
                    "published": release.get("published_at"),
                    "release_type": "prerelease" if release.get("prerelease") else "release",
                    "asset": name,
                    "kind": kind,
                    "size": size,
                    "size_mib": round(size / 1_048_576, 1),
                    "downloads": downloads,
                    "bytes": size * downloads,
                    "gib": round((size * downloads) / 1_073_741_824, 2),
                    "url": asset.get("browser_download_url"),
                }
            )
    return rows


def sum_rows(rows: list[dict[str, Any]], kind: str) -> tuple[int, int, float]:
    matches = [row for row in rows if row["kind"] == kind]
    downloads = sum(int(row["downloads"]) for row in matches)
    bytes_served = sum(int(row["bytes"]) for row in matches)
    return downloads, bytes_served, round(bytes_served / 1_073_741_824, 2)


def release_summary(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        grouped.setdefault(str(row["tag"]), []).append(row)

    summaries: list[dict[str, Any]] = []
    for tag, group in grouped.items():
        zip_downloads = sum(row["downloads"] for row in group if row["kind"] == "zip")
        stable_downloads = sum(row["downloads"] for row in group if row["kind"] == "stable_dmg")
        versioned_downloads = sum(row["downloads"] for row in group if row["kind"] == "versioned_dmg")
        zip_bytes = sum(row["bytes"] for row in group if row["kind"] == "zip")
        dmg_bytes = sum(row["bytes"] for row in group if row["kind"] != "zip")
        first = group[0]
        summaries.append(
            {
                "published": first["published"],
                "tag": tag,
                "release_type": first["release_type"],
                "zip_downloads": zip_downloads,
                "zip_gib": round(zip_bytes / 1_073_741_824, 2),
                "stable_dmg_downloads": stable_downloads,
                "versioned_dmg_downloads": versioned_downloads,
                "total_dmg_downloads": stable_downloads + versioned_downloads,
                "dmg_gib": round(dmg_bytes / 1_073_741_824, 2),
            }
        )

    return sorted(summaries, key=lambda row: str(row["published"] or ""), reverse=True)


def markdown_table(headers: list[str], rows: list[list[Any]]) -> str:
    lines = [
        "| " + " | ".join(headers) + " |",
        "| " + " | ".join("---" for _ in headers) + " |",
    ]
    for row in rows:
        lines.append("| " + " | ".join(str(cell) for cell in row) + " |")
    return "\n".join(lines)


def print_markdown(repo: str, rows: list[dict[str, Any]], selected_count: int) -> None:
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    print(f"Repository: `{repo}`")
    print(f"Fetched: {now}")
    print(f"Releases included: {selected_count}")
    print()

    zip_dl, zip_bytes, zip_gib = sum_rows(rows, "zip")
    stable_dl, stable_bytes, stable_gib = sum_rows(rows, "stable_dmg")
    versioned_dl, versioned_bytes, versioned_gib = sum_rows(rows, "versioned_dmg")
    print("## Totals")
    print()
    print(
        markdown_table(
            ["Asset group", "Downloads", "Bytes", "GiB"],
            [
                ["ZIP updater assets", zip_dl, zip_bytes, zip_gib],
                ["Stable PwrAgent.dmg alias", stable_dl, stable_bytes, stable_gib],
                ["Versioned DMG assets", versioned_dl, versioned_bytes, versioned_gib],
                [
                    "All DMG assets",
                    stable_dl + versioned_dl,
                    stable_bytes + versioned_bytes,
                    round(stable_gib + versioned_gib, 2),
                ],
            ],
        )
    )
    print()

    print("## By Release")
    print()
    print(
        markdown_table(
            [
                "Published",
                "Tag",
                "Type",
                "ZIP dl",
                "ZIP GiB",
                "Stable DMG dl",
                "Versioned DMG dl",
                "Total DMG dl",
                "DMG GiB",
            ],
            [
                [
                    row["published"],
                    row["tag"],
                    row["release_type"],
                    row["zip_downloads"],
                    row["zip_gib"],
                    row["stable_dmg_downloads"],
                    row["versioned_dmg_downloads"],
                    row["total_dmg_downloads"],
                    row["dmg_gib"],
                ]
                for row in release_summary(rows)
            ],
        )
    )
    print()

    print("## Asset Details")
    print()
    print(
        markdown_table(
            ["Tag", "Asset", "Size MiB", "Downloads", "GiB"],
            [[row["tag"], row["asset"], row["size_mib"], row["downloads"], row["gib"]] for row in rows],
        )
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("tags", nargs="*", help="Release tags or shorthand such as beta.22")
    parser.add_argument("--repo", default=DEFAULT_REPO, help=f"GitHub repo, default: {DEFAULT_REPO}")
    parser.add_argument("--latest", type=int, help="Include the latest N releases by published_at")
    parser.add_argument("--json", action="store_true", help="Emit JSON instead of markdown")
    args = parser.parse_args()

    if args.latest is not None and args.latest <= 0:
        parser.error("--latest must be positive")

    releases = run_gh(args.repo)
    selected = select_releases(releases, args.tags, args.latest)
    rows = collect_assets(selected)

    if args.json:
        print(
            json.dumps(
                {
                    "repo": args.repo,
                    "fetched_at": datetime.now(timezone.utc).isoformat(),
                    "release_count": len(selected),
                    "totals": {
                        "zip": dict(zip(["downloads", "bytes", "gib"], sum_rows(rows, "zip"))),
                        "stable_dmg": dict(
                            zip(["downloads", "bytes", "gib"], sum_rows(rows, "stable_dmg"))
                        ),
                        "versioned_dmg": dict(
                            zip(["downloads", "bytes", "gib"], sum_rows(rows, "versioned_dmg"))
                        ),
                    },
                    "by_release": release_summary(rows),
                    "assets": rows,
                },
                indent=2,
            )
        )
    else:
        print_markdown(args.repo, rows, len(selected))

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
