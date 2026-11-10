#!/usr/bin/env python3
"""Inventory or explicitly clean selected Git worktrees' disposable caches on macOS."""
import argparse
import contextlib
import ctypes
import hashlib
from functools import lru_cache
import json
import os
from pathlib import Path
import plistlib
import shutil
import stat
import struct
import subprocess
import sys
import tempfile
import time
import uuid

FORMAT = 1
SHARING_FLAGS = 0x01 | 0x40  # EF_MAY_SHARE_BLOCKS | EF_SHARES_ALL_BLOCKS
FORK_ATTRS = 0x08 | 0x100 | 0x200  # PRIVATESIZE, CLONEID, EXT_FLAGS
CACHE_NAMES = ("node_modules/.vitest-cache", "node_modules/.vite/vitest")


class Unsafe(RuntimeError):
    pass


class AttrList(ctypes.Structure):
    _fields_ = [("count", ctypes.c_uint16), ("reserved", ctypes.c_uint16),
                *[(name, ctypes.c_uint32) for name in ("common", "volume", "directory", "file", "fork")]]


@lru_cache(maxsize=1)
def attribute_reader():
    libc = ctypes.CDLL(None, use_errno=True)
    libc.getattrlist.argtypes = [ctypes.c_char_p, ctypes.POINTER(AttrList), ctypes.c_void_p,
                                ctypes.c_size_t, ctypes.c_ulong]
    return libc.getattrlist


def apfs_metadata(path):
    if sys.platform != "darwin":
        raise Unsafe("APFS metadata is only supported on macOS")
    attrs = AttrList(5, 0, 0x80000000, 0, 0, 0, FORK_ATTRS)
    buffer = ctypes.create_string_buffer(128)
    if attribute_reader()(os.fsencode(path), ctypes.byref(attrs), buffer, len(buffer), 0x20):
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error), str(path))
    length, common, _, _, _, fork, private, clone, flags = struct.unpack_from("=I5IQQQ", buffer.raw)
    if length < 48 or not common & 0x80000000 or fork & FORK_ATTRS != FORK_ATTRS:
        raise Unsafe(f"Missing APFS metadata for {path}")
    return {"private_bytes": private, "clone_id": clone, "sharing_flags": flags}


def git(project, *args):
    env = {key: value for key, value in os.environ.items()
           if key not in ("GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE")}
    env["GIT_OPTIONAL_LOCKS"] = "0"
    return subprocess.check_output(["git", "-C", str(project), *args], env=env, stderr=subprocess.PIPE)


def common_dir(project):
    return Path(os.fsdecode(git(project, "rev-parse", "--path-format=absolute", "--git-common-dir")).strip()).resolve()


def worktrees(project):
    result, record = [], {}
    for field in git(project, "worktree", "list", "--porcelain", "-z").split(b"\0"):
        if not field:
            if record:
                result.append(record)
                record = {}
        else:
            key, _, value = os.fsdecode(field).partition(" ")
            record[key] = value
    if record:
        result.append(record)
    return result


def process_snapshot():
    # Only paths and PIDs leave this function; never include other processes'
    # command lines in a report. cwd/txt include shells, tests and loaded apps.
    command = ["/usr/sbin/lsof", "-nP", "-w", "-a", "-u", str(os.getuid()), "-d", "cwd,txt", "-F0pn"]
    run = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if run.returncode or not run.stdout:
        raise Unsafe("Cannot establish active-process ownership with lsof; no cleanup is safe")
    observations, pid = [], None
    for field in run.stdout.split(b"\0"):
        field = field.lstrip(b"\n")
        if field.startswith(b"p"):
            pid = int(field[1:])
        elif field.startswith(b"n/") and pid is not None:
            observations.append((pid, os.fsdecode(field[1:])))
    # An absolute script path can name a worktree even when cwd is elsewhere.
    ps = subprocess.run(["ps", "-axo", "pid=,ppid=,args="], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if ps.returncode:
        raise Unsafe("Cannot establish process command ownership; no cleanup is safe")
    processes = {}
    for line in os.fsdecode(ps.stdout).splitlines():
        parts = line.strip().split(None, 2)
        if len(parts) == 3 and parts[0].isdigit() and parts[1].isdigit():
            processes[int(parts[0])] = (int(parts[1]), parts[2])
    # Maintenance shell arguments name --project too. Ignore our ancestry
    # only for command matching; its real cwd/executable paths still protect it.
    ancestors, current = set(), os.getpid()
    while current and current not in ancestors:
        ancestors.add(current)
        current = processes.get(current, (0, ""))[0]
    commands = [(pid, command) for pid, (_, command) in processes.items() if pid not in ancestors]
    return observations, commands


def active_pids(root, snapshot):
    prefix = str(root)
    observations, commands = snapshot
    found = {pid for pid, name in observations if name == prefix or name.startswith(prefix + "/")}
    # Require a path boundary; /repo-other is not /repo.
    for pid, command in commands:
        for suffix in ("/", " ", '"', "'", ""):
            token = prefix + suffix
            if token in command and (suffix or command.endswith(prefix)):
                found.add(pid)
                break
    return sorted(found)


def safe_directory(root, path):
    relative = path.relative_to(root)
    if not relative.parts or ".." in relative.parts:
        raise Unsafe("Candidate must be strictly inside its worktree")
    current = root
    for part in relative.parts:
        current /= part
        info = current.lstat()
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
            raise Unsafe(f"Not an independent directory: {current}")


def tree_state(path, metadata=apfs_metadata):
    """Never follow links/mounts; fingerprint identity and observable changes."""
    device = path.lstat().st_dev
    digest = hashlib.sha256()
    totals = {"allocated_bytes": 0, "private_bytes": 0, "regular_files": 0,
              "shares_blocks": False, "hardlinks": False}
    seen = set()
    witness = None
    for directory, dirs, files in os.walk(path, followlinks=False):
        for name in [".", *sorted(dirs), *sorted(files)]:
            item = Path(directory) if name == "." else Path(directory) / name
            if item.name == ".git":
                raise Unsafe(f"Nested Git data: {item}")
            info = item.lstat()
            if info.st_dev != device:
                raise Unsafe(f"Nested mount: {item}")
            entry = [str(item.relative_to(path)), info.st_dev, info.st_ino, info.st_mode,
                     info.st_size, info.st_mtime_ns, info.st_nlink]
            if stat.S_ISLNK(info.st_mode):
                target = os.readlink(item)
                resolved = Path(os.path.normpath(str(item.parent / target)))
                if os.path.isabs(target) or not resolved.is_relative_to(path):
                    raise Unsafe(f"Escaping symlink: {item}")
                entry.append(target)
            elif stat.S_ISREG(info.st_mode):
                attrs = metadata(item)
                entry.append(attrs)
                if witness is None or info.st_size > witness["size"]:
                    witness = {"path": str(item.relative_to(path)), "inode": info.st_ino, "size": info.st_size, **attrs}
                key = (info.st_dev, info.st_ino)
                if key not in seen:
                    seen.add(key)
                    totals["regular_files"] += 1
                    totals["allocated_bytes"] += info.st_blocks * 512
                    totals["private_bytes"] += attrs["private_bytes"]
                totals["shares_blocks"] |= bool(attrs["sharing_flags"] & SHARING_FLAGS)
                totals["hardlinks"] |= info.st_nlink > 1
            elif not stat.S_ISDIR(info.st_mode):
                raise Unsafe(f"Special file: {item}")
            digest.update(json.dumps(entry, sort_keys=True).encode())
            digest.update(b"\n")
    return {**totals, "fingerprint": digest.hexdigest(), "witness": witness}


def package_roots(root):
    files = git(root, "ls-files", "-z", "--", "package.json", "**/package.json").split(b"\0")
    return sorted({root, *[root / Path(os.fsdecode(name)).parent for name in files if name]})


def candidate_paths(root):
    for package in package_roots(root):
        for name in CACHE_NAMES:
            path = package / name
            if path.exists() or path.is_symlink():
                yield "vitest", path
    store = root / "node_modules/.pnpm"
    if store.is_dir() and not store.is_symlink():
        for package in sorted(store.glob("electron@*/node_modules/electron")):
            if (package / "dist").exists() or (package / "dist").is_symlink():
                yield "electron", package / "dist"
    direct = root / "node_modules/electron"
    if direct.is_dir() and not direct.is_symlink() and (direct / "dist").exists():
        yield "electron", direct / "dist"


def runtime_identity(dist):
    package = json.loads((dist.parent / "package.json").read_text())
    if package.get("name") != "electron" or (dist / "version").read_text().strip() != package.get("version"):
        raise Unsafe("Runtime does not match its Electron package version")
    allowed = {"Electron.app", "LICENSE", "LICENSES.chromium.html", "version", "electron.d.ts"}
    if set(os.listdir(dist)) - allowed:
        raise Unsafe("Unexpected files in runtime root; preserve possible unique data")
    app = dist / "Electron.app/Contents"
    plist = plistlib.loads((app / "Info.plist").read_bytes())
    if plist.get("CFBundleIdentifier") != "com.github.Electron":
        raise Unsafe("Not a stock Electron app bundle")
    executable = app / "MacOS/Electron"
    if not executable.is_file() or executable.is_symlink():
        raise Unsafe("Missing independent Electron executable")
    return {"version": package["version"]}


def tracked(root, path):
    return bool(git(root, "ls-files", "-z", "--", str(path.relative_to(root))))


def audit(project, snapshot=None, metadata=apfs_metadata, progress=None, for_sharing=False):
    project = project.resolve(strict=True)
    common = common_dir(project)
    snapshot = process_snapshot() if snapshot is None else snapshot
    report = {"format": FORMAT, "project": str(project), "common_dir": str(common),
              "created_at": time.time(), "candidates": [], "preserved": [], "worktrees": []}
    registered = worktrees(project)
    for index, record in enumerate(registered):
        if progress and index % 10 == 0:
            progress({"worktrees_started": index, "registered": len(registered), "candidates": len(report["candidates"])})
        root = Path(record["worktree"])
        entry = {"path": str(root)}
        report["worktrees"].append(entry)
        try:
            root = root.resolve(strict=True)
            if common_dir(root) != common or "locked" in record or "prunable" in record or "bare" in record:
                raise Unsafe("Locked, prunable, bare or foreign worktree")
            pids = active_pids(root, snapshot)
            if pids and not for_sharing:
                entry.update(status="active", pids=pids)
                continue
            entry["status"] = "scanned"
            if pids:
                entry["pids"] = pids
            for kind, path in candidate_paths(root):
                if for_sharing and kind != "electron":
                    continue
                detail = {"kind": kind, "worktree": str(root), "path": str(path)}
                try:
                    safe_directory(root, path)
                    if for_sharing and active_pids(path, snapshot):
                        raise Unsafe("Electron runtime is in use")
                    if tracked(root, path):
                        raise Unsafe("Contains tracked files")
                    if kind == "electron":
                        detail.update(runtime_identity(path))
                        if (path.parent / ".pwragent-runtime-lock").exists():
                            raise Unsafe("Electron installer lock exists")
                    state = tree_state(path, metadata)
                    detail.update(state)
                    if state["hardlinks"]:
                        raise Unsafe("Hardlinked data; private bytes cannot be attributed to this directory")
                    if kind == "electron" and state["shares_blocks"]:
                        raise Unsafe("Shared/clone-backed runtime")
                    detail["id"] = hashlib.sha256((str(path) + state["fingerprint"]).encode()).hexdigest()[:20]
                    report["candidates"].append(detail)
                except (OSError, ValueError, Unsafe) as error:
                    detail["reason"] = str(error)
                    report["preserved"].append(detail)
        except (OSError, ValueError, subprocess.SubprocessError, Unsafe) as error:
            entry.update(status="preserved", reason=str(error))
    return report


@contextlib.contextmanager
def installer_lock(package):
    """Use the installer's atomic, nonempty owner-token protocol; never steal."""
    lock = package / ".pwragent-runtime-lock"
    candidate = Path(tempfile.mkdtemp(prefix=".cleanup-lock-", dir=package))
    token = f"{os.getpid()}-{uuid.uuid4()}"
    (candidate / token).touch()
    published = False
    try:
        if lock.exists():
            raise Unsafe("Electron installer is busy")
        try:
            candidate.rename(lock)
        except OSError as error:
            raise Unsafe("Electron installer lock changed") from error
        published = True
        yield
    finally:
        if published:
            (lock / token).unlink()
            try:
                lock.rmdir()
            except FileNotFoundError:
                pass
        else:
            shutil.rmtree(candidate)


def clean(report, snapshot_fn=process_snapshot, metadata=apfs_metadata, verify_fn=None):
    if report.get("format") != FORMAT or not shutil.rmtree.avoids_symlink_attacks:
        raise Unsafe("Unsupported plan format or unsafe recursive deletion implementation")
    project = Path(report["project"]).resolve(strict=True)
    if str(common_dir(project)) != report["common_dir"]:
        raise Unsafe("Project Git identity changed")
    # Re-discover from Git and re-measure; a modified/stale plan cannot name
    # arbitrary directories or authorize a newly replaced runtime/cache.
    fresh = audit(project, snapshot_fn(), metadata)
    available = {entry["id"]: entry for entry in fresh["candidates"]}
    result = {"removed": [], "preserved": []}
    for approved in report["candidates"]:
        current = available.get(approved["id"])
        if current is None or any(approved.get(key) != current.get(key) for key in ("path", "worktree", "kind", "fingerprint")):
            result["preserved"].append({"path": approved.get("path"), "reason": "Candidate changed or is now active"})
            continue
        path, root = Path(current["path"]), Path(current["worktree"])
        quarantine = path.with_name(f".cache-cleanup-{uuid.uuid4()}")
        moved = False
        try:
            lock = installer_lock(path.parent) if current["kind"] == "electron" else contextlib.nullcontext()
            with lock:
                if active_pids(root, snapshot_fn()):
                    raise Unsafe("Worktree became active")
                safe_directory(root, path)
                if tree_state(path, metadata)["fingerprint"] != current["fingerprint"]:
                    raise Unsafe("Candidate changed before cleanup")
                if current["kind"] == "electron":
                    (verify_fn or verify_installed_runtime)(path)
                    # Preparation can take time; recheck immediately before moving.
                    if active_pids(root, snapshot_fn()) or tree_state(path, metadata)["fingerprint"] != current["fingerprint"]:
                        raise Unsafe("Runtime changed or worktree became active during verification")
                path.rename(quarantine)
                moved = True
                if active_pids(root, snapshot_fn()) or tree_state(quarantine, metadata)["fingerprint"] != current["fingerprint"]:
                    raise Unsafe("Activity or content changed during cleanup")
                shutil.rmtree(quarantine)
                moved = False
                result["removed"].append(current)
        except (OSError, ValueError, Unsafe, subprocess.SubprocessError) as error:
            if moved and not path.exists() and not path.is_symlink():
                try:
                    quarantine.rename(path)
                    moved = False
                except OSError as restore_error:
                    error = Unsafe(f"{error}; restore failed: {restore_error}")
            result["preserved"].append({"path": str(path), "reason": str(error),
                                         **({"quarantine": str(quarantine)} if moved else {})})
    return result


def content_inventory(root):
    """Match the installer's byte/mode/link inventory; do not follow links."""
    entries = []
    def visit(directory):
        for item in sorted(directory.iterdir()):
            info = item.lstat()
            entry = {"path": str(item.relative_to(root)), "mode": (info.st_mode & 0o777)}
            if item.is_symlink():
                entry["link"] = os.readlink(item)
            elif item.is_dir():
                entry["directory"] = True
            elif item.is_file():
                digest = hashlib.sha256()
                with item.open("rb") as stream:
                    for block in iter(lambda: stream.read(1024 * 1024), b""):
                        digest.update(block)
                entry["sha256"] = digest.hexdigest()
            else:
                raise Unsafe("Unsupported runtime entry")
            entries.append(entry)
            if entry.get("directory"):
                visit(item)
    visit(root)
    return entries


def prepare_runtime(package, arch):
    helper = Path(__file__).with_name("prepare-electron-runtime.mjs")
    return json.loads(subprocess.check_output(["node", str(helper), str(package), arch]))


def runtime_arch(path):
    executable = path / "Electron.app/Contents/MacOS/Electron"
    value = subprocess.check_output(["/usr/bin/lipo", "-archs", str(executable)], text=True).strip()
    if value not in ("arm64", "x86_64"):
        raise Unsafe(f"Unsupported runtime architecture: {value}")
    return {"arm64": "arm64", "x86_64": "x64"}[value]


def verified_source(path, cache, version, arch):
    identity = cache["identity"]
    if identity.get("version") != version or identity.get("platform") != "darwin" or identity.get("arch") != arch:
        raise Unsafe("Prepared cache target mismatch")
    source = Path(cache["cache"]) / "dist"
    manifest = json.loads((source.parent / "runtime.json").read_text())
    tree_state(source)  # Reject escaping symlinks and special files before reading content.
    files = content_inventory(source)
    if manifest["identity"] != identity or files != manifest["files"]:
        raise Unsafe("Cache content changed after checksum verification")
    if stat.S_IMODE(path.lstat().st_mode) != stat.S_IMODE(source.lstat().st_mode):
        raise Unsafe("Runtime root mode differs from verified artifact")
    old_files = content_inventory(path)
    # Legacy Electron installers move the declaration out of dist.
    wanted = files if (path / "electron.d.ts").exists() else [f for f in files if f["path"] != "electron.d.ts"]
    if old_files != wanted:
        raise Unsafe("Existing runtime differs from verified artifact; preserve possible custom data")
    return source, old_files


def verify_installed_runtime(path):
    arch = runtime_arch(path)
    cache = prepare_runtime(path.parent, arch)
    verified_source(path, cache, runtime_identity(path)["version"], arch)


def clone_oracle(source, destination):
    """Prove independent inodes, equal clone IDs and zero private allocation."""
    for directory, _, files in os.walk(destination):
        for name in files:
            clone = Path(directory) / name
            if clone.is_symlink():
                continue
            original = source / clone.relative_to(destination)
            info, source_info = clone.stat(), original.stat()
            if (info.st_dev, info.st_ino) == (source_info.st_dev, source_info.st_ino) or info.st_nlink != 1:
                raise Unsafe("Runtime clone is not independently owned")
            attrs, source_attrs = apfs_metadata(clone), apfs_metadata(original)
            if info.st_blocks and (attrs["private_bytes"] or not attrs["sharing_flags"] & SHARING_FLAGS
                    or attrs["clone_id"] != source_attrs["clone_id"]):
                raise Unsafe(f"Runtime file is not APFS shared: {clone}")


def share(report, snapshot_fn=process_snapshot, prepare_fn=prepare_runtime, arch_fn=runtime_arch):
    """Replace unused private runtimes with verified clones, even in busy worktrees."""
    if report.get("format") != FORMAT or not shutil.rmtree.avoids_symlink_attacks:
        raise Unsafe("Unsupported plan or recursive deletion implementation")
    project = Path(report["project"]).resolve(strict=True)
    if str(common_dir(project)) != report["common_dir"]:
        raise Unsafe("Project Git identity changed")
    fresh = audit(project, snapshot_fn(), for_sharing=True)
    available = {item["id"]: item for item in fresh["candidates"]}
    result, prepared = {"shared": [], "preserved": []}, {}
    for approved in report["candidates"]:
        current = available.get(approved["id"])
        if current is None or any(approved.get(key) != current.get(key) for key in ("path", "worktree", "kind", "fingerprint")):
            result["preserved"].append({"path": approved.get("path"), "reason": "Changed or runtime in use"})
            continue
        path, root = Path(current["path"]), Path(current["worktree"])
        stage, moved, published = None, False, False
        backup_removal_safe = False
        try:
            with installer_lock(path.parent):
                arch = arch_fn(path)
                key = (current["version"], arch)
                if key not in prepared:
                    prepared[key] = prepare_fn(path.parent, arch)
                cache = prepared[key]
                source, old_files = verified_source(path, cache, key[0], arch)
                safe_directory(root, path)
                if tree_state(path)["fingerprint"] != current["fingerprint"] or active_pids(path, snapshot_fn()):
                    raise Unsafe("Runtime changed or became active")
                stage = Path(tempfile.mkdtemp(prefix=".sharing-install-", dir=path.parent))
                new, backup = stage / "dist", stage / "previous-dist"
                subprocess.run(["/bin/cp", "-cRpP", str(source), str(new)], check=True)
                if not (path / "electron.d.ts").exists() and (new / "electron.d.ts").exists():
                    (new / "electron.d.ts").unlink()
                if content_inventory(new) != old_files:
                    raise Unsafe("Clone content verification failed")
                clone_oracle(source, new)
                if tree_state(path)["fingerprint"] != current["fingerprint"] or active_pids(path, snapshot_fn()):
                    raise Unsafe("Runtime changed before publication")
                original_inode = path.lstat().st_ino
                path.rename(backup)
                moved = True
                if active_pids(path, snapshot_fn()) or active_pids(backup, snapshot_fn()):
                    raise Unsafe("Runtime became active during publication")
                new.rename(path)
                published = True
                witness = tree_state(path)["witness"]
                result["shared"].append({"path": str(path), "version": key[0], "arch": arch,
                                         "cache": str(source), "witness": witness})
                # A just-started app might still map the original inodes. Keep
                # that backup rather than removing a runtime beneath it.
                snapshot = snapshot_fn()
                if active_pids(path, snapshot) or active_pids(backup, snapshot):
                    result["preserved"].append({"path": str(backup), "inode": original_inode, "witness": current["witness"],
                        "reason": "New runtime activity; backup retained"})
                    stage = None
                else:
                    backup_removal_safe = True
        except (OSError, ValueError, Unsafe, subprocess.SubprocessError) as error:
            if published and not backup_removal_safe:
                result["preserved"].append({"path": str(backup), "inode": original_inode, "witness": current["witness"],
                    "reason": f"{error}; original backup retained because final safety checks did not succeed"})
                continue
            if moved and not published:
                try:
                    if not path.exists() and not path.is_symlink():
                        backup.rename(path)
                        moved = False
                except OSError as restore_error:
                    error = Unsafe(f"{error}; restore failed: {restore_error}")
                if moved:
                    stage = None
                    error = Unsafe(f"{error}; original retained at {backup}")
            result["preserved"].append({"path": str(path), "reason": str(error)})
        finally:
            # Publication alone never authorizes deleting the original. A
            # failed post-publication inspection must retain its exact inode.
            if stage is not None and (not moved or backup_removal_safe):
                shutil.rmtree(stage)
        print(json.dumps({"runtimes_shared": len(result["shared"]), "preserved": len(result["preserved"])}), file=sys.stderr, flush=True)
    return result


def summary(report):
    return {"registered_worktrees": len(report["worktrees"]),
            "active_worktrees": sum(bool(entry.get("pids")) for entry in report["worktrees"]),
            "candidates": {kind: {"count": sum(item["kind"] == kind for item in report["candidates"]),
                "private_bytes": sum(item["private_bytes"] for item in report["candidates"] if item["kind"] == kind),
                "allocated_bytes": sum(item["allocated_bytes"] for item in report["candidates"] if item["kind"] == kind)}
                for kind in ("vitest", "electron")},
            "preserved": len(report["preserved"])}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("audit", "clean", "audit-share", "share"))
    parser.add_argument("--project", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    if sys.platform != "darwin":
        parser.error("This APFS cleanup tool is macOS-only; nothing was removed")
    if args.mode in ("audit", "audit-share"):
        report = audit(args.project, for_sharing=args.mode == "audit-share", progress=lambda value: print(json.dumps(value), file=sys.stderr, flush=True))
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps({**summary(report), "report": str(args.report.resolve())}))
    else:
        report = json.loads(args.report.read_text())
        if common_dir(args.project.resolve(strict=True)) != Path(report["common_dir"]):
            parser.error("--project does not own this plan")
        result = share(report) if args.mode == "share" else clean(report)
        if args.mode == "share":
            args.report.with_suffix(".result.json").write_text(json.dumps(result, indent=2) + "\n")
            print(json.dumps({"shared": len(result["shared"]), "preserved": result["preserved"]}))
            return
        print(json.dumps({"removed": len(result["removed"]), "preserved": result["preserved"],
                          "removed_private_bytes": sum(item["private_bytes"] for item in result["removed"]),
                          "removed_allocated_bytes": sum(item["allocated_bytes"] for item in result["removed"])}))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, Unsafe, subprocess.SubprocessError) as error:
        print(f"Cleanup stopped: {error}", file=sys.stderr)
        sys.exit(1)
