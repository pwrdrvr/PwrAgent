import assert from "node:assert/strict";
import { chmodSync } from "node:fs";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { installManagedGit, verifyManagedGitGeneration } from "../../managed-git-runtime";
import { buildRelease, fakeGithub, FIXTURE_BUNDLED_VERSION } from "../helpers/managed-git-fixture";

const [rootDir, mask] = process.argv.slice(2);
assert.ok(rootDir && (mask === "022" || mask === "077"));
const sealedFiles = { "bin/git": 0o755, COPYING: 0o644 };
const release = buildRelease("2.56.0-dev-pwrgit.5", {
  mutate: { payload: (root) => {
    for (const [file, mode] of Object.entries(sealedFiles)) chmodSync(path.join(root, file), mode);
  } },
});
const { fetch, fetchReleases } = fakeGithub([release]);
const options = {
  rootDir,
  platform: "linux" as const,
  arch: "x64",
  bundledVersion: FIXTURE_BUNDLED_VERSION,
  fetch,
  fetchReleases,
  verify: { probe: false },
};

process.umask(Number.parseInt(mask, 8));
const installed = await installManagedGit({ ...options, tag: release.tag });
await verifyManagedGitGeneration(installed.generation, options);
for (const [file, mode] of Object.entries(sealedFiles)) {
  assert.equal((await lstat(path.join(installed.root, file))).mode & 0o7777, mode, file);
}
