import { readFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { expect } from "vitest";

type SyncedSidecar = { contents: string; committedOffset: number };

/** Model the durability fences, keeping real bytes, handles, renames and receiver
 * restarts. Repeating physical fsyncs tests the host disk's latency rather than
 * the generated protocol ordering. A separate integration case uses real syncs.
 *
 * Oracle: data must be synced before its offset; that sidecar must be synced,
 * renamed and directory-synced before the resume root makes it durable.
 */
export class BlobDurabilityModel {
  committedOffset = 0;
  private syncedDataBytes = 0;
  private sidecar?: SyncedSidecar;
  private renamedSidecar?: SyncedSidecar;
  private syncedDirectory?: SyncedSidecar;

  constructor(private readonly directory: string) {}

  async sync(filePath: string, file: FileHandle): Promise<void> {
    const root = path.join(this.directory, ".pwragent-resumable");
    if (path.basename(filePath) === "data.part") {
      this.syncedDataBytes = (await file.stat()).size;
    } else if (path.basename(filePath) === "offset.tmp") {
      const contents = await readFile(filePath, "utf8");
      const { committedOffset } = JSON.parse(contents) as { committedOffset: number };
      expect(committedOffset, "sidecar cannot commit unsynced data").toBeLessThanOrEqual(this.syncedDataBytes);
      this.sidecar = { contents, committedOffset };
      this.renamedSidecar = undefined;
      this.syncedDirectory = undefined;
    } else if (path.dirname(filePath) === root) {
      expect(this.renamedSidecar, "sidecar must be renamed before its directory is synced").toBeDefined();
      this.syncedDirectory = this.renamedSidecar;
    } else if (filePath === root) {
      expect(this.syncedDirectory, "transfer directory must be synced before the resume root").toBeDefined();
      expect(this.syncedDirectory).toBe(this.sidecar);
      this.committedOffset = this.syncedDirectory!.committedOffset;
    } else if (filePath !== this.directory && path.dirname(filePath) !== this.directory) {
      throw new Error(`Unexpected blob durability fence: ${filePath}`);
    }
  }

  async rename(source: string, destination: string): Promise<void> {
    expect(path.basename(source)).toBe("offset.tmp");
    expect(destination).toBe(path.join(path.dirname(source), "offset.json"));
    expect(this.sidecar, "sidecar must be synced before its rename").toBeDefined();
    expect(await readFile(destination, "utf8")).toBe(this.sidecar!.contents);
    this.renamedSidecar = this.sidecar;
    // Windows cannot sync directory handles. Its final fence is the rename
    // following the file sync; POSIX also requires both directory syncs.
    if (process.platform === "win32") this.committedOffset = this.sidecar!.committedOffset;
  }
}
