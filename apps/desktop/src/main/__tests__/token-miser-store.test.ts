import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TokenMiserStore } from "../token-miser/token-miser-store";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { force: true, recursive: true })
    ),
  );
});

describe("TokenMiserStore", () => {
  it("stores output, restricts reads to the owning thread, and accounts retrieval", async () => {
    const store = await createStore();
    const metadata = await store.store({
      threadId: "thread-owner",
      turnId: "turn-1",
      toolUseId: "tool-1",
      toolName: "Bash",
      output: "alpha\nneedle one\nomega\nneedle two",
      replacementCharacters: 300,
      summary: {
        summary: "Two matching lines.",
        usefulDetails: ["needle one", "needle two"],
        suggestedNextStep: "Read the matching lines.",
      },
    });

    expect(
      await store.readLines({
        objectId: metadata.objectId,
        threadId: "thread-other",
      }),
    ).toBeUndefined();

    const search = await store.search({
      objectId: metadata.objectId,
      threadId: "thread-owner",
      query: "needle",
    });
    expect(search?.matches).toEqual([
      { line: 2, text: "needle one" },
      { line: 4, text: "needle two" },
    ]);

    const read = await store.readLines({
      objectId: metadata.objectId,
      threadId: "thread-owner",
      startLine: 2,
      endLine: 3,
    });
    expect(read).toMatchObject({
      startLine: 2,
      endLine: 3,
      totalLines: 4,
      text: "needle one\nomega",
    });
    expect((await store.readMetadata(metadata.objectId))?.retrievedCharacters).toBe(
      "needle one".length + "needle two".length + "needle one\nomega".length,
    );
  });

  it("prunes expired and over-budget outputs oldest first", async () => {
    const store = await createStore();
    const expired = await createObject(store, "expired", 1);
    const older = await createObject(store, "older", 100);
    const newer = await createObject(store, "newer", 200);

    await store.prune({ maxAgeMs: 250, maxBytes: 6, now: 300 });

    expect(await store.readMetadata(expired.objectId)).toBeUndefined();
    expect(await store.readMetadata(older.objectId)).toBeUndefined();
    expect(await store.readMetadata(newer.objectId)).toBeDefined();
  });
});

async function createStore(): Promise<TokenMiserStore> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pwragent-token-miser-"));
  temporaryDirectories.push(root);
  return new TokenMiserStore(root);
}

async function createObject(
  store: TokenMiserStore,
  output: string,
  now: number,
) {
  return await store.store({
    threadId: "thread-owner",
    turnId: `turn-${now}`,
    toolUseId: `tool-${now}`,
    toolName: "Bash",
    output,
    replacementCharacters: 100,
    summary: {
      summary: output,
      usefulDetails: [],
      suggestedNextStep: "None.",
    },
    now,
  });
}
