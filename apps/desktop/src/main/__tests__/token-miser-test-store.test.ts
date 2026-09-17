import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { TestTokenMiserStore } from "./token-miser-test-store";

it("owns database files separately from caller directories and shares them across connections", async () => {
  const callerDirectory = mkdtempSync(path.join(os.tmpdir(), "miser-caller-"));
  try {
    const root = path.join(callerDirectory, "objects");
    const first = new TestTokenMiserStore(root);
    const second = new TestTokenMiserStore(root);
    const databaseFile = (first.stateDb.raw.pragma("database_list") as Array<{ name: string; file: string }>)
      .find((database) => database.name === "main")!.file;
    expect(realpathSync(databaseFile).startsWith(`${realpathSync(callerDirectory)}${path.sep}`)).toBe(false);
    const entry = await first.store({
      threadId: "thread", turnId: "turn", toolUseId: "tool", toolName: "fixture",
      output: "fixture output", replacementCharacters: 10,
      summary: { summary: "fixture summary", usefulDetails: [] },
    });
    // Suite teardown may delete this directory before the helper's hook runs.
    rmSync(callerDirectory, { recursive: true, force: true });
    expect(await second.readMetadata(entry.objectId)).toMatchObject({ objectId: entry.objectId });
  } finally {
    rmSync(callerDirectory, { recursive: true, force: true });
  }
});
