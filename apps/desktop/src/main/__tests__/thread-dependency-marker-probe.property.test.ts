import { execFile } from "node:child_process";
import { once } from "node:events";
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { expect, inject, it, onTestFinished, vi } from "vitest";
import { authorizeLocalFile, readLocalFile } from "../app-server/thread-dependency-local-files";
import { nativeRelayPath } from "../native-relay-path";

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, lstat: vi.fn(fs.lstat), realpath: vi.fn(fs.realpath) };
});

vi.mock("../native-relay-path", () => ({
  nativeRelayPath: vi.fn(() => inject("nativeHelperFixtures").markerProbe!.relay),
}));

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pwragent-marker-")));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  return root;
}

it("does not trust a pathname lookup after the checked directory has been replaced", async () => {
  const root = await fixture();
  onTestFinished(() => {
    vi.mocked(lstat).mockReset();
    vi.mocked(realpath).mockReset();
  });
  const parent = path.join(root, "parent");
  await mkdir(parent);
  const other = path.join(root, "unrelated");
  await writeFile(other, "");
  const unrelatedMetadata = await lstat(other);
  let replaced = false;
  // Model a namespace change immediately after the old path check succeeds.
  vi.mocked(realpath).mockImplementationOnce(async () => {
    replaced = true;
    return parent;
  });
  vi.mocked(lstat).mockImplementationOnce(async () => {
    expect(replaced).toBe(true);
    return unrelatedMetadata;
  });
  expect(await readLocalFile({ path: path.join(parent, "result"), since: 1 })).toBeUndefined();
});

it.each([["slot", "nested"], ["slot/nested", ""]] as const)(
  "keeps the opened directory when %s is replaced before looking up the leaf",
  async (prefix, remainingDirectory) => {
    const root = await fixture();
    const held = path.join(root, prefix);
    const other = path.join(root, "replacement");
    const rest = path.join(remainingDirectory, "résult marker");
    const original = path.join(held, rest);
    const replacement = path.join(other, rest);
    const since = 60_000;
    await mkdir(path.dirname(original), { recursive: true });
    await mkdir(path.dirname(replacement), { recursive: true });
    await writeFile(original, "original");
    await utimes(original, new Date(0), new Date(0));
    await writeFile(replacement, "replacement");
    const marker = await authorizeLocalFile(root, { path: original, since });

    const anchor = path.parse(held).root;
    const lookup = promisify(execFile)(inject("nativeHelperFixtures").markerProbe!.identity!, [
      "--marker-after-open", path.toNamespacedPath(anchor), path.relative(anchor, held), rest,
    ], { timeout: 10_000, windowsHide: true });
    const lines = createInterface({ input: lookup.child.stdout! });
    try {
      // The native harness uses the production walk and waits on stdin
      // after opening the selected directory. No timing guesses are needed.
      const [ready] = await Promise.race([once(lines, "line"), lookup.then(() => [])]);
      expect(ready).toBe("opened");
      await rename(held, path.join(root, "retired"));
      await rename(other, held);
      lookup.child.stdin!.end("x");
      expect((await lookup).stdout.trim().split(/\s+/)).toEqual(["opened", "0"]);
      expect(await readLocalFile(marker)).toBe("result");
      expect(await readFile(original, "utf8")).toBe("replacement");
    } finally {
      lines.close();
      lookup.child.kill();
      await lookup.catch(() => undefined);
    }
  },
);

it("ignores missing, stale and nonregular markers and prefers a fresh result over exit", async () => {
  const root = await fixture();
  const workspace = path.join(root, "work");
  await mkdir(workspace);
  const marker = path.join(workspace, "résult marker");
  const exit = path.join(workspace, "exit");
  const since = 60_000;
  const file = await authorizeLocalFile(workspace, { path: marker, since, exitPath: exit });
  expect(await readLocalFile(file)).toBeUndefined();
  await writeFile(marker, "");
  await utimes(marker, new Date(0), new Date(0));
  expect(await readLocalFile(file)).toBeUndefined();
  await writeFile(exit, "");
  expect(await readLocalFile(file)).toBe("exited");
  await utimes(marker, new Date(since), new Date(since));
  expect(await readLocalFile(file)).toBe("result");

  const directory = path.join(workspace, "directory");
  await mkdir(directory);
  expect(await readLocalFile({ path: directory, since })).toBeUndefined();
  await expect(readLocalFile({ path: path.join(marker, "child"), since })).rejects.toThrow("directory changed");
});

it("rejects a redirected directory and ignores a link at the marker itself", async () => {
  const root = await fixture();
  const workspace = path.join(root, "work");
  const parent = path.join(workspace, "slot");
  const link = path.join(workspace, "link");
  const marker = path.join(parent, "nested", "result");
  await mkdir(path.dirname(marker), { recursive: true });
  const file = await authorizeLocalFile(workspace, { path: marker, since: 1 });
  await rm(parent, { recursive: true });
  expect(await readLocalFile(file)).toBeUndefined();

  // A junction exercises Windows reparse points without symlink privileges.
  const directoryLink = process.platform === "win32" ? "junction" : "dir";
  await symlink(root, parent, directoryLink);
  await symlink(root, link, directoryLink);
  await expect(readLocalFile(file)).rejects.toThrow("directory changed");
  await expect(authorizeLocalFile(workspace, { path: path.join(parent, "result"), since: 1 })).rejects.toThrow("inside");
  await expect(authorizeLocalFile(workspace, { path: path.join(root, "outside"), since: 1 })).rejects.toThrow("inside");
  expect(await readLocalFile({ path: link, since: 1 })).toBeUndefined();
});

it.skipIf(process.platform === "win32")("ignores a symlink to a fresh regular marker", async () => {
  const root = await fixture();
  const target = path.join(root, "target");
  const link = path.join(root, "link");
  await writeFile(target, "");
  await symlink(target, link);
  expect(await readLocalFile({ path: link, since: 1 })).toBeUndefined();
});

it("treats an unavailable native probe as an inspection error", async () => {
  const root = await fixture();
  const marker = path.join(root, "result");
  await writeFile(marker, "");
  vi.mocked(nativeRelayPath).mockReturnValueOnce(path.join(root, "missing-helper"));
  await expect(readLocalFile({ path: marker, since: 1 })).rejects.toThrow("metadata could not be verified");
});

it.runIf(process.platform === "win32")("rejects drive-relative marker paths", async () => {
  await expect(readLocalFile({ path: "C:result", since: 1 })).rejects.toThrow("path is unsafe");
});
