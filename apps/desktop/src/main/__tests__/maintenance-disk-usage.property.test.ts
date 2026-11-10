import { execFile } from "node:child_process";
import { lstat, link, mkdir, mkdtemp, open, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, inject, it } from "vitest";
import { measureMaintenanceAllocation, measureMaintenanceAllocationPaths } from "../app-server/maintenance-disk-usage";

describe.skipIf(process.platform === "win32")("maintenance allocation", () => {
  // Filesystem oracle: allocated blocks, counting each inode once without
  // following symlinks. Logical bytes and snapshot bytes are different values.
  it("matches filesystem allocation for hardlinks and external symlinks", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "maintenance-allocation-"));
    try {
      const checkout = path.join(root, "checkout");
      await mkdir(checkout);
      await writeFile(path.join(root, "outside"), Buffer.alloc(1024 * 1024));
      await writeFile(path.join(checkout, "source"), Buffer.alloc(8192));
      await link(path.join(checkout, "source"), path.join(checkout, "same-inode"));
      await symlink(path.join(root, "outside"), path.join(checkout, "outside-link"));
      const seen = new Set<string>();
      let bytes = 0;
      for (const target of [checkout, ...(await readdir(checkout)).map((name) => path.join(checkout, name))]) {
        const info = await lstat(target);
        const key = `${info.dev}:${info.ino}`;
        if (!seen.has(key)) { bytes += info.blocks * 512; seen.add(key); }
      }
      expect(await measureMaintenanceAllocation(checkout, new AbortController().signal))
        .toEqual({ allocatedBytes: Math.ceil(bytes / 1024) * 1024 });
      const source = await lstat(path.join(checkout, "source"));
      expect(await measureMaintenanceAllocationPaths([path.join(checkout, "source"), path.join(checkout, "same-inode")], new AbortController().signal))
        .toEqual({ allocatedBytes: Math.ceil(source.blocks * 512 / 1024) * 1024 });
      expect(await measureMaintenanceAllocation(path.join(root, "missing"), new AbortController().signal)).toBeUndefined();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe.skipIf(process.platform !== "win32")("Windows maintenance allocation OS oracle", () => {
  const execute = promisify(execFile);
  const signal = () => new AbortController().signal;
  const options = { helperPath: inject("nativeHelperFixtures").maintenanceAllocation!.relay };

  // The OS owns the answer. Known unique files are queried independently;
  // the production walk must match them, across both APIs and overlapping roots.
  it("matches native allocation for resident, ordinary, sparse and compressed files without following junctions", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "maintenance-allocation-"));
    try {
      const checkout = path.join(root, "checkout-雪");
      const nested = path.join(checkout, "nested");
      await mkdir(nested, { recursive: true });
      const files = ["empty", "tiny", "ordinary", "sparse", "compressed"].map((name) => path.join(nested, name));
      await Promise.all([0, 1, 8193, 0, 256 * 1024].map((size, index) => writeFile(files[index]!, Buffer.alloc(size, 42))));
      const system = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32");
      await execute(path.join(system, "fsutil.exe"), ["sparse", "setflag", files[3]!]);
      const sparse = await open(files[3]!, "r+");
      try { await sparse.truncate(16 * 1024 * 1024); } finally { await sparse.close(); }
      await execute(path.join(system, "compact.exe"), ["/C", "/I", "/Q", files[4]!]);
      await link(files[2]!, path.join(checkout, "hardlink"));
      const outside = path.join(root, "outside");
      await mkdir(outside);
      await writeFile(path.join(outside, "external"), Buffer.alloc(1024 * 1024));

      const manifest = path.join(root, "oracle.json");
      await writeFile(manifest, JSON.stringify([...files, checkout, nested]));
      const oracle = fileURLToPath(new URL("./fixtures/windows-allocation-oracle.ps1", import.meta.url));
      const { stdout } = await execute(path.join(system, "WindowsPowerShell/v1.0/powershell.exe"),
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", oracle, "-Manifest", manifest],
        { timeout: 30_000, maxBuffer: 8192, windowsHide: true });
      const allocations = JSON.parse(stdout.trim()) as number[];
      expect(allocations).toHaveLength(files.length + 2);
      expect(allocations.every((bytes) => Number.isSafeInteger(bytes) && bytes >= 0)).toBe(true);
      expect(allocations[3]).toBeLessThan((await lstat(files[3]!)).size);
      expect(allocations[4]).toBeLessThan((await lstat(files[4]!)).size);
      const total = allocations.reduce((sum, bytes) => sum + bytes, 0);
      expect(await measureMaintenanceAllocationPaths(files, signal(), options))
        .toEqual({ allocatedBytes: allocations.slice(0, files.length).reduce((sum, bytes) => sum + bytes, 0) });
      expect(await measureMaintenanceAllocation(checkout, signal(), options)).toEqual({ allocatedBytes: total });
      expect(await measureMaintenanceAllocationPaths([checkout, ...files, path.join(checkout, "hardlink")], signal(), options))
        .toEqual({ allocatedBytes: total });
      await symlink(outside, path.join(checkout, "external-junction"), "junction");
      expect(await measureMaintenanceAllocation(checkout, signal(), options)).toEqual({ allocatedBytes: total, lowerBound: true });
      expect(await measureMaintenanceAllocation(path.join(checkout, "external-junction"), signal(), options)).toBeUndefined();
      expect(await measureMaintenanceAllocation(path.join(root, "missing"), signal(), options)).toBeUndefined();
      expect(await measureMaintenanceAllocationPaths([files[2]!, path.join(root, "missing")], signal(), options)).toBeUndefined();
      expect(await measureMaintenanceAllocation(checkout, signal(), { helperPath: path.join(root, "missing-helper.exe") })).toBeUndefined();
      const cancelled = new AbortController();
      cancelled.abort();
      expect(await measureMaintenanceAllocation(checkout, cancelled.signal, options)).toBeUndefined();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
