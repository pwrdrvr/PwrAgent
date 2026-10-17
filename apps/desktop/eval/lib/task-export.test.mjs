import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, lstatSync, readlinkSync, symlinkSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { sanitizer } from "./headless-contract.mjs";

import { stageTaskExports } from "./task-export.mjs";
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0" } });
function fixture() {
  const base = mkdtempSync(path.join(os.tmpdir(), "nested-export-proof-"));
  const source = path.join(base, "task");
  const stage = path.join(base, "stage");
  mkdirSync(source); mkdirSync(stage);
  git(source, "init", "-q");
  const repo = path.join(source, "clone"); mkdirSync(repo);
  git(repo, "init", "-q");
  writeFileSync(path.join(repo, "module.py"), "print('source')\n");
  git(repo, "add", "module.py");
  git(repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture");
  return { base, source, stage, repo };
}

test("real Git nested-repo directory reproduces frozen 088 export failure", () => {
  const f = fixture();
  try {
    const names = git(f.source, "ls-files", "--others", "--exclude-standard", "-z").split("\0").filter(Boolean);
    assert.deepEqual(names, ["clone/"]);
    assert.throws(() => {
      for (const name of names) {
        const info = lstatSync(path.join(f.source, name));
        if (!info.isSymbolicLink() && !info.isFile()) throw new Error("Unsupported artifact file type");
      }
    }, /Unsupported artifact file type/);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test("recursive export archives nested source and safe provenance without copying .git credentials or logs", () => {
  const f = fixture();
  try {
    const secret = "synthetic-credential-never-export";
    writeFileSync(path.join(f.repo, ".git", "secret.log"), secret);
    writeFileSync(path.join(f.repo, "build.log"), `log: ${secret}`);
    writeFileSync(path.join(f.repo, "new.py"), "# untracked source\n");
    const manifest = stageTaskExports(f.source, f.stage, ["clone/"], sanitizer([secret]));
    assert.equal(readFileSync(path.join(f.stage, "clone/module.py"), "utf8"), "print('source')\n");
    assert.equal(readFileSync(path.join(f.stage, "clone/new.py"), "utf8"), "# untracked source\n");
    assert.equal(readFileSync(path.join(f.stage, "clone/build.log"), "utf8"), "log: [REDACTED]");
    assert.ok(!existsSync(path.join(f.stage, "clone/.git")));
    assert.equal(manifest.repositories[0].head, git(f.repo, "rev-parse", "HEAD").trim());
    const archive = path.join(f.base, "untracked.tar.gz");
    execFileSync("tar", ["-C", f.stage, "--null", "-T", "-", "-czf", archive], { input: "clone/\0" });
    const entries = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" });
    assert.match(entries, /clone\/new.py/);
    assert.doesNotMatch(entries, /\.git/);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test("unsafe symlinks are rejected; safe relative links stay inside the artifact", () => {
  const f = fixture();
  try {
    const auth = path.join(f.base, "auth.json"); writeFileSync(auth, "synthetic-secret");
    for (const link of [auth, f.base, path.join(f.repo, "module.py")]) {
      symlinkSync(link, path.join(f.repo, "link"));
      assert.throws(() => stageTaskExports(f.source, f.stage, ["clone/link"], sanitizer()), /Unsafe artifact symlink/);
      rmSync(path.join(f.repo, "link"));
    }
    symlinkSync("module.py", path.join(f.repo, "relative-internal"));
    stageTaskExports(f.source, f.stage, ["clone/"], sanitizer());
    assert.equal(readlinkSync(path.join(f.stage, "clone/relative-internal")), "module.py");
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test("metadata symlinks are excluded without resolving external git state", () => {
  const f = fixture();
  try {
    rmSync(path.join(f.repo, ".git"), { recursive: true, force: true });
    symlinkSync(path.join(f.base, "missing-private-state"), path.join(f.repo, ".git"));
    const manifest = stageTaskExports(f.source, f.stage, ["clone/"], sanitizer());
    assert.equal(manifest.repositories.length, 0);
    assert.equal(manifest.omitted[0].reason, "git-private-state");
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test("export rejects traversal and special files, preserving failure evidence", () => {
  const f = fixture();
  try {
    assert.throws(() => stageTaskExports(f.source, f.stage, ["../auth.json"], sanitizer()), /Unsafe artifact path/);
    execFileSync("mkfifo", [path.join(f.repo, "fifo")]);
    assert.throws(() => stageTaskExports(f.source, f.stage, ["clone/"], sanitizer()), /Unsupported artifact file type/);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test("credential paths, linked parent directories and symlink chains cannot escape staging", () => {
  const f = fixture();
  try {
    for (const name of ["auth.json", ".env", ".netrc", "credentials.json"]) {
      writeFileSync(path.join(f.repo, name), "synthetic-credential");
      assert.throws(() => stageTaskExports(f.source, f.stage, ["clone/" + name], sanitizer()), /credential path/);
    }
    symlinkSync("auth.json", path.join(f.repo, "auth-alias"));
    assert.throws(() => stageTaskExports(f.source, f.stage, ["clone/auth-alias"], sanitizer()), /credential path/);
    symlinkSync(f.base, path.join(f.repo, "outside"));
    symlinkSync("outside", path.join(f.repo, "chain"));
    assert.throws(() => stageTaskExports(f.source, f.stage, ["clone/chain"], sanitizer()), /Unsafe artifact symlink/);
    assert.throws(() => stageTaskExports(f.source, f.stage, ["clone/outside/task/clone/module.py"], sanitizer()), /Unsafe artifact path/);
    symlinkSync(".git/HEAD", path.join(f.repo, "git-alias"));
    assert.throws(() => stageTaskExports(f.source, f.stage, ["clone/git-alias"], sanitizer()), /Git state/);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});
