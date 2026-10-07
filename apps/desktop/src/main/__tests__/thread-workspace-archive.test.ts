import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { zipSync } from "fflate";
import * as tar from "tar";
import { afterEach, expect, it } from "vitest";
import { exportWorkspaceArchive, importWorkspaceArchive } from "../federation/thread-workspace-archive";

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-workspace-archive-"));
  roots.push(root);
  const source = path.join(root, "source");
  const staging = path.join(root, "staging");
  const destination = path.join(root, "destination");
  await Promise.all([source, staging, destination].map((directory) => mkdir(directory)));
  return { root, source, staging, destination };
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it.each(["darwin", "linux", "win32"])("transfers binary files and empty directories to %s using the required archive format", async (platform) => {
  const { source, staging, destination } = await fixture();
  await mkdir(path.join(source, "nested", "empty"), { recursive: true });
  const binary = Buffer.from([0, 255, 128, 13, 10]);
  await writeFile(path.join(source, "nested", "data.bin"), binary);
  const archive = await exportWorkspaceArchive(source, staging, platform);
  expect(archive.format).toBe(process.platform === "win32" || platform === "win32" ? "zip" : "tar.gz");
  await importWorkspaceArchive(destination, staging, archive);
  expect(await readFile(path.join(destination, "nested", "data.bin"))).toEqual(binary);
  expect((await lstat(path.join(destination, "nested", "empty"))).isDirectory()).toBe(true);
});

it("transfers an empty workspace", async () => {
  const { source, staging, destination } = await fixture();
  const archive = await exportWorkspaceArchive(source, staging, process.platform);
  await importWorkspaceArchive(destination, staging, archive);
  expect((await lstat(destination)).isDirectory()).toBe(true);
});

it.skipIf(process.platform === "win32")("preserves executable files and internal tar links while omitting external links", async () => {
  const { root, source, staging, destination } = await fixture();
  await writeFile(path.join(source, "run.sh"), "#!/bin/sh\nexit 0\n");
  await chmod(path.join(source, "run.sh"), 0o755);
  await symlink("run.sh", path.join(source, "internal-link"));
  await symlink("missing-target", path.join(source, "dangling-link"));
  await writeFile(path.join(root, "external.txt"), "private bytes\n");
  await symlink("../external.txt", path.join(source, "external-link"));
  const archive = await exportWorkspaceArchive(source, staging, "linux");
  expect(archive.warnings).toContain("1 symlink(s) were omitted from the workspace archive.");
  await importWorkspaceArchive(destination, staging, archive);
  expect(await readlink(path.join(destination, "internal-link"))).toBe("run.sh");
  expect(await readlink(path.join(destination, "dangling-link"))).toBe("missing-target");
  expect((await lstat(path.join(destination, "run.sh"))).mode & 0o111).toBe(0o111);
  await expect(lstat(path.join(destination, "external-link"))).rejects.toMatchObject({ code: "ENOENT" });
});

it.skipIf(process.platform === "win32")("omits all symlinks and warns when Windows requires ZIP", async () => {
  const { source, staging, destination } = await fixture();
  await writeFile(path.join(source, "data.txt"), "file bytes\n");
  await symlink("data.txt", path.join(source, "link"));
  const archive = await exportWorkspaceArchive(source, staging, "win32");
  expect(archive.warnings).toContain("ZIP workspaces do not transfer symlinks.");
  await importWorkspaceArchive(destination, staging, archive);
  await expect(lstat(path.join(destination, "link"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(path.join(destination, "data.txt"), "utf8")).toBe("file bytes\n");
});

it.each(["../escape.txt", ".git/config", "/absolute.txt"])("rejects unsafe ZIP path %s before extracting", async (file) => {
  const { root, staging, destination } = await fixture();
  const bytes = zipSync({ [file]: Buffer.from("unsafe") });
  await expect(importWorkspaceArchive(destination, staging, { format: "zip", dataBase64: Buffer.from(bytes).toString("base64"), warnings: [] }))
    .rejects.toThrow("Unsafe");
  await expect(lstat(path.join(root, "escape.txt"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("rejects ZIP paths nested under a file before extraction", async () => {
  const { staging, destination } = await fixture();
  const bytes = zipSync({ file: Buffer.from("parent"), "file/child": Buffer.from("child") });
  await expect(importWorkspaceArchive(destination, staging, { format: "zip", dataBase64: Buffer.from(bytes).toString("base64"), warnings: [] }))
    .rejects.toThrow("nested under a file or symlink");
  await expect(lstat(path.join(destination, "file"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("rejects excessive declared ZIP expansion before decompressing", async () => {
  const { staging, destination } = await fixture();
  const bytes = Buffer.from(zipSync({ file: Buffer.from("small") }));
  const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  bytes.writeUInt32LE(129 * 1024 * 1024, central + 24);
  await expect(importWorkspaceArchive(destination, staging, { format: "zip", dataBase64: bytes.toString("base64"), warnings: [] }))
    .rejects.toThrow("expanded workspace exceeds 128 MiB");
});

it.skipIf(process.platform === "win32")("rejects an incoming tar link outside the workspace", async () => {
  const { source, staging, destination } = await fixture();
  await symlink("../external", path.join(source, "link"));
  const file = path.join(staging, "unsafe.tar.gz");
  await tar.c({ cwd: source, file, gzip: true }, ["link"]);
  await expect(importWorkspaceArchive(destination, staging, { format: "tar.gz", dataBase64: (await readFile(file)).toString("base64"), warnings: [] }))
    .rejects.toThrow("Unsafe");
  await expect(lstat(path.join(destination, "link"))).rejects.toMatchObject({ code: "ENOENT" });
});
