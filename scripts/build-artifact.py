#!/usr/bin/env python3
"""Acquire published bytes from their release build, never a release download URL.

This standard-library helper is mirrored in the three product repositories.
The published SHA-256 and size bind an artifact member to the release bytes.
"""

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
import zipfile
from pathlib import Path
from urllib.parse import urlencode

REPOSITORIES = {
    "pwrdrvr/PwrGit": "desktop-release-macos-artifacts",
    "pwrdrvr/PwrSnap": "desktop-release-macos-artifacts",
    "pwrdrvr/PwrAgent": "desktop-release-artifacts",
}


def api(endpoint):
    return json.loads(subprocess.check_output(["gh", "api", endpoint], text=True))


def pages(endpoint, field, read=api):
    result = []
    separator = "&" if "?" in endpoint else "?"
    for page in range(1, 101):
        rows = read(f"{endpoint}{separator}per_page=100&page={page}")[field]
        result.extend(rows)
        if len(rows) < 100:
            return result
    raise ValueError("Artifact discovery exceeds 100 pages; refusing incomplete results")


def tag_commit(repo, tag, read=api):
    obj = read(f"repos/{repo}/git/ref/tags/{tag}")["object"]
    for _ in range(10):
        if obj["type"] == "commit" and re.fullmatch(r"[a-f0-9]{40}", obj["sha"]):
            return obj["sha"]
        if obj["type"] != "tag":
            break
        obj = read(f"repos/{repo}/git/tags/{obj['sha']}")["object"]
    raise ValueError("Release tag does not resolve to a commit")


def select_artifact(repo, tag, name, read=api):
    if repo not in REPOSITORIES or not re.fullmatch(r"v\d+\.\d+\.\d+", tag):
        raise ValueError("Expected a PwrDrvr stable release tag")
    sha = tag_commit(repo, tag, read)
    query = urlencode({"head_sha": sha, "status": "success"})
    runs = pages(f"repos/{repo}/actions/workflows/release.yml/runs?{query}", "workflow_runs", read)
    windows = name.endswith(".exe") or "windows-SHA256SUMS" in name
    names = ["windows-installer"] if windows else [REPOSITORIES[repo]]
    # Older PwrAgent Windows artifacts had seven-day retention; its assembled
    # publication artifact also contains the exact signed installers/checksums.
    if repo == "pwrdrvr/PwrAgent":
        names.append("release-publish-artifacts")
    for run in runs:
        if (run.get("head_sha") != sha or run.get("conclusion") != "success"
                or run.get("event") not in {"push", "workflow_dispatch"}
                or run.get("head_repository", {}).get("full_name") != repo
                or run.get("path") != ".github/workflows/release.yml"
                or run.get("head_branch") != tag):
            continue
        artifacts = pages(f"repos/{repo}/actions/runs/{run['id']}/artifacts", "artifacts", read)
        for artifact_name in names:
            candidates = [a for a in artifacts if a["name"] == artifact_name and not a["expired"]]
            if len(candidates) > 1:
                raise ValueError("Ambiguous release build artifact")
            if candidates:
                return {"repository": repo, "run": run["id"], "head_sha": sha,
                        "artifact": candidates[0]}
    raise ValueError(f"No retained successful release build artifact for {repo} {tag}. "
                     "Restore the original build artifact; release-download fallback is prohibited.")


def verify(path, sha256, size):
    digest = hashlib.sha256()
    total = 0
    with Path(path).open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
            total += len(chunk)
    if digest.hexdigest() != sha256 or total != size:
        raise ValueError(f"Build artifact digest/size mismatch: {Path(path).name}")


def extract(archive, name, target, sha256, size):
    # Renaming SHA256SUMS during publication changes its name, not its bytes.
    with zipfile.ZipFile(archive) as bundle:
        matches = [info for info in bundle.infolist() if Path(info.filename).name == name and not info.is_dir()]
        if not matches and "windows-SHA256SUMS" in name:
            matches = [info for info in bundle.infolist() if Path(info.filename).name == "SHA256SUMS" and not info.is_dir()]
        if len(matches) != 1 or matches[0].file_size != size:
            raise ValueError(f"Missing/ambiguous/wrong-size artifact member: {name}")
        info = matches[0]
        if Path(info.filename).is_absolute() or ".." in Path(info.filename).parts or (info.external_attr >> 16) & 0o170000 == 0o120000:
            raise ValueError("Unsafe artifact member")
        with bundle.open(info) as source, Path(target).open("wb") as destination:
            shutil.copyfileobj(source, destination)
    verify(target, sha256, size)


def download_archive(repo, artifact, target):
    # gh handles API authentication/redirects. No release URL is accepted here.
    cache = Path(os.environ.get("BUILD_ARTIFACT_CACHE", ".local/build-artifacts"))
    cache.mkdir(parents=True, exist_ok=True)
    archive = cache / f"{repo.replace('/', '-')}-{artifact['id']}.zip"
    if not archive.exists():
        temporary = archive.with_suffix(".partial")
        try:
            with temporary.open("wb") as destination:
                subprocess.run(["gh", "api", f"repos/{repo}/actions/artifacts/{artifact['id']}/zip"],
                               stdout=destination, check=True)
            temporary.replace(archive)
        finally:
            temporary.unlink(missing_ok=True)
    digest = artifact.get("digest")
    if digest:
        if not re.fullmatch(r"sha256:[a-f0-9]{64}", digest):
            raise ValueError("Invalid Actions artifact archive digest")
        verify(archive, digest[7:], archive.stat().st_size)
    shutil.copyfile(archive, target)


def acquire(url, sha256, size, target, read=api, download=download_archive):
    match = re.fullmatch(r"https://github.com/(pwrdrvr/(?:PwrGit|PwrSnap|PwrAgent))/releases/download/"
                         r"(v\d+\.\d+\.\d+)/([A-Za-z0-9.-]+)", url)
    if not match or not re.fullmatch(r"[a-f0-9]{64}", sha256) or size <= 0:
        raise ValueError("Expected immutable release metadata with SHA-256 and size")
    repo, tag, name = match.groups()
    target = Path(target)
    if target.exists():
        verify(target, sha256, size)
        return "restored"
    selected = select_artifact(repo, tag, name, read)
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=target.parent) as directory:
        archive = Path(directory) / "artifact.zip"
        temporary = Path(directory) / name
        download(repo, selected["artifact"], archive)
        extract(archive, name, temporary, sha256, size)
        # Detect a moved/deleted tag while acquiring bytes.
        if tag_commit(repo, tag, read) != selected["head_sha"]:
            raise ValueError("Release tag changed during artifact acquisition")
        temporary.replace(target)
    print(f"Verified build artifact: {repo} {tag}; run={selected['run']}; artifact={selected['artifact']['id']}; member={name}")
    return "build-artifact"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", required=True)
    parser.add_argument("--sha256", required=True)
    parser.add_argument("--size", type=int, required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    print(acquire(args.url, args.sha256, args.size, args.output))


if __name__ == "__main__":
    main()
