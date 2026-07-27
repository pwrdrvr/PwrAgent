import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  listRecentFileReferencePaths,
  recordRecentFileReferencePaths,
} from "../state/recent-file-references-store";
import { StateDb } from "../state/state-db";

let stateDb: StateDb;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "pwragent-recent-file-refs-"));
  stateDb = StateDb.open(path.join(tempDir, "state.db"), {
    profileName: "dev",
  });
});

afterEach(() => {
  stateDb.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("recent-file-references-store", () => {
  it("returns an empty list before anything is recorded", () => {
    expect(listRecentFileReferencePaths(stateDb)).toEqual([]);
  });

  it("prepends new records most-recent-first", () => {
    recordRecentFileReferencePaths(stateDb, ["/a.md"]);
    recordRecentFileReferencePaths(stateDb, ["/b.md", "/c.md"]);

    expect(listRecentFileReferencePaths(stateDb)).toEqual([
      "/b.md",
      "/c.md",
      "/a.md",
    ]);
  });

  it("dedupes by path, bumping a re-recorded file to the front", () => {
    recordRecentFileReferencePaths(stateDb, ["/a.md", "/b.md"]);
    recordRecentFileReferencePaths(stateDb, ["/b.md"]);

    expect(listRecentFileReferencePaths(stateDb)).toEqual(["/b.md", "/a.md"]);
  });

  it("caps the list at 20 entries", () => {
    for (let index = 0; index < 25; index += 1) {
      recordRecentFileReferencePaths(stateDb, [`/file-${index}.md`]);
    }

    const listed = listRecentFileReferencePaths(stateDb);
    expect(listed).toHaveLength(20);
    expect(listed[0]).toBe("/file-24.md");
    expect(listed[19]).toBe("/file-5.md");
  });

  it("ignores empty batches and empty paths", () => {
    recordRecentFileReferencePaths(stateDb, []);
    recordRecentFileReferencePaths(stateDb, [""]);

    expect(listRecentFileReferencePaths(stateDb)).toEqual([]);
  });

  it("self-heals from a corrupt persisted value", () => {
    stateDb.setMeta("recentFileReferences", "{not json");

    expect(listRecentFileReferencePaths(stateDb)).toEqual([]);
    recordRecentFileReferencePaths(stateDb, ["/a.md"]);
    expect(listRecentFileReferencePaths(stateDb)).toEqual(["/a.md"]);
  });
});
