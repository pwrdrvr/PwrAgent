import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkReceivingFolder, resolveReceivingFolder } from "../federation/receiving-folder-access";

describe("receiving folder access", () => {
  let directory: string;
  beforeEach(async () => { directory = await fs.mkdtemp(path.join(os.tmpdir(), "pwragent-folder-check-")); });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("resolves the default, trims paths, and rejects relative or invalid paths", () => {
    expect(resolveReceivingFolder("  ", directory)).toBe(directory);
    expect(resolveReceivingFolder(` ${directory} `, "/unused")).toBe(directory);
    expect(() => resolveReceivingFolder("relative", directory)).toThrow("absolute path");
    expect(() => resolveReceivingFolder(`${directory}\0bad`, directory)).toThrow("absolute path");
  });

  it("tests writing and reading, cleans its probe, and preserves existing files", async () => {
    await fs.writeFile(path.join(directory, "keep"), "existing");
    const result = await checkReceivingFolder(directory);
    expect(result.status).toBe("writable");
    expect(result.message).toContain("does not verify OS privacy permission");
    expect(await fs.readdir(directory)).toEqual(["keep"]);
    expect(await fs.readFile(path.join(directory, "keep"), "utf8")).toBe("existing");
  });

  it("does not create missing folders or accept files as folders", async () => {
    const missing = path.join(directory, "missing");
    expect(await checkReceivingFolder(missing)).toMatchObject({ status: "failed", message: expect.stringContaining("ENOENT") });
    await expect(fs.stat(missing)).rejects.toMatchObject({ code: "ENOENT" });
    const file = path.join(directory, "file");
    await fs.writeFile(file, "");
    expect(await checkReceivingFolder(file)).toMatchObject({ status: "failed", message: expect.stringContaining("not a folder") });
  });

  it("reports a denied write as a failed check and keeps privacy state unknown", async () => {
    vi.spyOn(fs, "open").mockRejectedValueOnce(Object.assign(new Error("denied"), { code: "EPERM" }));
    expect(await checkReceivingFolder(directory)).toMatchObject({ status: "failed", message: expect.stringContaining("EPERM") });
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it("cleans its created probe after a read failure", async () => {
    vi.spyOn(fs, "readFile").mockRejectedValueOnce(Object.assign(new Error("denied"), { code: "EACCES" }));
    expect(await checkReceivingFolder(directory)).toMatchObject({ status: "failed", message: expect.stringContaining("EACCES") });
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it("reports the exact leftover probe when cleanup fails", async () => {
    vi.spyOn(fs, "unlink").mockRejectedValue(Object.assign(new Error("denied"), { code: "EPERM" }));
    const result = await checkReceivingFolder(directory);
    expect(result.status).toBe("failed");
    const [probe] = await fs.readdir(directory);
    expect(result.message).toContain(`could not be removed: "${path.join(directory, probe)}"`);
  });
});
