#!/usr/bin/env python3
"""Read-only release-stack resolution. Python 3.10+, standard library only."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

TARGETS = {"darwin-universal", "darwin-arm64", "win32-x64", "linux-x64", "linux-arm64"}
REPO = "pwrdrvr/PwrAgent"
MAX_ARCHIVE = 256 * 1024 * 1024
MAX_FILE = 128 * 1024 * 1024
MAX_TOTAL = 1024 * 1024 * 1024
HEX = re.compile(r"[0-9a-f]{64}\Z")
COMMIT = re.compile(r"[0-9a-f]{40}\Z")
JS = re.compile(r"\.(?:js|cjs|mjs)\Z")
BASE64 = {c: i for i, c in enumerate("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/")}


class DiagnosticError(Exception):
    pass


def require(condition, message):
    if not condition:
        raise DiagnosticError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def safe_path(name):
    require(isinstance(name, str), "Non-string archive path")
    name = name.removeprefix("./")
    require(name and "\\" not in name and "\x00" not in name
            and not name.startswith("/") and not re.match(r"^[A-Za-z]:", name)
            and all(p not in ("", ".", "..") for p in name.split("/")),
            f"Unsafe archive path: {name!r}")
    return name


def read_archive(archive, checksum):
    require(archive.stat().st_size <= MAX_ARCHIVE, "Archive exceeds 256 MiB limit")
    require(checksum.stat().st_size <= 4096, "Checksum sidecar exceeds 4 KiB")
    sidecar = checksum.read_text().strip()
    match = re.fullmatch(r"([0-9a-fA-F]{64})\s+\*?(.+)", sidecar)
    require(match is not None and match[2] == archive.name,
            "Checksum sidecar must name this exact archive; supply its original .sha256")
    archive_hash = digest(archive.read_bytes())
    require(archive_hash == match[1].lower(), "Archive checksum mismatch; obtain the matching archive/sidecar")
    contents, total, members = {}, 0, set()
    # Read members into memory. Never extract, follow links, or write archive paths.
    with tarfile.open(archive, "r:gz") as tar:
        for i, member in enumerate(tar):
            require(i < 20000, "Archive has too many members")
            name = safe_path(member.name.rstrip("/") if member.isdir() else member.name)
            require(member.isdir() or member.isfile(), f"Archive link/special member rejected: {name}")
            require(name not in members, f"Duplicate archive member: {name}")
            members.add(name)
            if member.isdir():
                continue
            require(name not in contents, f"Duplicate archive member: {name}")
            total += member.size
            require(0 <= member.size <= MAX_FILE and total <= MAX_TOTAL, "Archive exceeds expanded size limits")
            contents[name] = tar.extractfile(member).read()
    metadata = []
    # macOS bsdtar emits AppleDouble extended-attribute sidecars. They are not
    # generated JS/maps, and are never extracted or interpreted as instructions.
    for name, data in list(contents.items()):
        leaf = PurePosixPath(name).name
        if leaf.startswith("._") and len(data) >= 26 and data[:4] == b"\x00\x05\x16\x07":
            counterpart = str(PurePosixPath(name).with_name(leaf[2:]))
            require(counterpart in members, f"Orphan AppleDouble member: {name}")
            metadata.append(name)
            del contents[name]
    require("manifest.json" in contents, "Missing manifest.json")
    manifest = json.loads(contents["manifest.json"])
    require(isinstance(manifest, dict), "Manifest must be a JSON object")
    return contents, manifest, archive_hash, metadata


def validate(contents, manifest, args):
    require(manifest.get("schemaVersion") == 1, "Unsupported manifest schemaVersion; need schema 1")
    require(manifest.get("version") == args.version, "Manifest version mismatch; supply the matching version/archive")
    require(COMMIT.fullmatch(manifest.get("commit", "")), "Manifest lacks a full build commit")
    if args.commit:
        require(manifest["commit"] == args.commit, "Manifest commit mismatch; obtain exact build artifacts")
    require(manifest.get("platform") == args.platform, "Manifest platform mismatch")
    if args.local_subset:
        require(args.archive is not None, "--local-subset requires --archive")
        require(manifest.get("arch") in (None, args.arch), "Local subset architecture mismatch")
        require(isinstance(manifest.get("scope"), str) and manifest["scope"],
                "Local subset requires explicit manifest scope")
        require(manifest.get("releaseTag") in (None, f"v{args.version}"), "Local subset releaseTag mismatch")
    else:
        require(manifest.get("arch") == args.arch, "Manifest architecture mismatch")
        require(manifest.get("releaseTag") == f"v{args.version}", "Manifest releaseTag mismatch")
        require(manifest.get("trackedChanges") is False, "Release manifest must identify a clean tracked tree")
        for key in ("builtAt", "buildHost", "tools", "lockfileSha256", "ci"):
            require(manifest.get(key), f"Release manifest missing {key}")
        require(HEX.fullmatch(manifest["lockfileSha256"]), "Invalid lockfile hash")
    files = manifest.get("files")
    require(isinstance(files, list) and files, "Manifest has no file records")
    records, scopes = {}, set()
    for record in files:
        require(isinstance(record, dict), "Manifest file record must be an object")
        name = safe_path(record.get("path"))
        require(name.startswith("out/"), f"Manifest file outside out/: {name}")
        require(name not in records, f"Duplicate manifest path: {name}")
        require(name in contents, f"Manifest file missing from archive: {name}")
        data = contents[name]
        require(type(record.get("bytes")) is int and len(data) == record["bytes"], f"Byte count mismatch: {name}")
        require(HEX.fullmatch(record.get("sha256", "")) and digest(data) == record["sha256"],
                f"File SHA-256 mismatch: {name}")
        records[name] = record
    auxiliary = set(contents) - {"manifest.json", "README.md"} - set(records)
    require(not auxiliary or args.local_subset and all(not p.startswith("out/") for p in auxiliary),
            "Archive has unlisted build files")
    for name, record in records.items():
        if JS.search(name):
            if args.local_subset:
                record.setdefault("sourceMap", name + ".map" if name + ".map" in records else None)
            else:
                require("sourceMap" in record, f"JavaScript lacks sourceMap declaration: {name}")
            map_name = record.get("sourceMap")
            if map_name is None:
                continue
            require(map_name == name + ".map" and map_name in records, f"Missing or mismatched map: {name}")
            sm = json.loads(contents[map_name])
            require(isinstance(sm, dict), f"Source map must be an object: {map_name}")
            require(sm.get("version") == 3 and sm.get("file") == PurePosixPath(name).name,
                    f"Source map identity mismatch: {map_name}")
            require(isinstance(sm.get("mappings"), str) and sm["mappings"]
                    and isinstance(sm.get("sources"), list) and sm["sources"]
                    and all(isinstance(s, str) for s in sm["sources"])
                    and isinstance(sm.get("names", []), list)
                    and all(isinstance(n, str) for n in sm.get("names", []))
                    and isinstance(sm.get("sourcesContent"), list)
                    and len(sm["sources"]) == len(sm["sourcesContent"])
                    and all(isinstance(s, str) for s in sm["sourcesContent"]),
                    f"Map lacks mappings/embedded source content: {map_name}")
            scopes.add(name.split("/")[1])
    if not args.local_subset:
        require({"main", "preload", "renderer"} <= scopes, "Full release archive lacks main/preload/renderer maps")
    return records, sorted(auxiliary)


def fetch(url, limit, token=None):
    headers = {"User-Agent": "PwrAgent-crash-stack-resolver", "Accept": "application/vnd.github+json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    try:
        started = time.monotonic()
        with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=45) as response:
            chunks, size = [], 0
            while True:
                require(time.monotonic() - started <= 120, "Download exceeded 120-second acquisition deadline; no retries")
                chunk = response.read(min(1024 * 1024, limit + 1 - size))
                if not chunk:
                    break
                chunks.append(chunk)
                size += len(chunk)
                require(size <= limit, f"Download exceeds size bound: {url}")
            data = b"".join(chunks)
        require(len(data) <= limit, f"Download exceeds size bound: {url}")
        return data
    except urllib.error.HTTPError as error:
        if error.code == 404:
            raise DiagnosticError(f"Authoritative GitHub 404: {url}; stop acquisition. Supply version/target correction or a local archive") from error
        raise DiagnosticError(f"GitHub HTTP {error.code}; no retries. Check access/rate limit or provide a local archive") from error
    except (urllib.error.URLError, TimeoutError) as error:
        raise DiagnosticError(f"Download failed; no retries: {error}. Provide a local archive or restore network access") from error


def atomic_write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as tmp:
        temp_name = tmp.name
        tmp.write(data)
    try:
        os.replace(temp_name, path)
    finally:
        Path(temp_name).unlink(missing_ok=True)


def acquire(args):
    if args.archive:
        return args.archive, args.checksum or Path(str(args.archive) + ".sha256"), {"kind": "local-override"}
    require(not args.local_subset, "Local subset mode cannot download a public release")
    # Public repository only; token never accompanies release CDN redirects.
    api = f"https://api.github.com/repos/{REPO}"
    release = json.loads(fetch(f"{api}/releases/tags/v{args.version}", 8 * 1024 * 1024,
                               os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")))
    require(release.get("tag_name") == f"v{args.version}" and not release.get("draft"), "Unexpected/draft release")
    name = f"PwrAgent-{args.version}-{args.platform}-{args.arch}-debug.tar.gz"
    assets = release.get("assets", [])
    selected = []
    for asset_name in (name, name + ".sha256"):
        matches = [a for a in assets if a.get("name") == asset_name and a.get("state") == "uploaded"]
        require(len(matches) == 1, f"Release has {len(matches)} assets named {asset_name}; stop. Need matching target or local debug archive")
        asset = matches[0]
        expected_url = f"https://github.com/{REPO}/releases/download/v{args.version}/{asset_name}"
        require(asset.get("browser_download_url") == expected_url, "Unexpected release asset URL")
        selected.append(asset)
    receipt = {"kind": "github-release", "releaseUrl": release["html_url"], "releaseId": release["id"],
               "tag": release["tag_name"], "assets": [{k: a.get(k) for k in ("id", "name", "size", "updated_at", "digest", "browser_download_url")} for a in selected]}
    # Asset IDs and update times prevent accidental reuse after release replacement.
    bucket = args.cache / args.version / f"{args.platform}-{args.arch}" / digest(json.dumps(receipt, sort_keys=True).encode())[:20]
    paths = [bucket / a["name"] for a in selected]
    for asset, path, limit in zip(selected, paths, (MAX_ARCHIVE, 4096)):
        require(type(asset.get("size")) is int and 0 < asset["size"] <= limit, "Asset size exceeds download bounds")
        if not path.exists():
            data = fetch(asset["browser_download_url"], limit)
            require(len(data) == asset["size"], "Release asset size mismatch")
            atomic_write(path, data)
        require(path.stat().st_size == asset["size"], "Cached asset size mismatch; remove this cache entry and reacquire explicitly")
        if asset.get("digest"):
            require(asset["digest"] == "sha256:" + digest(path.read_bytes()), "GitHub asset digest mismatch")
    atomic_write(bucket / "release.json", (json.dumps(receipt, indent=2) + "\n").encode())
    return *paths, receipt


def parse_frame(raw):
    value = raw.strip()
    if value.startswith("at "):
        value = value[3:]
    # Firefox/Safari function@URL; V8 function (URL); bare URL.
    function = None
    if value.endswith(")") and " (" in value:
        function, value = value.rsplit(" (", 1)
        value = value[:-1]
    elif "@" in value and not value.startswith(("file:", "http:", "https:")):
        function, value = value.split("@", 1)
    match = re.fullmatch(r"(.+):(\d+):(\d+)", value)
    if match:
        return {"location": match[1], "line": int(match[2]), "column": int(match[3]), "function": function}
    match = re.fullmatch(r"(.+\.(?:js|cjs|mjs)):(\d+)", value)
    if match:
        return {"location": match[1], "line": int(match[2]), "column": None, "function": function}
    return None


def locate(location, records):
    value = urllib.parse.unquote(location).replace("\\", "/")
    if value.startswith(("node:", "native", "electron:", "webpack:", "data:", "blob:")) or "node_modules/" in value:
        return [], "Native/external/opaque frame has no release source map"
    # Strip URL query/fragment after decoding, preserving Windows drive letters.
    value = value.split("?", 1)[0].split("#", 1)[0]
    if "/out/" in value:
        value = "out/" + value.rsplit("/out/", 1)[1]
        candidates = [value] if value in records and JS.search(value) else []
    elif value.startswith("out/"):
        candidates = [value] if value in records and JS.search(value) else []
    else:
        if ".asar/" in value:
            value = value.split(".asar/", 1)[1]
        else:
            value = re.sub(r"^[a-zA-Z][a-zA-Z0-9+.-]*://[^/]*/*", "", value).lstrip("/")
        # Require all visible relative path components to match. Basenames are
        # allowed only when unique, and never treated as installed-byte proof.
        candidates = [p for p in records if JS.search(p) and (p == value or p.endswith("/" + value))]
    return candidates, "Generated JS not in archive; need its exact map/archive" if not candidates else None


def vlq(segment):
    result, value, shift = [], 0, 0
    for char in segment:
        require(char in BASE64, "Invalid source-map VLQ character")
        digit = BASE64[char]
        value |= (digit & 31) << shift
        require(shift <= 35, "Source-map VLQ overflow")
        if digit & 32:
            shift += 5
        else:
            result.append(-(value >> 1) if value & 1 else value >> 1)
            value, shift = 0, 0
    require(shift == 0, "Truncated source-map VLQ")
    return result


def original_position(sm, line, column):
    require("sections" not in sm, "Indexed maps unsupported; need a flattened exact-build map")
    source = original_line = original_column = name = 0
    rows = sm["mappings"].split(";")
    if line > len(rows):
        return None
    best = None
    for row_index, row in enumerate(rows[:line]):
        generated_column = 0
        for segment in row.split(",") if row else []:
            fields = vlq(segment)
            require(len(fields) in (1, 4, 5), "Malformed source-map segment")
            generated_column += fields[0]
            require(fields[0] >= 0, "Unsorted generated source-map columns")
            position = None
            if len(fields) > 1:
                source += fields[1]
                original_line += fields[2]
                original_column += fields[3]
                if len(fields) == 5:
                    name += fields[4]
                require(0 <= source < len(sm["sources"]) and original_line >= 0 and original_column >= 0,
                        "Invalid original source-map position")
                function = None
                if len(fields) == 5:
                    require(0 <= name < len(sm.get("names", [])), "Invalid source-map name index")
                    function = sm["names"][name]
                position = (source, original_line, original_column, function)
            if row_index == line - 1 and generated_column <= column:
                best = position  # An unmapped segment cancels a preceding match.
    return best


def installed_evidence(args, records):
    evidence = {}
    if args.hashes:
        given = json.loads(args.hashes.read_text())
        require(isinstance(given, dict), "--hashes must be a JSON object keyed by out/... path")
        for name, value in given.items():
            safe_path(name)
            require(name in records and JS.search(name), f"Unknown installed hash path: {name}")
            require(isinstance(value, (str, dict)), f"Invalid installed hash record: {name}")
            sha = value if isinstance(value, str) else value.get("sha256")
            require(isinstance(sha, str) and HEX.fullmatch(sha.lower()), f"Invalid installed hash: {name}")
            size = None if isinstance(value, str) else value.get("bytes")
            require(size is None or type(size) is int and size >= 0, f"Invalid installed byte count: {name}")
            evidence[name] = {"sha256": sha.lower(), "bytes": size, "origin": "operator-supplied installed hash", "kind": "operator-hash"}
    paths = []
    if args.installed_root:
        for name in records:
            if JS.search(name):
                path = args.installed_root / name
                if path.is_file():
                    paths.append((name, path))
    for binding in args.installed_file:
        name, separator, path = binding.partition("=")
        require(separator and name in records and JS.search(name), "--installed-file must be out/path.js=/original/extracted/file.js")
        paths.append((name, Path(path)))
    for name, path in paths:
        require(path.stat().st_size <= MAX_FILE, "Installed file exceeds size bound")
        data = path.read_bytes()
        entry = {"sha256": digest(data), "bytes": len(data), "origin": str(path.resolve()), "kind": "direct-file"}
        if name in evidence:
            require(evidence[name]["sha256"] == entry["sha256"]
                    and evidence[name]["bytes"] in (None, entry["bytes"]),
                    f"Conflicting installed evidence: {name} ({evidence[name]['origin']} vs {entry['origin']})")
        evidence[name] = entry
    return evidence


def resolve_frames(stack, contents, records, evidence, args):
    frames, maps, js_lines = [], {}, {}
    for raw in stack.splitlines():
        entry = {"original": raw, "status": "unmapped"}
        frame = parse_frame(raw)
        if frame is None:
            entry["reason"] = "No JS line/column frame (message, native/external, eval, or unsupported format)"
            frames.append(entry)
            continue
        entry["generated"] = frame
        candidates, reason = locate(frame["location"], records)
        if len(candidates) != 1:
            entry["reason"] = reason or "Ambiguous JS path; supply full app.asar out/... location"
            if candidates:
                entry["candidates"] = candidates
            frames.append(entry)
            continue
        path = candidates[0]
        record, proof = records[path], evidence.get(path)
        entry["generated"]["archivePath"] = path
        entry["installedVerification"] = "unavailable"
        if proof is None:
            entry["verificationNextInput"] = f"Original installed {path} bytes or its SHA-256 (and byte count when available)"
        if proof:
            entry["installedEvidence"] = proof
            if proof["sha256"] != record["sha256"] or proof["bytes"] not in (None, record["bytes"]):
                entry["installedVerification"] = "mismatch"
                entry["reason"] = "Installed JS hash/size mismatch; need artifacts for those exact installed bytes"
                frames.append(entry)
                continue
            entry["installedVerification"] = "sha256-match" if proof["bytes"] is None else "sha256-and-size-match"
        elif args.local_subset:
            entry["reason"] = "Local subset/rebuild requires original installed JS or its SHA-256 before mapping"
            frames.append(entry)
            continue
        if frame["column"] is None:
            entry["reason"] = "Missing generated column; supply the original JS line:column"
            frames.append(entry)
            continue
        column = frame["column"] - args.column_base
        entry["generated"]["sourceMapColumn0"] = column
        if frame["line"] < 1 or column < 0:
            entry["reason"] = "Invalid line/column for declared column base; browser/V8 columns begin at 1"
            frames.append(entry)
            continue
        if path not in js_lines:
            js_lines[path] = contents[path].decode("utf-8").split("\n")
        lines = js_lines[path]
        if frame["line"] > len(lines) or column >= len(lines[frame["line"] - 1].encode("utf-16-le")) // 2:
            entry["reason"] = "Generated position outside exact JS bytes; check stack/build/column base"
            frames.append(entry)
            continue
        map_path = record.get("sourceMap")
        if not map_path:
            entry["reason"] = "Generated JS has no map; external/copied asset or missing exact-build map"
            frames.append(entry)
            continue
        try:
            if map_path not in maps:
                maps[map_path] = json.loads(contents[map_path])
            sm = maps[map_path]
            position = original_position(sm, frame["line"], column)
            if position is None:
                entry["reason"] = "No mapped segment at this generated position"
            else:
                source, line0, column0, function = position
                text = sm["sourcesContent"][source].splitlines()
                require(line0 < len(text), "Mapped line outside embedded source content")
                entry.update(status="mapped", source={"path": sm.get("sourceRoot", "") + sm["sources"][source],
                             "line": line0 + 1, "column": column0 + 1, "column0": column0,
                             "function": function, "stackFunction": frame["function"]},
                             excerpt=[{"line": i + 1, "text": text[i]} for i in range(max(0, line0 - 2), min(len(text), line0 + 3))])
                entry["mappingConfidence"] = (
                    "installed-hash-match (operator-supplied)" if proof and proof["kind"] == "operator-hash"
                    else "installed-bytes-sha256-and-size-match" if proof
                    else "archive-self-consistent-only; installed build unverified"
                )
        except (DiagnosticError, ValueError, KeyError, TypeError, IndexError) as error:
            entry["reason"] = f"Invalid/unsupported map: {error}"
        frames.append(entry)
    return frames


def render(report):
    p = report["provenance"]
    lines = [f"Artifact: {p['archive']}", f"SHA-256: {p['archiveSha256']}",
             f"Build: v{p['version']} {p['commit']} {p['platform']}-{p['arch']}",
             f"Archive checks: passed ({p['mode']}); installed evidence checked per frame; inspect origin."]
    if p.get("scope"):
        lines.append(f"Scope: {p['scope']}")
    lines.append(f"Acquisition: {p['kind']}; release: {p.get('releaseUrl') or 'local override, not a public asset'}")
    if p.get("unlistedLocalAuxiliaryFiles"):
        lines.append("Local auxiliary files not in per-file manifest (not executed): " + ", ".join(p["unlistedLocalAuxiliaryFiles"]))
    for frame in report["frames"]:
        lines.append("\n" + frame["original"])
        if frame["status"] == "mapped":
            s = frame["source"]
            lines.append(f"  -> {s['path']}:{s['line']}:{s['column']} ({s['function'] or 'name unavailable'})")
            lines.append(f"  {frame['mappingConfidence']}; input column base {report['inputColumnBase']}")
            if frame.get("installedEvidence"):
                lines.append("  Evidence: " + frame["installedEvidence"]["origin"])
            if frame.get("verificationNextInput"):
                lines.append("  For installed verification: " + frame["verificationNextInput"])
            lines.extend(f"  {e['line']:>5} {'>' if e['line'] == s['line'] else ' '} {e['text']}" for e in frame["excerpt"])
        else:
            lines.append("  unresolved: " + frame["reason"])
    return "\n".join(lines)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", help="Exact desktop version or v-tag; required, never inferred from latest")
    parser.add_argument("--platform", choices=["darwin", "win32", "linux"])
    parser.add_argument("--arch", choices=["universal", "arm64", "x64"], help="Archive/package target; macOS process arch does not identify universal packaging")
    parser.add_argument("--commit", help="Optional authoritative full release/build commit (not a guessed local tag)")
    parser.add_argument("--stack", type=Path, help="UTF-8 stack file; otherwise paste via stdin")
    parser.add_argument("--archive", type=Path, help="Local debug archive override, no network")
    parser.add_argument("--checksum", type=Path, help="Defaults to ARCHIVE.sha256; required for local archives")
    parser.add_argument("--local-subset", action="store_true", help="Explicit local scoped backfill; original installed hashes/bytes mandatory for each mapped frame")
    parser.add_argument("--installed-root", type=Path, help="Operator-extracted original app.asar root containing out/")
    parser.add_argument("--installed-file", action="append", default=[], help="Repeated out/path.js=/path/to/original.js")
    parser.add_argument("--hashes", type=Path, help='JSON {"out/path.js": "sha256" or {"sha256": "...", "bytes": 123}} from installed JS')
    parser.add_argument("--column-base", type=int, choices=[0, 1], default=1, help="Input columns: browser/V8=1; explicitly preconverted source-map positions=0")
    parser.add_argument("--cache", type=Path, default=Path.home() / ".cache/pwragent-crash-stacks")
    parser.add_argument("--json", action="store_true", help="Structured report, original input lines preserved")
    args = parser.parse_args(argv)
    try:
        require(args.version, "Missing version; need exact desktop version/release tag (or local archive plus its build version)")
        args.version = args.version.removeprefix("v")
        require(re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?", args.version), "Invalid version")
        require(args.platform and args.arch, "Missing target; need package platform and architecture (darwin universal vs arm64 may be ambiguous)")
        require(f"{args.platform}-{args.arch}" in TARGETS, "Unsupported/ambiguous release target")
        require(not args.commit or COMMIT.fullmatch(args.commit), "--commit needs an authoritative full 40-character commit")
        if args.stack:
            require(args.stack.stat().st_size <= 1024 * 1024, "Stack exceeds 1 MiB")
        stack = args.stack.read_text(encoding="utf-8") if args.stack else sys.stdin.read(1024 * 1024 + 1)
        require(0 < len(stack.encode("utf-8")) <= 1024 * 1024, "Stack empty or exceeds 1 MiB")
        archive, checksum, acquisition = acquire(args)
        contents, manifest, archive_hash, metadata = read_archive(archive, checksum)
        records, auxiliary = validate(contents, manifest, args)
        evidence = installed_evidence(args, records)
        provenance = {"archive": str(archive.resolve()), "archiveSha256": archive_hash, **acquisition,
                      "version": manifest["version"], "releaseTag": manifest.get("releaseTag"), "commit": manifest["commit"],
                      "platform": manifest["platform"], "arch": manifest.get("arch", "unspecified-local-subset"),
                      "requestedTarget": f"{args.platform}-{args.arch}", "ci": manifest.get("ci"), "builtAt": manifest.get("builtAt"),
                      "scope": manifest.get("scope"), "buildMethod": manifest.get("buildMethod"),
                      "ignoredAppleDoubleMetadata": metadata, "unlistedLocalAuxiliaryFiles": auxiliary,
                      "mode": "local-subset" if args.local_subset else "full-release-schema",
                      "identityNote": "Manifest identity is checked; no installed build identity inferred from version, tag, filename or archive alone"}
        if acquisition["kind"] == "github-release":
            # Validated identity receipt includes commit; files are rechecked on every reuse.
            atomic_write(archive.parent / f"validated-{manifest['commit']}.json", (json.dumps(provenance, indent=2) + "\n").encode())
        frames = resolve_frames(stack, contents, records, evidence, args)
        report = {"provenance": provenance, "inputColumnBase": args.column_base, "frames": frames}
        print(json.dumps(report, indent=2, ensure_ascii=False) if args.json else render(report))
        return 0 if any(f["status"] == "mapped" for f in frames) else 3
    except (DiagnosticError, OSError, ValueError, KeyError, TypeError, tarfile.TarError) as error:
        print(json.dumps({"error": str(error)}) if args.json else f"Cannot resolve: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
