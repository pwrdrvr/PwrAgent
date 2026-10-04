import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/resolve_stack.py"
spec = importlib.util.spec_from_file_location("resolver", SCRIPT)
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)
checks = 0


def check(value, label):
    global checks
    assert value, label
    checks += 1


def package(directory, contents, manifest, name="PwrAgent-9.9.9-linux-x64-debug.tar.gz", extra=None):
    contents = {**contents, "manifest.json": json.dumps(manifest).encode()}
    path = directory / name
    with tarfile.open(path, "w:gz") as tar:
        for key, data in contents.items():
            item = tarfile.TarInfo(key)
            item.size = len(data)
            tar.addfile(item, io.BytesIO(data))
        if extra:
            tar.addfile(extra)
    Path(str(path) + ".sha256").write_text(r.digest(path.read_bytes()) + "  " + path.name + "\n")
    return path


def invoke(args):
    stdout, stderr = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
        code = r.main(args)
    return code, json.loads(stdout.getvalue() or stderr.getvalue())


with tempfile.TemporaryDirectory(prefix="pwragent-resolver-test-") as workspace:
    temp = Path(workspace)
    contents, files = {}, []
    for kind, filename in [("main", "index.js"), ("preload", "index.js"), ("renderer/assets", "lazy.js"), ("renderer/workers", "worker.js")]:
        path = f"out/{kind}/{filename}"
        contents[path] = b"abcdefghij\nsecondline\n"
        sm = {"version": 3, "file": filename, "sources": ["../original.ts"],
              "sourcesContent": ["one\ntwo();\nthree();\n"], "names": ["first", "second"],
              "mappings": "AACCA,IAAEC,C;AACFA"}
        # Column0 0 -> original line2 col1; col0 4 -> line2 col3;
        # col0 5 unmapped. Next row name is a delta, not line-reset.
        contents[path + ".map"] = json.dumps(sm).encode()
        files.extend([{"path": path, "bytes": len(contents[path]), "sha256": r.digest(contents[path]), "sourceMap": path + ".map"},
                      {"path": path + ".map", "bytes": len(contents[path + ".map"]), "sha256": r.digest(contents[path + ".map"])}])
    manifest = {"schemaVersion": 1, "version": "9.9.9", "releaseTag": "v9.9.9", "commit": "a" * 40,
                "trackedChanges": False, "builtAt": "2026-10-03T00:00:00Z", "platform": "linux", "arch": "x64",
                "buildHost": {"platform": "linux"}, "tools": {"vite": "7"}, "lockfileSha256": "b" * 64,
                "ci": {"runId": "1", "runAttempt": "1"}, "files": files}
    archive = package(temp, contents, manifest)
    stack = temp / "stack.txt"
    stack.write_text("Error: example\n    at work (file:///opt/app.asar/out/main/index.js:1:5)\nother@file:///app.asar/out/preload/index.js:1:1\nat file:///out/renderer/workers/worker.js:1:5\nat lazy.js:1:5\nat node:internal/process/task_queues:1:1\nat Object.fn (native)\n")
    base = ["--version", "9.9.9", "--platform", "linux", "--arch", "x64", "--archive", str(archive), "--stack", str(stack), "--json"]
    code, result = invoke(base)
    check(code == 0 and sum(f["status"] == "mapped" for f in result["frames"]) == 4, "main/preload/worker/lazy map without checkout")
    check(result["frames"][1]["source"]["column"] == 4 and result["frames"][1]["source"]["function"] == "second", "browser column converted once at boundary")
    check(result["frames"][1]["generated"]["sourceMapColumn0"] == 4, "generated zero-based column explicit")
    stack.write_text("at lazy.js:1:4")
    _, before_boundary = invoke(base)
    check(before_boundary["frames"][0]["source"]["function"] == "first", "browser column just before mapping boundary uses preceding segment")
    stack.write_text("at lazy.js:2:1")
    _, second_line = invoke(base)
    check(second_line["frames"][0]["source"]["line"] == 3 and second_line["frames"][0]["source"]["column"] == 2
          and second_line["frames"][0]["source"]["function"] == "second", "source and name deltas carry across generated lines")
    stack.write_text("Error: example\n    at work (file:///opt/app.asar/out/main/index.js:1:5)\nother@file:///app.asar/out/preload/index.js:1:1\nat file:///out/renderer/workers/worker.js:1:5\nat lazy.js:1:5\nat node:internal/process/task_queues:1:1\nat Object.fn (native)\n")
    check(result["frames"][1]["installedVerification"] == "unavailable" and "unverified" in result["frames"][1]["mappingConfidence"], "archive validation separate from installed match")
    check(result["frames"][0]["original"] == "Error: example" and result["frames"][-1]["status"] == "unmapped", "raw/native frames preserved")
    hashes = temp / "hashes.json"
    hashes.write_text(json.dumps({f["path"]: {"sha256": f["sha256"], "bytes": f["bytes"]} for f in files if f["path"].endswith(".js")}))
    code, result = invoke(base + ["--hashes", str(hashes)])
    check(code == 0 and result["frames"][1]["installedVerification"] == "sha256-and-size-match", "installed digest and size match")
    check(result['frames'][1]['mappingConfidence'] == 'installed-hash-match (operator-supplied)', "operator hash origin explicit in confidence label")
    installed = temp / "original.js"
    installed.write_bytes(contents["out/main/index.js"])
    code, result = invoke(base + ["--installed-file", "out/main/index.js=" + str(installed)])
    check(result["frames"][1]["installedVerification"] == "sha256-and-size-match", "direct installed bytes are hashed")
    check(result['frames'][1]['mappingConfidence'] == 'installed-bytes-sha256-and-size-match', "direct-byte origin explicit in confidence label")
    conflicting = temp / "conflicting.js"
    conflicting.write_bytes(b"z" + contents["out/main/index.js"][1:])
    root = temp / "installed-root"
    root_file = root / "out/main/index.js"
    root_file.parent.mkdir(parents=True)
    root_file.write_bytes(conflicting.read_bytes())
    code, result = invoke(base + ["--installed-root", str(root), "--installed-file", "out/main/index.js=" + str(installed)])
    check(code == 2 and "Conflicting installed evidence" in result["error"], "mismatching root cannot be overridden by a matching explicit file")
    root_file.write_bytes(installed.read_bytes())
    code, result = invoke(base + ["--installed-root", str(root), "--installed-file", "out/main/index.js=" + str(conflicting)])
    check(code == 2 and "Conflicting installed evidence" in result["error"], "matching root rejects conflicting explicit file")
    for first, second in [(conflicting, installed), (installed, conflicting)]:
        code, result = invoke(base + ["--installed-file", "out/main/index.js=" + str(first), "--installed-file", "out/main/index.js=" + str(second)])
        check(code == 2 and "Conflicting installed evidence" in result["error"], "conflicting repeated file inputs rejected regardless of order")
    identical = temp / "identical.js"
    identical.write_bytes(installed.read_bytes())
    code, result = invoke(base + ["--installed-file", "out/main/index.js=" + str(installed), "--installed-file", "out/main/index.js=" + str(identical)])
    check(code == 0 and result["frames"][1]["installedVerification"] == "sha256-and-size-match", "identical repeated file inputs remain accepted")
    code, result = invoke(base + ["--installed-root", str(root), "--installed-file", "out/main/index.js=" + str(identical)])
    check(code == 0 and result["frames"][1]["installedVerification"] == "sha256-and-size-match", "consistent root and explicit file remain accepted")
    code, result = invoke(base + ["--hashes", str(hashes), "--installed-root", str(root), "--installed-file", "out/main/index.js=" + str(identical)])
    check(code == 0 and result["frames"][1]["mappingConfidence"] == "installed-bytes-sha256-and-size-match", "consistent operator hash and all direct files remain accepted")
    code, result = invoke(base + ["--hashes", str(hashes), "--installed-file", "out/main/index.js=" + str(conflicting), "--installed-file", "out/main/index.js=" + str(installed)])
    check(code == 2 and "Conflicting installed evidence" in result["error"], "matching final file cannot hide earlier conflict with operator hash")
    installed.write_bytes(b"wrong byte content")
    code, result = invoke(base + ["--installed-file", "out/main/index.js=" + str(installed)])
    check(result["frames"][1]["status"] == "unmapped" and result["frames"][1]["installedVerification"] == "mismatch", "wrong installed bytes refuse mapping")
    values = json.loads(hashes.read_text())
    values["out/main/index.js"]["bytes"] += 1
    hashes.write_text(json.dumps(values))
    code, result = invoke(base + ["--hashes", str(hashes)])
    check(result["frames"][1]["installedVerification"] == "mismatch", "wrong installed size refuses mapping")
    stack.write_text("at lazy.js:1:5")
    _, browser = invoke(base)
    stack.write_text("at lazy.js:1:4")
    _, zero = invoke(base + ["--column-base", "0"])
    check(browser["frames"][0]["source"] == zero["frames"][0]["source"], "equivalent explicit zero-based input maps identically")
    stack.write_text("at lazy.js:1:0")
    check(invoke(base)[0] == 3, "invalid browser column zero rejected")
    stack.write_text("at lazy.js:1:6")
    check(invoke(base)[0] == 3, "unmapped segment cancels preceding mapping")
    stack.write_text("at lazy.js:1:99")
    check(invoke(base)[0] == 3, "out-of-range generated column rejected")
    stack.write_text("at lazy.js:1")
    check("Missing generated column" in invoke(base)[1]["frames"][0]["reason"], "missing column asks exact input")
    stack.write_text("at file:///app.asar/out/main/not-here.js:1:1")
    check("not in archive" in invoke(base)[1]["frames"][0]["reason"], "missing chunk explicit")
    stack.write_text("at index.js:1:1")
    check("Ambiguous" in invoke(base)[1]["frames"][0]["reason"], "same basename across main/preload not silently selected")
    stack.write_text("at C:\\Program Files\\App\\app.asar\\out\\main\\index.js:1:1")
    check(invoke(base)[0] == 0, "Windows path with spaces and drive colon parsed")
    stack.write_text("fn@file:///App%20Name/app.asar/out/main/index.js:1:1")
    check(invoke(base)[0] == 0, "Firefox percent-encoded URL parsed")
    check(invoke(base[2:])[0] == 2, "missing version surfaced")
    check(invoke(["--version", "9.9.8"] + base[2:])[0] == 2, "wrong version refused")
    check(invoke(base + ["--commit", "c" * 40])[0] == 2, "wrong commit refused")
    check(invoke(base + ["--platform", "darwin", "--arch", "arm64"])[0] == 2, "wrong target refused")
    check(invoke(["--version", "9.9.9", "--stack", str(stack), "--json"])[0] == 2, "missing target surfaced before acquisition")
    subset = {**manifest, "scope": "Renderer subset", "files": [f for f in files if "/renderer/" in f["path"]]}
    subset.pop("arch")
    subset_path = package(temp, {p: d for p, d in contents.items() if "/renderer/" in p}, subset, "subset.tar.gz")
    stack.write_text("at lazy.js:1:1")
    subset_args = ["--version", "9.9.9", "--platform", "linux", "--arch", "x64", "--archive", str(subset_path), "--stack", str(stack), "--json"]
    check(invoke(subset_args)[0] == 2, "subset not accepted as full release")
    check(invoke(subset_args + ["--local-subset"])[0] == 3, "local backfill without installed hash does not map")
    hashes.write_text(json.dumps({"out/renderer/assets/lazy.js": r.digest(contents["out/renderer/assets/lazy.js"])}))
    code, result = invoke(subset_args + ["--local-subset", "--hashes", str(hashes)])
    check(code == 0 and result["provenance"]["arch"] == "unspecified-local-subset", "subset mapped with installed hash and arch uncertainty retained")
    bad = {**manifest, "files": [dict(f) for f in files]}
    bad["files"][0]["sha256"] = "0" * 64
    package(temp, contents, bad)
    check(invoke(base)[0] == 2, "manifest file hash mismatch rejected")
    package(temp, contents, manifest)
    archive.write_bytes(archive.read_bytes() + b"tamper")
    check(invoke(base)[0] == 2, "archive checksum mismatch rejected")
    link = tarfile.TarInfo("out/evil")
    link.type = tarfile.SYMTYPE
    link.linkname = "/tmp/overwrite"
    package(temp, contents, manifest, extra=link)
    check(invoke(base)[0] == 2, "archive symlink rejected")
    traversal = tarfile.TarInfo("../escape")
    package(temp, contents, manifest, extra=traversal)
    check(invoke(base)[0] == 2 and not (temp.parent / "escape").exists(), "traversal rejected with no extraction")
    missing = {**manifest, "files": [f for f in files if f["path"] != "out/main/index.js.map"]}
    package(temp, {p: d for p, d in contents.items() if p != "out/main/index.js.map"}, missing)
    check(invoke(base)[0] == 2, "missing exact map rejected")
    package(temp, {**contents, "unknown.txt": b"unexpected"}, manifest)
    check(invoke(base)[0] == 2, "unlisted full-release payload rejected")
    # package() uses empty extra members; put AppleDouble bytes in normal contents.
    package(temp, {**contents, "out/main/._index.js": b"\x00\x05\x16\x07" + b"\0" * 22}, manifest)
    check(invoke(base)[0] == 0, "paired macOS AppleDouble metadata accepted without extraction")
    package(temp, {**contents, "out/main/._index.js": b"not AppleDouble"}, manifest)
    check(invoke(base)[0] == 2, "unrecognized dot-underscore payload not silently ignored")
    package(temp, contents, {**manifest, "trackedChanges": True})
    check(invoke(base)[0] == 2, "dirty full-release identity rejected")
    empty_contents = dict(contents)
    sm = json.loads(empty_contents['out/main/index.js.map']); sm['mappings'] = ''
    empty_contents['out/main/index.js.map'] = json.dumps(sm).encode()
    empty_manifest = {**manifest, 'files': [dict(f) for f in files]}
    for f in empty_manifest['files']:
        f['bytes'] = len(empty_contents[f['path']]); f['sha256'] = r.digest(empty_contents[f['path']])
    package(temp, empty_contents, empty_manifest)
    check(invoke(base)[0] == 2, "empty source mappings rejected")
    # Deterministic acquisition contract: cached downloads revalidated, no retries.
    package(temp, contents, manifest)
    public_bytes = archive.read_bytes()
    side_bytes = Path(str(archive) + ".sha256").read_bytes()
    assets = [{"id": i, "name": name, "state": "uploaded", "size": len(data), "updated_at": "now", "digest": "sha256:" + r.digest(data),
               "browser_download_url": f"https://github.com/{r.REPO}/releases/download/v9.9.9/{name}"}
              for i, (name, data) in enumerate([(archive.name, public_bytes), (archive.name + ".sha256", side_bytes)])]
    release = {"id": 1, "tag_name": "v9.9.9", "draft": False, "html_url": "https://github.com/pwrdrvr/PwrAgent/releases/tag/v9.9.9", "assets": assets}
    calls = []
    saved_fetch = r.fetch
    def fake_fetch(url, limit, token=None):
        calls.append(url)
        return json.dumps(release).encode() if "/releases/tags/" in url else (side_bytes if url.endswith(".sha256") else public_bytes)
    r.fetch = fake_fetch
    download_args = ["--version", "9.9.9", "--platform", "linux", "--arch", "x64", "--cache", str(temp / "cache"), "--stack", str(stack), "--json"]
    check(invoke(download_args)[0] == 0 and len(calls) == 3, "exact named asset pair acquired once")
    calls.clear()
    check(invoke(download_args)[0] == 0 and len(calls) == 1, "cache avoids redownload and checks metadata")
    check(len(list((temp / "cache").rglob("validated-*.json"))) == 1, "cache records validated commit identity")
    cached = list((temp / "cache").rglob("*.tar.gz"))[0]
    cached.write_bytes(b"bad")
    calls.clear()
    check(invoke(download_args)[0] == 2 and len(calls) == 1, "corrupt cache fails without retry/redownload")
    release["assets"] = []
    calls.clear()
    check(invoke(download_args)[0] == 2 and len(calls) == 1, "authoritative missing assets stop before download")
    release['assets'] = assets + [assets[0]]
    calls.clear()
    check(invoke(download_args)[0] == 2 and len(calls) == 1, "duplicate authoritative assets stop before download")
    r.fetch = saved_fetch

print(f"PASS: {checks} observable resolver checks")
