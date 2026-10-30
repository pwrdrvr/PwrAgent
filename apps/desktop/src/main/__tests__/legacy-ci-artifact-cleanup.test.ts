import { mkdir, mkdtemp, readFile, readdir, rm, symlink, truncate, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupLegacyCiArtifacts } from "../pr-status/legacy-ci-artifact-cleanup";

const day = 24 * 60 * 60 * 1000;
const now = Date.UTC(2026, 10, 1);

describe("retired CI artifact store cleanup", () => {
  let directory: string;
  let root: string;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "pwragent-legacy-ci-"));
    root = path.join(directory, "artifacts", "ci");
    await mkdir(root, { recursive: true });
  });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  async function file(bucket: string, name: string, age: number, size = 8) {
    const parent = path.join(root, bucket);
    await mkdir(parent, { recursive: true });
    const target = path.join(parent, name);
    await writeFile(target, "retained");
    await truncate(target, size);
    await utimes(target, new Date(now - age), new Date(now - age));
    return target;
  }

  it("expires seven-day legacy ZIPs and abandoned partials without scanning project data", async () => {
    await file("download-aaaaaa", "artifact.zip", 8 * day);
    await file("download-bbbbbb", "artifact.zip.partial", 8 * day);
    const recent = await file("download-cccccc", "artifact.zip", day);
    const project = path.join(directory, "project");
    await mkdir(project);
    await writeFile(path.join(project, "artifact.zip"), "project-owned");
    expect(await cleanupLegacyCiArtifacts(root, now)).toEqual({ removedFiles: 2, removedBytes: 16 });
    expect(await readdir(root)).toEqual(["download-cccccc"]);
    expect(await readFile(recent, "utf8")).toBe("retained");
    expect(await readFile(path.join(project, "artifact.zip"), "utf8")).toBe("project-owned");
  });

  it("trims old completed archives to 512 MiB before their age expiry", async () => {
    await file("download-aaaaaa", "artifact.zip", 3 * day, 300 * 1024 * 1024);
    await file("download-bbbbbb", "artifact.zip", 2 * day, 300 * 1024 * 1024);
    expect(await cleanupLegacyCiArtifacts(root, now)).toEqual({ removedFiles: 1, removedBytes: 300 * 1024 * 1024 });
    expect(await readdir(root)).toEqual(["download-bbbbbb"]);
  });

  it("preserves recent files and buckets with an active partial or unexpected contents", async () => {
    await file("download-aaaaaa", "artifact.zip", 10 * day);
    await file("download-aaaaaa", "artifact.zip.partial", 60_000);
    await file("download-bbbbbb", "artifact.zip", 10 * day);
    await file("download-bbbbbb", "notes.txt", 10 * day);
    await file("user-folder", "artifact.zip", 10 * day);
    await file("download-cccccc", "artifact.zip", 60_000, 600 * 1024 * 1024);
    const publishing = path.join(root, "download-dddddd");
    await mkdir(publishing);
    await utimes(publishing, new Date(now - 60_000), new Date(now - 60_000));
    expect(await cleanupLegacyCiArtifacts(root, now)).toEqual({ removedFiles: 0, removedBytes: 0 });
    expect(await readdir(root)).toHaveLength(5);
  });

  it("does not follow directory symlinks or junctions", async () => {
    const outside = path.join(directory, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "artifact.zip"), "outside data");
    await symlink(outside, path.join(root, "download-aaaaaa"), "junction");
    expect(await cleanupLegacyCiArtifacts(root, now)).toEqual({ removedFiles: 0, removedBytes: 0 });
    expect(await readFile(path.join(outside, "artifact.zip"), "utf8")).toBe("outside data");
    await rm(path.join(directory, "artifacts"), { recursive: true });
    await symlink(outside, path.join(directory, "artifacts"), "junction");
    expect(await cleanupLegacyCiArtifacts(root, now)).toEqual({ removedFiles: 0, removedBytes: 0 });
    expect(await readFile(path.join(outside, "artifact.zip"), "utf8")).toBe("outside data");
  });
});
