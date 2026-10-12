// Run only in a dedicated subprocess: changing umask in a test worker affects
// every concurrent filesystem operation in that process.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, link, lstat, mkdir, readFile, readlink, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import * as tar from "tar";
import { exportWorkspaceArchive, importWorkspaceArchive } from "../../federation/thread-workspace-archive";

const root = process.argv[2]!;
const mask = Number(process.argv[3]);
assert.ok(mask === 0o022 || mask === 0o077);
process.umask(mask);

const source = path.join(root, "permission-source");
const staging = path.join(root, "permission-staging");
const destination = path.join(root, "permission-destination");
await Promise.all([source, staging, destination].map((directory) => mkdir(directory)));

const files = [
  ["run.sh", 0o755],
  ["selective.sh", 0o751],
  ["private.sh", 0o700],
  ["public.txt", 0o644],
  ["group.txt", 0o640],
  ["private.txt", 0o600],
  ["privileged.sh", 0o6755],
] as const;
for (const [name, mode] of files) {
  await writeFile(path.join(source, name), "#!/bin/sh\nprintf 'usable'\n");
  await chmod(path.join(source, name), mode);
  assert.equal((await lstat(path.join(source, name))).mode & 0o7777, mode);
}
await mkdir(path.join(source, "directory"));
await chmod(path.join(source, "directory"), 0o2755);
await writeFile(path.join(source, "directory", "nested.txt"), "nested");
await chmod(path.join(source, "directory", "nested.txt"), 0o644);
await link(path.join(source, "run.sh"), path.join(source, "run-hardlink"));
await symlink("run.sh", path.join(source, "internal-link"));
await symlink("missing-target", path.join(source, "dangling-link"));
await writeFile(path.join(root, "external.txt"), "external bytes");
await symlink("../external.txt", path.join(source, "external-link"));

const archive = await exportWorkspaceArchive(source, staging, "linux");
assert.equal(archive.format, "tar.gz");
assert.ok(archive.warnings.includes("1 symlink(s) were omitted from the workspace archive."));
// Prove the archive carries both privileged bits; checking only the imported
// mode could otherwise pass because the fixture never exercised sanitization.
const headers = new Map<string, number | undefined>();
await tar.t({ file: path.join(staging, "workspace.tar.gz"), onReadEntry: (entry) => {
  headers.set(entry.path.replace(/\/$/, ""), entry.mode);
} });
assert.equal(headers.get("privileged.sh"), 0o6755);
assert.equal(headers.get("directory"), 0o2755);

await importWorkspaceArchive(destination, staging, archive);
assert.equal(await readFile(path.join(destination, "directory", "nested.txt"), "utf8"), "nested");
assert.equal((await lstat(path.join(destination, "directory", "nested.txt"))).mode & 0o7777, mask === 0o077 ? 0o600 : 0o644);
const modes = await Promise.all([
  ...files.map(([name]) => name), "directory", "run-hardlink",
].map(async (name) => (await lstat(path.join(destination, name))).mode & 0o7777));

const run = promisify(execFile);
for (const name of ["run.sh", "selective.sh", "private.sh", "privileged.sh", "internal-link", "run-hardlink"]) {
  const { stdout } = await run(path.join(destination, name));
  assert.equal(stdout, "usable");
}
assert.equal(await readlink(path.join(destination, "internal-link")), "run.sh");
assert.equal(await readlink(path.join(destination, "dangling-link")), "missing-target");
assert.equal((await lstat(path.join(destination, "run-hardlink"))).ino, (await lstat(path.join(destination, "run.sh"))).ino);
await assert.rejects(lstat(path.join(destination, "external-link")), { code: "ENOENT" });
process.stdout.write(JSON.stringify({ modes, executable: true, links: true, externalOmitted: true }));
