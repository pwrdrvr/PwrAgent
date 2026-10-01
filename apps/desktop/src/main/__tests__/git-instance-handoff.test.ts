import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { exportGitHandoff, importGitHandoff } from "../app-server/git-instance-handoff";

const execute = promisify(execFile);
const roots: string[] = [];
async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execute("git", ["-C", cwd, ...args], { encoding: "utf8" })).stdout;
}
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-instance-handoff-"));
  roots.push(root);
  const source = path.join(root, "source");
  const receiver = path.join(root, "receiver");
  const staging = path.join(root, "staging");
  await mkdir(source);
  await mkdir(staging);
  await git(source, "init", "-b", "main");
  await git(source, "config", "user.email", "test@example.invalid");
  await git(source, "config", "user.name", "Fixture");
  await git(source, "config", "core.autocrlf", "false");
  await writeFile(path.join(source, "both.txt"), "base\n");
  await writeFile(path.join(source, "deleted.txt"), "remove\n");
  await writeFile(path.join(source, ".gitignore"), "ignored.txt\n");
  await git(source, "add", ".");
  await git(source, "commit", "-m", "base");
  await git(root, "clone", source, receiver);
  await git(source, "switch", "-c", "feature/windows-tests");
  await writeFile(path.join(source, "commit.txt"), "unpublished\n");
  await git(source, "add", "commit.txt");
  await git(source, "commit", "-m", "unpublished");
  return { root, source, receiver, staging };
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("carries unpublished commits and distinct index/working layers without altering either checkout", async () => {
  const { source, receiver, staging, root } = await fixture();
  await writeFile(path.join(source, "both.txt"), "staged\n");
  await git(source, "add", "both.txt");
  await writeFile(path.join(source, "both.txt"), "working\r\n");
  await rm(path.join(source, "deleted.txt"));
  await writeFile(path.join(source, "binary.bin"), Buffer.from([0, 255, 13, 10, 42]));
  await writeFile(path.join(source, "ignored.txt"), "not transferred");
  await writeFile(path.join(receiver, "both.txt"), "receiver changes\n");
  const sourceStatus = await git(source, "status", "--porcelain=v1", "-z");
  const sourceIndex = await git(source, "ls-files", "--stage", "-z");
  const sourceHead = await git(source, "rev-parse", "HEAD");
  const receiverHead = await git(receiver, "rev-parse", "HEAD");
  const snapshot = await exportGitHandoff(source, staging);
  const bundlePath = path.join(root, "incoming.bundle");
  await writeFile(bundlePath, Buffer.from(snapshot.bundleBase64, "base64"));
  const worktree = path.join(root, "handoff");
  const rollback = await importGitHandoff({ repository: receiver, worktree, bundlePath, snapshot });
  expect(await git(worktree, "rev-parse", "HEAD")).toBe(sourceHead);
  expect(await git(worktree, "ls-files", "--stage", "-z")).toBe(sourceIndex);
  expect(await readFile(path.join(worktree, "both.txt"), "utf8")).toBe("working\r\n");
  expect(await git(worktree, "show", ":both.txt")).toBe("staged\n");
  expect(await readFile(path.join(worktree, "binary.bin"))).toEqual(Buffer.from([0, 255, 13, 10, 42]));
  expect(await readFile(path.join(worktree, "commit.txt"), "utf8")).toBe("unpublished\n");
  await expect(readFile(path.join(worktree, "deleted.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(path.join(worktree, "ignored.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await git(source, "status", "--porcelain=v1", "-z")).toBe(sourceStatus);
  expect(await git(source, "ls-files", "--stage", "-z")).toBe(sourceIndex);
  expect(await git(source, "rev-parse", "HEAD")).toBe(sourceHead);
  expect(await git(source, "for-each-ref", "refs/pwragent/handoffs")).toBe("");
  expect(await git(receiver, "rev-parse", "HEAD")).toBe(receiverHead);
  expect(await readFile(path.join(receiver, "both.txt"), "utf8")).toBe("receiver changes\n");
  await rollback();
  await expect(readFile(path.join(worktree, "both.txt"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("rejects a tampered file and removes the partially created worktree", async () => {
  const { source, receiver, staging, root } = await fixture();
  const snapshot = await exportGitHandoff(source, staging);
  snapshot.files[0].dataBase64 = Buffer.from("tampered").toString("base64");
  const bundlePath = path.join(root, "incoming.bundle");
  await writeFile(bundlePath, Buffer.from(snapshot.bundleBase64, "base64"));
  const worktree = path.join(root, "handoff");
  await expect(importGitHandoff({ repository: receiver, worktree, bundlePath, snapshot })).rejects.toThrow("did not match");
  expect(await git(receiver, "worktree", "list")).not.toContain(worktree);
  expect(await git(receiver, "for-each-ref", "refs/pwragent/handoffs")).toBe("");
});

it("omits shared history from a bundle when the receiver advertises a known commit", async () => {
  const { source, receiver, staging, root } = await fixture();
  const receiverHead = (await git(receiver, "rev-parse", "HEAD")).trim();
  const snapshot = await exportGitHandoff(source, staging, [receiverHead]);
  const bundle = Buffer.from(snapshot.bundleBase64, "base64");
  expect(bundle.subarray(0, 200).toString("utf8")).toContain(`-${receiverHead}`);
  const bundlePath = path.join(root, "incremental.bundle");
  await writeFile(bundlePath, bundle);
  const worktree = path.join(root, "handoff");
  await importGitHandoff({ repository: receiver, worktree, bundlePath, snapshot });
  expect((await git(worktree, "rev-parse", "HEAD")).trim()).toBe(snapshot.head);
  expect(await readFile(path.join(worktree, "commit.txt"), "utf8")).toBe("unpublished\n");
});

it("rejects symlinks and repository escape paths before materializing files", async () => {
  const { source, receiver, staging, root } = await fixture();
  const snapshot = await exportGitHandoff(source, staging);
  snapshot.files[0].path = "../escape.txt";
  await expect(importGitHandoff({ repository: receiver, worktree: path.join(root, "handoff"), bundlePath: "unused", snapshot })).rejects.toThrow("Unsafe");
  await git(source, "update-index", "--add", "--cacheinfo", "120000", snapshot.head, "link");
  await expect(exportGitHandoff(source, staging)).rejects.toThrow("symlinks");
});
