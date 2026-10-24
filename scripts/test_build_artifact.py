"""No release HTTP fallback, exact release-build provenance, verified ZIP members."""
import hashlib
import importlib.util
import subprocess
import tempfile
import unittest
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("artifact", ROOT / "scripts/build-artifact.py")
artifact = importlib.util.module_from_spec(spec)
spec.loader.exec_module(artifact)


class BuildArtifactTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.target = Path(self.temp.name) / "installer.dmg"
        self.payload = b"signed installer"
        self.sha = hashlib.sha256(self.payload).hexdigest()
        self.commit = "a" * 40
        self.run = dict(id=10, head_sha=self.commit, conclusion="success", event="push",
                        path=".github/workflows/release.yml", head_branch="v1.2.3",
                        head_repository=dict(full_name="pwrdrvr/PwrSnap"))
        self.archive = dict(id=20, name="desktop-release-macos-artifacts", expired=False)
        self.url = "https://github.com/pwrdrvr/PwrSnap/releases/download/v1.2.3/PwrSnap-1.2.3-universal.dmg"
        self.calls = []

    def read(self, endpoint):
        self.calls.append(endpoint)
        self.assertNotIn("releases/download", endpoint)
        self.assertNotIn("releases/assets", endpoint)
        if "/git/ref/" in endpoint:
            return dict(object=dict(type="commit", sha=self.commit))
        if "/workflows/" in endpoint:
            return dict(workflow_runs=[self.run])
        return dict(artifacts=[self.archive])

    def download(self, repo, selected, target):
        self.assertEqual(selected["id"], 20)
        with zipfile.ZipFile(target, "w") as bundle:
            bundle.writestr("dist/PwrSnap-1.2.3-universal.dmg", self.payload)

    def acquire(self):
        return artifact.acquire(self.url, self.sha, len(self.payload), self.target, self.read, self.download)

    def test_cold_build_artifact_then_warm_cache_has_no_network(self):
        self.assertEqual(self.acquire(), "build-artifact")
        self.assertEqual(self.target.read_bytes(), self.payload)
        count = len(self.calls)
        self.assertEqual(self.acquire(), "restored")
        self.assertEqual(len(self.calls), count)

    def test_untrusted_failed_wrong_commit_workflow_or_branch_cannot_supply_bytes(self):
        for key, value in [("event", "pull_request"), ("conclusion", "failure"),
                           ("head_sha", "b" * 40), ("path", ".github/workflows/preview-build.yml"),
                           ("head_branch", "main"), ("head_repository", dict(full_name="attacker/fork"))]:
            with self.subTest(key=key):
                original = self.run[key]
                self.run[key] = value
                with self.assertRaisesRegex(ValueError, "fallback is prohibited"):
                    self.acquire()
                self.run[key] = original
        self.assertFalse(self.target.exists())

    def test_expired_missing_artifacts_and_corrupt_cache_fail_closed(self):
        self.archive["expired"] = True
        with self.assertRaisesRegex(ValueError, "fallback is prohibited"):
            self.acquire()
        self.target.write_bytes(b"bad")
        with self.assertRaisesRegex(ValueError, "digest/size mismatch"):
            self.acquire()

    def test_wrong_bytes_duplicate_and_traversal_members_never_promote(self):
        archive = self.target.with_suffix(".zip")
        name = "PwrSnap-1.2.3-universal.dmg"
        for members in [{name: b"wrong installer!"}, {name: self.payload, "dist/" + name: self.payload},
                        {"../" + name: self.payload}]:
            with self.subTest(members=list(members)):
                with zipfile.ZipFile(archive, "w") as bundle:
                    for path, content in members.items():
                        bundle.writestr(path, content)
                with self.assertRaises(ValueError):
                    artifact.extract(archive, name, self.target, self.sha, len(self.payload))

    def test_annotated_tag_and_moved_tag(self):
        def annotated(endpoint):
            if "/git/ref/" in endpoint:
                return dict(object=dict(type="tag", sha="b" * 40))
            return dict(object=dict(type="commit", sha=self.commit))
        self.assertEqual(artifact.tag_commit("pwrdrvr/PwrSnap", "v1.2.3", annotated), self.commit)
        def moved(repo, selected, target):
            self.download(repo, selected, target)
            self.commit = "c" * 40
        with self.assertRaisesRegex(ValueError, "tag changed"):
            artifact.acquire(self.url, self.sha, len(self.payload), self.target, self.read, moved)
        self.assertFalse(self.target.exists())

    def test_windows_checksum_rename_is_verified(self):
        archive = self.target.with_suffix(".zip")
        with zipfile.ZipFile(archive, "w") as bundle:
            bundle.writestr("SHA256SUMS", self.payload)
        artifact.extract(archive, "PwrAgent-windows-SHA256SUMS", self.target, self.sha, len(self.payload))
        self.assertEqual(self.target.read_bytes(), self.payload)

    def test_homebrew_curl_guard_blocks_release_and_release_asset_api(self):
        for url in [self.url, "https://api.github.com/repos/pwrdrvr/PwrSnap/releases/assets/123"]:
            result = subprocess.run([str(ROOT / "scripts/ci-curl.py"), "-L", url], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("blocked in CI", result.stderr)
