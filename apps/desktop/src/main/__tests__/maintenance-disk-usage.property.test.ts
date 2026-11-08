import { lstat, link, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
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
