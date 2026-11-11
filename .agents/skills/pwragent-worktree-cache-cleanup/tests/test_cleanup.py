import importlib.util
import json
import os
from pathlib import Path
import plistlib
import random
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.dont_write_bytecode = True
SKILL = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("cleanup", SKILL / "scripts/cleanup_worktree_caches.py")
cleanup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cleanup)
IDLE = ([], [])


def private(path):
    info = path.stat()
    return {"private_bytes": info.st_blocks * 512, "clone_id": info.st_ino, "sharing_flags": 0}


def git(root, *args):
    return subprocess.check_output(["git", "-C", str(root), "-c", "user.name=Fixture", "-c",
        "user.email=fixture@example.test", "-c", "commit.gpgsign=false", *args], stderr=subprocess.PIPE)


def runtime(root, suffix=""):
    package = root / f"node_modules/.pnpm/electron@44.10.1{suffix}/node_modules/electron"
    contents = package / "dist/Electron.app/Contents"
    (contents / "MacOS").mkdir(parents=True)
    (package / "package.json").write_text(json.dumps({"name": "electron", "version": "44.10.1"}))
    (package / "dist/version").write_text("44.10.1\n")
    (contents / "Info.plist").write_bytes(plistlib.dumps({"CFBundleIdentifier": "com.github.Electron"}))
    (contents / "MacOS/Electron").write_bytes(os.urandom(8192))
    dist = package / "dist"
    (package / "fixture-artifact.json").write_text(json.dumps({
        "files": cleanup.content_inventory(dist), "mode": dist.stat().st_mode & 0o777}))
    return dist


def cache(root, path="node_modules/.vitest-cache"):
    target = root / path
    target.mkdir(parents=True)
    (target / "entry").write_bytes(os.urandom(8192))
    return target


class CleanupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="pwragent-cleanup-test-")
        self.base = Path(self.temp.name).resolve()
        self.project = self.base / "project"
        self.project.mkdir()
        git(self.project, "init", "-b", "main")
        (self.project / "package.json").write_text('{"name":"fixture"}')
        (self.project / "source.txt").write_text("unique source")
        (self.project / ".gitignore").write_text("node_modules/\n.local/\napps/desktop/out/\n")
        git(self.project, "add", ".")
        git(self.project, "commit", "-m", "fixture")
        self.linked = self.base / "linked space \u2603"
        git(self.project, "worktree", "add", "-b", "linked", str(self.linked))

    def tearDown(self):
        self.temp.cleanup()

    def audit(self, metadata=private, snapshot=IDLE):
        return cleanup.audit(self.project, snapshot, metadata)

    def clean(self, report, snapshot_fn=lambda: IDLE, metadata=private):
        def verify(path):
            pinned = json.loads((path.parent / "fixture-artifact.json").read_text())
            if cleanup.content_inventory(path) != pinned["files"] or path.stat().st_mode & 0o777 != pinned["mode"]:
                raise cleanup.Unsafe("Runtime differs from fixture artifact")
        return cleanup.clean(report, snapshot_fn, metadata, verify_fn=verify)

    def test_git_is_the_discovery_oracle(self):
        extra = self.base / "unregistered-project"
        extra.mkdir()
        cache(extra)
        report = self.audit()
        self.assertEqual({item["path"] for item in report["worktrees"]}, {str(self.project), str(self.linked)})
        self.assertEqual(report["candidates"], [])

    def test_property_only_approved_cache_classes_are_removed(self):
        rng = random.Random(3580)
        for _ in range(12):
            root = rng.choice([self.project, self.linked])
            target = cache(root)
            dist = runtime(root)
            unique = root / ".local/unique.txt"
            unique.parent.mkdir(exist_ok=True)
            unique.write_bytes(rng.randbytes(40))
            out = root / "apps/desktop/out/build.js"
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_bytes(rng.randbytes(40))
            source_before = (root / "source.txt").read_bytes()
            unique_before, out_before = unique.read_bytes(), out.read_bytes()
            report = self.audit()
            self.assertEqual({item["kind"] for item in report["candidates"]}, {"vitest", "electron"})
            result = self.clean(report)
            self.assertEqual(len(result["removed"]), 2)
            self.assertFalse(target.exists())
            self.assertFalse(dist.exists())
            self.assertEqual((root / "source.txt").read_bytes(), source_before)
            self.assertEqual(unique.read_bytes(), unique_before)
            self.assertEqual(out.read_bytes(), out_before)
            self.assertEqual((root / "node_modules/.pnpm/electron@44.10.1/node_modules/electron/package.json").exists(), True)
            # Reuse the dependency package on the next generated case.
            (dist.parent / "package.json").unlink()

    def test_partial_clone_is_preserved_even_with_private_bytes(self):
        dist = runtime(self.linked)
        def partial(path):
            return {**private(path), "sharing_flags": cleanup.SHARING_FLAGS}
        report = self.audit(partial)
        self.assertEqual(report["candidates"], [])
        self.assertEqual(len(report["preserved"]), 1)
        self.clean(report, metadata=partial)
        self.assertTrue(dist.exists())

    def test_zero_private_bytes_alone_do_not_classify_a_runtime_as_cloned(self):
        runtime(self.linked)
        def snapshot_retained(path):
            return {**private(path), "private_bytes": 0}
        report = self.audit(snapshot_retained)
        self.assertEqual(len(report["candidates"]), 1)
        self.assertFalse(report["candidates"][0]["shares_blocks"])

    def test_busy_worktree_does_not_prevent_sharing_an_unused_runtime(self):
        runtime(self.linked)
        cache(self.linked)
        busy = ([(123, str(self.linked))], [])
        report = cleanup.audit(self.project, busy, private, for_sharing=True)
        self.assertEqual([item["kind"] for item in report["candidates"]], ["electron"])
        self.assertEqual(report["worktrees"][1]["status"], "scanned")
        self.assertEqual(cleanup.summary(report)["active_worktrees"], 1)

    def test_loaded_runtime_is_never_a_sharing_candidate(self):
        dist = runtime(self.linked)
        busy = ([(123, str(dist / "Electron.app/Contents/MacOS/Electron"))], [])
        report = cleanup.audit(self.project, busy, private, for_sharing=True)
        self.assertEqual(report["candidates"], [])
        self.assertTrue(dist.exists())

    @unittest.skipUnless(sys.platform == "darwin", "macOS APFS sharing oracle")
    def test_sharing_preserves_content_and_isolates_inodes_in_a_busy_worktree(self):
        dist = runtime(self.linked)
        cache_root = self.base / "runtime-cache"
        shutil.copytree(dist, cache_root / "dist", symlinks=True)
        identity = {"version": "44.10.1", "platform": "darwin", "arch": "arm64", "checksum": "fixture"}
        manifest = {"identity": identity, "files": cleanup.content_inventory(cache_root / "dist")}
        (cache_root / "runtime.json").write_text(json.dumps(manifest))
        busy = ([(123, str(self.linked))], [])
        before = cleanup.content_inventory(dist)
        original_inode = (dist / "Electron.app/Contents/MacOS/Electron").stat().st_ino
        report = cleanup.audit(self.project, busy, for_sharing=True)
        result = cleanup.share(report, snapshot_fn=lambda: busy,
            prepare_fn=lambda _package, _arch: {"cache": str(cache_root), "identity": identity},
            arch_fn=lambda _path: "arm64")
        self.assertEqual(result["preserved"], [])
        self.assertEqual(len(result["shared"]), 1)
        self.assertEqual(cleanup.content_inventory(dist), before)
        self.assertNotEqual((dist / "Electron.app/Contents/MacOS/Electron").stat().st_ino, original_inode)
        cleanup.clone_oracle(cache_root / "dist", dist)
        cached_file = cache_root / "dist/Electron.app/Contents/MacOS/Electron"
        cached_bytes = cached_file.read_bytes()
        (dist / "Electron.app/Contents/MacOS/Electron").write_bytes(b"worktree-private modification")
        self.assertEqual(cached_file.read_bytes(), cached_bytes)
        self.assertTrue((self.linked / "source.txt").exists())
        self.assertEqual(list(dist.parent.glob(".sharing-install-*")), [])

    @unittest.skipUnless(sys.platform == "darwin", "macOS APFS sharing oracle")
    def test_sharing_restores_original_when_runtime_starts_during_publication(self):
        dist = runtime(self.linked)
        cache_root = self.base / "runtime-cache"
        shutil.copytree(dist, cache_root / "dist", symlinks=True)
        identity = {"version": "44.10.1", "platform": "darwin", "arch": "arm64", "checksum": "fixture"}
        (cache_root / "runtime.json").write_text(json.dumps({"identity": identity,
            "files": cleanup.content_inventory(cache_root / "dist")}))
        original_inode = (dist / "Electron.app/Contents/MacOS/Electron").stat().st_ino
        snapshots = iter([IDLE, IDLE, IDLE, ([(123, str(dist / "Electron.app/Contents/MacOS/Electron"))], [])])
        report = cleanup.audit(self.project, IDLE, for_sharing=True)
        result = cleanup.share(report, snapshot_fn=lambda: next(snapshots),
            prepare_fn=lambda _package, _arch: {"cache": str(cache_root), "identity": identity},
            arch_fn=lambda _path: "arm64")
        self.assertEqual(result["shared"], [])
        self.assertEqual((dist / "Electron.app/Contents/MacOS/Electron").stat().st_ino, original_inode)
        self.assertEqual(list(dist.parent.glob(".sharing-install-*")), [])

    @unittest.skipUnless(sys.platform == "darwin", "macOS APFS sharing oracle")
    def test_original_backup_requires_explicit_post_publication_safety(self):
        for outcome in ("filesystem_error", "snapshot_error", "activity", "safe"):
            with self.subTest(outcome=outcome):
                dist = runtime(self.linked, "-" + outcome)
                cache_root = self.base / ("cache-" + outcome)
                shutil.copytree(dist, cache_root / "dist", symlinks=True)
                identity = {"version": "44.10.1", "platform": "darwin", "arch": "arm64", "checksum": "fixture"}
                (cache_root / "runtime.json").write_text(json.dumps({"identity": identity,
                    "files": cleanup.content_inventory(cache_root / "dist")}))
                relative = "Electron.app/Contents/MacOS/Electron"
                original_inode = (dist / relative).stat().st_ino
                original_directory_inode = dist.stat().st_ino
                original_bytes = (dist / relative).read_bytes()
                def published():
                    return dist.exists() and (dist / relative).stat().st_ino != original_inode
                def snapshot():
                    if published():
                        if outcome == "snapshot_error":
                            raise cleanup.Unsafe("Injected final process inspection failure")
                        if outcome == "activity":
                            return ([(123, str(dist / relative))], [])
                    return IDLE
                original_state = cleanup.tree_state
                def state(path, *args, **kwargs):
                    if path == dist and published() and outcome == "filesystem_error":
                        raise OSError("Injected post-publication filesystem failure")
                    return original_state(path, *args, **kwargs)
                report = cleanup.audit(self.project, IDLE, for_sharing=True)
                with mock.patch.object(cleanup, "tree_state", side_effect=state):
                    result = cleanup.share(report, snapshot_fn=snapshot,
                        prepare_fn=lambda _package, _arch: {"cache": str(cache_root), "identity": identity},
                        arch_fn=lambda _path: "arm64")
                backups = list(dist.parent.glob(".sharing-install-*/previous-dist"))
                self.assertTrue(dist.exists())
                if outcome == "safe":
                    self.assertEqual(backups, [])
                    self.assertEqual(result["preserved"], [])
                else:
                    self.assertEqual(len(backups), 1)
                    self.assertEqual((backups[0] / relative).stat().st_ino, original_inode)
                    self.assertEqual((backups[0] / relative).read_bytes(), original_bytes)
                    retained = next(item for item in result["preserved"] if item["path"] == str(backups[0]))
                    self.assertEqual(retained["inode"], original_directory_inode)
                    self.assertEqual(retained["witness"]["inode"], original_inode)

    @unittest.skipUnless(sys.platform == "darwin", "macOS APFS preservation oracle")
    def test_open_handles_cannot_lose_writes_to_the_original_backup(self):
        for change in ("file-write", "directory-write", "inspection-error"):
            with self.subTest(change=change):
                dist = runtime(self.linked, "-" + change)
                source = self.base / ("cache-" + change)
                shutil.copytree(dist, source / "dist", symlinks=True)
                identity = {"version": "44.10.1", "platform": "darwin", "arch": "arm64", "checksum": "fixture"}
                (source / "runtime.json").write_text(json.dumps({"identity": identity,
                    "files": cleanup.content_inventory(source / "dist")}))
                binary = dist / "Electron.app/Contents/MacOS/Electron"
                inode, directory_inode = binary.stat().st_ino, dist.stat().st_ino
                modified = False
                directory_fd = os.open(dist, os.O_RDONLY)
                original_state = cleanup.tree_state
                def state(path, *args, **kwargs):
                    if change == "inspection-error" and Path(path).name == "previous-dist":
                        raise OSError("Original backup inspection failed")
                    return original_state(path, *args, **kwargs)
                try:
                    with binary.open("r+b") as handle:
                        def snapshot():
                            nonlocal modified
                            # Ordinary writable handles are intentionally absent
                            # from cwd/txt ownership: prove filesystem revalidation.
                            if dist.exists() and binary.stat().st_ino != inode and not modified:
                                if change == "file-write":
                                    handle.seek(0)
                                    handle.write(b"operator write through original handle")
                                    handle.flush()
                                    os.fsync(handle.fileno())
                                elif change == "directory-write":
                                    fd = os.open("unique-data", os.O_CREAT | os.O_WRONLY, 0o600, dir_fd=directory_fd)
                                    try:
                                        os.write(fd, b"operator data through original directory")
                                    finally:
                                        os.close(fd)
                                modified = True
                            return IDLE
                        report = cleanup.audit(self.project, IDLE, for_sharing=True)
                        with mock.patch.object(cleanup, "tree_state", side_effect=state):
                            result = cleanup.share(report, snapshot_fn=snapshot,
                                prepare_fn=lambda _package, _arch: {"cache": str(source), "identity": identity},
                                arch_fn=lambda _path: "arm64")
                    backups = list(dist.parent.glob(".sharing-install-*/previous-dist"))
                    self.assertEqual(len(backups), 1, result)
                    self.assertEqual(backups[0].stat().st_ino, directory_inode)
                    self.assertEqual((backups[0] / binary.relative_to(dist)).stat().st_ino, inode)
                    self.assertTrue(any(item["path"] == str(backups[0]) for item in result["preserved"]))
                    if change == "file-write":
                        self.assertTrue((backups[0] / binary.relative_to(dist)).read_bytes().startswith(b"operator write"))
                    elif change == "directory-write":
                        self.assertEqual((backups[0] / "unique-data").read_bytes(), b"operator data through original directory")
                finally:
                    os.close(directory_fd)


    @unittest.skipUnless(sys.platform == "darwin", "macOS APFS preservation oracle")
    def test_special_permission_changes_are_never_verified_as_stock(self):
        for entry in ("Electron.app/Contents", "Electron.app/Contents/MacOS/Electron"):
            for bit in (stat.S_ISVTX, stat.S_ISUID, stat.S_ISGID):
                with self.subTest(entry=entry, bit=oct(bit)):
                    suffix = "-" + entry.replace("/", "-") + "-" + str(bit)
                    dist = runtime(self.linked, suffix)
                    source = self.base / ("cache" + suffix)
                    shutil.copytree(dist, source / "dist", symlinks=True)
                    identity = {"version": "44.10.1", "platform": "darwin", "arch": "arm64", "checksum": "fixture"}
                    (source / "runtime.json").write_text(json.dumps({"identity": identity,
                        "files": cleanup.content_inventory(source / "dist")}))
                    target = dist / entry
                    mode = stat.S_IMODE(target.stat().st_mode) | bit
                    target.chmod(mode)
                    self.assertEqual(stat.S_IMODE(target.stat().st_mode), mode)
                    with self.assertRaises(cleanup.Unsafe):
                        cleanup.verified_source(dist, {"cache": str(source), "identity": identity}, "44.10.1", "arm64")
                    self.assertEqual(stat.S_IMODE(target.stat().st_mode), mode)


    @unittest.skipUnless(sys.platform == "darwin", "macOS runtime preparation")
    def test_cache_root_follows_configured_home_or_explicit_override(self):
        subprocess.run(["node", "--test", str(SKILL / "tests/prepare-runtime-cache-root.test.mjs")],
            check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    def test_clean_preserves_runtime_changes_against_verified_artifact(self):
        for mutation in ("bytes", "mode", "link", "root-mode", "none"):
            with self.subTest(mutation=mutation):
                dist = runtime(self.linked, "-clean-" + mutation)
                cache_root = self.base / ("cache-clean-" + mutation)
                shutil.copytree(dist, cache_root / "dist", symlinks=True)
                identity = {"version": "44.10.1", "platform": "darwin", "arch": "arm64", "checksum": "fixture"}
                (cache_root / "runtime.json").write_text(json.dumps({"identity": identity,
                    "files": cleanup.content_inventory(cache_root / "dist")}))
                binary = dist / "Electron.app/Contents/MacOS/Electron"
                if mutation == "bytes":
                    binary.write_bytes(b"operator's modified runtime")
                elif mutation == "mode":
                    binary.chmod(0o700)
                elif mutation == "link":
                    (dist / "Electron.app/Contents/custom-link").symlink_to("MacOS/Electron")
                elif mutation == "root-mode":
                    dist.chmod((dist.stat().st_mode & 0o777) ^ 0o010)
                inode, contents = binary.stat().st_ino, binary.read_bytes()
                report = self.audit()
                report["candidates"] = [item for item in report["candidates"] if item["path"] == str(dist)]
                # Exercise the actual verification logic with a controlled
                # checksum-verified-artifact boundary; no downloads are needed.
                with mock.patch.object(cleanup, "prepare_runtime", return_value={"cache": str(cache_root), "identity": identity}), \
                        mock.patch.object(cleanup, "runtime_arch", return_value="arm64"):
                    result = cleanup.clean(report, snapshot_fn=lambda: IDLE, metadata=private)
                if mutation == "none":
                    self.assertFalse(dist.exists())
                    self.assertEqual([item["path"] for item in result["removed"]], [str(dist)])
                else:
                    self.assertTrue(dist.exists())
                    self.assertEqual(result["removed"], [])
                    self.assertEqual(binary.stat().st_ino, inode)
                    self.assertEqual(binary.read_bytes(), contents)

    def test_clean_preserves_runtime_if_verification_fails_or_activity_starts(self):
        for outcome in ("preparation_failure", "new_activity"):
            with self.subTest(outcome=outcome):
                dist = runtime(self.linked, "-" + outcome)
                cache_root = self.base / ("cache-" + outcome)
                shutil.copytree(dist, cache_root / "dist", symlinks=True)
                identity = {"version": "44.10.1", "platform": "darwin", "arch": "arm64", "checksum": "fixture"}
                (cache_root / "runtime.json").write_text(json.dumps({"identity": identity,
                    "files": cleanup.content_inventory(cache_root / "dist")}))
                active = False
                def prepare(_package, _arch):
                    nonlocal active
                    if outcome == "preparation_failure":
                        raise subprocess.CalledProcessError(1, "fixture-prepare")
                    active = True
                    return {"cache": str(cache_root), "identity": identity}
                def snapshot():
                    return ([(123, str(self.linked))], []) if active else IDLE
                report = self.audit()
                report["candidates"] = [item for item in report["candidates"] if item["path"] == str(dist)]
                with mock.patch.object(cleanup, "prepare_runtime", side_effect=prepare), \
                        mock.patch.object(cleanup, "runtime_arch", return_value="arm64"):
                    result = cleanup.clean(report, snapshot_fn=snapshot, metadata=private)
                self.assertEqual(result["removed"], [])
                self.assertTrue(dist.exists())

    @unittest.skipUnless(sys.platform == "darwin", "macOS APFS sharing oracle")
    def test_sharing_preserves_modified_runtime_root_mode(self):
        dist = runtime(self.linked)
        cache_root = self.base / "cache-root-mode"
        shutil.copytree(dist, cache_root / "dist", symlinks=True)
        identity = {"version": "44.10.1", "platform": "darwin", "arch": "arm64", "checksum": "fixture"}
        (cache_root / "runtime.json").write_text(json.dumps({"identity": identity,
            "files": cleanup.content_inventory(cache_root / "dist")}))
        changed_mode = (dist.stat().st_mode & 0o777) ^ 0o010
        dist.chmod(changed_mode)
        report = cleanup.audit(self.project, IDLE, for_sharing=True)
        result = cleanup.share(report, snapshot_fn=lambda: IDLE,
            prepare_fn=lambda _package, _arch: {"cache": str(cache_root), "identity": identity},
            arch_fn=lambda _path: "arm64")
        self.assertEqual(result["shared"], [])
        self.assertEqual(dist.stat().st_mode & 0o777, changed_mode)

    def test_sharing_rejects_content_that_differs_from_pinned_artifact(self):
        dist = runtime(self.linked)
        cache_root = self.base / "runtime-cache"
        shutil.copytree(dist, cache_root / "dist", symlinks=True)
        identity = {"version": "44.10.1", "platform": "darwin", "arch": "arm64", "checksum": "fixture"}
        (cache_root / "runtime.json").write_text(json.dumps({"identity": identity,
            "files": cleanup.content_inventory(cache_root / "dist")}))
        unique = dist / "Electron.app/Contents/unique-user-data"
        unique.write_text("preserve")
        report = cleanup.audit(self.project, IDLE, for_sharing=True)
        result = cleanup.share(report, snapshot_fn=lambda: IDLE,
            prepare_fn=lambda _package, _arch: {"cache": str(cache_root), "identity": identity},
            arch_fn=lambda _path: "arm64")
        self.assertEqual(result["shared"], [])
        self.assertIn("differs", result["preserved"][0]["reason"])
        self.assertEqual(unique.read_text(), "preserve")

    def test_current_process_activity_preserves_the_entire_worktree(self):
        target = cache(self.linked)
        report = self.audit(snapshot=([(123, str(self.linked))], []))
        self.assertEqual(report["candidates"], [])
        self.assertEqual(report["worktrees"][1]["status"], "active")
        self.assertTrue(target.exists())

    def test_stale_and_tampered_plans_do_not_delete_replacements_or_other_paths(self):
        target = cache(self.linked)
        report = self.audit()
        (target / "later").write_text("new data")
        self.assertEqual(self.clean(report)["removed"], [])
        self.assertTrue(target.exists())
        fresh = self.audit()
        fresh["candidates"][0]["path"] = str(self.project)
        self.assertEqual(self.clean(fresh)["removed"], [])
        self.assertTrue((self.project / "source.txt").exists())

    def test_symlink_escapes_and_tracked_cache_files_are_preserved(self):
        outside = self.base / "outside"
        outside.mkdir()
        (outside / "unique").write_text("keep")
        target = self.linked / "node_modules/.vitest-cache"
        target.parent.mkdir()
        target.symlink_to(outside, target_is_directory=True)
        self.assertEqual(self.audit()["candidates"], [])
        self.assertEqual((outside / "unique").read_text(), "keep")
        target.unlink()
        cache(self.linked)
        git(self.linked, "add", "--force", "node_modules/.vitest-cache/entry")
        self.assertEqual(self.audit()["candidates"], [])

    def test_racing_activity_restores_the_quarantined_directory(self):
        target = cache(self.linked)
        report = self.audit()
        snapshots = iter([IDLE, IDLE, ([(123, str(self.linked))], [])])
        result = self.clean(report, snapshot_fn=lambda: next(snapshots))
        self.assertEqual(result["removed"], [])
        self.assertTrue((target / "entry").exists())
        self.assertEqual(list(target.parent.glob(".cache-cleanup-*")), [])

    def test_installer_lock_and_unknown_or_modified_bundle_are_preserved(self):
        dist = runtime(self.linked)
        lock = dist.parent / ".pwragent-runtime-lock"
        lock.mkdir()
        self.assertEqual(self.audit()["candidates"], [])
        lock.rmdir()
        (dist / "unique.txt").write_text("keep")
        self.assertEqual(self.audit()["candidates"], [])

    def test_missing_metadata_fails_closed(self):
        cache(self.linked)
        def unavailable(_path):
            raise OSError("APFS metadata unavailable")
        self.assertEqual(self.audit(unavailable)["candidates"], [])

    def test_worktree_path_prefixes_do_not_imply_process_ownership(self):
        self.assertEqual(cleanup.active_pids(self.linked, ([(123, str(self.linked) + "-other")], [])), [])

    @unittest.skipUnless(sys.platform == "darwin", "macOS APFS oracle")
    def test_actual_apfs_clone_is_preserved_and_private_runtime_removed(self):
        original = runtime(self.linked)
        shared = original.parent.parent.parent.parent / "electron@44.10.1-shared/node_modules/electron"
        shared.mkdir(parents=True)
        (shared / "package.json").write_text((original.parent / "package.json").read_text())
        subprocess.run(["/bin/cp", "-cRpP", str(original), str(shared / "dist")], check=True)
        original_file = original / "Electron.app/Contents/MacOS/Electron"
        clone_file = shared / "dist/Electron.app/Contents/MacOS/Electron"
        self.assertNotEqual(original_file.stat().st_ino, clone_file.stat().st_ino)
        self.assertEqual(original_file.read_bytes(), clone_file.read_bytes())
        original_attrs, clone_attrs = cleanup.apfs_metadata(original_file), cleanup.apfs_metadata(clone_file)
        self.assertEqual(original_attrs["clone_id"], clone_attrs["clone_id"])
        self.assertEqual(clone_attrs["private_bytes"], 0)
        self.assertTrue(clone_attrs["sharing_flags"] & cleanup.SHARING_FLAGS)
        # Both clone participants must survive, including the original inode.
        report = self.audit(cleanup.apfs_metadata)
        self.assertEqual(report["candidates"], [])
        self.assertEqual(len(report["preserved"]), 2)
        independent = runtime(self.project)
        report = self.audit(cleanup.apfs_metadata)
        self.assertEqual(len(report["candidates"]), 1)
        self.clean(report, metadata=cleanup.apfs_metadata)
        self.assertFalse(independent.exists())
        self.assertTrue(original.exists())
        self.assertTrue((shared / "dist").exists())

    @unittest.skipUnless(sys.platform == "darwin", "macOS process oracle")
    def test_actual_live_process_cwd_is_detected(self):
        target = cache(self.linked)
        child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"], cwd=self.linked)
        try:
            report = cleanup.audit(self.project)
            self.assertEqual(report["candidates"], [])
            self.assertTrue(target.exists())
        finally:
            child.terminate()
            child.wait(timeout=5)


if __name__ == "__main__":
    unittest.main()
